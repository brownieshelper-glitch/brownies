// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BrownieHook} from "../src/hook/BrownieHook.sol";
import {BrownieLauncher} from "../src/hook/BrownieLauncher.sol";
import {BrownieToken} from "../src/hook/BrownieToken.sol";
import {IBrownieModule, Phases} from "../src/hook/IBrownieModule.sol";
import {FixedFeeModule} from "../src/hook/modules/FixedFeeModule.sol";
import {ViralityModule} from "../src/hook/modules/ViralityModule.sol";

/// A stand-in for the Universal Router: swaps for a caller, names it through msgSender() during the swap, pays
/// native ETH from the value it was sent and refunds what the swap did not use.
contract TestRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager immutable m;
    address public msgSender;

    constructor(IPoolManager m_) {
        m = m_;
    }

    receive() external payable {}

    function swap(PoolKey calldata key, SwapParams calldata p) external payable returns (BalanceDelta d) {
        msgSender = msg.sender;
        d = abi.decode(m.unlock(abi.encode(msg.sender, key, p)), (BalanceDelta));
        msgSender = address(0);
        uint256 left = address(this).balance;
        if (left > 0) payable(msg.sender).transfer(left);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (address user, PoolKey memory key, SwapParams memory p) = abi.decode(data, (address, PoolKey, SwapParams));
        BalanceDelta d = m.swap(key, p, "");
        // currency0 is native ETH: settled from this contract's balance; currency1 is the coin: from the user
        if (d.amount0() < 0) key.currency0.settle(m, address(this), uint256(uint128(-d.amount0())), false);
        else if (d.amount0() > 0) key.currency0.take(m, user, uint256(uint128(d.amount0())), false);
        if (d.amount1() < 0) key.currency1.settle(m, user, uint256(uint128(-d.amount1())), false);
        else if (d.amount1() > 0) key.currency1.take(m, user, uint256(uint128(d.amount1())), false);
        return abi.encode(d);
    }
}

/// Modules for the walls: one that asks too much, one that reverts, one that burns all its gas, one with a share.
contract GreedyModule is IBrownieModule {
    function moduleId() external pure returns (bytes32) { return keccak256("test.greedy"); }
    function phases() external pure returns (uint16) { return 0; }
    function feeFor(SwapView calldata) external pure returns (uint16, uint16) { return (5000, 9000); }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}
    function onPhase(uint16, address, bytes calldata) external pure {}
}

contract RevertingModule is IBrownieModule {
    function moduleId() external pure returns (bytes32) { return keccak256("test.reverting"); }
    function phases() external pure returns (uint16) { return Phases.AFTER_SWAP; }
    function feeFor(SwapView calldata) external pure returns (uint16, uint16) { revert("no"); }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure { revert("no"); }
    function onPhase(uint16, address, bytes calldata) external pure { revert("no"); }
}

contract GasBurnerModule is IBrownieModule {
    function moduleId() external pure returns (bytes32) { return keccak256("test.gas"); }
    function phases() external pure returns (uint16) { return 0; }
    function feeFor(SwapView calldata) external view returns (uint16, uint16) {
        uint256 x;
        while (true) { x += gasleft(); }
        return (uint16(x), 0);
    }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}
    function onPhase(uint16, address, bytes calldata) external pure {}
}

/// Modules that answer feeFor() with garbage instead of reverting: nothing, one word, two words that are not uint16s,
/// three words. A typed call would fail to decode these inside the hook; the hook must treat them as "base fee".
contract EmptyReturnModule is IBrownieModule {
    function moduleId() external pure returns (bytes32) { return keccak256("test.empty"); }
    function phases() external pure returns (uint16) { return Phases.AFTER_SWAP; }
    function feeFor(SwapView calldata) external pure returns (uint16, uint16) { assembly { return(0, 0) } }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}
    function onPhase(uint16, address, bytes calldata) external pure {}
}

