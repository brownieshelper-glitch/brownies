// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////
                    TeamVault, the budget of Brownies' AI helpers
//////////////////////////////////////////////////////////////////////////*/
/*
  10% of every BROWNIE tax payment arrives here as SUGAR, minted by the harvester. This vault pays the AI helpers
  that work for the coin: marketing, community, research, building.

  THE CAP. Once a day anyone may call release(). It hands out one thirtieth of whatever the vault holds, split among
  the active helpers by their weights, as AI balance on each helper's key (the SUGAR is activated, which burns it).
  So the daily budget always follows the vault: steady tax means steady work, a quiet market shrinks the budget
  slowly and never to zero overnight, and a deposit raises it the same day. Anyone may deposit by sending SUGAR here.

  TIPS. tip(helperId, amount) takes SUGAR from the caller and activates it straight to that helper's key.

  PAYOUTS. One address, the payer (the skills registry), may pay SUGAR out of the vault to people whose work the
  stakers approved. It can pay at most 20% of the vault in each 30-day window, counted on the smaller of the vault
  when the window opened and the vault now (with the window's own payouts added back). Windows follow one another, so payouts at the end of one window and the
  start of the next can add up to 36% of the vault in a short time; that is the true ceiling.

  WHO DECIDES. This vault is the one part of Brownies with an owner: the Brownies team. The owner chooses the helpers,
  their keys and their weights, and can switch every helper off (the SUGAR then simply stays here). The owner names
  the payer: the first one at launch, and any later one only 7 days after proposing it in public (PAYER_DELAY), so a
  stolen owner key cannot point the payouts at itself overnight. Switching payouts off is immediate. The owner cannot
  change the daily fraction or the payout cap and has no function that sends SUGAR to an address of its choice.
  What the owner CAN take, and stakers should know it: a helper's daily share goes to whatever key the owner sets,
  as AI credit, never as SUGAR that can be sold. Everything the owner does is an event on chain. Ownership moves in
  two steps and can be handed to a contract (a vote) later.
*/

import {ISugar} from "./interfaces/IBrownies.sol";

