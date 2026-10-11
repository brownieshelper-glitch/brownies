// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/*
  BrownieHook: the coin's Uniswap v4 hook. An immutable shell around a replaceable module.

  WHAT NEVER CHANGES (this contract, no proxy, no setters):
    - the pool it serves (one native ETH / BROWNIE pool, bound at initialization by the launcher),
    - the fee is taken in ETH on buys and on sells: Programmable's platform leg of PLATFORM_BPS (0.30%) to
      PLATFORM_RECIPIENT, plus the project's leg that never passes MAX_BUY_BPS / MAX_SELL_BPS (3% = 3.3% in all),
    - at least (10000 - MAX_MODULE_SHARE_BPS) of the project's leg goes to the harvester (the contract that pays the
      main wallet and buys SUGAR for the stakers); anyone may call harvest() to send it, and claimPlatform() to pay
      Programmable,
    - the launch window: for CAP_SECONDS after the pool opens, one wallet may buy at most CAP_BPS of the supply,
      and only through CAP_ROUTER (the Universal Router), whose msgSender() names the wallet,
    - a module change waits MODULE_DELAY seconds between proposeModule() and applyModule(); clearing the module is
      instant (that only removes freedom, it never adds any),
    - a module that reverts or runs out of its gas budget inside a swap does not block the swap: the base fee applies.

  WHAT THE MODULE DECIDES (replaceable, see IBrownieModule): the fee of each swap inside the ceilings, its own share
  of that fee up to the cap, and what happens on the pool's other events. That is where the coin evolves.

  FEE MATHS. The fee is always on the ETH leg, bps = project bps + PLATFORM_BPS. Four swap shapes:
    buy, exact input  (ETH named):    fee = named * bps / 10000, taken before the swap from the named amount
    sell, exact output (ETH named):   the pool pays named + fee, the hook keeps fee = named * bps / (10000 - bps)
    buy, exact output (coin named):   the pool takes net ETH, the swapper pays net + fee, fee = net * bps / (10000 - bps)
    sell, exact input (coin named):   the pool pays gross ETH, the swapper gets gross - fee, fee = gross * bps / 10000
  When the ETH leg is the named one, the fee was computed on a number the pool may not reach (a partial fill when
  the pool runs out of liquidity): such a swap is refused whole rather than overcharged (PartialFill).
*/
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IBrownieModule, Phases} from "./IBrownieModule.sol";

interface IMsgSender {
    function msgSender() external view returns (address);
}

