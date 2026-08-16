// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./BaseTest.sol";
import {CoreConstants} from "../src/CoreConstants.sol";
import {KeeperVerifier} from "../src/KeeperVerifier.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";
import {MockQuote} from "./mocks/Mocks.sol";

/// Unit tests beyond the anchor suite: the verifier-gated claim/cancel flow,
/// the swap seam, settlement reads, and input validation. Anchors stay the
/// oracle; these pin the paths they do not cover.
contract OutcomeVaultTest is BaseTest {
    /// 1 USDC = 1e5 units at the fixture's 5 decimals.
    uint256 internal constant ONE_USDC = 1e5;

    function opKey(uint256 opId) internal view returns (bytes32) {
        return keccak256(abi.encode(address(vault), opId));
    }

    // --- deposit / split ------------------------------------------------

    /// Decimals sanity: 10 USDC in mints exactly 10.0 of each side and splits
    /// exactly 10 * 1e5 outcome wei (5-dec), not the 8-dec quote amount.
    function test_DepositMintsExactPairAndSplitsFiveDecimalWei() public {
        depositAndClaim(10 * ONE_USDC);
        assertEq(vault.oYes().balanceOf(user), 10 * 10 ** vault.oYes().decimals());
        assertEq(vault.oNo().balanceOf(user), 10 * 10 ** vault.oNo().decimals());
        bytes memory expected = CoreConstants.encodeOutcomeOp(
            CoreConstants.OP_SPLIT_OUTCOME, OUTCOME, uint64(10 * CoreConstants.OUTCOME_WEI_PER_SHARE)
        );
        assertEq(writer.getPayload(0), expected);
    }

    function test_DepositSendsQuoteThroughCoreDepositWallet() public {
        vm.prank(user);
        vault.deposit(100e6);
        assertEq(quote.balanceOf(address(depositWallet)), 100e6, "quote not deposited via Core deposit wallet");
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    function test_DepositZeroReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes("BAD_AMOUNT"));
        vault.deposit(0);
    }

    /// Rounding never favors the user: an amount finer than one outcome wei is
    /// rejected instead of silently truncated (a truncated split would mint
    /// shares the collateral does not back). Needs a 6-dec quote to have dust.
    function test_DepositDustReverts() public {
        MockQuote quote6 = new MockQuote("Mock USD 6", "mUSD6", 6);
        OutcomeVault vault6 = new OutcomeVault(
            IERC20(address(quote6)), SYSTEM_ADDR, TOKEN_INDEX, QUESTION, OUTCOME, keeper, verifier, "SIXDEC", 6
        );
        quote6.mint(user, 10e6);
        vm.startPrank(user);
        quote6.approve(address(vault6), type(uint256).max);
        vm.expectRevert(bytes("DUST"));
        vault6.deposit(1e6 + 1);
        vm.stopPrank();
    }

    function test_DepositWhilePendingReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(user);
        vm.expectRevert(bytes("BUSY"));
        vault.deposit(1e6);
    }

    function test_DepositAfterSettleReverts() public {
        vault.settle(1e18);
        vm.prank(user);
        vm.expectRevert(bytes("SETTLED"));
        vault.deposit(100e6);
    }

    // --- claim / cancel gated on attestation -----------------------------

    function test_ClaimBeforeAttestationReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processTransfersOnly();
        vm.expectRevert(bytes("SPLIT_NOT_CONFIRMED"));
        vault.claimDeposit();
    }

    function test_ClaimDepositTwiceReverts() public {
        depositAndClaim(100e6);
        vm.expectRevert(bytes("NO_PENDING"));
        vault.claimDeposit();
    }

    /// Elapsed time proves nothing about a Core action: without a Failed
    /// verdict there is no cancel, however long the caller waits.
    function test_CancelWithoutFailedAttestationReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processTransfersOnly();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(bytes("SPLIT_NOT_FAILED"));
        vault.cancelDeposit();

        sim.processActions(); // split executed and attested — claim is the only way out
        vm.expectRevert(bytes("SPLIT_NOT_FAILED"));
        vault.cancelDeposit();
    }

    function test_SilentDropThenFailedAttestationRefunds() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processTransfersOnly(); // credit landed, split dropped
        sim.dropPendingActions(); // keeper attests Failed
        vault.cancelDeposit();
        assertEq(vault.owed(user), 100e6);
        sim.processAll(); // refund spotSend lands on the EVM side
        vm.prank(user);
        vault.withdraw();
        assertEq(quote.balanceOf(user), 1_000e6, "user not made whole");
        assertEq(vault.oYes().totalSupply(), 0);
    }

    /// A refund spotSend the Core balance cannot cover would itself be dropped.
    function test_CancelWithoutCreditReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.dropPendingActions(); // nothing credited, split dead
        vm.expectRevert(bytes("CREDIT_NOT_ARRIVED"));
        vault.cancelDeposit();
    }

    // --- redeem ----------------------------------------------------------

    function test_ClaimRedeemBeforeMergeReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        vm.expectRevert(bytes("MERGE_NOT_CONFIRMED"));
        vault.claimRedeem();
    }

    function test_CancelRedeemAfterDroppedMergeRemints() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.dropPendingActions();
        vault.cancelRedeem();
        assertEq(vault.oYes().balanceOf(user), 100e6);
        assertEq(vault.oNo().balanceOf(user), 100e6);
    }

    function test_CancelRedeemAfterMergeExecutedReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.processAll();
        vm.expectRevert(bytes("MERGE_NOT_FAILED"));
        vault.cancelRedeem();
    }

    function test_RequestRedeemWhileDepositPendingReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.deposit(100e6); // second deposit in flight
        vm.prank(user);
        vm.expectRevert(bytes("BUSY"));
        vault.requestRedeem(50e6);
    }

    function test_WithdrawNothingOwedReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOTHING_OWED"));
        vault.withdraw();
    }

    /// The wedge fix: a queued Core→EVM send must be observed leaving the Core
    /// account before the next op, else that op's baseline is stale and its
    /// recovery proof can never be satisfied.
    function test_OutboundSendBlocksNextOpUntilObserved() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processTransfersOnly();
        sim.dropPendingActions();
        vault.cancelDeposit(); // refund spotSend queued, Core debit not applied yet

        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);

        sim.processAll();
        vm.prank(user);
        vault.deposit(100e6); // debit observed, baseline is safe again
    }

    // --- verifier seam ----------------------------------------------------

    /// The architectural-integrity proof: Core executed, the keeper went dark,
    /// and the funds are still recoverable because the owner can repoint the
    /// vault at a different attestation source. No timeout, no trust in one
    /// keeper staying alive.
    function test_VerifierSwapRecoversFromKeeperSilence() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.setKeeperSilent(true);
        sim.processAll(); // Core really split; nobody attested

        vm.expectRevert(bytes("SPLIT_NOT_CONFIRMED"));
        vault.claimDeposit();

        KeeperVerifier replacement = new KeeperVerifier(address(this));
        replacement.setMinDelay(0);
        vault.setVerifier(replacement);
        replacement.attest(opKey(vault.nextOpId()), true);

        vault.claimDeposit();
        assertEq(vault.oYes().balanceOf(user), 100e6);
        assertEq(vault.oNo().balanceOf(user), 100e6);
    }

    function test_SetVerifierOnlyOwner() public {
        KeeperVerifier replacement = new KeeperVerifier(address(this));
        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.setVerifier(replacement);
    }

    function test_PauseBlocksClaims() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processAll();
        verifier.pause();
        vm.expectRevert(bytes("SPLIT_NOT_CONFIRMED"));
        vault.claimDeposit();
        verifier.unpause();
        vault.claimDeposit();
        assertEq(vault.oYes().balanceOf(user), 100e6);
    }

    /// minDelay is the blast radius control: a fresh attestation is not
    /// actionable until it has had time to be paused.
    function test_ClaimBlockedUntilMinDelayElapses() public {
        verifier.setMinDelay(10 minutes);
        vm.prank(user);
        vault.deposit(100e6);
        sim.processAll();
        vm.expectRevert(bytes("SPLIT_NOT_CONFIRMED"));
        vault.claimDeposit();
        vm.warp(block.timestamp + 10 minutes + 1);
        vault.claimDeposit();
        assertEq(vault.oYes().balanceOf(user), 100e6);
    }

    // --- settlement -------------------------------------------------------

    /// Trustless path: while 0x814 still holds the value, anyone can settle and
    /// the relayed fraction argument is ignored.
    function test_SettleReadsPrecompilePermissionlessly() public {
        outcomeStatus.set(CoreConstants.OUTCOME_SETTLED, 0.6e8, QUESTION);
        vm.prank(other);
        vault.settle(1e18);
        assertTrue(vault.settled());
        assertEq(vault.settleFractionWad(), 0.6e18);
    }

    function test_SettleRejectsWrongQuestionBinding() public {
        outcomeStatus.set(CoreConstants.OUTCOME_SETTLED, 1e8, QUESTION + 1);
        vm.expectRevert(bytes("QUESTION_MISMATCH"));
        vault.settle(1e18);
    }

    /// Core prunes settled outcomes fast (FINDINGS.md: 2→3 in ~10 minutes) and
    /// the value is gone at status 3. Then, and only then, the keeper relays.
    function test_SettleFallsBackToKeeperOncePruned() public {
        outcomeStatus.set(CoreConstants.OUTCOME_SETTLED, 0.6e8, QUESTION);
        outcomeStatus.prune();
        vm.prank(other);
        vm.expectRevert(bytes("NOT_KEEPER"));
        vault.settle(0.6e18);
        vault.settle(0.6e18); // keeper == address(this)
        assertEq(vault.settleFractionWad(), 0.6e18);
    }

    function test_SettleFractionAboveOneReverts() public {
        vm.expectRevert(bytes("BAD_FRACTION"));
        vault.settle(1e18 + 1);
    }

    function test_SettleWhileDepositPendingReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.expectRevert(bytes("BUSY"));
        vault.settle(1e18);
    }

    function test_PullBeforeSettleReverts() public {
        vm.expectRevert(bytes("NOT_SETTLED"));
        vault.pullSettledFunds();
    }

    /// Settled payouts round down — the remainder stays with the vault.
    function test_SettledRedemptionRoundsDownToVault() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();
        vault.pullSettledFunds();
        sim.processAll();

        uint256 before = quote.balanceOf(user);
        vm.prank(user);
        vault.redeemSettled(true, 1); // 1 unit * 0.5 rounds to 0
        assertEq(quote.balanceOf(user), before);
        assertEq(vault.oYes().balanceOf(user), 100e6 - 1);
    }
}
