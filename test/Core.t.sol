// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
  Unit tests for Sugar, SugarMinter, BrownieStaking (with the loyalty boost), TeamVault and SkillRegistry. No chain,
  no Pons: two mock tokens stand in for USDG (6 decimals) and BROWNIE (18 decimals). The harvester is covered by the
  fork test.

  Time: every warp is to an ABSOLUTE timestamp from t0. With via-IR the optimizer folds two identical
  `block.timestamp + x` expressions in one function into one value, so a second relative warp goes nowhere.
*/

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Sugar} from "../src/Sugar.sol";
import {SugarMinter} from "../src/SugarMinter.sol";
import {BrownieStaking} from "../src/BrownieStaking.sol";
import {BrownieCore} from "../src/BrownieCore.sol";
import {TeamVault} from "../src/TeamVault.sol";
import {SkillRegistry} from "../src/SkillRegistry.sol";
import {PonsPredict} from "../src/libraries/PonsPredict.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract CoreTest is Test {
    MockToken usdg;
    MockToken coin;
    Sugar sugar;
    SugarMinter minter;
    BrownieStaking staking;
    TeamVault vault;
    SkillRegistry registry;

    address funding = makeAddr("funding");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address harvester = makeAddr("harvester");
    address team = makeAddr("team-owner");
    address stranger = makeAddr("stranger");

    uint256 constant MIN = 10_000e18;
    uint256 t0;

    function key(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function setUp() public {
        t0 = 1_700_000_000;
        vm.warp(t0);
        usdg = new MockToken("Global Dollar", "USDG", 6);
        coin = new MockToken("Brownies", "BROWNIE", 18);
        uint256 n = vm.getNonce(address(this));
        address predictedSugar = vm.computeCreateAddress(address(this), n + 2);
        staking = new BrownieStaking(address(coin), predictedSugar, address(usdg), funding, MIN, team);
        minter = new SugarMinter(address(usdg), predictedSugar, funding);
        sugar = new Sugar(address(staking), address(minter));
        assertEq(address(sugar), predictedSugar, "sugar lands where predicted");
        vault = new TeamVault(address(sugar), team);
        registry = new SkillRegistry(address(staking), address(vault));
        vm.prank(team);
        vault.setPayer(address(registry));

        usdg.mint(harvester, 1_000_000e6);
        usdg.mint(alice, 1_000_000e6);
        usdg.mint(bob, 1_000_000e6);
        for (uint256 i = 0; i < 3; i++) {
            address a = i == 0 ? alice : i == 1 ? bob : carol;
            coin.mint(a, 1_000_000e18);
            vm.prank(a);
            coin.approve(address(staking), type(uint256).max);
            vm.prank(a);
            usdg.approve(address(minter), type(uint256).max);
        }
        vm.prank(harvester);
        usdg.approve(address(staking), type(uint256).max);
    }

    function _fund(uint256 atoms) internal {
        vm.prank(harvester);
        staking.fund(atoms);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(amount);
    }

    /// Put `atoms` of SUGAR into the team vault, the way the harvester does: bought at par.
    function _fillVault(uint256 atoms) internal {
        vm.prank(alice);
        minter.mint(address(vault), atoms);
    }

    /*//////////////////////////////////////////////////////////////
                                    CORE
    //////////////////////////////////////////////////////////////*/

    function test_core_deploysAndWires() public {
        MockPool pool = new MockPool(address(usdg), address(coin));
        BrownieCore core = new BrownieCore(
            BrownieCore.Config({
                token: address(coin),
                weth: address(coin),
                usdc: address(usdg),
                wethUsdcPool: address(pool),
                mainWallet: makeAddr("main"),
                fundingWallet: funding,
                teamOwner: team,
                minPosition: MIN
            })
        );
        assertEq(core.SUGAR().STAKING(), address(core.STAKING()));
        assertEq(core.SUGAR().MINTER(), address(core.MINTER()));
        assertEq(address(core.STAKING().SUGAR()), address(core.SUGAR()));
        assertEq(address(core.MINTER().SUGAR()), address(core.SUGAR()));
        assertEq(address(core.TEAM_VAULT().SUGAR()), address(core.SUGAR()));
        assertEq(core.TEAM_VAULT().owner(), team);
        assertEq(core.HARVESTER().owner(), team, "the team holds the harvester's switch too");
        assertEq(core.HARVESTER().programOn(), true);
        assertEq(address(core.HARVESTER().STAKING()), address(core.STAKING()));
        assertEq(address(core.HARVESTER().MINTER()), address(core.MINTER()));
        assertEq(core.HARVESTER().TEAM_VAULT(), address(core.TEAM_VAULT()));
        assertEq(core.HARVESTER().TOKEN(), address(coin));
        assertEq(core.HARVESTER().WETH_IS_0(), pool.token0() == address(coin), "the harvester read the pool's order");
        assertEq(address(core.HARVESTER()), PonsPredict.createAddress(address(core), core.HARVESTER_NONCE()), "the harvester is child 5");
    }

    function test_core_createAddressMatchesFoundry() public pure {
        address d = 0x8e45a70CeAA3d7CA50995ee5DaaBAA9726212c3F;
        uint256[9] memory nonces = [uint256(0), 1, 4, 127, 128, 255, 256, 65_535, 70_000];
        for (uint256 i = 0; i < nonces.length; i++) {
            assertEq(PonsPredict.createAddress(d, nonces[i]), vm.computeCreateAddress(d, nonces[i]), "nonce");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                    SUGAR
    //////////////////////////////////////////////////////////////*/

    function test_sugar_onlyMintersMint() public {
        assertEq(sugar.decimals(), 6);
        vm.expectRevert(Sugar.NotMinter.selector);
        sugar.mint(alice, 1e6);
        vm.prank(address(staking));
        sugar.mint(alice, 1e6);
        vm.prank(address(minter));
        sugar.mint(alice, 2e6);
        assertEq(sugar.balanceOf(alice), 3e6);
    }

    function test_sugar_activateBurnsAndEmits() public {
        vm.prank(address(minter));
        sugar.mint(alice, 5e6);
        vm.expectEmit(true, true, true, true);
        emit Sugar.Activated(1, alice, key(bob), 3e6);
        vm.prank(alice);
        uint256 id = sugar.activate(3e6, key(bob));
        assertEq(id, 1);
        assertEq(sugar.balanceOf(alice), 2e6);
        assertEq(sugar.totalSupply(), 2e6);
        assertEq(sugar.totalActivated(), 3e6);
        vm.prank(alice);
        id = sugar.activate(1e6);
        assertEq(id, 2);
    }

    function test_sugar_activateRefusesZero() public {
        vm.prank(address(minter));
        sugar.mint(alice, 5e6);
        vm.prank(alice);
        vm.expectRevert(Sugar.ZeroAmount.selector);
        sugar.activate(0, bytes32(uint256(1)));
        vm.prank(alice);
        vm.expectRevert(Sugar.ZeroBeneficiary.selector);
        sugar.activate(1e6, bytes32(0));
    }

    /*//////////////////////////////////////////////////////////////
                                   MINTER
    //////////////////////////////////////////////////////////////*/

    function test_minter_parDoor() public {
        vm.prank(alice);
        uint256 got = minter.mint(bob, 250e6);
        assertEq(got, 250e6);
        assertEq(sugar.balanceOf(bob), 250e6, "one SUGAR per USDG");
        assertEq(usdg.balanceOf(funding), 250e6, "the dollars reached the funding wallet");
        assertEq(usdg.balanceOf(address(minter)), 0, "the minter keeps nothing");
    }

    function test_minter_mintAndActivate() public {
        vm.prank(alice);
        uint256 id = minter.mintAndActivate(40e6, key(bob));
        assertEq(id, 1);
        assertEq(sugar.totalSupply(), 0, "minted and burned in one call");
        assertEq(sugar.totalActivated(), 40e6);
        assertEq(usdg.balanceOf(funding), 40e6);
    }

    function test_minter_refusesZero() public {
        vm.prank(alice);
        vm.expectRevert(SugarMinter.ZeroAmount.selector);
        minter.mint(bob, 0);
    }

    /*//////////////////////////////////////////////////////////////
                              STAKING, THE STREAM
    //////////////////////////////////////////////////////////////*/

    function test_staking_fundPullsDollarsFirst() public {
        uint256 before = usdg.balanceOf(funding);
        _fund(3_600e6);
        assertEq(usdg.balanceOf(funding) - before, 3_600e6, "USDG to the funding wallet");
        assertEq(staking.totalFunded(), 3_600e6);
        assertEq(staking.unstreamed(), 3_600e6, "nothing earned yet, all still streaming");
        vm.expectRevert(abi.encodeWithSelector(BrownieStaking.BelowMinimumFund.selector, 0, 1e6));
        vm.prank(harvester);
        staking.fund(0);
        vm.prank(carol);
        vm.expectRevert();
        staking.fund(1e6);
    }

    function test_staking_oneStakerGetsTheWholeHour() public {
        _stake(alice, MIN);
        _fund(3_600e6);
        vm.warp(t0 + 1 hours);
        assertApproxEqAbs(staking.earned(alice), 3_600e6, 2, "the whole budget after the hour");
        vm.prank(alice);
        uint256 minted = staking.claim();
        assertApproxEqAbs(minted, 3_600e6, 2);
        assertEq(sugar.balanceOf(alice), minted);
        assertLe(staking.totalMinted(), staking.totalFunded(), "never mints more than was funded");
    }

    function test_staking_proRataByStake() public {
        _stake(alice, MIN);
        _stake(bob, 3 * MIN);
        _fund(4_000e6);
        vm.warp(t0 + 1 hours);
        assertApproxEqAbs(staking.earned(alice), 1_000e6, 2);
        assertApproxEqAbs(staking.earned(bob), 3_000e6, 2);
    }

    function test_staking_proRataByTime() public {
        _stake(alice, MIN);
        _fund(3_600e6);
        vm.warp(t0 + 30 minutes);
        _stake(bob, MIN);
        vm.warp(t0 + 60 minutes);
        assertApproxEqAbs(staking.earned(alice), 2_700e6, 3, "alice: 1800 alone + 900 shared");
        assertApproxEqAbs(staking.earned(bob), 900e6, 3, "bob: 900 shared");
    }

    function test_staking_flashStakeEarnsAlmostNothing() public {
        _stake(alice, MIN);
        _fund(3_600e6);
        vm.warp(t0 + 10 minutes);
        _stake(bob, 900_000e18);
        _fund(3_600e6);
        vm.warp(t0 + 10 minutes + 1);
        vm.prank(bob);
        staking.exit();
        assertLt(sugar.balanceOf(bob), 3e6, "a one second stake earns one second");
    }

    function test_staking_nobodyStakedCarriesTheBudget() public {
        _fund(1_000e6);
        vm.warp(t0 + 2 hours);
        assertApproxEqAbs(staking.unstreamed(), 1_000e6, 2, "carried, not lost (one atom of rounding)");
        _stake(alice, MIN);
        _fund(1_000e6);
        vm.warp(t0 + 3 hours);
        assertApproxEqAbs(staking.earned(alice), 2_000e6, 3, "both budgets reach the first staker");
    }

    function test_staking_refundRollsLeftoverForward() public {
        _stake(alice, MIN);
        _fund(3_600e6);
        vm.warp(t0 + 30 minutes);
        _fund(1_800e6);
        assertApproxEqAbs(staking.unstreamed(), 3_600e6, 2);
        vm.warp(t0 + 90 minutes);
        assertApproxEqAbs(staking.earned(alice), 5_400e6, 3);
    }

    function test_staking_minPosition() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BrownieStaking.BelowMinimumPosition.selector, MIN - 1, MIN));
        staking.stake(MIN - 1);
        _stake(alice, MIN);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BrownieStaking.BelowMinimumPosition.selector, MIN - 1, MIN));
        staking.unstake(1);
        vm.prank(alice);
        staking.unstake(MIN);
        assertEq(staking.stakeOf(alice), 0);
        assertEq(staking.weightOf(alice), 0);
        assertEq(staking.totalWeight(), 0);
        assertEq(coin.balanceOf(alice), 1_000_000e18, "all the BROWNIE came back");
    }

    function test_staking_claimNothingReverts() public {
        vm.prank(alice);
        vm.expectRevert(BrownieStaking.NothingToClaim.selector);
        staking.claim();
    }

    function test_staking_exitReturnsStakeAndMints() public {
        _stake(alice, MIN);
        _fund(600e6);
        vm.warp(t0 + 1 hours);
        vm.prank(alice);
        uint256 minted = staking.exit();
        assertApproxEqAbs(minted, 600e6, 2);
        assertEq(staking.stakeOf(alice), 0);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.startOf(alice), 0, "a full exit resets the age");
        assertEq(coin.balanceOf(alice), 1_000_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                             STAKING, THE LOYALTY BOOST
    //////////////////////////////////////////////////////////////*/

    function test_boost_tiers() public view {
        assertEq(staking.boostBps(0), 10_000);
        assertEq(staking.boostBps(30 days - 1), 10_000);
        assertEq(staking.boostBps(30 days), 11_000);
        assertEq(staking.boostBps(90 days - 1), 11_000);
        assertEq(staking.boostBps(90 days), 12_000);
        assertEq(staking.boostBps(180 days), 13_000);
        assertEq(staking.boostBps(3650 days), 13_000, "the boost stops at 1.30");
    }

    function test_boost_appliesOnPoke_andPaysMore() public {
        _stake(alice, MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 31 days);
        (uint256 earnedBps, uint256 appliedBps) = staking.boostOf(alice);
        assertEq(earnedBps, 11_000, "31 days earns 1.10");
        assertEq(appliedBps, 10_000, "but the weight still uses 1.00 until refreshed");
        vm.prank(stranger);
        staking.poke(alice); // anyone may refresh anyone
        (, appliedBps) = staking.boostOf(alice);
        assertEq(appliedBps, 11_000);
        assertEq(staking.weightOf(alice), MIN * 11 / 10);
        assertEq(staking.totalWeight(), MIN * 21 / 10, "bob was not refreshed and keeps 1.00");
        _fund(2_100e6);
        vm.warp(t0 + 31 days + 1 hours);
        assertApproxEqAbs(staking.earned(alice), 1_100e6, 3, "alice: 11 parts of 21");
        assertApproxEqAbs(staking.earned(bob), 1_000e6, 3, "bob: 10 parts of 21");
    }

    function test_boost_claimRefreshesTheCaller() public {
        _stake(alice, MIN);
        _fund(100e6);
        vm.warp(t0 + 91 days);
        vm.prank(alice);
        staking.claim();
        assertEq(staking.weightOf(alice), MIN * 12 / 10, "claiming applied the 90 day boost");
    }

    function test_boost_addingStakeAveragesTheAge() public {
        _stake(alice, MIN); // 10,000 at t0
        vm.warp(t0 + 180 days);
        vm.prank(alice);
        staking.poke(alice);
        assertEq(staking.weightOf(alice), MIN * 13 / 10, "the small old stake has the top boost");
        _stake(alice, 99 * MIN); // 990,000 more, today
        // age of the whole position: 1% of it is 180 days old, 99% is new -> 1.8 days
        assertApproxEqAbs(staking.startOf(alice), t0 + 180 days - 1.8 days, 2);
        assertEq(staking.weightOf(alice), 100 * MIN, "a big new stake cannot borrow the old stake's boost");
    }

    function test_boost_partialUnstakeKeepsTheAge() public {
        _stake(alice, 4 * MIN);
        vm.warp(t0 + 100 days);
        vm.prank(alice);
        staking.unstake(MIN);
        assertEq(staking.startOf(alice), t0, "the age is kept");
        assertEq(staking.weightOf(alice), 3 * MIN * 12 / 10, "and unstaking refreshed the boost to 1.20");
    }

    function test_boost_staleWeightNeverOverpays() public {
        _stake(alice, MIN);
        _stake(bob, 2 * MIN);
        _fund(900e6);
        vm.warp(t0 + 200 days);
        _fund(900e6);
        vm.warp(t0 + 200 days + 30 minutes);
        staking.poke(alice); // alice jumps to 1.30 mid-stream, bob stays stale at 1.00
        vm.warp(t0 + 200 days + 2 hours);
        vm.prank(alice);
        staking.exit();
        vm.prank(bob);
        staking.exit();
        assertLe(staking.totalMinted(), staking.totalFunded(), "minted <= funded with mixed boosts");
        assertLe(staking.totalFunded() - staking.totalMinted() - staking.unstreamed(), 10, "books balance to dust");
        assertEq(staking.totalWeight(), 0);
    }

    /// Whatever the sequence, SUGAR minted never exceeds USDG funded, and the books balance to a few atoms.
    function testFuzz_staking_neverOverMints(uint96 a, uint96 b, uint64 budget1, uint64 budget2, uint32 gap, bool pokeA) public {
        uint256 sa = bound(uint256(a), MIN, 900_000e18);
        uint256 sb = bound(uint256(b), MIN, 900_000e18);
        uint256 f1 = bound(uint256(budget1), 1e6, 1_000_000e6);
        uint256 f2 = bound(uint256(budget2), 1e6, 1_000_000e6);
        uint256 g = bound(uint256(gap), 1, 200 days);
        usdg.mint(harvester, f1 + f2);

        _stake(alice, sa);
        _fund(f1);
        vm.warp(t0 + g);
        _stake(bob, sb);
        if (pokeA) staking.poke(alice);
        _fund(f2);
        vm.warp(t0 + g + 2 hours);
        vm.prank(alice);
        staking.exit();
        vm.prank(bob);
        staking.exit();

        assertLe(staking.totalMinted(), staking.totalFunded(), "minted <= funded");
        assertLe(staking.totalFunded() - staking.totalMinted() - staking.unstreamed(), 10, "books balance to dust");
    }

    /*//////////////////////////////////////////////////////////////
                                 TEAM VAULT
    //////////////////////////////////////////////////////////////*/

    function _twoHelpers() internal {
        vm.startPrank(team);
        vault.addHelper("marketing", key(makeAddr("h-marketing")), 3);
        vault.addHelper("builder", key(makeAddr("h-builder")), 1);
        vm.stopPrank();
    }

    function test_vault_releaseIsOneThirtiethByWeight() public {
        _fillVault(3_000e6);
        _twoHelpers();
        assertEq(vault.dailyBudget(), 100e6, "one thirtieth of the vault");
        uint256 activatedBefore = sugar.totalActivated();
        vm.prank(stranger); // anyone may release
        uint256 handed = vault.release();
        assertEq(handed, 100e6);
        assertEq(vault.releasedTo(0), 75e6, "weight 3 of 4");
        assertEq(vault.releasedTo(1), 25e6, "weight 1 of 4");
        assertEq(sugar.totalActivated() - activatedBefore, 100e6, "it became AI balance on the helpers' keys");
        assertEq(sugar.balanceOf(address(vault)), 2_900e6);
    }

    function test_vault_oneReleaseADay_andTheBudgetFollowsTheVault() public {
        _fillVault(3_000e6);
        _twoHelpers();
        vault.release();
        vm.expectRevert(abi.encodeWithSelector(TeamVault.TooEarly.selector, t0 + 1 days));
        vault.release();
        vm.warp(t0 + 1 days);
        assertEq(vault.dailyBudget(), 2_900e6 / uint256(30), "tomorrow's budget is a thirtieth of what is left");
        vault.release();
        // a deposit raises the budget the same day
        uint256 before = vault.dailyBudget();
        _fillVault(3_000e6);
        assertGt(vault.dailyBudget(), before + 99e6);
    }

    function test_vault_slowDecayNeverEmptiesOvernight() public {
        _fillVault(3_000e6);
        _twoHelpers();
        for (uint256 d = 0; d < 30; d++) {
            vm.warp(t0 + d * 1 days);
            vault.release();
        }
        // thirty days with no income at all: more than a third is still there
        assertGt(sugar.balanceOf(address(vault)), 1_000e6);
    }

    function test_vault_nothingToRelease() public {
        vm.expectRevert(TeamVault.NothingToRelease.selector);
        vault.release(); // empty and no helpers
        _fillVault(300e6);
        vm.expectRevert(TeamVault.NothingToRelease.selector);
        vault.release(); // money but no helpers
        _twoHelpers();
        vm.startPrank(team);
        vault.setHelper(0, 3, false);
        vault.setHelper(1, 1, false);
        vm.stopPrank();
        vm.expectRevert(TeamVault.NothingToRelease.selector);
        vault.release(); // every helper switched off
    }

    function test_vault_setHelperChangesTheSplit() public {
        _fillVault(3_000e6);
        _twoHelpers();
        vm.prank(team);
        vault.setHelper(0, 1, true); // marketing down from 3 to 1
        assertEq(vault.totalActiveWeight(), 2);
        vault.release();
        assertEq(vault.releasedTo(0), 50e6);
        assertEq(vault.releasedTo(1), 50e6);
        vm.prank(team);
        vault.setHelper(1, 1, false); // builder off
        assertEq(vault.totalActiveWeight(), 1);
    }

    function test_vault_tipGoesStraightToTheHelper() public {
        _twoHelpers();
        vm.prank(alice);
        minter.mint(bob, 20e6);
        vm.prank(bob);
        sugar.approve(address(vault), 5e6);
        uint256 activatedBefore = sugar.totalActivated();
        vm.prank(bob);
        vault.tip(1, 5e6);
        assertEq(vault.tippedTo(1), 5e6);
        assertEq(vault.totalTipped(), 5e6);
        assertEq(sugar.totalActivated() - activatedBefore, 5e6);
        assertEq(sugar.balanceOf(address(vault)), 0, "a tip never rests in the vault");
        assertEq(sugar.balanceOf(bob), 15e6);
        vm.prank(bob);
        vm.expectRevert(TeamVault.BadHelper.selector);
        vault.tip(7, 1e6);
        vm.prank(bob);
        vm.expectRevert(TeamVault.ZeroAmount.selector);
        vault.tip(0, 0);
    }

    function test_vault_onlyTheOwnerManages() public {
        vm.startPrank(stranger);
        vm.expectRevert(TeamVault.NotOwner.selector);
        vault.addHelper("x", key(stranger), 1);
        vm.expectRevert(TeamVault.NotOwner.selector);
        vault.setHelper(0, 1, true);
        vm.expectRevert(TeamVault.NotOwner.selector);
        vault.setPayer(stranger);
        vm.expectRevert(TeamVault.NotOwner.selector);
        vault.transferOwnership(stranger);
        vm.stopPrank();
        // two steps
        vm.prank(team);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), team, "nothing moves until the new owner accepts");
        vm.prank(stranger);
        vm.expectRevert(TeamVault.NotPendingOwner.selector);
        vault.acceptOwnership();
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
    }

    function test_vault_payerCapIsTwentyPercentAMonth() public {
        _fillVault(1_000e6);
        // a new payer is only proposed: it can pay nothing until 7 days have passed in public
        vm.prank(team);
        vault.setPayer(bob);
        assertEq(vault.payer(), address(registry), "the old payer stays until the wait is over");
        vm.prank(bob);
        vm.expectRevert(TeamVault.NotPayer.selector);
        vault.pay(bob, 1e6, "too early");
        vm.prank(team);
        vm.expectRevert(abi.encodeWithSelector(TeamVault.PayerNotReady.selector, t0 + 7 days));
        vault.acceptPayer();
        vm.warp(t0 + 7 days);
        vm.prank(stranger);
        vm.expectRevert(TeamVault.NotOwner.selector);
        vault.acceptPayer();
        vm.prank(team);
        vault.acceptPayer();
        vm.prank(stranger);
        vm.expectRevert(TeamVault.NotPayer.selector);
        vault.pay(stranger, 1e6, "x");
        assertEq(vault.payAllowance(), 200e6);
        vm.prank(bob);
        vault.pay(carol, 150e6, "skill one");
        assertEq(sugar.balanceOf(carol), 150e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TeamVault.OverPayCap.selector, 60e6, 50e6));
        vault.pay(carol, 60e6, "too much");
        vm.prank(bob);
        vault.pay(carol, 50e6, "the rest of the window");
        assertEq(vault.payAllowance(), 0);
        // a new window opens 30 days later, based on what the vault holds then
        vm.warp(t0 + 37 days);
        assertEq(vault.payAllowance(), 800e6 * 20 / 100);
        vm.prank(bob);
        vault.pay(carol, 160e6, "next month");
        assertEq(vault.totalPaid(), 360e6);
    }

    function test_vault_tooManyHelpers() public {
        vm.startPrank(team);
        for (uint256 i = 0; i < 32; i++) vault.addHelper("h", bytes32(i + 1), 1);
        vm.expectRevert(TeamVault.TooManyHelpers.selector);
        vault.addHelper("one too many", bytes32(uint256(99)), 1);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                               SKILL REGISTRY
    //////////////////////////////////////////////////////////////*/

    function test_skill_submitNeedsAStake() public {
        vm.prank(stranger);
        vm.expectRevert(SkillRegistry.NotStaker.selector);
        registry.submit("repo/skills/x", 10e6);
        _stake(bob, MIN);
        vm.prank(bob);
        vm.expectRevert(SkillRegistry.StakeTooYoung.selector);
        registry.submit("repo/skills/x", 10e6);
        vm.warp(t0 + 1 days);
        vm.prank(bob);
        vm.expectRevert(SkillRegistry.ZeroAmount.selector);
        registry.submit("repo/skills/x", 0);
        vm.prank(bob);
        vm.expectRevert(SkillRegistry.BadUri.selector);
        registry.submit("", 10e6);
        vm.prank(bob);
        uint256 id = registry.submit("repo/skills/x", 10e6);
        assertEq(id, 0);
        assertEq(registry.count(), 1);
    }

    function test_skill_passesAndIsPaid() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("repo/skills/x-thread-writer", 30e6);
        vm.prank(alice);
        registry.vote(id, true);
        vm.prank(alice);
        vm.expectRevert(SkillRegistry.AlreadyVoted.selector);
        registry.vote(id, true);
        vm.expectRevert(SkillRegistry.VotingOpen.selector);
        registry.finalize(id);
        vm.warp(t0 + 5 days);
        vm.prank(bob);
        vm.expectRevert(SkillRegistry.VotingClosed.selector);
        registry.vote(id, true);
        vm.prank(stranger); // anyone settles
        registry.finalize(id);
        assertEq(sugar.balanceOf(bob), 30e6, "the author was paid the ask");
        assertEq(registry.skill(id).paidAmount, 30e6);
        vm.expectRevert(SkillRegistry.AlreadyDone.selector);
        registry.finalize(id);
    }

    function test_skill_failsWithoutQuorumOrMajority() public {
        _fillVault(1_000e6);
        _stake(alice, 100 * MIN);
        _stake(bob, MIN); // bob is 1 of 101: under the 5% quorum on his own
        _stake(carol, 10 * MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 lonely = registry.submit("repo/skills/a", 10e6);
        vm.prank(bob);
        registry.vote(lonely, true);
        vm.prank(carol); // one open proposal per author, so the second one is carol's
        uint256 outvoted = registry.submit("repo/skills/b", 10e6);
        vm.prank(carol);
        registry.vote(outvoted, true);
        vm.prank(alice);
        registry.vote(outvoted, false);
        vm.warp(t0 + 5 days);
        registry.finalize(lonely);
        registry.finalize(outvoted);
        assertEq(sugar.balanceOf(bob) + sugar.balanceOf(carol), 0, "neither was paid");
        assertEq(sugar.balanceOf(address(vault)), 1_000e6);
    }

    function test_skill_youngStakeCannotVote_soCoinsCannotVoteTwice() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("repo/skills/x", 10e6);
        vm.prank(alice);
        registry.vote(id, true);
        // alice moves her coins to carol to vote again: carol's stake is younger than the proposal
        vm.warp(t0 + 2 days + 1 hours);
        vm.prank(alice);
        staking.unstake(50 * MIN);
        vm.prank(alice);
        coin.transfer(carol, 50 * MIN);
        _stake(carol, 50 * MIN);
        vm.prank(carol);
        vm.expectRevert(SkillRegistry.StakeTooYoung.selector);
        registry.vote(id, true);
    }

    function test_skill_payIsCappedAtFivePercentOfTheVault() public {
        _fillVault(2_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("repo/skills/greedy", 1_000e6);
        vm.prank(alice);
        registry.vote(id, true);
        vm.warp(t0 + 5 days);
        registry.finalize(id);
        assertEq(sugar.balanceOf(bob), 100e6, "5% of the vault, not the ask");
    }

    function test_skill_vetoByTheTeam() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("repo/skills/bad", 30e6);
        vm.prank(alice);
        registry.vote(id, true);
        vm.prank(stranger);
        vm.expectRevert(SkillRegistry.NotVaultOwner.selector);
        registry.veto(id);
        vm.prank(team);
        registry.veto(id);
        vm.warp(t0 + 5 days);
        vm.expectRevert(SkillRegistry.AlreadyDone.selector);
        registry.finalize(id);
        assertEq(sugar.balanceOf(bob), 0);
    }

    function test_skill_theVaultsMonthlyCapStillHolds() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        address[5] memory authors;
        for (uint256 i = 0; i < 5; i++) {
            authors[i] = address(uint160(0xA000 + i));
            coin.mint(authors[i], MIN);
            vm.prank(authors[i]);
            coin.approve(address(staking), MIN);
            _stake(authors[i], MIN);
        }
        vm.warp(t0 + 2 days);
        // five skills at 5% each would be 25% of the vault; the vault allows 20% a window
        uint256[5] memory ids;
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(authors[i]);
            ids[i] = registry.submit("repo/skills/n", 50e6);
            vm.prank(alice);
            registry.vote(ids[i], true);
        }
        vm.warp(t0 + 5 days);
        uint256 paidCount;
        for (uint256 i = 0; i < 5; i++) {
            try registry.finalize(ids[i]) {
                paidCount++;
            } catch {}
        }
        assertLe(vault.totalPaid(), 200e6, "never more than 20% of the vault in the window");
        assertLt(paidCount, 5, "the last one waits for the next window");
        // it is not lost: it can be finalized once the window turns
        vm.warp(t0 + 35 days);
        registry.finalize(ids[4]);
        assertGt(vault.totalPaid(), 200e6);
    }

    function test_skill_aNewPayerCutsTheOldOneOff() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("repo/skills/x", 30e6);
        vm.prank(alice);
        registry.vote(id, true);
        vm.prank(team);
        vault.setPayer(address(0)); // the team names no payer: this registry can pay nothing more
        vm.warp(t0 + 5 days);
        vm.expectRevert(TeamVault.NotPayer.selector);
        registry.finalize(id);
    }
}

/// Only what BrownieHarvester's constructor reads: token0, token1.
/// Only what BrownieHarvester's constructor reads: the two tokens and a pool with price history.
contract MockPool {
    address public token0;
    address public token1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, 0, 0, 500, 500, 0, true);
    }
}