contract TeamVault {
    uint256 public constant RELEASE_PERIOD = 1 days;
    uint256 public constant RUNWAY_DAYS = 30; // a release hands out balance / RUNWAY_DAYS
    uint256 public constant PAY_WINDOW = 30 days;
    uint256 public constant PAY_CAP_BPS = 2_000; // the payer's ceiling per window: 20% of the vault at the window's start
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_HELPERS = 32;
    uint256 public constant PAYER_DELAY = 7 days; // a new payer waits this long, in public, before it can pay

    ISugar public immutable SUGAR;

    address public owner;
    address public pendingOwner;
    address public payer;
    address public pendingPayer; // proposed by the owner, usable from payerReadyAt
    uint256 public payerReadyAt;
    bool public payerEverSet; // the first payer, set at launch, needs no wait

    struct Helper {
        bytes32 key; // the helper's gateway beneficiary: bytes32(uint256(uint160(its wallet)))
        uint32 weight; // its share of each release, relative to the other active helpers
        bool active;
        string name;
    }

    Helper[] private _helpers;
    uint256 public totalActiveWeight;
    mapping(uint256 => uint256) public releasedTo; // SUGAR atoms ever released to a helper
    mapping(uint256 => uint256) public tippedTo; // SUGAR atoms ever tipped to a helper

    uint256 public lastRelease;
    uint256 public totalReleased;
    uint256 public totalTipped;
    uint256 public totalPaid;

    uint256 public windowStart;
    uint256 public windowBase; // the vault's balance when the current payout window opened
    uint256 public paidInWindow;

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event PayerSet(address indexed payer);
    event PayerProposed(address indexed payer, uint256 readyAt);
    event HelperKeySet(uint256 indexed id, bytes32 key);
    event HelperAdded(uint256 indexed id, string name, bytes32 key, uint32 weight);
    event HelperSet(uint256 indexed id, uint32 weight, bool active);
    event Released(uint256 budget, uint256 vaultAfter);
    event HelperPaid(uint256 indexed id, uint256 amount, uint256 activationId);
    event Tipped(uint256 indexed id, address indexed from, uint256 amount, uint256 activationId);
    event Paid(address indexed to, uint256 amount, string memo);

    error NotOwner();
    error NotPendingOwner();
    error NotPayer();
    error ZeroAddress();
    error ZeroAmount();
    error BadHelper();
    error TooManyHelpers();
    error TooEarly(uint256 nextRelease);
    error NothingToRelease();
    error OverPayCap(uint256 wanted, uint256 left);
    error PayerNotReady(uint256 readyAt);
    error Reentered();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address sugar, address owner_) {
        if (sugar == address(0) || owner_ == address(0)) revert ZeroAddress();
        SUGAR = ISugar(sugar);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /*//////////////////////////////////////////////////////////////
                              THE DAILY RELEASE
    //////////////////////////////////////////////////////////////*/

    /// What a release would hand out right now: one thirtieth of the vault.
    function dailyBudget() public view returns (uint256) {
        return SUGAR.balanceOf(address(this)) / RUNWAY_DAYS;
    }

    /// Hand today's budget to the active helpers by weight. Anyone may call it, once a day.
    function release() external nonReentrant returns (uint256 budget) {
        if (block.timestamp < lastRelease + RELEASE_PERIOD) revert TooEarly(lastRelease + RELEASE_PERIOD);
        uint256 tw = totalActiveWeight;
        budget = dailyBudget();
        if (tw == 0 || budget == 0) revert NothingToRelease();
        lastRelease = block.timestamp;
        uint256 n = _helpers.length;
        uint256 handed;
        for (uint256 i = 0; i < n; i++) {
            Helper storage h = _helpers[i];
            if (!h.active || h.weight == 0) continue;
            uint256 amount = budget * h.weight / tw;
            if (amount == 0) continue;
            handed += amount;
            releasedTo[i] += amount;
            uint256 id = SUGAR.activate(amount, h.key);
            emit HelperPaid(i, amount, id);
        }
        totalReleased += handed;
        emit Released(handed, SUGAR.balanceOf(address(this)));
        return handed;
    }

    /*//////////////////////////////////////////////////////////////
                                    TIPS
    //////////////////////////////////////////////////////////////*/

    /// Send SUGAR to one helper. It goes straight onto that helper's key and never rests in the vault.
    function tip(uint256 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (id >= _helpers.length || !_helpers[id].active) revert BadHelper();
        if (!SUGAR.transferFrom(msg.sender, address(this), amount)) revert ZeroAmount();
        tippedTo[id] += amount;
        totalTipped += amount;
        uint256 actId = SUGAR.activate(amount, _helpers[id].key);
        emit Tipped(id, msg.sender, amount, actId);
    }

    /*//////////////////////////////////////////////////////////////
                         PAYOUTS FOR APPROVED WORK
    //////////////////////////////////////////////////////////////*/

    /// What the payer may still pay in the current window. The cap is 20% of the smaller of the vault when the
    /// window opened and the vault now: after a month of releases the opening balance says little.
    function payAllowance() public view returns (uint256) {
        uint256 bal = SUGAR.balanceOf(address(this));
        if (block.timestamp >= windowStart + PAY_WINDOW) return bal * PAY_CAP_BPS / BPS;
        // the vault now, with this window's payouts added back: releases shrink the cap, the payouts themselves do not
        uint256 basis = bal + paidInWindow;
        if (windowBase < basis) basis = windowBase;
        uint256 cap = basis * PAY_CAP_BPS / BPS;
        return cap > paidInWindow ? cap - paidInWindow : 0;
    }

    /// Pay SUGAR to someone whose work was approved. Only the payer, and never past the window's cap.
    function pay(address to, uint256 amount, string calldata memo) external nonReentrant {
        if (msg.sender != payer) revert NotPayer();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = SUGAR.balanceOf(address(this));
        if (block.timestamp >= windowStart + PAY_WINDOW) {
            windowStart = block.timestamp;
            windowBase = bal;
            paidInWindow = 0;
        }
        // the vault now, with this window's payouts added back: releases shrink the cap, the payouts themselves do not
        uint256 basis = bal + paidInWindow;
        if (windowBase < basis) basis = windowBase;
        uint256 cap = basis * PAY_CAP_BPS / BPS;
        uint256 left = cap > paidInWindow ? cap - paidInWindow : 0;
        if (amount > left) revert OverPayCap(amount, left);
        paidInWindow += amount;
        totalPaid += amount;
        if (!SUGAR.transfer(to, amount)) revert ZeroAmount();
        emit Paid(to, amount, memo);
    }

    /*//////////////////////////////////////////////////////////////
                                 THE HELPERS
    //////////////////////////////////////////////////////////////*/

    function helperCount() external view returns (uint256) {
        return _helpers.length;
    }

    function helper(uint256 id) external view returns (string memory name, bytes32 key, uint32 weight, bool active) {
        Helper storage h = _helpers[id];
        return (h.name, h.key, h.weight, h.active);
    }

    function addHelper(string calldata name, bytes32 key, uint32 weight) external onlyOwner returns (uint256 id) {
        if (key == bytes32(0) || weight == 0) revert BadHelper();
        if (_helpers.length >= MAX_HELPERS) revert TooManyHelpers();
        id = _helpers.length;
        _helpers.push(Helper({key: key, weight: weight, active: true, name: name}));
        totalActiveWeight += weight;
        emit HelperAdded(id, name, key, weight);
    }

    /// Give a helper a new key (a lost or leaked wallet). The 32 places are for ever, so a key must be replaceable.
    function setKey(uint256 id, bytes32 key) external onlyOwner {
        if (id >= _helpers.length || key == bytes32(0)) revert BadHelper();
        _helpers[id].key = key;
        emit HelperKeySet(id, key);
    }

    /// Change a helper's weight, or switch it off or on.
    function setHelper(uint256 id, uint32 weight, bool active) external onlyOwner {
        if (id >= _helpers.length) revert BadHelper();
        if (active && weight == 0) revert BadHelper();
        Helper storage h = _helpers[id];
        if (h.active) totalActiveWeight -= h.weight;
        h.weight = weight;
        h.active = active;
        if (active) totalActiveWeight += weight;
        emit HelperSet(id, weight, active);
    }

    /*//////////////////////////////////////////////////////////////
                                  THE OWNER
    //////////////////////////////////////////////////////////////*/

    /// Name the payer. Zero switches payouts off at once. The first payer (at launch) is set at once. Any later
    /// payer is only proposed here and can be put in place PAYER_DELAY later with acceptPayer().
    function setPayer(address payer_) external onlyOwner {
        if (payer_ == address(0)) {
            payer = address(0);
            pendingPayer = address(0);
            payerReadyAt = 0;
            emit PayerSet(address(0));
        } else if (!payerEverSet) {
            payerEverSet = true;
            payer = payer_;
            emit PayerSet(payer_);
        } else {
            pendingPayer = payer_;
            payerReadyAt = block.timestamp + PAYER_DELAY;
            emit PayerProposed(payer_, payerReadyAt);
        }
    }

    /// Put the proposed payer in place once its wait is over.
    function acceptPayer() external onlyOwner {
        if (pendingPayer == address(0) || block.timestamp < payerReadyAt) revert PayerNotReady(payerReadyAt);
        payer = pendingPayer;
        pendingPayer = address(0);
        payerReadyAt = 0;
        emit PayerSet(payer);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