contract ShortReturnModule is IBrownieModule {
    function moduleId() external pure returns (bytes32) { return keccak256("test.short"); }
    function phases() external pure returns (uint16) { return 0; }
    function feeFor(SwapView calldata) external pure returns (uint16, uint16) { assembly { mstore(0, 100) return(0, 32) } }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}
    function onPhase(uint16, address, bytes calldata) external pure {}
}

contract HugeWordModule is IBrownieModule {
    function moduleId() external pure returns (bytes32) { return keccak256("test.huge"); }
    function phases() external pure returns (uint16) { return 0; }
    function feeFor(SwapView calldata) external pure returns (uint16, uint16) { assembly { mstore(0, 100) mstore(32, not(0)) return(0, 64) } }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}
    function onPhase(uint16, address, bytes calldata) external pure {}
}

contract LongReturnModule is IBrownieModule {
    function moduleId() external pure returns (bytes32) { return keccak256("test.long"); }
    function phases() external pure returns (uint16) { return 0; }
    function feeFor(SwapView calldata) external pure returns (uint16, uint16) { assembly { mstore(0, 300) mstore(32, 0) mstore(64, 7) return(0, 96) } }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external pure {}
    function onPhase(uint16, address, bytes calldata) external pure {}
}

contract SharingModule is IBrownieModule {
    BrownieHook public hook;
    uint256 public afterSwaps;
    function setHook(BrownieHook h) external { hook = h; }
    function moduleId() external pure returns (bytes32) { return keccak256("test.sharing"); }
    function phases() external pure returns (uint16) { return Phases.AFTER_SWAP; }
    function feeFor(SwapView calldata) external pure returns (uint16, uint16) { return (300, 5000); }
    function onAfterSwap(SwapView calldata, int128, int128, uint256) external { afterSwaps++; }
    function onPhase(uint16, address, bytes calldata) external pure {}
    function take(address to, uint256 amount) external { hook.takeModuleBudget(to, amount); }
}