contract BrownieHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    // ---- configuration, all fixed at deployment ----
    struct Config {
        address poolManager;
        address token; // BROWNIE
        address quote; // address(0) for native ETH (what the pool uses), or an ERC20
        address harvester; // where the project's fee goes
        address platformRecipient; // Programmable
        uint16 platformBps; // 30: Programmable's 0.30% on every buy and sell, on top of the project's fee
        address launcher; // the only contract allowed to open the pool and add the first liquidity
        address owner; // proposes modules; two-step transfer
        address firstModule; // the module at launch (may be zero: base fee only)
        uint16 baseBuyBps; // the fee without a module, or when the module fails
        uint16 baseSellBps;
        uint16 maxBuyBps; // ceilings for ever
        uint16 maxSellBps;
        uint16 maxModuleShareBps; // of the fee, for ever
        uint16 capBps; // launch window: max supply share per wallet
        uint32 capSeconds; // launch window length
        address capRouter; // the only router during the window (its msgSender() names the wallet)
        address capRouter2; // a second trusted router for the window (Programmable's; same msgSender()), or zero
        uint32 moduleDelay; // seconds between proposing and applying a module
        uint32 moduleGas; // gas budget of a module call inside a swap
    }

    uint256 internal constant BPS = 10_000;
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint256 internal constant MAX_FEE_BPS = 2_000; // 20%: nothing above this can even be configured

    IPoolManager public immutable poolManager;
    address public immutable TOKEN;
    address public immutable QUOTE;
    uint256 internal immutable QUOTE_ID;
    bool public immutable QUOTE_IS_0;
    address public immutable HARVESTER;
    address public immutable PLATFORM_RECIPIENT;
    uint16 public immutable PLATFORM_BPS;
    address public immutable LAUNCHER;
    uint16 public immutable BASE_BUY_BPS;
    uint16 public immutable BASE_SELL_BPS;
    uint16 public immutable MAX_BUY_BPS;
    uint16 public immutable MAX_SELL_BPS;
    uint16 public immutable MAX_MODULE_SHARE_BPS;
    uint256 public immutable CAP_TOKENS;
    uint32 public immutable CAP_SECONDS;
    address public immutable CAP_ROUTER;
    address public immutable CAP_ROUTER_2;
    uint32 public immutable MODULE_DELAY;
    uint32 public immutable MODULE_GAS;

    // ---- the pool ----
    PoolKey internal _key;
    bytes32 public poolId;
    uint64 public openedAt; // 0 until the launcher opens the pool
    mapping(address wallet => uint256 bought) public purchased; // during the launch window

    // ---- the fee ----
    uint256 public harvestable; // ETH claims held here for the harvester
    uint256 public moduleBudget; // ETH claims held here for the module
    uint256 public platformOwed; // ETH claims held here for Programmable
    uint256 public totalFees; // project + platform
    uint256 public totalPlatform;
    uint256 public totalHarvested;

    // ---- the module ----
    address public module;
    uint16 public modulePhases;
    address public pendingModule;
    uint64 public pendingAt;
    address public owner;
    address public pendingOwner;

    // transient scratch between beforeSwap and afterSwap (one swap at a time per unlock)
    uint256 private constant TS_FEE = 0x01;
    uint256 private constant TS_EXPECT = 0x02;
    uint256 private constant TS_BPS = 0x03;
    uint256 private constant TS_SHARE = 0x04;

    event PoolOpened(bytes32 indexed poolId, uint160 sqrtPriceX96, uint64 openedAt);
    event Swap(bytes32 indexed poolId, address indexed router, address wallet, bool buy, bool exactInput, uint256 quoteGross, uint256 projectFee, uint256 platformFee, uint16 bps, uint16 shareBps);
    event Harvested(address indexed to, uint256 amount);
    event PlatformClaimed(address indexed to, uint256 amount);
    event ModuleBudgetTaken(address indexed module, address indexed to, uint256 amount);
    event ModuleProposed(address indexed module, uint64 appliesAt);
    event ModuleApplied(address indexed module, bytes32 moduleId, uint16 phases);
    event ModuleCleared(address indexed module);
    event ModuleFailed(address indexed module, uint16 phase);
    event Note(address indexed by, string text);
    event OwnershipProposed(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error OnlyPoolManager();
    error OnlyOwner();
    error OnlyModule();
    error OnlyLauncher();
    error BadConfig();
    error AlreadyOpened();
    error NotOurPool();
    error WrongPool();
    error PartialFill();
    error BadDelta();
    error FeeEatsSwap();
    error CapRouterOnly();
    error CapBuyer();
    error CapExceeded(address wallet, uint256 bought, uint256 cap);
    error NothingPending();
    error TooEarly(uint64 appliesAt);
    error BadModule();
    error NotEnoughBudget();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(Config memory c) {
        if (
            c.poolManager == address(0) || c.token == address(0) || c.token == c.quote || c.harvester == address(0)
                || c.launcher == address(0) || c.owner == address(0) || c.capRouter == address(0)
                || (c.platformBps != 0 && c.platformRecipient == address(0))
        ) revert BadConfig();
        if (
            c.maxBuyBps > MAX_FEE_BPS || c.maxSellBps > MAX_FEE_BPS || c.baseBuyBps > c.maxBuyBps || c.baseSellBps > c.maxSellBps
                || c.platformBps > MAX_FEE_BPS || c.maxModuleShareBps > BPS || c.capBps == 0 || c.capBps > BPS || c.moduleGas < 30_000
        ) revert BadConfig();
        poolManager = IPoolManager(c.poolManager);
        TOKEN = c.token;
        QUOTE = c.quote;
        QUOTE_ID = uint256(uint160(c.quote));
        QUOTE_IS_0 = c.quote < c.token;
        HARVESTER = c.harvester;
        PLATFORM_RECIPIENT = c.platformRecipient;
        PLATFORM_BPS = c.platformBps;
        LAUNCHER = c.launcher;
        BASE_BUY_BPS = c.baseBuyBps;
        BASE_SELL_BPS = c.baseSellBps;
        MAX_BUY_BPS = c.maxBuyBps;
        MAX_SELL_BPS = c.maxSellBps;
        MAX_MODULE_SHARE_BPS = c.maxModuleShareBps;
        CAP_TOKENS = SUPPLY * c.capBps / BPS;
        CAP_SECONDS = c.capSeconds;
        CAP_ROUTER = c.capRouter;
        CAP_ROUTER_2 = c.capRouter2;
        MODULE_DELAY = c.moduleDelay;
        MODULE_GAS = c.moduleGas;
        owner = c.owner;
        emit OwnershipTransferred(address(0), c.owner);
        if (c.firstModule != address(0)) _setModule(c.firstModule);
    }

    // ================================================================= the pool
    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96) external onlyPoolManager returns (bytes4) {
        if (sender != LAUNCHER) revert OnlyLauncher();
        if (openedAt != 0) revert AlreadyOpened();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (!((c0 == QUOTE && c1 == TOKEN) || (c0 == TOKEN && c1 == QUOTE)) || address(key.hooks) != address(this)) revert WrongPool();
        _key = key;
        poolId = PoolId.unwrap(key.toId());
        openedAt = uint64(block.timestamp);
        emit PoolOpened(poolId, sqrtPriceX96, openedAt);
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick) external onlyPoolManager returns (bytes4) {
        _phase(Phases.AFTER_INITIALIZE, sender, abi.encode(key, sqrtPriceX96, tick), false);
        return IHooks.afterInitialize.selector;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    function capEndsAt() public view returns (uint256) {
        return openedAt == 0 ? type(uint256).max : uint256(openedAt) + CAP_SECONDS;
    }

    // ================================================================= swaps
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata p, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (PoolId.unwrap(key.toId()) != poolId) revert NotOurPool();
        bool buy = p.zeroForOne == QUOTE_IS_0;
        bool exactIn = p.amountSpecified < 0;
        uint256 specified = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);

        (uint16 bps, uint16 share) = _ask(sender, buy, exactIn, specified);
        _tstore(TS_BPS, bps);
        _tstore(TS_SHARE, share);

        // an exact-output buy names its coins now: check the launch cap before the pool runs
        if (buy && !exactIn && block.timestamp < capEndsAt()) _checkCap(sender, specified, hookData);

        if (buy == exactIn) {
            // the ETH leg is the named one: the fee (project + platform) is taken here, on the named amount
            uint256 total = uint256(bps) + PLATFORM_BPS;
            uint256 fee = buy ? specified * total / BPS : specified * total / (BPS - total);
            if (buy && fee >= specified) revert FeeEatsSwap();
            if (fee > uint256(uint128(type(int128).max))) revert BadDelta();
            _tstore(TS_FEE, fee);
            _tstore(TS_EXPECT, buy ? specified - fee : specified + fee);
            return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
        }
        _tstore(TS_FEE, 0);
        _tstore(TS_EXPECT, 0);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata p, BalanceDelta delta, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        if (PoolId.unwrap(key.toId()) != poolId) revert NotOurPool();
        bool buy = p.zeroForOne == QUOTE_IS_0;
        bool exactIn = p.amountSpecified < 0;
        int128 qd = QUOTE_IS_0 ? delta.amount0() : delta.amount1();
        int128 td = QUOTE_IS_0 ? delta.amount1() : delta.amount0();
        // a buy pays ETH and receives coins; a sell the reverse. Anything else is not a trade we understand.
        if (buy ? (qd >= 0 || td <= 0) : (qd <= 0 || td >= 0)) revert BadDelta();
        uint256 quoteAmount = uint256(uint128(qd < 0 ? -qd : qd));
        uint256 tokenAmount = uint256(uint128(td < 0 ? -td : td));
        uint16 bps = uint16(_tload(TS_BPS));
        uint16 share = uint16(_tload(TS_SHARE));

        uint256 fee;
        int128 ret;
        uint256 gross;
        if (buy == exactIn) {
            fee = _tload(TS_FEE);
            if (quoteAmount != _tload(TS_EXPECT)) revert PartialFill();
            gross = buy ? quoteAmount + fee : quoteAmount; // a sell: what the pool paid out, fee included
        } else {
            // the coin was named: the fee rides on the ETH leg the pool just computed
            uint256 total = uint256(bps) + PLATFORM_BPS;
            fee = buy ? quoteAmount * total / (BPS - total) : quoteAmount * total / BPS;
            if (fee > uint256(uint128(type(int128).max))) revert BadDelta();
            ret = int128(int256(fee));
            gross = buy ? quoteAmount + fee : quoteAmount;
        }

        address wallet;
        if (buy && block.timestamp < capEndsAt()) wallet = _countCap(sender, tokenAmount, hookData);

        uint256 platformFee;
        if (fee != 0) {
            // the fee becomes a claim held here; the delta the pool manager owes us for it is settled by our return
            // value (coin named) or by the delta we returned before the swap (ETH named)
            poolManager.mint(address(this), QUOTE_ID, fee);
            platformFee = gross * PLATFORM_BPS / BPS;
            if (platformFee > fee) platformFee = fee;
            uint256 project = fee - platformFee;
            uint256 m = project * share / BPS;
            moduleBudget += m;
            harvestable += project - m;
            platformOwed += platformFee;
            totalFees += fee;
            totalPlatform += platformFee;
        }
        emit Swap(poolId, sender, wallet, buy, exactIn, gross, fee - platformFee, platformFee, bps, share);

        address mod = module;
        if (mod != address(0) && (modulePhases & Phases.AFTER_SWAP) != 0) {
            try IBrownieModule(mod).onAfterSwap{gas: MODULE_GAS}(IBrownieModule.SwapView(poolId, sender, buy, exactIn, exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified)), qd, td, fee) {}
            catch {
                emit ModuleFailed(mod, Phases.AFTER_SWAP);
            }
        }
        return (IHooks.afterSwap.selector, ret);
    }

    /// The module's word on this swap, bounded. Never reverts.
    function _ask(address sender, bool buy, bool exactIn, uint256 specified) internal view returns (uint16 bps, uint16 share) {
        bps = buy ? BASE_BUY_BPS : BASE_SELL_BPS;
        address mod = module;
        if (mod == address(0)) return (bps, 0);
        // A bounded low-level call, decoded by hand: a revert, out-of-gas, an empty, short, long or malformed answer,
        // a word that is not a uint16, all mean "the base fee" and the swap goes on. A typed try/catch would not do:
        // the ABI decoding of a bad answer happens in this contract and would revert the trade.
        (bool ok, bytes memory ret) = mod.staticcall{gas: MODULE_GAS}(abi.encodeCall(IBrownieModule.feeFor, (IBrownieModule.SwapView(poolId, sender, buy, exactIn, specified))));
        if (!ok || ret.length != 64) return (bps, 0);
        (uint256 b, uint256 s) = abi.decode(ret, (uint256, uint256));
        if (b > type(uint16).max || s > type(uint16).max) return (bps, 0);
        uint16 cap = buy ? MAX_BUY_BPS : MAX_SELL_BPS;
        bps = b > cap ? cap : uint16(b);
        share = s > MAX_MODULE_SHARE_BPS ? MAX_MODULE_SHARE_BPS : uint16(s);
    }

    // ---- the launch window ----
    /// Who is buying, during the window. Only three senders are trusted to name the wallet: the two routers, which
    /// authenticate their caller (msgSender()), and the launcher, which names the launch wallet of its own initial
    /// buy in the hook data. Any other sender, and any unnamed wallet, is refused.
    function _buyer(address router, bytes calldata hookData) internal view returns (address wallet) {
        if (router == LAUNCHER) {
            if (hookData.length != 32) revert CapBuyer();
            wallet = abi.decode(hookData, (address));
        } else if (router == CAP_ROUTER || (CAP_ROUTER_2 != address(0) && router == CAP_ROUTER_2)) {
            wallet = IMsgSender(router).msgSender();
        } else {
            revert CapRouterOnly();
        }
        if (wallet == address(0)) revert CapBuyer();
    }

    function _checkCap(address router, uint256 tokens, bytes calldata hookData) internal view {
        address wallet = _buyer(router, hookData);
        uint256 had = purchased[wallet];
        if (tokens > CAP_TOKENS - had) revert CapExceeded(wallet, had + tokens, CAP_TOKENS);
    }

    function _countCap(address router, uint256 tokens, bytes calldata hookData) internal returns (address wallet) {
        wallet = _buyer(router, hookData);
        uint256 had = purchased[wallet];
        if (tokens > CAP_TOKENS - had) revert CapExceeded(wallet, had + tokens, CAP_TOKENS);
        purchased[wallet] = had + tokens;
    }

    // ================================================================= the fee leaves
    /// Anyone: pay Programmable its platform fee.
    function claimPlatform() external returns (uint256 amount) {
        amount = platformOwed;
        if (amount == 0) return 0;
        platformOwed = 0;
        poolManager.unlock(abi.encode(PLATFORM_RECIPIENT, amount));
        emit PlatformClaimed(PLATFORM_RECIPIENT, amount);
    }

    /// Anyone: send what the harvester is owed (plain ETH; the harvester wraps it when its claim() runs).
    function harvest() external returns (uint256 amount) {
        amount = harvestable;
        if (amount == 0) return 0;
        harvestable = 0;
        totalHarvested += amount;
        poolManager.unlock(abi.encode(HARVESTER, amount));
        emit Harvested(HARVESTER, amount);
    }

    /// The module: take from its own share.
    function takeModuleBudget(address to, uint256 amount) external {
        if (msg.sender != module) revert OnlyModule();
        if (amount > moduleBudget) revert NotEnoughBudget();
        moduleBudget -= amount;
        poolManager.unlock(abi.encode(to, amount));
        emit ModuleBudgetTaken(msg.sender, to, amount);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        poolManager.burn(address(this), QUOTE_ID, amount);
        poolManager.take(Currency.wrap(QUOTE), to, amount);
        return "";
    }

    // ================================================================= the module
    function proposeModule(address mod) external onlyOwner {
        if (mod == address(0)) revert BadModule();
        pendingModule = mod;
        pendingAt = uint64(block.timestamp + MODULE_DELAY);
        emit ModuleProposed(mod, pendingAt);
    }

    function applyModule() external onlyOwner {
        address mod = pendingModule;
        if (mod == address(0)) revert NothingPending();
        if (block.timestamp < pendingAt) revert TooEarly(pendingAt);
        pendingModule = address(0);
        pendingAt = 0;
        _setModule(mod);
    }

    /// Instant: back to the base fee and no events. Removing a module never needs to wait.
    function clearModule() external onlyOwner {
        emit ModuleCleared(module);
        module = address(0);
        modulePhases = 0;
    }

    function _setModule(address mod) internal {
        if (mod.code.length == 0) revert BadModule();
        bytes32 id = IBrownieModule(mod).moduleId();
        uint16 ph = IBrownieModule(mod).phases();
        if (id == bytes32(0)) revert BadModule();
        module = mod;
        modulePhases = ph;
        emit ModuleApplied(mod, id, ph);
    }

    /// The cookbook: a line of text on chain, by the owner or the module (a changed tax, a new function, a reason).
    function note(string calldata text) external {
        if (msg.sender != owner && msg.sender != module) revert OnlyOwner();
        emit Note(msg.sender, text);
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

    // ================================================================= the other phases
    function _phase(uint16 phase, address sender, bytes memory data, bool blocking) internal {
        address mod = module;
        if (mod == address(0) || (modulePhases & phase) == 0) return;
        if (blocking) {
            IBrownieModule(mod).onPhase{gas: MODULE_GAS}(phase, sender, data);
        } else {
            try IBrownieModule(mod).onPhase{gas: MODULE_GAS}(phase, sender, data) {}
            catch {
                emit ModuleFailed(mod, phase);
            }
        }
    }

    function beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata p, bytes calldata) external onlyPoolManager returns (bytes4) {
        if (PoolId.unwrap(key.toId()) != poolId) revert NotOurPool();
        if (sender != LAUNCHER) _phase(Phases.BEFORE_ADD_LIQUIDITY, sender, abi.encode(key, p), true);
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata p, BalanceDelta d, BalanceDelta f, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BalanceDelta)
    {
        if (sender != LAUNCHER) _phase(Phases.AFTER_ADD_LIQUIDITY, sender, abi.encode(key, p, d, f), false);
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata p, bytes calldata) external onlyPoolManager returns (bytes4) {
        _phase(Phases.BEFORE_REMOVE_LIQUIDITY, sender, abi.encode(key, p), true);
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata p, BalanceDelta d, BalanceDelta f, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BalanceDelta)
    {
        _phase(Phases.AFTER_REMOVE_LIQUIDITY, sender, abi.encode(key, p, d, f), false);
        return (IHooks.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function beforeDonate(address sender, PoolKey calldata key, uint256 a0, uint256 a1, bytes calldata) external onlyPoolManager returns (bytes4) {
        _phase(Phases.BEFORE_DONATE, sender, abi.encode(key, a0, a1), true);
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address sender, PoolKey calldata key, uint256 a0, uint256 a1, bytes calldata) external onlyPoolManager returns (bytes4) {
        _phase(Phases.AFTER_DONATE, sender, abi.encode(key, a0, a1), false);
        return IHooks.afterDonate.selector;
    }

    // ================================================================= transient scratch
    function _tstore(uint256 slot, uint256 value) private {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function _tload(uint256 slot) private view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }
}
