// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////
          BrownieStaking, stake BROWNIE, earn SUGAR by the second, more if you stay
//////////////////////////////////////////////////////////////////////////*/
/*
  Stake BROWNIE and earn SUGAR, one dollar of inference per SUGAR, in proportion to how much you staked and for how
  long. Every budget that arrives is streamed to stakers over the next hour, second by second. A wallet that stakes
  for ten seconds earns ten seconds' worth. There is nothing to front-run.

  LOYALTY. A stake that stays earns more. Each account has a weight = stake * boost, and the stream is shared by
  weight. The boost depends on the age of the stake:
      under 30 days   1.00
      30 days         1.10
      90 days         1.20
      180 days        1.30
  The age is counted from `startOf`. A first stake starts now. Adding to a stake moves the start to the average of
  the old start and now, weighted by the amounts, so a small old stake cannot lend its age to a large new one.
  Unstaking part keeps the age; unstaking everything resets it.
  A weight only ever grows with time, so it is refreshed lazily: stake, unstake and claim refresh the caller, and
  anyone may call poke(account). An account that is never refreshed simply keeps its older, lower weight. Nobody
  can gain from a stale weight.

  Where the budget comes from: fund(usdgAtoms). Anyone may call it, and it pulls that many USDG atoms from the caller
  and sends them to the inference funding wallet in the same call. Only then does it book the same number of SUGAR
  atoms into the stream. Nobody can book a budget without paying the dollars first, so SUGAR minted here is always
  funded. While nobody is staked the stream is not lost: it is carried into the next budget.

  stake(amount) needs a position of at least MIN_POSITION afterwards; unstake(amount) leaves zero or at least that.
  Unstaking has no cooldown and can NEVER be paused.

  THE EMERGENCY STOP. The owner (the Brownies team) can stop and restart the staking at any time, with an event.
  Stopped means: no new stakes, no new budget, no SUGAR minted (claims wait). Everyone can always take their coins
  out, stopped or not; what they earned stays booked and can be claimed when the owner restarts. The owner can
  never touch anyone's coins or SUGAR. Nothing to upgrade.
*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISugar} from "./interfaces/IBrownies.sol";

contract BrownieStaking {
    using SafeERC20 for IERC20;

    uint256 public constant DURATION = 1 hours;
    uint256 public constant BPS = 10_000;
    uint256 public constant TIER1_AGE = 30 days;
    uint256 public constant TIER1_BPS = 11_000;
    uint256 public constant TIER2_AGE = 90 days;
    uint256 public constant TIER2_BPS = 12_000;
    uint256 public constant TIER3_AGE = 180 days;
    uint256 public constant TIER3_BPS = 13_000;
    uint256 internal constant RATE_SCALE = 1e18; // rewardRate is SUGAR atoms * 1e18 per second
    uint256 internal constant RPW_SCALE = 1e36; // rewardPerWeight is SUGAR atoms * 1e36 per unit of weight

    IERC20 public immutable BROWNIE;
    ISugar public immutable SUGAR;
    IERC20 public immutable USDG;
    address public immutable FUNDING;
    uint256 public immutable MIN_POSITION;

    uint256 public totalStaked;
    uint256 public totalWeight;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public weightOf; // stake * boost / BPS, as of the account's last refresh
    mapping(address => uint256) public startOf; // the time the stake's age is counted from; 0 with no stake
    /// The last time the account ADDED coins. startOf is an average, so it can stay old while almost every coin is
    /// new; anything that must know "these coins were here before" (a vote) reads this instead.
    mapping(address => uint256) public lastStakeAt;

    uint256 public rewardRate; // atoms * 1e18 per second, streamed until periodFinish
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerWeightStored; // atoms * 1e36 per unit of weight
    uint256 public carried; // atoms that streamed while nobody was staked, folded into the next budget
    mapping(address => uint256) public userRewardPerWeightPaid;
    mapping(address => uint256) public rewards; // atoms settled and not yet minted

    address public owner;
    address public pendingOwner;
    bool public stopped;

    uint256 public totalFunded; // USDG atoms ever pulled to the funding wallet through fund()
    uint256 public totalMinted; // SUGAR atoms ever minted by claims; always <= totalFunded

    event Funded(address indexed funder, uint256 usdgAtoms, uint256 streaming);
    event Staked(address indexed account, uint256 amount, uint256 position, uint256 start);
    event Unstaked(address indexed account, uint256 amount, uint256 position);
    event Claimed(address indexed account, uint256 sugarAtoms);
    event Reweighed(address indexed account, uint256 weight, uint256 boostBps);
    event Stopped(bool stopped);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error ZeroAddress();
    error ZeroAmount();
    error BelowMinimumPosition(uint256 position, uint256 minimum);
    error NothingToClaim();
    error BelowMinimumFund(uint256 amount, uint256 minimum);
    error FundingCannotFund();
    error Reentered();
    error StakingStopped();
    error NotOwner();
    error NotPendingOwner();

    /// The smallest budget fund() takes: 1 dollar. Every fund() spreads what is still streaming over a new hour, so
    /// a stream of dust calls could stretch it for ever; this makes stretching cost 1 dollar a call.
    uint256 public constant MIN_FUND = 1e6;

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

    constructor(address brownie, address sugar, address usdg, address funding, uint256 minPosition, address owner_) {
        if (brownie == address(0) || sugar == address(0) || usdg == address(0) || funding == address(0) || owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        if (minPosition == 0) revert ZeroAmount();
        BROWNIE = IERC20(brownie);
        SUGAR = ISugar(sugar);
        USDG = IERC20(usdg);
        FUNDING = funding;
        MIN_POSITION = minPosition;
        lastUpdate = block.timestamp;
    }

    /*//////////////////////////////////////////////////////////////
                                 THE OWNER
    //////////////////////////////////////////////////////////////*/

    /// Stop (true) or restart (false) stakes, budgets and claims. Unstaking is never affected.
    function setStopped(bool stop) external onlyOwner {
        stopped = stop;
        emit Stopped(stop);
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

    /*//////////////////////////////////////////////////////////////
                                 THE BUDGET
    //////////////////////////////////////////////////////////////*/

    /// Pull `usdgAtoms` from the caller to the funding wallet, then stream that many SUGAR atoms over the next hour.
    /// What was still streaming from the last budget, and what streamed to nobody, join the new hour.
    function fund(uint256 usdgAtoms) external nonReentrant {
        if (stopped) revert StakingStopped();
        if (usdgAtoms < MIN_FUND) revert BelowMinimumFund(usdgAtoms, MIN_FUND);
        if (msg.sender == FUNDING) revert FundingCannotFund(); // a transfer to itself would move no dollar
        USDG.safeTransferFrom(msg.sender, FUNDING, usdgAtoms);
        _update();
        uint256 leftover;
        if (block.timestamp < periodFinish) leftover = (periodFinish - block.timestamp) * rewardRate / RATE_SCALE;
        uint256 streaming = usdgAtoms + leftover + carried;
        carried = 0;
        rewardRate = streaming * RATE_SCALE / DURATION;
        periodFinish = block.timestamp + DURATION;
        lastUpdate = block.timestamp;
        totalFunded += usdgAtoms;
        emit Funded(msg.sender, usdgAtoms, streaming);
    }

    /*//////////////////////////////////////////////////////////////
                                 THE STAKE
    //////////////////////////////////////////////////////////////*/

    function stake(uint256 amount) external nonReentrant {
        if (stopped) revert StakingStopped();
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        // count what really arrived: nothing here can be fixed later if the coin ever took a cut on transfer
        uint256 had = BROWNIE.balanceOf(address(this));
        BROWNIE.safeTransferFrom(msg.sender, address(this), amount);
        amount = BROWNIE.balanceOf(address(this)) - had;
        if (amount == 0) revert ZeroAmount();
        uint256 old = stakeOf[msg.sender];
        uint256 position = old + amount;
        if (position < MIN_POSITION) revert BelowMinimumPosition(position, MIN_POSITION);
        // The age of the whole position is the average of the two ages, weighted by the amounts. An old stake
        // counts as 180 days old at most: age past the top tier earns nothing, so it must not be lent to new coins.
        uint256 start = block.timestamp;
        if (old != 0) {
            uint256 s0 = startOf[msg.sender];
            if (block.timestamp - s0 > TIER3_AGE) s0 = block.timestamp - TIER3_AGE;
            start = (old * s0 + amount * block.timestamp) / position;
        }
        startOf[msg.sender] = start;
        lastStakeAt[msg.sender] = block.timestamp;
        stakeOf[msg.sender] = position;
        totalStaked += amount;
        _reweigh(msg.sender);
        emit Staked(msg.sender, amount, position, start);
    }

    /// No cooldown. The remainder is zero or at least MIN_POSITION, the rule stake() keeps. The age is kept.
    function unstake(uint256 amount) external nonReentrant {
        _unstake(amount);
    }

    /// Mint everything earned to the caller, and refresh the caller's loyalty weight. Waits while stopped.
    function claim() external nonReentrant returns (uint256 minted) {
        if (stopped) revert StakingStopped();
        return _claim();
    }

    /// Unstake everything and claim, in one call. While stopped it still returns the coins; the SUGAR waits.
    function exit() external nonReentrant returns (uint256 minted) {
        uint256 all = stakeOf[msg.sender];
        if (all != 0) _unstake(all);
        if (!stopped && rewards[msg.sender] != 0) minted = _claim();
    }

    /// Refresh an account's loyalty weight to what its stake's age now earns. Anyone may call it for anyone.
    function poke(address account) external nonReentrant {
        _settle(account);
        _reweigh(account);
    }

    function _unstake(uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        uint256 position = stakeOf[msg.sender] - amount; // reverts on more than staked
        if (position != 0 && position < MIN_POSITION) revert BelowMinimumPosition(position, MIN_POSITION);
        stakeOf[msg.sender] = position;
        totalStaked -= amount;
        if (position == 0) startOf[msg.sender] = 0;
        _reweigh(msg.sender);
        BROWNIE.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, position);
    }

    function _claim() internal returns (uint256 minted) {
        _settle(msg.sender);
        _reweigh(msg.sender);
        minted = rewards[msg.sender];
        if (minted == 0) revert NothingToClaim();
        rewards[msg.sender] = 0;
        totalMinted += minted;
        SUGAR.mint(msg.sender, minted);
        emit Claimed(msg.sender, minted);
    }

    /*//////////////////////////////////////////////////////////////
                                THE ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    /// The boost for a stake of this age, in BPS.
    function boostBps(uint256 age) public pure returns (uint256) {
        if (age >= TIER3_AGE) return TIER3_BPS;
        if (age >= TIER2_AGE) return TIER2_BPS;
        if (age >= TIER1_AGE) return TIER1_BPS;
        return BPS;
    }

    /// Advance the stream to now. With no weight staked the streamed atoms are carried, not lost.
    function _update() internal {
        uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (t <= lastUpdate) {
            if (block.timestamp > lastUpdate) lastUpdate = block.timestamp;
            return;
        }
        uint256 streamed = (t - lastUpdate) * rewardRate; // atoms * 1e18
        if (totalWeight == 0) {
            carried += streamed / RATE_SCALE;
        } else {
            rewardPerWeightStored += streamed * RATE_SCALE / totalWeight; // atoms * 1e36 per unit of weight
        }
        lastUpdate = block.timestamp;
    }

    /// Book what the account earned under the weight it has had since its last settle.
    function _settle(address account) internal {
        _update();
        uint256 pending = weightOf[account] * (rewardPerWeightStored - userRewardPerWeightPaid[account]) / RPW_SCALE;
        if (pending != 0) rewards[account] += pending;
        userRewardPerWeightPaid[account] = rewardPerWeightStored;
    }

    /// Set the account's weight from its stake and its age now. Always called right after _settle(account).
    function _reweigh(address account) internal {
        uint256 s = stakeOf[account];
        uint256 boost = s == 0 ? BPS : boostBps(block.timestamp - startOf[account]);
        uint256 w = s * boost / BPS;
        uint256 old = weightOf[account];
        if (w != old) {
            totalWeight = totalWeight - old + w;
            weightOf[account] = w;
            emit Reweighed(account, w, boost);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                   VIEWS
    //////////////////////////////////////////////////////////////*/

    /// The accumulator as it would be after an update now.
    function rewardPerWeight() public view returns (uint256) {
        uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (t <= lastUpdate || totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored + (t - lastUpdate) * rewardRate * RATE_SCALE / totalWeight;
    }

    /// SUGAR atoms `account` could claim right now.
    function earned(address account) external view returns (uint256) {
        return rewards[account] + weightOf[account] * (rewardPerWeight() - userRewardPerWeightPaid[account]) / RPW_SCALE;
    }

    /// The boost the account's stake has earned by its age (BPS), and the boost its weight currently uses. When the
    /// first is higher, a poke or a claim raises the weight.
    function boostOf(address account) external view returns (uint256 earnedBps, uint256 appliedBps) {
        uint256 s = stakeOf[account];
        if (s == 0) return (BPS, BPS);
        earnedBps = boostBps(block.timestamp - startOf[account]);
        appliedBps = weightOf[account] * BPS / s;
    }

    /// SUGAR atoms still streaming (not yet earned by anyone), plus what streamed to nobody and waits to be carried.
    function unstreamed() external view returns (uint256) {
        uint256 left = block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate / RATE_SCALE : 0;
        uint256 toCarry;
        if (totalWeight == 0) {
            uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
            if (t > lastUpdate) toCarry = (t - lastUpdate) * rewardRate / RATE_SCALE;
        }
        return left + carried + toCarry;
    }
}