contract HookTest is Test, Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 constant SUPPLY = 1_000_000_000 ether;
    uint256 constant BPS = 10_000;
    uint16 constant PLATFORM = 30;
    address constant HARVESTER = address(0xA11CE);
    address constant PROGRAMMABLE = address(0xD88539d3c4C460136a733A3Fd60cf6BF269079da);
    address constant OWNER = address(0xB0B);
    address constant SIGNER = address(0x51);
    address alice = address(0xA1);
    address bob = address(0xB2);
    int24 constant START_TICK = 200220; // the coin is currency1 (coins per ETH): about 5,000 USD for the supply

    TestRouter router;
    TestRouter router2; // Programmable's trading router stands in: a second trusted router for the window
    BrownieLauncher launcher;
    BrownieHook hook;
    BrownieToken token;
    FixedFeeModule fixedModule;

    function setUp() public {
        deployFreshManagerAndRouters();
        router = new TestRouter(manager);
        router2 = new TestRouter(manager);
        fixedModule = new FixedFeeModule(200, 200);
        _launch(address(fixedModule));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        _approve(alice);
        _approve(bob);
    }

    function _config(address firstModule, address token_, address launcher_) internal view returns (BrownieHook.Config memory c) {
        c.poolManager = address(manager);
        c.token = token_;
        c.quote = address(0);
        c.harvester = HARVESTER;
        c.platformRecipient = PROGRAMMABLE;
        c.platformBps = PLATFORM;
        c.launcher = launcher_;
        c.owner = OWNER;
        c.firstModule = firstModule;
        c.baseBuyBps = 200;
        c.baseSellBps = 200;
        c.maxBuyBps = 300;
        c.maxSellBps = 300;
        c.maxModuleShareBps = 5000;
        c.capBps = 200;
        c.capSeconds = 180;
        c.capRouter = address(router);
        c.capRouter2 = address(router2);
        c.moduleDelay = 1 days;
        c.moduleGas = 150_000;
    }

    /// The graph as Programmable's factory runs it, in its acyclic order: the launcher (depends on nothing), the
    /// token (mints to the launcher), the hook (names the token and the launcher, address mined for the flags),
    /// then the launcher's initializer. Here the test contract plays the factory.
    function _launch(address firstModule) internal {
        _launchGraph(firstModule, "g1", address(0), 0, 0);
    }

    /// With `initialBuyTokens` > 0 the launcher buys that many coins for `buyer` with `value` ETH inside the launch.
    function _launchGraph(address firstModule, string memory seed, address buyer, uint256 initialBuyTokens, uint256 value) internal {
        _deployGraph(firstModule, seed, buyer, initialBuyTokens);
        launcher.initializeGraph{value: value}(address(token), address(hook));
        key = launcher.poolKey();
    }

    /// The three contracts without the initializer call (so a test can expect the initializer to revert).
    function _deployGraph(address firstModule, string memory seed, address buyer, uint256 initialBuyTokens) internal {
        launcher = new BrownieLauncher{salt: keccak256(abi.encodePacked(seed, "launcher"))}(address(manager), address(this), START_TICK, buyer, initialBuyTokens);
        token = new BrownieToken{salt: keccak256(abi.encodePacked(seed, "token"))}("Brownies", "BROWNIE", address(launcher), "Four AI helpers that work for the coin.", "https://feedthebrownies.com", "https://feedthebrownies.com/assets/logo-1024.png", bytes(""));
        BrownieHook.Config memory c = _config(firstModule, address(token), address(launcher));
        bytes32 initHash = keccak256(abi.encodePacked(type(BrownieHook).creationCode, abi.encode(c)));
        bytes32 hookSalt;
        for (uint256 i = 0; i < 400_000; i++) {
            hookSalt = bytes32(i);
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), hookSalt, initHash)))));
            if ((uint160(a) & Hooks.ALL_HOOK_MASK) == Hooks.ALL_HOOK_MASK) break;
        }
        hook = new BrownieHook{salt: hookSalt}(c);
        assertTrue(launcher.hasHookFlags(address(hook)), "mined");
    }

    function _approve(address who) internal {
        vm.startPrank(who);
        token.approve(address(router), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    // a buy gives ETH (currency0) for the coin (currency1): zeroForOne
    function _swap(address who, bool buy, int256 amountSpecified, uint256 value) internal returns (BalanceDelta d) {
        SwapParams memory p = SwapParams({zeroForOne: buy, amountSpecified: amountSpecified, sqrtPriceLimitX96: buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1});
        vm.prank(who);
        d = router.swap{value: value}(key, p);
    }

    function _swapPlain(address who, bool buy, int256 amountSpecified, uint256 value) internal returns (BalanceDelta d) {
        SwapParams memory p = SwapParams({zeroForOne: buy, amountSpecified: amountSpecified, sqrtPriceLimitX96: buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1});
        vm.prank(who);
        d = swapRouter.swap{value: value}(key, p, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");
    }

    function _eth(BalanceDelta d) internal pure returns (int128) {
        return d.amount0();
    }

    function _coin(BalanceDelta d) internal pure returns (int128) {
        return d.amount1();
    }

    function _afterWindow() internal {
        vm.warp(block.timestamp + 181);
    }

    function _feeTotal() internal view returns (uint256) {
        return hook.harvestable() + hook.moduleBudget() + hook.platformOwed();
    }

    // ------------------------------------------------------------------ the launch
    function test_launch_shape() public view {
        assertTrue(launcher.hasHookFlags(address(hook)), "hook address carries every permission bit");
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(hook.openedAt(), uint64(block.timestamp));
        assertEq(hook.poolId(), launcher.poolId());
        (, int24 tick,,) = manager.getSlot0(key.toId());
        assertEq(tick, START_TICK, "pool opens at the start tick");
        assertEq(Currency.unwrap(key.currency0), address(0), "native ETH is currency0");
        assertGt(token.balanceOf(address(manager)), SUPPLY - 1e18, "supply in the pool");
        assertEq(token.balanceOf(address(launcher)), launcher.dust());
        assertLt(launcher.dust(), 1e18);
        assertEq(address(manager).balance, 0, "the ETH side starts empty");
        assertEq(hook.module(), address(fixedModule));
        assertEq(hook.owner(), OWNER);
        (string memory desc, string memory site, string memory image,) = token.metadata();
        assertEq(site, "https://feedthebrownies.com");
        assertGt(bytes(desc).length, 0);
        assertGt(bytes(image).length, 0);
    }

    function test_launch_once_and_only_initializer() public {
        vm.expectRevert(BrownieLauncher.Once.selector);
        launcher.initializeGraph(address(token), address(hook));
        BrownieLauncher other = new BrownieLauncher(address(manager), address(0xDEAD), START_TICK, address(0), 0);
        vm.expectRevert(BrownieLauncher.OnlyInitializer.selector);
        other.initializeGraph(address(token), address(hook));
    }

    function test_second_pool_refused() public {
        PoolKey memory other = PoolKey({currency0: key.currency0, currency1: key.currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
        vm.expectRevert();
        manager.initialize(other, TickMath.getSqrtPriceAtTick(0));
    }

    // ------------------------------------------------------------------ the four swap shapes
    function test_buy_exact_in_takes_the_fee_before() public {
        _afterWindow();
        uint256 before = alice.balance;
        BalanceDelta d = _swap(alice, true, -1 ether, 1 ether);
        assertEq(_eth(d), -1 ether, "the buyer pays exactly what it named");
        assertEq(before - alice.balance, 1 ether, "and nothing more");
        assertGt(_coin(d), 0);
        assertEq(_feeTotal(), 0.023 ether, "2% project + 0.3% platform of the named ETH");
        assertEq(hook.platformOwed(), 0.003 ether);
        assertEq(hook.harvestable(), 0.02 ether);
        assertEq(manager.balanceOf(address(hook), 0), 0.023 ether, "held as a claim on native ETH");
        assertEq(address(manager).balance, 1 ether);
    }

    function test_buy_exact_out_fee_on_top() public {
        _afterWindow();
        uint256 want = 10_000_000 ether;
        uint256 before = alice.balance;
        BalanceDelta d = _swap(alice, true, int256(want), 1 ether);
        assertEq(_coin(d), int128(int256(want)), "exactly the coins named");
        uint256 paid = uint256(uint128(-_eth(d)));
        assertEq(before - alice.balance, paid, "the router refunded the rest");
        uint256 fee = _feeTotal();
        uint256 net = paid - fee;
        assertEq(fee, net * 230 / 9770, "fee = net * bps / (10000 - bps)");
        assertApproxEqRel(fee * BPS, paid * 230, 1e12, "which is 2.3% of what was paid");
        assertEq(hook.platformOwed(), paid * 30 / BPS, "platform leg on the gross");
    }

    function test_sell_exact_in_fee_from_output() public {
        _afterWindow();
        _swap(alice, true, -1 ether, 1 ether);
        uint256 before = _feeTotal();
        uint256 coins = token.balanceOf(alice);
        uint256 ethBefore = alice.balance;
        BalanceDelta d = _swap(alice, false, -int256(coins), 0);
        assertEq(_coin(d), -int128(int256(coins)));
        uint256 received = uint256(uint128(_eth(d)));
        assertEq(alice.balance - ethBefore, received, "the ETH arrived");
        uint256 fee = _feeTotal() - before;
        uint256 gross = received + fee;
        assertEq(fee, gross * 230 / BPS, "2.3% of the gross ETH the pool paid");
        assertEq(token.balanceOf(alice), 0);
    }

    function test_sell_exact_out_fee_on_top() public {
        _afterWindow();
        _swap(alice, true, -1 ether, 1 ether);
        uint256 before = _feeTotal();
        uint256 ethBefore = alice.balance;
        BalanceDelta d = _swap(alice, false, 0.1 ether, 0);
        assertEq(_eth(d), 0.1 ether, "exactly the ETH named comes out");
        assertEq(alice.balance - ethBefore, 0.1 ether);
        uint256 fee = _feeTotal() - before;
        assertEq(fee, uint256(0.1 ether) * 230 / 9770, "the pool paid named + fee");
    }

    function test_partial_fill_refused_when_eth_named() public {
        _afterWindow();
        _swap(alice, true, -1 ether, 1 ether);
        vm.expectRevert();
        _swap(alice, false, 5 ether, 0);
        assertGt(token.balanceOf(alice), 0, "nothing was taken");
    }

    function test_zero_project_fee_still_pays_the_platform() public {
        _afterWindow();
        _install(address(new FixedFeeModule(0, 0)));
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), 0);
        assertEq(hook.platformOwed(), 0.003 ether, "0.3% even at a 0% project tax");
    }

    // ------------------------------------------------------------------ the launch window
    function test_cap_inside_window() public {
        vm.expectRevert();
        _swap(alice, true, -1 ether, 1 ether);
        vm.expectRevert();
        _swap(alice, true, int256(20_000_001 ether), 1 ether);
        _swap(alice, true, int256(20_000_000 ether), 1 ether);
        assertEq(hook.purchased(alice), 20_000_000 ether);
        vm.expectRevert();
        _swap(alice, true, int256(1 ether), 1 ether);
        _swap(bob, true, int256(20_000_000 ether), 1 ether);
        vm.expectRevert();
        _swapPlain(alice, true, -0.001 ether, 0.001 ether);
        _swap(alice, false, -int256(1_000_000 ether), 0);
    }

    function test_cap_ends() public {
        _afterWindow();
        _swap(alice, true, -1 ether, 1 ether);
        assertGt(token.balanceOf(alice), 20_000_000 ether, "no cap after the window");
        _swapPlain(bob, true, -0.5 ether, 0.5 ether);
        assertGt(token.balanceOf(bob), 0, "any router after the window");
    }

    /// Programmable's trading router is trusted during the window like the Universal Router; the cap is one count
    /// per wallet across both; an unknown sender is still refused.
    function test_cap_second_router() public {
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: int256(12_000_000 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        vm.prank(alice);
        router2.swap{value: 1 ether}(key, p);
        assertEq(token.balanceOf(alice), 12_000_000 ether, "bought through the second router");
        assertEq(hook.purchased(alice), 12_000_000 ether, "counted");
        // the rest of the cap through the first router, one count per wallet
        _swap(alice, true, int256(8_000_000 ether), 1 ether);
        vm.expectRevert();
        _swap(alice, true, int256(1 ether), 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        router2.swap{value: 1 ether}(key, p);
        // a sender that is neither router nor the launcher
        vm.expectRevert();
        _swapPlain(bob, true, int256(1 ether), 1 ether);
        // the same hook data trick from a plain router is refused too: the launcher alone may name a wallet
        SwapParams memory q = SwapParams({zeroForOne: true, amountSpecified: int256(1 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        vm.prank(bob);
        vm.expectRevert();
        swapRouter.swap{value: 1 ether}(key, q, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), abi.encode(bob));
    }

    // ------------------------------------------------------------------ the initial buy inside the launch
    function test_initial_buy_inside_launch() public {
        uint256 ethBefore = address(this).balance;
        uint256 aliceEthBefore = alice.balance;
        _launchGraph(address(fixedModule), "g2", alice, 20_000_000 ether, 1 ether);
        assertEq(token.balanceOf(alice), 20_000_000 ether, "the launch wallet holds exactly the initial buy");
        assertEq(hook.purchased(alice), 20_000_000 ether, "counted against the cap");
        assertEq(address(launcher).balance, 0, "the launcher keeps no ETH");
        uint256 paid = ethBefore - address(this).balance; // what the initializer sent, less the refund it did not get back
        uint256 refunded = alice.balance - aliceEthBefore;
        assertEq(paid, 1 ether, "the initializer paid the whole value");
        assertGt(refunded, 0.9 ether, "most of it came back to the buyer");
        assertLt(refunded, 1 ether, "less what the buy cost");
        assertGt(hook.harvestable(), 0, "project fee booked on the initial buy");
        assertGt(hook.platformOwed(), 0, "platform fee booked on the initial buy");
        // the buyer is full for the window; another wallet is not
        _approve(alice);
        vm.expectRevert();
        _swap(alice, true, int256(1 ether), 1 ether);
        _approve(bob);
        _swap(bob, true, int256(1_000_000 ether), 1 ether);
    }

    function test_initial_buy_needs_matching_value() public {
        _deployGraph(address(fixedModule), "g3", alice, 20_000_000 ether);
        vm.expectRevert(BrownieLauncher.BuyValue.selector);
        launcher.initializeGraph{value: 0}(address(token), address(hook));
        _deployGraph(address(fixedModule), "g4", address(0), 0);
        vm.expectRevert(BrownieLauncher.BuyValue.selector);
        launcher.initializeGraph{value: 1 ether}(address(token), address(hook));
    }

    function test_initial_buy_over_the_cap_fails_the_launch() public {
        _deployGraph(address(fixedModule), "g5", alice, 20_000_001 ether);
        vm.expectRevert();
        launcher.initializeGraph{value: 1 ether}(address(token), address(hook));
    }

    function test_initial_buy_too_little_eth_fails_the_launch() public {
        _deployGraph(address(fixedModule), "g6", alice, 20_000_000 ether);
        vm.expectRevert();
        launcher.initializeGraph{value: 0.001 ether}(address(token), address(hook));
    }

    function test_initial_buy_needs_a_buyer() public {
        vm.expectRevert(BrownieLauncher.NoBuyer.selector);
        new BrownieLauncher(address(manager), address(this), START_TICK, address(0), 1 ether);
    }

    // ------------------------------------------------------------------ the fee leaves
    function test_harvest_and_platform_claim() public {
        _afterWindow();
        _swap(alice, true, -1 ether, 1 ether);
        _swap(alice, false, -int256(token.balanceOf(alice) / 2), 0);
        uint256 owed = hook.harvestable();
        uint256 platform = hook.platformOwed();
        assertGt(owed, 0.02 ether);
        assertGt(platform, 0.003 ether);
        assertEq(hook.harvest(), owed);
        assertEq(HARVESTER.balance, owed, "plain ETH in the harvester");
        assertEq(hook.harvestable(), 0);
        assertEq(hook.claimPlatform(), platform);
        assertEq(PROGRAMMABLE.balance, platform, "plain ETH to Programmable");
        assertEq(hook.platformOwed(), 0);
        assertEq(hook.harvest(), 0, "nothing twice");
        assertEq(hook.claimPlatform(), 0);
        assertEq(manager.balanceOf(address(hook), 0), 0, "no claim left behind");
    }

    // ------------------------------------------------------------------ the module's walls
    function _install(address mod) internal {
        vm.prank(OWNER);
        hook.proposeModule(mod);
        vm.warp(block.timestamp + 1 days);
        vm.prank(OWNER);
        hook.applyModule();
    }

    function test_module_is_clamped_to_the_ceilings() public {
        _afterWindow();
        _install(address(new GreedyModule()));
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(_feeTotal(), 0.033 ether, "3% ceiling + 0.3%, not 50%");
        assertEq(hook.moduleBudget(), 0.015 ether, "share clamped to half of the project leg");
        assertEq(hook.harvestable(), 0.015 ether);
        uint256 before = _feeTotal();
        BalanceDelta s = _swap(alice, false, -int256(token.balanceOf(alice)), 0);
        uint256 fee = _feeTotal() - before;
        uint256 gross = uint256(uint128(_eth(s))) + fee;
        assertEq(fee, gross * 330 / BPS, "3.3% sell ceiling");
    }

    function test_failing_module_means_base_fee_not_a_blocked_trade() public {
        _afterWindow();
        _install(address(new RevertingModule()));
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), 0.02 ether, "base fee");
        _install(address(new GasBurnerModule()));
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), 0.04 ether, "base fee again, the swap went through");
    }

    /// Programmable's review (2026-10-11): a module that returns successfully with empty or malformed data must not
    /// block trades either. Every bad answer means the base fee, for buys and for sells.
    function test_malformed_module_answer_means_base_fee() public {
        _afterWindow();
        address[4] memory bad = [address(new EmptyReturnModule()), address(new ShortReturnModule()), address(new HugeWordModule()), address(new LongReturnModule())];
        uint256 expected = 0;
        for (uint256 i = 0; i < bad.length; i++) {
            _install(bad[i]);
            _swap(alice, true, -1 ether, 1 ether);
            expected += 0.02 ether;
            assertEq(hook.harvestable(), expected, "buy at the base fee");
            uint256 before = hook.harvestable();
            _swap(alice, false, -int256(token.balanceOf(alice) / 4), 0);
            assertGt(hook.harvestable(), before, "sell went through at the base fee");
            expected = hook.harvestable();
        }
        vm.prank(OWNER);
        hook.clearModule();
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), expected + 0.02 ether, "base fee with no module");
    }

    function test_module_change_waits_and_clear_is_instant() public {
        GreedyModule g = new GreedyModule();
        vm.expectRevert(BrownieHook.OnlyOwner.selector);
        hook.proposeModule(address(g));
        vm.prank(OWNER);
        hook.proposeModule(address(g));
        vm.prank(OWNER);
        vm.expectRevert();
        hook.applyModule();
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(OWNER);
        vm.expectRevert();
        hook.applyModule();
        vm.warp(block.timestamp + 1);
        vm.prank(OWNER);
        hook.applyModule();
        assertEq(hook.module(), address(g));
        vm.prank(OWNER);
        hook.clearModule();
        assertEq(hook.module(), address(0));
        _afterWindow();
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), 0.02 ether, "base fee without a module");
    }

    function test_module_budget() public {
        _afterWindow();
        SharingModule s = new SharingModule();
        s.setHook(hook);
        _install(address(s));
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.moduleBudget(), 0.015 ether, "half of a 3% project fee");
        assertEq(hook.harvestable(), 0.015 ether);
        assertEq(hook.platformOwed(), 0.003 ether, "the platform leg is never shared");
        assertEq(s.afterSwaps(), 1, "the module heard the swap");
        vm.expectRevert(BrownieHook.OnlyModule.selector);
        hook.takeModuleBudget(address(this), 1);
        vm.expectRevert(BrownieHook.NotEnoughBudget.selector);
        s.take(address(0xC0FFEE), 0.016 ether);
        s.take(address(0xC0FFEE), 0.015 ether);
        assertEq(address(0xC0FFEE).balance, 0.015 ether);
        assertEq(hook.moduleBudget(), 0);
        hook.harvest();
        assertEq(HARVESTER.balance, 0.015 ether);
    }

    function test_note_and_ownership() public {
        vm.expectRevert(BrownieHook.OnlyOwner.selector);
        hook.note("not mine");
        vm.prank(OWNER);
        hook.note("tax 2% at launch");
        vm.prank(OWNER);
        hook.transferOwnership(alice);
        assertEq(hook.owner(), OWNER);
        vm.prank(alice);
        hook.acceptOwnership();
        assertEq(hook.owner(), alice);
    }

    // ------------------------------------------------------------------ the brownies cook the tax
    function _virality() internal returns (ViralityModule v) {
        ViralityModule.Band[] memory bands = new ViralityModule.Band[](3);
        bands[0] = ViralityModule.Band({scoreMin: 0, buyBps: 0, sellBps: 100});
        bands[1] = ViralityModule.Band({scoreMin: 50, buyBps: 200, sellBps: 200});
        bands[2] = ViralityModule.Band({scoreMin: 80, buyBps: 300, sellBps: 300});
        v = new ViralityModule(OWNER, SIGNER, 200, 200, 300, 200, 1 days, bands);
        _install(address(v));
    }

    function test_virality_score_moves_the_tax_inside_walls() public {
        _afterWindow();
        ViralityModule v = _virality();
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), 0.02 ether, "no score yet: base");
        vm.expectRevert(ViralityModule.OnlySigner.selector);
        v.setScore(90, "nope");
        vm.prank(SIGNER);
        v.setScore(90, "X mentions tripled, Telegram +40%");
        (uint16 b, uint16 s) = v.effective();
        assertEq(b, 300);
        assertEq(s, 300);
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), 0.05 ether, "3% buy now");
        uint256 before = _feeTotal();
        BalanceDelta d = _swap(alice, false, -int256(token.balanceOf(alice)), 0);
        uint256 fee = _feeTotal() - before;
        assertEq(fee, (uint256(uint128(_eth(d))) + fee) * 330 / BPS, "3% + 0.3% sell during the hype");
        // a cliff is refused: from 300 straight to 0 is a step of 300, above the 200 allowed
        vm.prank(SIGNER);
        vm.expectRevert();
        v.setScore(10, "dump");
        // a stale score falls back to the base
        vm.warp(block.timestamp + 2 days);
        (b, s) = v.effective();
        assertEq(b, 200);
        assertEq(s, 200);
        uint256 before2 = hook.harvestable();
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable() - before2, 0.02 ether, "base again");
        // from the base, a quiet score lowers the tax: 200 -> 0 buy is a step of 200, allowed
        vm.prank(SIGNER);
        v.setScore(10, "quiet week");
        (b, s) = v.effective();
        assertEq(b, 0);
        assertEq(s, 100);
        before2 = hook.platformOwed();
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.platformOwed() - before2, 0.003 ether, "0% buy tax: only Programmable's leg");
    }

    function test_virality_owner_switches_are_instant() public {
        _afterWindow();
        ViralityModule v = _virality();
        vm.prank(SIGNER);
        v.setScore(90, "hype");
        (uint16 b,) = v.effective();
        assertEq(b, 300);
        // pause: the base fees apply at once, whatever the score; nobody else can
        vm.expectRevert(ViralityModule.OnlyOwner.selector);
        v.setPaused(true);
        vm.prank(OWNER);
        v.setPaused(true);
        (b,) = v.effective();
        assertEq(b, 200, "paused: base");
        _swap(alice, true, -1 ether, 1 ether);
        assertEq(hook.harvestable(), 0.02 ether, "the hook charges the base while paused");
        vm.prank(OWNER);
        v.setPaused(false);
        (b,) = v.effective();
        assertEq(b, 300, "resumed: the score is back");
        // the step and the age are the owner's, inside bounds
        vm.prank(OWNER);
        vm.expectRevert();
        v.setMaxStep(0);
        vm.prank(OWNER);
        vm.expectRevert();
        v.setMaxStep(301);
        vm.prank(OWNER);
        v.setMaxStep(300);
        vm.prank(SIGNER);
        v.setScore(0, "a cliff the owner now allows");
        (b,) = v.effective();
        assertEq(b, 0);
        vm.prank(OWNER);
        vm.expectRevert();
        v.setMaxAge(10);
        vm.prank(OWNER);
        v.setMaxAge(2 hours);
        assertEq(v.maxAge(), 2 hours);
        // the signer can be removed: Nib cannot post any more, the score ages out
        vm.prank(OWNER);
        v.setSigner(address(0));
        vm.prank(SIGNER);
        vm.expectRevert(ViralityModule.OnlySigner.selector);
        v.setScore(50, "no");
        vm.warp(block.timestamp + 3 hours);
        (b,) = v.effective();
        assertEq(b, 200, "aged out: base");
    }

    function test_virality_tables_are_bounded() public {
        ViralityModule v = _virality();
        ViralityModule.Band[] memory bad = new ViralityModule.Band[](1);
        bad[0] = ViralityModule.Band({scoreMin: 0, buyBps: 301, sellBps: 100});
        vm.prank(OWNER);
        vm.expectRevert();
        v.setBands(bad);
        bad[0] = ViralityModule.Band({scoreMin: 101, buyBps: 100, sellBps: 100});
        vm.prank(OWNER);
        vm.expectRevert();
        v.setBands(bad);
        vm.prank(OWNER);
        vm.expectRevert();
        v.setBase(301, 200);
        vm.prank(SIGNER);
        vm.expectRevert();
        v.setScore(101, "too high");
    }
}
