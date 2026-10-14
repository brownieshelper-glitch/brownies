// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/*
  BrownieHook: the coin's Uniswap v4 hook. An immutable shell around a replaceable module.

  WHAT NEVER CHANGES (this contract, no proxy, no setters):
    - the pool it serves (one native ETH / BROWNIE pool, bound at initialization by the launcher),
    - the fee is taken in ETH on buys and on sells: Programmable's platform leg of PLATFORM_BPS (0.30%) to
      PLATFORM_RECIPIENT, plus the project's leg that never passes MAX_BUY_BPS / MAX_SELL_BPS (3% = 3.3% in all),
      the launch tax below being the one exception, and only for its blocks,
    - the launch tax: for the first LAUNCH_BLOCKS blocks, counting the block the pool opens in, the project's leg is
      LAUNCH_BUY_BPS / LAUNCH_SELL_BPS instead. Both are fixed at deployment (at most 30%, at most 50 blocks, none if
      LAUNCH_BLOCKS is 0). The module is not asked and has no share of it. The base part of it (BASE_BUY_BPS /
      BASE_SELL_BPS) goes to the harvester as always; the part above the base goes to LAUNCH_TAX_WALLET, a plain
      address fixed at deployment (claimLaunchTax() by anyone sends it), or to the harvester too when that address is
      zero. One wallet may be exempt, LAUNCH_TAX_FREE_BUYER (the launch wallet): its BUYS pay the base fee instead,
      and only while the wallet cap below runs, so it can never buy more than the cap free of the launch tax; its
      sells pay the launch tax like everyone's. From the block after the last one the ceilings above hold for ever:
      no function can bring the launch tax back, extend it, or move its wallet,
    - at least (10000 - MAX_MODULE_SHARE_BPS) of the project's leg goes to the harvester (the contract that pays the
      main wallet and buys SUGAR for the stakers); anyone may call harvest() to send it, and claimPlatform() to pay
      Programmable,
    - the launch window: for CAP_SECONDS after the pool opens, one wallet may buy at most CAP_BPS of the supply,
      and only through CAP_ROUTER (the Universal Router), whose msgSender() names the wallet,
    - a module change waits MODULE_DELAY seconds between proposeModule() and applyModule() (zero for BROWNIE, the
      owner's choice: a new module can be applied at once); the proposal names the
      module's code (its hash: what is read during the wait is what is applied) and lapses PROPOSAL_LIFE after it
      could be applied (the wait reads code: a module that is a proxy, or a wallet that delegates, could change
      behind the same code after it, so a delegating wallet is refused and a proxy must never be proposed);
      clearing the module is instant (that only removes freedom, it never adds any). When a module
      goes, by clearing or by a replacement, what it was owed and did not take goes to the harvester: nothing is
      stranded, and the next module inherits nothing,
    - a module that reverts or runs out of its gas budget inside a swap does not block the swap: the base fee applies.
      Nor can it block one quietly: what it does after a swap runs inside a call that is undone whole if it left
      the pool manager's books changed (an unsettled amount of its own, the swapper's or ours, a currency left
      synced, or the reserve a sync took). Its revert is never copied. If it fails, the share of this swap it was
      given goes to the harvester instead: the module never has money it did not hear about. And it always gets its
      whole gas budget: a swap whose router left too little gas for it fails.
      The check reads this pool's two currencies; a plain ETH / coin trade is wholly inside it, so a module cannot
      make one fail. Trades routed through other pools in the same unlock are not all covered; reaching them needs
      a hostile module, and only the owner installs modules,
    - nobody but the launcher and the owner adds liquidity to the pool: a coin sold by resting it in the pool would pay
      no fee. The owner adds through LIQUIDITY_ROUTER (Uniswap's PositionManager, fixed at deployment), which names
      the wallet behind it (msgSender()), and only once the launch window is over (the launch tax and the wallet
      cap): inside it, coins rested in the pool would be sold to launch buyers free of the launch sell tax. What the
      owner adds is the owner's own position, taken out the same way.

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
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IBrownieModule, Phases} from "./IBrownieModule.sol";

interface IMsgSender {
    function msgSender() external view returns (address);
}

