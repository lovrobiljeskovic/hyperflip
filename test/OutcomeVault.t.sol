// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./BaseTest.sol";

/// Unit tests beyond the anchor suite: input validation, serialization,
/// cancel/settle edges. Anchors stay the oracle; these pin revert paths.
contract OutcomeVaultTest is BaseTest {
    function test_DepositZeroReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes("BAD_AMOUNT"));
        vault.deposit(0);
    }

    function test_DepositWhilePendingReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(user);
        vm.expectRevert(bytes("BUSY"));
        vault.deposit(1e6);
    }

    function test_ClaimDepositTwiceReverts() public {
        depositAndClaim(100e6);
        vm.expectRevert(bytes("NO_PENDING"));
        vault.claimDeposit();
    }

    function test_CancelBeforeTimeoutReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processTransfersOnly();
        sim.dropPendingActions();
        vm.warp(block.timestamp + vault.CANCEL_TIMEOUT()); // exactly at limit: still too early
        vm.expectRevert(bytes("TOO_EARLY"));
        vault.cancelDeposit();
    }

    function test_CancelAfterSplitExecutedReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processAll(); // split executed — only claim is legitimate
        vm.warp(block.timestamp + vault.CANCEL_TIMEOUT() + 1);
        vm.expectRevert(bytes("SPLIT_EXECUTED"));
        vault.cancelDeposit();
    }

    function test_WithdrawNothingOwedReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOTHING_OWED"));
        vault.withdraw();
    }

    function test_RequestRedeemWhileDepositPendingReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.deposit(100e6); // second deposit in flight
        vm.prank(user);
        vm.expectRevert(bytes("BUSY"));
        vault.requestRedeem(50e6);
    }

    function test_ClaimRedeemBeforeMergeReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        vm.expectRevert(bytes("MERGE_NOT_CONFIRMED"));
        vault.claimRedeem();
    }

    function test_CancelRedeemBeforeTimeoutReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        vm.expectRevert(bytes("TOO_EARLY"));
        vault.cancelRedeem();
    }

    function test_CancelRedeemAfterDroppedMergeRemints() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.dropPendingActions();
        vm.warp(block.timestamp + vault.CANCEL_TIMEOUT() + 1);
        vault.cancelRedeem();
        assertEq(vault.oYes().balanceOf(user), 100e6);
        assertEq(vault.oNo().balanceOf(user), 100e6);
    }

    function test_CancelRedeemAfterMergeExecutedReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.processAll();
        vm.warp(block.timestamp + vault.CANCEL_TIMEOUT() + 1);
        vm.expectRevert(bytes("MERGE_EXECUTED"));
        vault.cancelRedeem();
    }

    function test_SettleFractionAboveOneReverts() public {
        vm.expectRevert(bytes("BAD_FRACTION"));
        vault.settle(1e18 + 1);
    }

    function test_DepositAfterSettleReverts() public {
        vault.settle(1e18);
        vm.prank(user);
        vm.expectRevert(bytes("SETTLED"));
        vault.deposit(100e6);
    }

    function test_PullBeforeSettleReverts() public {
        vm.expectRevert(bytes("NOT_SETTLED"));
        vault.pullSettledFunds();
    }

    function test_SettleWhileDepositPendingReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.expectRevert(bytes("BUSY"));
        vault.settle(1e18);
    }

    function test_CancelWithoutCreditReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.dropPendingActions(); // nothing credited, split dead
        vm.warp(block.timestamp + vault.CANCEL_TIMEOUT() + 1);
        vm.expectRevert(bytes("CREDIT_NOT_ARRIVED"));
        vault.cancelDeposit();
    }
}
