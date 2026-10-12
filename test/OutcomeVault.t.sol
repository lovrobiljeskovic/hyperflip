// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./BaseTest.sol";
import {CoreConstants} from "../src/CoreConstants.sol";
import {KeeperVerifier} from "../src/KeeperVerifier.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";
import {MockQuote} from "./mocks/Mocks.sol";

/// Unit tests beyond the anchor suite: verifier-gated claim/cancel, the
/// verifier swap, settlement reads, outbound tracking and input validation.
contract OutcomeVaultTest is BaseTest {
    uint256 internal constant ONE_USDC = 1e5; // fixture quote is 5-dec

    function opKey(uint256 opId) internal view returns (bytes32) {
        return keccak256(abi.encode(address(vault), opId));
    }

    /// Deposit whose EVM→Core credit landed but whose split Core dropped.
    function depositThenDrop() internal {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processTransfersOnly();
        sim.dropPendingActions();
    }

    /// Burn a pair, let Core merge, claim the payout (spotSend queued, not landed).
    function redeemAndClaim(uint256 amount) internal {
        vm.prank(user);
        vault.requestRedeem(amount);
        sim.processAll();
        vault.claimRedeem();
    }

    function settleAndSweep(uint256 fractionWad) internal {
        vault.settle(fractionWad);
        sim.creditSettlement();
        vault.pullSettledFunds();
        sim.processAll();
    }

    function donate(uint256 amount) internal {
        quote.mint(other, amount);
        vm.prank(other);
        quote.transfer(address(vault), amount);
    }

    /// Two payouts queued while Core→EVM sends are held back; neither has landed.
    function stackTwoDeferredPayouts() internal {
        depositAndClaim(100e6);
        sim.setDeferSpotSends(true);
        redeemAndClaim(60e6);
        redeemAndClaim(40e6);
        sim.processActions();
    }

    function expectRedeemSettledRevert(bytes memory err) internal {
        vm.prank(user);
        vm.expectRevert(err);
        vault.redeemSettled(true, 100e6);
        assertEq(vault.oYes().balanceOf(user), 100e6, "position burned");
    }

    // deposit / split

    /// 10 USDC mints 10.0 of each side and splits 10 * 1e5 outcome wei (5-dec).
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

    function test_DepositEmitsOpQueued() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit OutcomeVault.OpQueued(1, OutcomeVault.OpType.Split, QUESTION, OUTCOME, uint64(100e6));
        vm.prank(user);
        vault.deposit(100e6);
    }

    function test_RedeemEmitsOpQueued() public {
        depositAndClaim(100e6);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OutcomeVault.OpQueued(2, OutcomeVault.OpType.Merge, QUESTION, OUTCOME, uint64(100e6));
        vm.prank(user);
        vault.requestRedeem(100e6);
    }

    function test_PayoutSpotSendTargetsSystemAddress() public {
        depositAndClaim(100e6);
        redeemAndClaim(100e6);
        bytes memory expected = CoreConstants.encodeSpotSend(SYSTEM_ADDR, TOKEN_INDEX, uint64(100e6 * QUOTE_MULT));
        assertEq(writer.lastPayload(), expected, "spotSend destination/amount wrong");
    }

    function test_DepositZeroReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes("BAD_AMOUNT"));
        vault.deposit(0);
    }

    /// Dust is rejected, never truncated; needs a 6-dec quote to have any.
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

    // claim / cancel gated on attestation

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

    /// Elapsed time proves nothing about a Core action.
    function test_CancelWithoutFailedAttestationReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.processTransfersOnly();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(bytes("SPLIT_NOT_FAILED"));
        vault.cancelDeposit();

        sim.processActions(); // executed and attested: claim is the only way out
        vm.expectRevert(bytes("SPLIT_NOT_FAILED"));
        vault.cancelDeposit();
    }

    /// A refund spotSend the Core balance cannot cover would itself be dropped.
    function test_CancelWithoutCreditReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.dropPendingActions();
        vm.expectRevert(bytes("CREDIT_NOT_ARRIVED"));
        vault.cancelDeposit();
    }

    // redeem

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

    /// A fee-sized merge shortfall (7 bps seen live) pays what arrived.
    function test_MergeFeeShortfallPaysOnlyWhatArrived() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(7);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.processAll();
        uint64 requested = uint64(100e6 * QUOTE_MULT);
        vm.expectEmit(true, true, true, true, address(vault));
        emit OutcomeVault.Payout(user, requested, requested - requested * 7 / 10_000);
        vault.claimRedeem();
        sim.processAll();

        uint256 expected = 100e6 - (100e6 * 7 / 10_000);
        assertEq(vault.owed(user), expected, "credited more than Core returned");
        vm.prank(user);
        vault.withdraw();
        assertEq(quote.balanceOf(user), 900e6 + expected);
        assertEq(quote.balanceOf(address(vault)), 0, "vault paid out more than arrived");
    }

    /// Past fee size a short balance means the credit has not landed: keep the slot.
    function test_LargeShortfallRevertsAndKeepsTheClaimAlive() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(200);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.processAll();

        vm.expectRevert(bytes("CORE_CREDIT_SHORT"));
        vault.claimRedeem();
        (address pendingUser,,) = vault.pendingRedeem();
        assertEq(pendingUser, user, "pending slot lost");
        assertEq(vault.owed(user), 0);
    }

    function test_RequestRedeemWhileDepositPendingReverts() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(user);
        vm.expectRevert(bytes("BUSY"));
        vault.requestRedeem(50e6);
    }

    function test_WithdrawNothingOwedReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes("NOTHING_OWED"));
        vault.withdraw();
    }

    // outbound dwell

    /// A queued Core→EVM send must be observed leaving Core before the next
    /// deposit, else that deposit's baseline is stale and its refund proof dead.
    function test_OutboundSendBlocksNextOpUntilObserved() public {
        depositThenDrop();
        vault.cancelDeposit(); // refund spotSend queued, debit not applied yet

        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);

        sim.processAll();
        vm.prank(user);
        vault.deposit(100e6);
    }

    /// A stray Core credit can hold the dwell shut forever; that may cost
    /// deposits, never redemptions or settlement.
    function test_StrayCoreCreditDoesNotBlockRedeemOrSettle() public {
        depositAndClaim(100e6);
        redeemAndClaim(50e6);
        sim.processAll();
        sim.creditStray(1);

        redeemAndClaim(50e6);
        sim.processAll();
        sim.creditStray(1);

        vault.settle(1e18);
        assertTrue(vault.settled());
    }

    function test_ClearOutboundRecoversDepositsAfterStrayCredit() public {
        depositAndClaim(100e6);
        redeemAndClaim(100e6);
        sim.processAll();
        sim.creditStray(1);

        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);

        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.clearOutbound();

        vault.clearOutbound();
        vm.prank(user);
        vault.deposit(100e6);
        assertEq(vault.nextOpId(), 3);
    }

    /// The dwell reads the Core side: EVM-side quote cannot clear it.
    function test_DonatedQuoteCannotSatisfyTheDwell() public {
        depositAndClaim(100e6);
        sim.setDeferSpotSends(true);
        redeemAndClaim(100e6);
        sim.processActions(); // send held, not landed
        donate(100e6);

        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);
    }

    /// The dwell must not clear when only the first of two stacked sends landed.
    function test_StackedOutboundsHoldTheDwell() public {
        stackTwoDeferredPayouts();

        sim.processSpotSends(1);
        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);

        sim.processSpotSends(1);
        vm.prank(user);
        vault.deposit(100e6);
        (,,, uint64 baseline) = vault.pendingDeposit();
        assertEq(baseline, 0, "baseline recorded over an unlanded transfer");
    }

    /// A second payout must price against the Core balance net of the first,
    /// unlanded send, or `owed` points at money Core will drop.
    function test_StackedPayoutsCreditOnlyWhatCoreWillDeliver() public {
        sim.setMergeFeeBps(50);
        stackTwoDeferredPayouts();
        sim.processSpotSends(2);

        assertEq(vault.owed(user), 99.5e6, "credited more than Core delivers");
        assertEq(vault.totalOwed(), quote.balanceOf(address(vault)), "phantom quote reserved");
        vm.prank(user);
        vault.withdraw();
        assertEq(quote.balanceOf(user), 900e6 + 99.5e6);
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    // verifier seam

    /// Core executed, the keeper went dark: the owner repoints the vault at a
    /// new attestation source and the funds come out. No timeout anywhere.
    function test_VerifierSwapRecoversFromKeeperSilence() public {
        vm.prank(user);
        vault.deposit(100e6);
        sim.setKeeperSilent(true);
        sim.processAll();

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

    // settlement

    function test_SettleReadsPrecompilePermissionlessly() public {
        outcomeStatus.set(CoreConstants.OUTCOME_SETTLED, 0.6e8, QUESTION);
        vm.prank(other);
        vault.settle(1e18); // argument ignored at status 2
        assertTrue(vault.settled());
        assertEq(vault.settleFractionWad(), 0.6e18);
    }

    function test_SettleRejectsWrongQuestionBinding() public {
        outcomeStatus.set(CoreConstants.OUTCOME_SETTLED, 1e8, QUESTION + 1);
        vm.expectRevert(bytes("QUESTION_MISMATCH"));
        vault.settle(1e18);
    }

    function test_SettleFallsBackToKeeperOncePruned() public {
        outcomeStatus.set(CoreConstants.OUTCOME_SETTLED, 0.6e8, QUESTION);
        outcomeStatus.prune();
        vm.prank(other);
        vm.expectRevert(bytes("NOT_KEEPER"));
        vault.settle(0.6e18);
        vault.settle(0.6e18); // keeper == address(this)
        assertEq(vault.settleFractionWad(), 0.6e18);
    }

    function test_SettleOnLiveMarketRevertsEvenForKeeper() public {
        outcomeStatus.set(CoreConstants.OUTCOME_ACTIVE, 0, QUESTION);
        vm.expectRevert(bytes("NOT_SETTLED_ON_CORE"));
        vault.settle(1e18);

        outcomeStatus.set(0, 0, QUESTION); // never existed
        vm.expectRevert(bytes("NOT_SETTLED_ON_CORE"));
        vault.settle(1e18);
    }

    function test_SetKeeperRotatesSettleAuthority() public {
        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.setKeeper(other);

        vault.setKeeper(other);
        assertEq(vault.keeper(), other);

        outcomeStatus.set(CoreConstants.OUTCOME_SETTLED, 0.6e8, QUESTION);
        outcomeStatus.prune();
        vm.expectRevert(bytes("NOT_KEEPER"));
        vault.settle(0.6e18);
        vm.prank(other);
        vault.settle(0.6e18);
        assertEq(vault.settleFractionWad(), 0.6e18);
    }

    function test_RotatedKeeperCannotSettleLiveMarket() public {
        vault.setKeeper(other);
        outcomeStatus.set(CoreConstants.OUTCOME_ACTIVE, 0, QUESTION);
        vm.prank(other);
        vm.expectRevert(bytes("NOT_SETTLED_ON_CORE"));
        vault.settle(1e18);
    }

    function test_SetOwnerTransfersEveryOwnerPower() public {
        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.setOwner(other);
        vm.expectRevert(bytes("ZERO_ADDRESS"));
        vault.setOwner(address(0));

        vault.setOwner(other);
        assertEq(vault.owner(), other);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.setKeeper(user);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.setVerifier(verifier);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.setOwner(address(this));
        vm.prank(other);
        vault.setKeeper(user);
        assertEq(vault.keeper(), user);
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

    function test_ConstructorRequiresDepositWalletCode() public {
        vm.etch(CoreConstants.CORE_DEPOSIT_WALLET, hex"");
        vm.expectRevert(bytes("NO_DEPOSIT_WALLET"));
        new OutcomeVault(
            IERC20(address(quote)), SYSTEM_ADDR, TOKEN_INDEX, QUESTION, OUTCOME, keeper, verifier, "BTC100K", DECIMALS
        );
    }

    // settled redemption

    /// Inside the pool-adequacy floor every holder takes the same haircut.
    function test_SettledRedemptionIsProRataWhenShort() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(50);
        settleAndSweep(0.5e18);

        uint256 available = quote.balanceOf(address(vault));
        assertEq(available, 99.5e6);

        vm.startPrank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 49.75e6, "early redeemer did not take the pro-rata haircut");
        vault.redeemSettled(false, 100e6); // tail redeemer must still be payable
        vm.stopPrank();

        assertEq(quote.balanceOf(user), 900e6 + available);
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    function test_SettledRedemptionRevertsWhenPoolTooShort() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(200);
        settleAndSweep(0.5e18);
        expectRedeemSettledRevert(bytes("SETTLEMENT_POOL_SHORT"));
    }

    /// The floor guard is `>=`: a shortfall landing exactly on it still pays.
    function test_SettledRedemptionExactlyAtFloorPasses() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(100);
        settleAndSweep(0.5e18);

        uint256 available = quote.balanceOf(address(vault));
        assertEq(available, 99e6);

        vm.startPrank(user);
        vault.redeemSettled(true, 100e6);
        vault.redeemSettled(false, 100e6);
        vm.stopPrank();

        assertEq(quote.balanceOf(user), 900e6 + available);
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    /// Fee residue below one EVM unit (19 wei seen live) would make a raw
    /// full-balance sweep drop; the sweep floors and strands the dust.
    function test_SweepFloorsUnrepresentableDust() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();
        sim.creditStray(19);
        vault.pullSettledFunds();
        sim.processAll();
        assertEq(quote.balanceOf(address(vault)), 100e6, "sweep did not land");

        vm.startPrank(user);
        vault.redeemSettled(true, 100e6);
        vault.redeemSettled(false, 100e6);
        vm.stopPrank();
        assertEq(quote.balanceOf(user), 1_000e6);
    }

    /// The sweep gate keys off quote actually received, not the Core balance.
    function test_StrayCoreCreditCannotHoldSettlementShut() public {
        depositAndClaim(100e6);
        settleAndSweep(0.5e18);
        sim.creditStray(1);

        vm.prank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 50e6);

        sim.creditStray(1);
        vm.prank(user);
        vault.redeemSettled(false, 100e6);
        assertEq(quote.balanceOf(user), 1_000e6);
    }

    /// Payouts round down to the vault; a zero payout never burns a position.
    function test_SettledRedemptionRoundsDownToVault() public {
        depositAndClaim(100e6);
        settleAndSweep(0.5e18);

        uint256 before = quote.balanceOf(user);
        vm.prank(user);
        vault.redeemSettled(true, 3); // 3 * 0.5 rounds down to 1
        assertEq(quote.balanceOf(user), before + 1);
        assertEq(vault.oYes().balanceOf(user), 100e6 - 3);

        vm.prank(user);
        vm.expectRevert(bytes("NOTHING_TO_REDEEM"));
        vault.redeemSettled(true, 1);
        assertEq(vault.oYes().balanceOf(user), 100e6 - 3, "position burned for nothing");
    }

    /// Redemption waits for the sweep: unarmed before any pull, pending while queued.
    function test_SettledRedemptionBlockedUntilSweepLands() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();
        expectRedeemSettledRevert(bytes("SWEEP_PENDING"));

        vault.pullSettledFunds();
        expectRedeemSettledRevert(bytes("SWEEP_PENDING"));

        sim.processAll();
        vm.prank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 50e6);
    }

    /// Before any pull `_unlandedEvm() == 0` holds trivially; a 2-wei donation
    /// must not open the gate (it would burn a full position for 1 wei).
    function test_DonationBeforePullCannotForceSettledRedemption() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();
        donate(2);
        expectRedeemSettledRevert(bytes("SWEEP_PENDING"));
    }

    /// A pull with nothing on Core must not arm the gate, even with a donation on top.
    function test_PullWithZeroCoreBalanceDoesNotArmTheGate() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        vault.pullSettledFunds(); // premature crank, nothing swept
        donate(2);
        expectRedeemSettledRevert(bytes("SWEEP_PENDING"));

        sim.creditSettlement();
        vault.pullSettledFunds();
        sim.processAll();
        vm.prank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 50e6);
    }

    /// A sub-unit stray credit floors to zero and does not arm; a larger one
    /// arms honestly and the pool-adequacy floor then refuses the burn.
    function test_SubUnitCoreCreditPlusDonationCannotForceRedemption() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditStray(999); // below one EVM unit at QUOTE_MULT = 1000
        vault.pullSettledFunds();
        donate(2);
        expectRedeemSettledRevert(bytes("SWEEP_PENDING"));

        sim.creditStray(1001); // 2000 total: a real 2-wei sweep
        vault.pullSettledFunds();
        sim.processAll();
        expectRedeemSettledRevert(bytes("SETTLEMENT_POOL_SHORT"));
    }

    function test_StrayCreditSweptToDustCannotForceRedemption() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditStray(2000);
        vault.pullSettledFunds();
        sim.processAll(); // 2-wei sweep lands; gate honestly open
        expectRedeemSettledRevert(bytes("SETTLEMENT_POOL_SHORT"));
    }

    /// Core lost the settlement credit and the owner refills the pool EVM-side:
    /// clearOutbound opens the gate where a donation alone may not.
    function test_ClearOutboundArmsSettlementGate() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        quote.mint(address(vault), 100e6);
        expectRedeemSettledRevert(bytes("SWEEP_PENDING"));

        vault.clearOutbound();
        vm.prank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 50e6);
    }

    /// Unwithdrawn `owed` is not part of the settlement pool.
    function test_ProRataDoesNotSpendUnwithdrawnOwed() public {
        depositAndClaim(200e6);
        sim.setMergeFeeBps(50);
        redeemAndClaim(50e6); // owed credited, deliberately not withdrawn
        sim.processAll();
        assertEq(vault.totalOwed(), 49.75e6);

        settleAndSweep(0.5e18);

        vm.startPrank(user);
        vault.redeemSettled(true, 150e6);
        vault.redeemSettled(false, 150e6);
        vault.withdraw(); // must still be funded
        vm.stopPrank();

        assertEq(quote.balanceOf(user), 999e6);
        assertEq(quote.balanceOf(address(vault)), 0);
        assertEq(vault.totalOwed(), 0);
    }
}