contract BrownieHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using TransientStateLibrary for IPoolManager;

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
        uint16 launchBuyBps; // THE LAUNCH TAX: the project's fee on buys while the launch window is open (0 with launchBlocks 0 = none)
        uint16 launchSellBps; // the same on sells
        uint32 launchBlocks; // how many blocks the launch tax lasts, counting the block the pool opens in
        address launchTaxWallet; // where the part of the launch tax above the base fee goes (zero: to the harvester like the rest)
        address launchTaxFreeBuyer; // the one wallet whose buys pay the base fee during the launch tax (the launch wallet; zero: nobody)
        address liquidityRouter; // Uniswap's PositionManager: the owner's door to add liquidity (its msgSender() names the wallet), or zero
    }

    uint256 internal constant BPS = 10_000;
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint256 internal constant MAX_FEE_BPS = 2_000; // 20%: nothing above this can even be configured
    uint256 internal constant MAX_LAUNCH_FEE_BPS = 3_000; // 30%: the most a launch tax can ever be
    uint256 internal constant MAX_LAUNCH_BLOCKS = 50; // about ten minutes: the longest a launch tax can ever last

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
    address public immutable LIQUIDITY_ROUTER;
    uint32 public immutable MODULE_DELAY;
    uint32 public immutable MODULE_GAS;
    uint16 public immutable LAUNCH_BUY_BPS;
    uint16 public immutable LAUNCH_SELL_BPS;
    uint32 public immutable LAUNCH_BLOCKS;
    address public immutable LAUNCH_TAX_WALLET;
    address public immutable LAUNCH_TAX_FREE_BUYER;

    // ---- the pool ----
    PoolKey internal _key;
    bytes32 public poolId;
    uint64 public openedAt; // 0 until the launcher opens the pool
    uint64 public openedBlock; // the block the pool opened in: the launch tax counts from here
    mapping(address wallet => uint256 bought) public purchased; // during the launch window

    // ---- the fee ----
    uint256 public harvestable; // ETH claims held here for the harvester
    uint256 public moduleBudget; // ETH claims held here for the module
    uint256 public platformOwed; // ETH claims held here for Programmable
    uint256 public launchTaxOwed; // ETH claims held here for the launch tax wallet
    uint256 public totalLaunchTax;
    uint256 public totalFees; // project + platform
    uint256 public totalPlatform;
    uint256 public totalHarvested;

    // ---- the module ----
    address public module;
    uint16 public modulePhases;
    address public pendingModule;
    uint64 public pendingAt;
    bytes32 public pendingCodeHash; // the code proposed: applyModule applies that code or nothing
    uint64 public moduleEpoch; // one more each time a module is applied or cleared: a module told apart from its own past
    uint64 public constant PROPOSAL_LIFE = 7 days; // a proposal not applied within this long after its time lapses
    address public owner;
    address public pendingOwner;

    // transient scratch between beforeSwap and afterSwap (one swap at a time per unlock)
    uint256 private constant TS_FEE = 0x01;
    uint256 private constant TS_EXPECT = 0x02;
    uint256 private constant TS_BPS = 0x03;
    uint256 private constant TS_SHARE = 0x04;
    uint256 private constant TS_EXTRA = 0x05; // the bps of this swap's fee that go to the launch tax wallet (0 outside the launch tax)

    event PoolOpened(bytes32 indexed poolId, uint160 sqrtPriceX96, uint64 openedAt);
    event Swap(bytes32 indexed poolId, address indexed router, address wallet, bool buy, bool exactInput, uint256 quoteGross, uint256 projectFee, uint256 platformFee, uint16 bps, uint16 shareBps);
    event Harvested(address indexed to, uint256 amount);
    event PlatformClaimed(address indexed to, uint256 amount);
    event LaunchTax(bytes32 indexed poolId, bool buy, uint256 amount);
    event LaunchTaxClaimed(address indexed to, uint256 amount);
    event ModuleBudgetTaken(address indexed module, address indexed to, uint256 amount);
    event ModuleProposed(address indexed module, uint64 appliesAt);
    event ModuleApplied(address indexed module, bytes32 moduleId, uint16 phases);
    event ModuleCleared(address indexed module);
    event ModuleFailed(address indexed module, uint16 phase);
    event ModuleShareReturned(address indexed module, uint256 amount);
    event ModuleBudgetSwept(address indexed module, uint256 amount);
    event Note(address indexed by, string text);
    event OwnershipProposed(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error OnlyPoolManager();
    error OnlyOwner();
    error OnlyModule();
    error OnlyLauncher();
    error OnlySelf();
    error NotEnoughGas();
    error ModuleTouchedThePool();
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
    error ProposalExpired();
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
        // the launch tax: bounded in size and in time, both or neither, and never below the base fee
        if (
            c.launchBuyBps > MAX_LAUNCH_FEE_BPS || c.launchSellBps > MAX_LAUNCH_FEE_BPS || c.launchBlocks > MAX_LAUNCH_BLOCKS
                || (c.launchBlocks == 0 && (c.launchBuyBps != 0 || c.launchSellBps != 0))
                || (c.launchBlocks != 0 && (c.launchBuyBps < c.baseBuyBps || c.launchSellBps < c.baseSellBps))
                || (c.launchBlocks == 0 && (c.launchTaxWallet != address(0) || c.launchTaxFreeBuyer != address(0)))
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
        LIQUIDITY_ROUTER = c.liquidityRouter;
        MODULE_DELAY = c.moduleDelay;
        MODULE_GAS = c.moduleGas;
        LAUNCH_BUY_BPS = c.launchBuyBps;
        LAUNCH_SELL_BPS = c.launchSellBps;
        LAUNCH_BLOCKS = c.launchBlocks;
        LAUNCH_TAX_WALLET = c.launchTaxWallet;
        LAUNCH_TAX_FREE_BUYER = c.launchTaxFreeBuyer;
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
        openedBlock = uint64(block.number);
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

    /// The first block in which the launch tax no longer applies. With LAUNCH_BLOCKS 13 and the pool opened in block N,
    /// blocks N to N+12 pay the launch tax and block N+13 pays the normal fee.
    function launchTaxEndBlock() public view returns (uint256) {
        return openedAt == 0 ? type(uint256).max : uint256(openedBlock) + LAUNCH_BLOCKS;
    }

    function launchTaxActive() public view returns (bool) {
        return LAUNCH_BLOCKS != 0 && block.number < launchTaxEndBlock();
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

        (uint16 bps, uint16 share, uint16 extra) = _ask(sender, buy, exactIn, specified, hookData);
        _tstore(TS_BPS, bps);
        _tstore(TS_SHARE, share);
        _tstore(TS_EXTRA, extra);

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
        uint256 m; // the module's share of this swap
        if (fee != 0) {
            // the fee becomes a claim held here; the delta the pool manager owes us for it is settled by our return
            // value (coin named) or by the delta we returned before the swap (ETH named)
            poolManager.mint(address(this), QUOTE_ID, fee);
            platformFee = gross * PLATFORM_BPS / BPS;
            if (platformFee > fee) platformFee = fee;
            uint256 project = fee - platformFee;
            uint256 extra = _tload(TS_EXTRA);
            if (extra != 0) {
                // the launch tax: the part above the base fee is the launch tax wallet's, the base part goes on as always
                uint256 x = project * extra / bps;
                launchTaxOwed += x;
                totalLaunchTax += x;
                project -= x;
                emit LaunchTax(poolId, buy, x);
            }
            m = project * share / BPS;
            moduleBudget += m;
            harvestable += project - m;
            platformOwed += platformFee;
            totalFees += fee;
            totalPlatform += platformFee;
        }
        emit Swap(poolId, sender, wallet, buy, exactIn, gross, fee - platformFee, platformFee, bps, share);

        address mod = module;
        if (mod != address(0) && (modulePhases & Phases.AFTER_SWAP) != 0) {
            // the module gets its whole budget whatever gas the swapper's router gave this swap
            if (gasleft() < _moduleGasFloor()) revert NotEnoughGas();
            try this.moduleAfterSwap(mod, sender, key.currency0, key.currency1, IBrownieModule.SwapView(poolId, sender, buy, exactIn, exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified)), qd, td, fee) {}
            catch {
                emit ModuleFailed(mod, Phases.AFTER_SWAP);
                // the module did not hear this swap: its share of it is the harvester's
                if (m != 0) {
                    moduleBudget -= m;
                    harvestable += m;
                    emit ModuleShareReturned(mod, m);
                }
            }
        }
        return (IHooks.afterSwap.selector, ret);
    }

    /// The module hears the swap inside a call of our own. A module cannot be stopped from calling the pool manager,
    /// but everything it did there is undone with this call if it left the books other than it found them: one more
    /// or one fewer unsettled amount, a currency left synced, or a wei moved in what the swapper or this hook owes.
    /// Any of those would make the swapper's router fail at the end of the trade.
    function moduleAfterSwap(address mod, address sender, Currency c0, Currency c1, IBrownieModule.SwapView calldata v, int128 qd, int128 td, uint256 fee) external {
        if (msg.sender != address(this)) revert OnlySelf();
        bytes32 before = _books(sender, c0, c1);
        bytes memory call_ = abi.encodeCall(IBrownieModule.onAfterSwap, (v, qd, td, fee));
        uint256 budget = MODULE_GAS;
        address callee = mod; // (mod is a word of assembly)
        bool ok;
        // nothing of what the module answers is copied: a revert of any size costs this hook nothing
        assembly ("memory-safe") {
            ok := call(budget, callee, 0, add(call_, 0x20), mload(call_), 0, 0)
        }
        if (!ok) revert BadModule();
        if (_books(sender, c0, c1) != before) revert ModuleTouchedThePool();
    }

    function _books(address sender, Currency c0, Currency c1) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                poolManager.getNonzeroDeltaCount(),
                poolManager.getSyncedCurrency(),
                poolManager.getSyncedReserves(),
                poolManager.currencyDelta(sender, c0),
                poolManager.currencyDelta(sender, c1),
                poolManager.currencyDelta(address(this), c0),
                poolManager.currencyDelta(address(this), c1)
            )
        );
    }

    /// The gas that must be left before the module is called, so that it gets MODULE_GAS in full.
    function _moduleGasFloor() internal view returns (uint256) {
        return uint256(MODULE_GAS) + MODULE_GAS / 16 + 60_000;
    }

    /// The fee of this swap: the launch tax while it runs, then the module's word, bounded. Never reverts. `extra` is the
    /// part of `bps` that goes to the launch tax wallet (0 outside the launch tax, or when there is no such wallet).
    function _ask(address sender, bool buy, bool exactIn, uint256 specified, bytes calldata hookData) internal view returns (uint16 bps, uint16 share, uint16 extra) {
        // the launch tax: a fixed fee for the first blocks, written into this contract; the module is not asked and
        // keeps no share of it; after the window the ceilings below are the only limit, for ever
        if (launchTaxActive()) {
            uint16 base = buy ? BASE_BUY_BPS : BASE_SELL_BPS;
            if (buy && _launchTaxFree(sender, hookData)) return (base, 0, 0);
            bps = buy ? LAUNCH_BUY_BPS : LAUNCH_SELL_BPS;
            return (bps, 0, LAUNCH_TAX_WALLET == address(0) ? 0 : bps - base);
        }
        bps = buy ? BASE_BUY_BPS : BASE_SELL_BPS;
        address mod = module;
        if (mod == address(0)) return (bps, 0, 0);
        // A bounded low-level call, decoded by hand: a revert, out-of-gas, an empty, short, long or malformed answer,
        // a word that is not a uint16, all mean "the base fee" and the swap goes on. A typed try/catch would not do:
        // the ABI decoding of a bad answer happens in this contract and would revert the trade.
        if (gasleft() < _moduleGasFloor()) revert NotEnoughGas();
        bytes memory ask = abi.encodeCall(IBrownieModule.feeFor, (IBrownieModule.SwapView(poolId, sender, buy, exactIn, specified)));
        uint256 budget = MODULE_GAS;
        address asked = mod; // "mod" is a word of the assembly language
        bool ok;
        uint256 b;
        uint256 s;
        // two words are read of whatever the module answers, into scratch space: a huge answer costs the swapper nothing
        assembly ("memory-safe") {
            ok := staticcall(budget, asked, add(ask, 0x20), mload(ask), 0x00, 0x40)
            if iszero(eq(returndatasize(), 0x40)) { ok := 0 }
            b := mload(0x00)
            s := mload(0x20)
        }
        if (!ok) return (bps, 0, 0);
        if (b > type(uint16).max || s > type(uint16).max) return (bps, 0, 0);
        uint16 cap = buy ? MAX_BUY_BPS : MAX_SELL_BPS;
        bps = b > cap ? cap : uint16(b);
        share = s > MAX_MODULE_SHARE_BPS ? MAX_MODULE_SHARE_BPS : uint16(s);
    }

    /// Whether this buy is the exempt wallet's. Only while the wallet cap runs (so what it buys free of the launch tax is
    /// counted against the cap like any buy), and only when a sender the cap already trusts names the wallet: the launcher
    /// (its own first buy, the wallet in the hook data) or one of the two routers (msgSender()). Never reverts: a router
    /// that does not answer simply means "not exempt".
    function _launchTaxFree(address router, bytes calldata hookData) internal view returns (bool) {
        address free = LAUNCH_TAX_FREE_BUYER;
        if (free == address(0) || block.timestamp >= capEndsAt()) return false;
        if (router == LAUNCHER) return hookData.length == 32 && abi.decode(hookData, (uint256)) == uint256(uint160(free));
        if (router == CAP_ROUTER || (CAP_ROUTER_2 != address(0) && router == CAP_ROUTER_2)) {
            (bool ok, bytes memory ret) = router.staticcall{gas: 30_000}(abi.encodeCall(IMsgSender.msgSender, ()));
            return ok && ret.length == 32 && abi.decode(ret, (uint256)) == uint256(uint160(free));
        }
        return false;
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

    /// Anyone: send the launch tax wallet what it is owed (plain ETH).
    function claimLaunchTax() external returns (uint256 amount) {
        amount = launchTaxOwed;
        if (amount == 0) return 0;
        launchTaxOwed = 0;
        poolManager.unlock(abi.encode(LAUNCH_TAX_WALLET, amount));
        emit LaunchTaxClaimed(LAUNCH_TAX_WALLET, amount);
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
        // a module that is there to be read: the wait is for reading it
        if (mod == address(0) || mod.code.length == 0) revert BadModule();
        // a wallet that delegates (EIP-7702) can point at other code whenever it likes: it is never a module
        if (mod.code.length == 23 && bytes3(mod.code) == 0xef0100) revert BadModule();
        pendingModule = mod;
        pendingCodeHash = mod.codehash;
        pendingAt = uint64(block.timestamp + MODULE_DELAY);
        emit ModuleProposed(mod, pendingAt);
    }

    function applyModule() external onlyOwner {
        address mod = pendingModule;
        if (mod == address(0)) revert NothingPending();
        if (block.timestamp < pendingAt) revert TooEarly(pendingAt);
        if (block.timestamp > uint256(pendingAt) + PROPOSAL_LIFE) revert ProposalExpired();
        if (mod.codehash != pendingCodeHash) revert BadModule(); // not the code that was proposed
        pendingModule = address(0);
        pendingAt = 0;
        pendingCodeHash = bytes32(0);
        _sweepModuleBudget();
        _setModule(mod);
    }

    /// Instant: back to the base fee and no events. Removing a module never needs to wait.
    function clearModule() external onlyOwner {
        emit ModuleCleared(module);
        _sweepModuleBudget();
        module = address(0);
        modulePhases = 0;
        moduleEpoch++;
    }

    /// What the outgoing module was owed and did not take goes to the harvester. (A module pays its own out first,
    /// before it is removed.)
    function _sweepModuleBudget() internal {
        uint256 b = moduleBudget;
        if (b == 0) return;
        moduleBudget = 0;
        harvestable += b;
        emit ModuleBudgetSwept(module, b);
    }

    function _setModule(address mod) internal {
        if (mod.code.length == 0) revert BadModule();
        bytes32 id = IBrownieModule(mod).moduleId();
        uint16 ph = IBrownieModule(mod).phases();
        if (id == bytes32(0)) revert BadModule();
        module = mod;
        modulePhases = ph;
        moduleEpoch++;
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

    function beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata) external view onlyPoolManager returns (bytes4) {
        if (PoolId.unwrap(key.toId()) != poolId) revert NotOurPool();
        // the launcher's position and the owner's own are the pool's only liquidity: a coin rested in the pool by anyone
        // else would be sold to the next buyer with no sell fee, no launch tax and none of the module's rules
        if (sender != LAUNCHER) {
            // the owner's door: through the liquidity router, named by it, and only after the launch window
            bool windowOver = !launchTaxActive() && block.timestamp >= capEndsAt();
            if (!(windowOver && sender == LIQUIDITY_ROUTER && sender != address(0) && _callerOf(sender) == owner)) revert OnlyLauncher();
        }
        return IHooks.beforeAddLiquidity.selector;
    }

    /// The wallet a router says it acts for (msgSender()), read with a bounded call; zero when it does not answer.
    function _callerOf(address router) internal view returns (address w) {
        (bool ok, bytes memory ret) = router.staticcall{gas: 30_000}(abi.encodeCall(IMsgSender.msgSender, ()));
        if (!ok || ret.length != 32) return address(0);
        uint256 v = abi.decode(ret, (uint256));
        if (v <= type(uint160).max) w = address(uint160(v));
    }

    /// Only the launcher and the owner add liquidity, so the module is not told: nothing in it may stand in the way.
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4, BalanceDelta)
    {
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
