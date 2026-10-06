// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////
                 SkillRegistry, stakers approve work and the vault pays for it
//////////////////////////////////////////////////////////////////////////*/
/*
  A skill is something the AI helpers can use: a tool, a prompt pack, a piece of code. A person or a helper submits
  one with a price in SUGAR. BROWNIE stakers vote for three days. If it passes, the author is paid from the
  TeamVault.

  THE VOTE
  - A voter's weight is its staking weight (stake times loyalty boost) at the moment it votes. One vote per wallet.
  - Only coins that were staked at least one day BEFORE the proposal may vote: the wallet's last addition to its
    stake (staking.lastStakeAt) must be a day older than the proposal. The age of a stake is an average and stays
    old when new coins join an old stake, so it proves nothing here; the review of October 2026 showed a vote won
    with coins held for one transaction. With this rule borrowed coins cannot vote, and coins moved to another
    wallet cannot vote a second time.
  - It passes when yes beats no and yes is at least 5% of all staking weight AS IT WAS WHEN THE PROPOSAL WAS MADE.
    Nobody can move that bar afterwards by staking or unstaking around the count.

  THE LIMITS
  - A proposer must hold a stake of at least the staking minimum that it has not added to for a day, and may have
    one open proposal at a time, so proposals cost something to spam.
  - A passed proposal is never settled for nothing: if the vault cannot pay it now, it waits and can be settled later.
  - One skill is paid at most 5% of the vault. The vault itself never lets this contract pay more than 20% of the
    vault in 30 days.
  - The vault's owner (the Brownies team) can veto a proposal before it is paid. A veto is an event on chain.

  This contract holds no money. If a flaw is ever found in it, the vault's owner names another payer and this one
  can pay nothing more.
*/

interface IStakingView {
    function stakeOf(address) external view returns (uint256);
    function weightOf(address) external view returns (uint256);
    function lastStakeAt(address) external view returns (uint256);
    function totalWeight() external view returns (uint256);
    function MIN_POSITION() external view returns (uint256);
}

interface ITeamVaultPay {
    function pay(address to, uint256 amount, string calldata memo) external;
    function owner() external view returns (address);
    function SUGAR() external view returns (address);
}

interface IBalance {
    function balanceOf(address) external view returns (uint256);
}

