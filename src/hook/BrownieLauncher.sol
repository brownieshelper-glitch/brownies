// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/*
  BrownieLauncher: the component of the launch graph that opens the pool, fills it and makes the first buy.

  Programmable's Router deploys the three contracts of the graph in one transaction through its Graph Factory
  (this launcher, the token, the hook; all CREATE2, all addresses known in advance), then runs the initializers:
  the factory calls initializeGraph(token, hook) here, forwarding the ETH of the launch transaction. The order is
  acyclic: the launcher first (its address depends on nothing of the two others), then the token (which mints the
  whole supply to the launcher), then the hook (whose config names the token and the launcher, at an address mined
  to carry every permission bit). This contract then opens the native ETH / coin pool at the start price, puts the
  full supply on the coin side of it, and, when the graph was built with an initial buy, buys exactly
  INITIAL_BUY_TOKENS for BUYER (the launch wallet) with the ETH it received, refunding what the buy did not use.
  The position belongs to this contract, which has no function to remove it: the liquidity can never leave.
  Rounding dust stays here too.

  The hook counts the initial buy against the launch wallet's cap: this contract names BUYER in the hook data, and
  the hook trusts only its launcher for that. The team's buys follow in the same block as a bundle (eth-launch/bundle).
  The same contract serves a direct launch (tests, or a launch without Programmable): whoever is INITIALIZER calls
  initializeGraph() after deploying the token and the hook.
*/
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {BrownieToken} from "./BrownieToken.sol";

contract BrownieLauncher is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    int24 public constant TICK_SPACING = 60;
    uint24 public constant LP_FEE = 0;
    uint256 internal constant SUPPLY = 1_000_000_000 ether; // BrownieToken.SUPPLY

    IPoolManager public immutable poolManager;
    address public immutable INITIALIZER; // Programmable's Graph Factory (or the deployer in a direct launch)
    int24 public immutable INITIAL_TICK; // multiple of 60: the start price (currency1 = coin per ETH)
    address public immutable BUYER; // the launch wallet: receives the initial buy and the refund
    uint256 public immutable INITIAL_BUY_TOKENS; // exact coins of the initial buy; 0 = no initial buy

    address public token;
    address public hook;
    PoolKey internal _key;
    uint256 public dust; // supply that rounding kept out of the position; stays here for ever
    bool public launched;

    event Launched(address indexed token, address indexed hook, bytes32 indexed poolId, int24 initialTick, uint256 liquidity, uint256 dust);
    event InitialBuy(address indexed buyer, uint256 tokens, uint256 ethPaid, uint256 ethRefunded);

    error OnlyInitializer();
    error Once();
    error OnlyPoolManager();
    error BadTick();
    error HookAddressFlags(address hook);
    error NoSupply();
    error NotDeployed(address what);
    error NoBuyer();
    error BuyValue();
    error BuyShape();
    error RefundFailed();

    constructor(address poolManager_, address initializer, int24 initialTick, address buyer, uint256 initialBuyTokens) {
        if (initialTick % TICK_SPACING != 0 || initialTick <= TickMath.minUsableTick(TICK_SPACING) || initialTick >= TickMath.maxUsableTick(TICK_SPACING)) revert BadTick();
        if (initialBuyTokens != 0 && buyer == address(0)) revert NoBuyer();
        if (initialBuyTokens >= SUPPLY) revert BuyValue();
        poolManager = IPoolManager(poolManager_);
        INITIALIZER = initializer;
        INITIAL_TICK = initialTick;
        BUYER = buyer;
        INITIAL_BUY_TOKENS = initialBuyTokens;
    }

    function hasHookFlags(address h) public pure returns (bool) {
        return (uint160(h) & Hooks.ALL_HOOK_MASK) == Hooks.ALL_HOOK_MASK;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    function poolId() external view returns (bytes32) {
        return PoolId.unwrap(_key.toId());
    }

    /// Called once by the initializer after the token and the hook exist. Opens the pool, fills it, makes the
    /// initial buy with the ETH it was sent (all of it is the budget; the rest goes back to BUYER).
    function initializeGraph(address token_, address hook_) external payable {
        if (msg.sender != INITIALIZER) revert OnlyInitializer();
        if (launched) revert Once();
        launched = true;
        if (token_.code.length == 0) revert NotDeployed(token_);
        if (hook_.code.length == 0) revert NotDeployed(hook_);
        if (!hasHookFlags(hook_)) revert HookAddressFlags(hook_);
        if (BrownieToken(token_).balanceOf(address(this)) == 0) revert NoSupply();
        if ((INITIAL_BUY_TOKENS == 0) != (msg.value == 0)) revert BuyValue();
        token = token_;
        hook = hook_;
        // native ETH is always currency0
        _key = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(token_), fee: LP_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(hook_)});

        poolManager.initialize(_key, TickMath.getSqrtPriceAtTick(INITIAL_TICK));
        bytes memory out = poolManager.unlock(abi.encode(msg.value));
        (uint256 liquidity, uint256 paid) = abi.decode(out, (uint256, uint256));
        dust = BrownieToken(token_).balanceOf(address(this));
        if (msg.value != 0) {
            uint256 refund = address(this).balance;
            if (refund != 0) {
                (bool ok,) = BUYER.call{value: refund}("");
                if (!ok) revert RefundFailed();
            }
            emit InitialBuy(BUYER, INITIAL_BUY_TOKENS, paid, refund);
        }
        emit Launched(token_, hook_, PoolId.unwrap(_key.toId()), INITIAL_TICK, liquidity, dust);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        uint256 value = abi.decode(data, (uint256));
        uint256 supply = BrownieToken(token).balanceOf(address(this));
        // the coin is currency1: its liquidity sits below the price, from the bottom of the range up to the start tick
        int24 tickLower = TickMath.minUsableTick(TICK_SPACING);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(INITIAL_TICK), supply);
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            _key, ModifyLiquidityParams({tickLower: tickLower, tickUpper: INITIAL_TICK, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)}), ""
        );
        // the ETH side must be zero (the price sits exactly at the range's edge); pay the coins the position needs
        require(d.amount0() == 0 && d.amount1() < 0, "launch: position shape");
        uint256 pay = uint256(uint128(-d.amount1()));
        poolManager.sync(_key.currency1);
        BrownieToken(token).transfer(address(poolManager), pay);
        poolManager.settle();

        uint256 paid;
        if (value != 0) {
            // the initial buy: exactly INITIAL_BUY_TOKENS for BUYER; the hook names BUYER from the hook data and
            // counts the buy against its launch cap, and takes its fee on the ETH leg
            BalanceDelta s = poolManager.swap(
                _key, SwapParams({zeroForOne: true, amountSpecified: int256(INITIAL_BUY_TOKENS), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}), abi.encode(BUYER)
            );
            if (s.amount0() >= 0 || s.amount1() <= 0 || uint256(uint128(s.amount1())) != INITIAL_BUY_TOKENS) revert BuyShape();
            paid = uint256(uint128(-s.amount0()));
            if (paid > value) revert BuyValue();
            poolManager.settle{value: paid}();
            poolManager.take(_key.currency1, BUYER, INITIAL_BUY_TOKENS);
        }
        return abi.encode(uint256(liquidity), paid);
    }
}
