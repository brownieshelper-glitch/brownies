// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CoreTest} from "./Core.t.sol";
import {BrownieStaking} from "../src/BrownieStaking.sol";
import {TeamVault} from "../src/TeamVault.sol";
import {SkillRegistry} from "../src/SkillRegistry.sol";

/// The findings of the review of October 2026, each one as a test of the fix.
/// The first test is the reviewer's own proof: before the fix those steps won the vote and were paid 50 SUGAR.
/// Times are always absolute (t0 + N): with via_ir two equal relative warps fold into one value.
contract ReviewTest is CoreTest {
    /*//////////////////////////////////////////////////////////////
                    A VOTE CANNOT BE WON WITH BORROWED COINS
    //////////////////////////////////////////////////////////////*/

    function test_review_borrowedStakeCannotVote() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN); // a small old stake
        vm.warp(t0 + 2 days);
        vm.startPrank(bob);
        uint256 id = registry.submit("x", 50e6);
        staking.stake(90 * MIN); // stands in for borrowed coins, held for one transaction
        assertLt(staking.startOf(bob), t0 + 2 days, "the averaged age still looks old: that was the hole");
        vm.expectRevert(SkillRegistry.StakeTooYoung.selector);
        registry.vote(id, true);
        staking.unstake(90 * MIN);
        vm.stopPrank();
        vm.prank(alice);
        registry.vote(id, false);
        vm.warp(t0 + 5 days);
        registry.finalize(id);
        assertEq(sugar.balanceOf(bob), 0, "nothing was paid");
    }

    function test_review_coinsMovedToAnOldWalletCannotVoteAgain() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        _stake(carol, MIN); // a wallet parked in advance
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("x", 10e6);
        vm.prank(alice);
        registry.vote(id, true);
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

    function test_review_stakeAddedLessThanADayBeforeCannotVote() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        _stake(carol, 80 * MIN); // one hour before the proposal
        vm.warp(t0 + 2 days + 1 hours);
        vm.prank(bob);
        uint256 id = registry.submit("x", 10e6);
        vm.prank(carol);
        vm.expectRevert(SkillRegistry.StakeTooYoung.selector);
        registry.vote(id, true);
        vm.prank(alice); // alice has not touched her stake for more than a day
        registry.vote(id, true);
    }

    /*//////////////////////////////////////////////////////////////
                      THE BAR CANNOT BE MOVED AFTERWARDS
    //////////////////////////////////////////////////////////////*/

    function test_review_quorumIsFixedWhenTheProposalIsMade() public {
        _fillVault(1_000e6);
        _stake(alice, 8 * MIN); // 8% of the weight: over the 5% bar
        _stake(bob, 92 * MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("x", 10e6);
        assertEq(registry.skill(id).quorumWeight, 100 * MIN);
        vm.prank(alice);
        registry.vote(id, true);
        vm.warp(t0 + 5 days);
        // someone stakes a mountain right before the count to raise the bar and kill the proposal
        _stake(carol, 90 * MIN);
        registry.finalize(id);
        assertEq(sugar.balanceOf(bob), 10e6, "it still passed: the bar was set at 5% of 100, not of 190");
    }

    function test_review_anEmptyVaultDoesNotSettleAPassedProposalForNothing() public {
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("x", 10e6);
        vm.prank(alice);
        registry.vote(id, true);
        vm.warp(t0 + 5 days);
        vm.expectRevert(SkillRegistry.NothingToPay.selector);
        registry.finalize(id);
        _fillVault(1_000e6);
        registry.finalize(id);
        assertEq(sugar.balanceOf(bob), 10e6, "paid once the vault could pay");
    }

    function test_review_oneOpenProposalPerAuthor() public {
        _fillVault(1_000e6);
        _stake(alice, 50 * MIN);
        _stake(bob, MIN);
        vm.warp(t0 + 2 days);
        vm.prank(bob);
        uint256 id = registry.submit("a", 10e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SkillRegistry.AlreadyOpen.selector, id));
        registry.submit("b", 10e6);
        vm.warp(t0 + 5 days);
        registry.finalize(id); // it failed (nobody voted) and is settled
        vm.prank(bob);
        assertEq(registry.submit("b", 10e6), 1);
        vm.prank(team);
        registry.veto(1);
        vm.prank(bob);
        assertEq(registry.submit("c", 10e6), 2, "a veto frees the author too");
    }

    /*//////////////////////////////////////////////////////////////
                                 THE STAKE
    //////////////////////////////////////////////////////////////*/

    function test_review_anOldDustStakeDoesNotLendItsAgeToNewCoins() public {
        _stake(bob, MIN);
        vm.warp(t0 + 720 days);
        _stake(bob, 3 * MIN);
        // before: the average of 720 days and 0 days was 180 days, the top bonus on coins that were 75% new.
        // now the old part counts as 180 days at most, so the average is 45 days: the first bonus only.
        assertEq(staking.startOf(bob), t0 + 720 days - 45 days);
        assertEq(staking.weightOf(bob), 4 * MIN * 11_000 / 10_000);
    }

    function test_review_fundRefusesDustAndTheFundingWalletItself() public {
        vm.prank(harvester);
        vm.expectRevert(abi.encodeWithSelector(BrownieStaking.BelowMinimumFund.selector, 999_999, 1e6));
        staking.fund(999_999);
        vm.prank(funding);
        vm.expectRevert(BrownieStaking.FundingCannotFund.selector);
        staking.fund(5e6);
        _fund(1e6); // exactly one dollar is fine
        assertEq(staking.totalFunded(), 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                    THE EMERGENCY STOP AND THE ATTACKS ON STAKING
    //////////////////////////////////////////////////////////////*/

    function test_stop_blocksStakesBudgetsAndClaims_neverUnstaking() public {
        _stake(alice, 50 * MIN);
        _fund(3_600e6);
        vm.warp(t0 + 30 minutes);
        vm.prank(stranger);
        vm.expectRevert(BrownieStaking.NotOwner.selector);
        staking.setStopped(true);
        vm.prank(team);
        staking.setStopped(true);
        vm.prank(bob);
        vm.expectRevert(BrownieStaking.StakingStopped.selector);
        staking.stake(MIN);
        vm.prank(harvester);
        vm.expectRevert(BrownieStaking.StakingStopped.selector);
        staking.fund(100e6);
        vm.prank(alice);
        vm.expectRevert(BrownieStaking.StakingStopped.selector);
        staking.claim();
        // the coins always come out, and what was earned is not lost
        uint256 earnedBefore = staking.earned(alice);
        assertGt(earnedBefore, 0);
        vm.prank(alice);
        staking.exit();
        assertEq(coin.balanceOf(alice), 1_000_000e18, "all the coins are back");
        assertEq(sugar.balanceOf(alice), 0, "no SUGAR minted while stopped");
        assertEq(staking.rewards(alice), earnedBefore, "the earned SUGAR waits");
        vm.prank(team);
        staking.setStopped(false);
        vm.prank(alice);
        staking.claim();
        assertEq(sugar.balanceOf(alice), earnedBefore, "paid once the owner restarted");
    }

    function test_attack_flashStakeAroundTheBudgetEarnsNothing() public {
        _stake(alice, 50 * MIN);
        vm.warp(t0 + 1 hours);
        coin.mint(bob, 500 * MIN);
        vm.prank(bob);
        staking.stake(500 * MIN); // a whale arrives right before the budget
        _fund(3_600e6);
        vm.prank(bob);
        staking.unstake(500 * MIN); // and leaves right after
        assertEq(staking.earned(bob), 0, "no time passed: nothing earned");
        vm.warp(t0 + 2 hours);
        assertEq(staking.earned(alice), 3_600e6, "alice gets the whole hour");
    }

    function test_attack_nobodyCanMoveOrClaimForSomeoneElse() public {
        _stake(alice, 50 * MIN);
        _fund(3_600e6);
        vm.warp(t0 + 1 hours);
        vm.prank(stranger);
        staking.poke(alice); // allowed, and harmless: it only refreshes alice's weight
        vm.prank(stranger);
        vm.expectRevert();
        staking.unstake(1); // the stranger has no stake to take
        assertEq(staking.stakeOf(alice), 50 * MIN);
        assertEq(staking.earned(alice), 3_600e6);
        vm.prank(stranger);
        vm.expectRevert(BrownieStaking.NothingToClaim.selector);
        staking.claim();
    }

    function test_attack_sugarCannotBeMintedByAnyoneElse() public {
        vm.prank(stranger);
        vm.expectRevert();
        sugar.mint(stranger, 1_000_000e6);
        vm.prank(team);
        vm.expectRevert();
        sugar.mint(team, 1e6);
        assertEq(sugar.totalSupply(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                 THE VAULT
    //////////////////////////////////////////////////////////////*/

    function test_review_theOwnerCannotPointPayoutsAtItselfOvernight() public {
        _fillVault(1_000e6);
        vm.startPrank(team);
        vault.setPayer(team); // only a proposal
        vm.expectRevert(TeamVault.NotPayer.selector);
        vault.pay(team, 200e6, "mine");
        // switching off and on again does not skip the wait either
        vault.setPayer(address(0));
        assertEq(vault.payer(), address(0));
        vault.setPayer(team);
        assertEq(vault.payer(), address(0), "still nobody can pay");
        vm.expectRevert(abi.encodeWithSelector(TeamVault.PayerNotReady.selector, t0 + 7 days));
        vault.acceptPayer();
        vm.stopPrank();
        assertEq(sugar.balanceOf(address(vault)), 1_000e6);
    }

    function test_review_thePayCapFollowsAVaultThatShrank() public {
        _fillVault(1_000e6);
        vm.startPrank(team);
        vault.addHelper("fudge", bytes32(uint256(1)), 1);
        vm.stopPrank();
        vm.prank(address(registry));
        vault.pay(alice, 10e6, "opens the window at 1,000");
        vm.warp(t0 + 1 days);
        vault.release(); // 990 / 30 = 33 leaves the vault
        uint256 bal = sugar.balanceOf(address(vault));
        assertEq(bal, 957e6);
        // 20% of (what is left + what this window already paid), not 20% of the 1,000 the window opened with
        assertEq(vault.payAllowance(), (bal + 10e6) * 20 / 100 - 10e6);
        assertLt(vault.payAllowance(), 190e6);
    }

    function test_review_aHelperKeyCanBeReplaced() public {
        vm.prank(team);
        uint256 id = vault.addHelper("chip", bytes32(uint256(7)), 1);
        vm.prank(stranger);
        vm.expectRevert(TeamVault.NotOwner.selector);
        vault.setKey(id, bytes32(uint256(8)));
        vm.prank(team);
        vm.expectRevert(TeamVault.BadHelper.selector);
        vault.setKey(id, bytes32(0));
        vm.prank(team);
        vault.setKey(id, bytes32(uint256(8)));
        (, bytes32 key,,) = vault.helper(id);
        assertEq(key, bytes32(uint256(8)));
    }
}