contract SkillRegistry {
    uint256 public constant VOTING_PERIOD = 3 days;
    uint256 public constant QUORUM_BPS = 500; // yes must reach 5% of all staking weight
    uint256 public constant MAX_PAY_BPS = 500; // one skill is paid at most 5% of the vault
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_URI = 300;
    uint256 public constant MIN_STAKE_AGE = 1 days; // coins must be staked this long before a proposal to vote on it

    IStakingView public immutable STAKING;
    ITeamVaultPay public immutable VAULT;
    IBalance public immutable SUGAR;

    struct Skill {
        address author;
        uint64 createdAt;
        uint64 closesAt;
        bool paid;
        bool vetoed;
        uint256 ask; // SUGAR atoms
        uint256 yes;
        uint256 no;
        uint256 paidAmount;
        uint256 quorumWeight; // all staking weight when the proposal was made: the bar is 5% of this
        string uri; // where the skill lives: a repository path, a content hash
    }

    Skill[] private _skills;
    mapping(uint256 => mapping(address => bool)) public voted;
    mapping(address => uint256) public openOf; // an author's unsettled proposal, as its id + 1; 0 for none

    event Submitted(uint256 indexed id, address indexed author, uint256 ask, string uri, uint64 closesAt);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event Vetoed(uint256 indexed id);
    event Finalized(uint256 indexed id, bool passed, uint256 paid);

    error NotStaker();
    error BadSkill();
    error BadUri();
    error ZeroAmount();
    error VotingClosed();
    error VotingOpen();
    error AlreadyVoted();
    error StakeTooYoung();
    error AlreadyDone();
    error NotVaultOwner();
    error AlreadyOpen(uint256 id);
    error NothingToPay();

    constructor(address staking, address vault) {
        STAKING = IStakingView(staking);
        VAULT = ITeamVaultPay(vault);
        SUGAR = IBalance(ITeamVaultPay(vault).SUGAR());
    }

    function count() external view returns (uint256) {
        return _skills.length;
    }

    function skill(uint256 id) external view returns (Skill memory) {
        return _skills[id];
    }

    /// The most one skill could be paid right now.
    function maxPay() public view returns (uint256) {
        return SUGAR.balanceOf(address(VAULT)) * MAX_PAY_BPS / BPS;
    }

    /// Submit a skill and what you ask for it. You must be staking at least the minimum.
    function submit(string calldata uri, uint256 ask) external returns (uint256 id) {
        if (STAKING.stakeOf(msg.sender) < STAKING.MIN_POSITION()) revert NotStaker();
        if (STAKING.lastStakeAt(msg.sender) + MIN_STAKE_AGE > block.timestamp) revert StakeTooYoung();
        if (openOf[msg.sender] != 0) revert AlreadyOpen(openOf[msg.sender] - 1);
        if (ask == 0) revert ZeroAmount();
        uint256 len = bytes(uri).length;
        if (len == 0 || len > MAX_URI) revert BadUri();
        id = _skills.length;
        uint64 nowTs = uint64(block.timestamp);
        _skills.push(
            Skill({author: msg.sender, createdAt: nowTs, closesAt: nowTs + uint64(VOTING_PERIOD), paid: false, vetoed: false, ask: ask, yes: 0, no: 0, paidAmount: 0, quorumWeight: STAKING.totalWeight(), uri: uri})
        );
        openOf[msg.sender] = id + 1;
        emit Submitted(id, msg.sender, ask, uri, nowTs + uint64(VOTING_PERIOD));
    }

    /// Vote with your staking weight. The last coins you added to your stake must be a day older than the proposal.
    function vote(uint256 id, bool support) external {
        if (id >= _skills.length) revert BadSkill();
        Skill storage s = _skills[id];
        if (block.timestamp >= s.closesAt || s.vetoed) revert VotingClosed();
        if (voted[id][msg.sender]) revert AlreadyVoted();
        uint256 w = STAKING.weightOf(msg.sender);
        if (w == 0) revert NotStaker();
        if (STAKING.lastStakeAt(msg.sender) + MIN_STAKE_AGE > s.createdAt) revert StakeTooYoung();
        voted[id][msg.sender] = true;
        if (support) s.yes += w;
        else s.no += w;
        emit Voted(id, msg.sender, support, w);
    }

    /// The Brownies team may stop a proposal before it is paid.
    function veto(uint256 id) external {
        if (msg.sender != VAULT.owner()) revert NotVaultOwner();
        if (id >= _skills.length) revert BadSkill();
        Skill storage s = _skills[id];
        if (s.paid || s.vetoed) revert AlreadyDone();
        s.vetoed = true;
        if (openOf[s.author] == id + 1) openOf[s.author] = 0;
        emit Vetoed(id);
    }

    /// After the vote closes, anyone may settle it. A passed skill is paid its ask, or 5% of the vault if that is less.
    function finalize(uint256 id) external {
        if (id >= _skills.length) revert BadSkill();
        Skill storage s = _skills[id];
        if (block.timestamp < s.closesAt) revert VotingOpen();
        if (s.paid || s.vetoed) revert AlreadyDone();
        bool passed = s.yes > s.no && s.yes >= s.quorumWeight * QUORUM_BPS / BPS;
        s.paid = true; // settled either way: a failed proposal cannot be finalized again
        if (openOf[s.author] == id + 1) openOf[s.author] = 0;
        uint256 amount;
        if (passed) {
            amount = s.ask;
            uint256 cap = maxPay();
            if (amount > cap) amount = cap;
            if (amount == 0) revert NothingToPay(); // an empty vault: nothing is written, it can be settled later
            s.paidAmount = amount;
            VAULT.pay(s.author, amount, s.uri);
        }
        emit Finalized(id, passed, amount);
    }
}
