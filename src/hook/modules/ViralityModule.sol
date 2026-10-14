// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBrownieModule} from "../IBrownieModule.sol";

/*
  The brownies cook the tax. A signer (Nib, fed by the numbers from X, Telegram and the Kitchen) posts a virality
  score from 0 to 100 with a reason, on chain. The score picks a band in a table set by the owner; each band says
  the buy fee and the sell fee. The owner holds every switch, instantly:
    - setPaused(true): the base fees apply whatever the score; setPaused(false) brings the score back;
    - setBands / setBase: the steps and the fee of each step, never above MAX_BAND_BPS (the hook clamps to its
      own ceilings anyway);
    - setMaxStep: how far one score update may move each fee (no cliffs); setMaxAge: how long a score lives
      (a silent signer means the base fees, not a stuck tax);
    - setSigner: who may post, or nobody.
  Everything is an event, so the Kitchen and the site can show why the tax is what it is.
*/
contract ViralityModule is IBrownieModule {
    struct Band {
        uint8 scoreMin; // the band applies from this score up, until the next band
        uint16 buyBps;
        uint16 sellBps;
    }

    uint16 public immutable MAX_BAND_BPS;
    uint32 public constant MIN_AGE = 1 hours;
    uint32 public constant MAX_MAX_AGE = 30 days;

    address public owner;
    address public pendingOwner;
    address public signer;
    bool public paused;
    uint16 public maxStepBps;
    uint32 public maxAge;
    uint16 public baseBuyBps;
    uint16 public baseSellBps;
    Band[] internal _bands; // ascending scoreMin, the first at 0

    uint8 public score;
    uint64 public scoredAt;
    uint16 public currentBuyBps; // what the last accepted score resolved to
    uint16 public currentSellBps;

    event SignerSet(address indexed signer);
    event BaseSet(uint16 buyBps, uint16 sellBps);
    event BandsSet(Band[] bands);
    event ScoreSet(uint8 score, uint16 buyBps, uint16 sellBps, string reason);
    event Paused(bool paused);
    event StepSet(uint16 maxStepBps);
    event AgeSet(uint32 maxAge);
    event OwnershipProposed(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error OnlyOwner();
    error OnlySigner();
    error BadBands();
    error BadFee(uint16 bps);
    error BadStep(uint16 bps);
    error BadAge(uint32 seconds_);
    error StepTooBig(uint16 fromBps, uint16 toBps, uint16 maxStep);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address owner_, address signer_, uint16 baseBuy, uint16 baseSell, uint16 maxBandBps, uint16 maxStepBps_, uint32 maxAge_, Band[] memory bands_) {
        if (owner_ == address(0) || maxBandBps == 0 || maxBandBps > 10_000) revert BadBands();
        MAX_BAND_BPS = maxBandBps;
        owner = owner_;
        signer = signer_;
        emit OwnershipTransferred(address(0), owner_);
        _setStep(maxStepBps_);
        _setAge(maxAge_);
        _setBase(baseBuy, baseSell);
        _setBands(bands_);
        currentBuyBps = baseBuy;
        currentSellBps = baseSell;
    }

    // ---- IBrownieModule ----
    function moduleId() external pure returns (bytes32) {
        return keccak256("brownies.module.virality.v1");
    }

    function phases() external pure returns (uint16) {
        return 0;
    }

    function feeFor(SwapView calldata s) external view returns (uint16, uint16) {
        (uint16 b, uint16 sl) = effective();
        return (s.buy ? b : sl, 0);
    }

    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}

    function onPhase(uint16, address, bytes calldata) external pure {}

    // ---- the signer's job ----
    function setScore(uint8 newScore, string calldata reason) external {
        if (msg.sender != signer) revert OnlySigner();
        if (newScore > 100) revert BadBands();
        (uint16 b, uint16 s) = bandFor(newScore);
        // the move is measured from what applies NOW (the base fees when paused, stale or never scored)
        (uint16 fromB, uint16 fromS) = effective();
        if (_diff(fromB, b) > maxStepBps) revert StepTooBig(fromB, b, maxStepBps);
        if (_diff(fromS, s) > maxStepBps) revert StepTooBig(fromS, s, maxStepBps);
        score = newScore;
        scoredAt = uint64(block.timestamp);
        currentBuyBps = b;
        currentSellBps = s;
        emit ScoreSet(newScore, b, s, reason);
    }

    // ---- views ----
    function bands() external view returns (Band[] memory) {
        return _bands;
    }

    function bandFor(uint8 sc) public view returns (uint16 buyBps, uint16 sellBps) {
        uint256 n = _bands.length;
        for (uint256 i = n; i > 0; i--) {
            Band memory b = _bands[i - 1];
            if (sc >= b.scoreMin) return (b.buyBps, b.sellBps);
        }
        return (baseBuyBps, baseSellBps);
    }

    /// The fees that apply right now: the base when paused, when there is no score, or when the score is stale.
    function effective() public view returns (uint16 buyBps, uint16 sellBps) {
        if (paused || scoredAt == 0 || block.timestamp - scoredAt > maxAge) return (baseBuyBps, baseSellBps);
        return (currentBuyBps, currentSellBps);
    }

    // ---- the owner's switches, all instant ----
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function setSigner(address s) external onlyOwner {
        signer = s;
        emit SignerSet(s);
    }

    function setBase(uint16 buyBps, uint16 sellBps) external onlyOwner {
        _setBase(buyBps, sellBps);
    }

    function setBands(Band[] calldata bands_) external onlyOwner {
        _setBands(bands_);
    }

    function setMaxStep(uint16 bps) external onlyOwner {
        _setStep(bps);
    }

    function setMaxAge(uint32 seconds_) external onlyOwner {
        _setAge(seconds_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipProposed(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _setStep(uint16 bps) internal {
        if (bps == 0 || bps > MAX_BAND_BPS) revert BadStep(bps);
        maxStepBps = bps;
        emit StepSet(bps);
    }

    function _setAge(uint32 seconds_) internal {
        if (seconds_ < MIN_AGE || seconds_ > MAX_MAX_AGE) revert BadAge(seconds_);
        maxAge = seconds_;
        emit AgeSet(seconds_);
    }

    function _setBase(uint16 buyBps, uint16 sellBps) internal {
        if (buyBps > MAX_BAND_BPS) revert BadFee(buyBps);
        if (sellBps > MAX_BAND_BPS) revert BadFee(sellBps);
        baseBuyBps = buyBps;
        baseSellBps = sellBps;
        emit BaseSet(buyBps, sellBps);
    }

    function _setBands(Band[] memory bands_) internal {
        delete _bands;
        uint256 last = 0;
        for (uint256 i = 0; i < bands_.length; i++) {
            Band memory b = bands_[i];
            if (b.scoreMin > 100 || (i > 0 && b.scoreMin <= last)) revert BadBands();
            if (b.buyBps > MAX_BAND_BPS) revert BadFee(b.buyBps);
            if (b.sellBps > MAX_BAND_BPS) revert BadFee(b.sellBps);
            _bands.push(b);
            last = b.scoreMin;
        }
        emit BandsSet(bands_);
    }

    function _diff(uint16 a, uint16 b) internal pure returns (uint16) {
        return a > b ? a - b : b - a;
    }
}
