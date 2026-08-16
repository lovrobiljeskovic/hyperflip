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

    /// OpQueued is the keeper's whole input: without it there is nothing to
    /// attest. opKey is derived from the opId it carries.
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

    /// FINDINGS.md #4: Core→EVM spotSend goes to the token's system address,
    /// never to the vault itself.
    function test_PayoutSpotSendTargetsSystemAddress() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.processAll();
        vault.claimRedeem();

        bytes memory payload = writer.lastPayload();
        bytes memory expected = CoreConstants.encodeSpotSend(SYSTEM_ADDR, TOKEN_INDEX, uint64(100e6 * QUOTE_MULT));
        assertEq(payload, expected, "spotSend destination/amount wrong");
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

    /// FINDINGS.md #5: a live split+merge round trip lost 7 bps, unitemized.
    /// The payout must survive a merge credit that lands short — send what is
    /// actually there and credit the user exactly that, rather than
    /// underflowing on the nominal amount and wedging the pending slot.
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

    /// Beyond fee size, a short balance means the credit has not landed yet.
    /// Reverting keeps the pending slot (and the claim) alive for a retry
    /// instead of silently converting the gap into a permanent loss.
    function test_LargeShortfallRevertsAndKeepsTheClaimAlive() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(200); // 2% — far past a plausible fee
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

    /// A third party can hold the dwell's balance check false forever by
    /// sending the vault's Core account a stray credit. That must cost at most
    /// deposits — never redemptions, and never settlement.
    function test_StrayCoreCreditDoesNotBlockRedeemOrSettle() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(50e6);
        sim.processAll();
        vault.claimRedeem(); // outbound queued
        sim.processAll(); // and landed
        sim.creditStray(1); // griefer credits 1 wei — dwell can never clear now

        vm.prank(user);
        vault.requestRedeem(50e6); // takes no baseline, so it must not be blockable
        sim.processAll();
        vault.claimRedeem();
        sim.processAll();
        sim.creditStray(1);

        vault.settle(1e18); // likewise settlement
        assertTrue(vault.settled());
    }

    function test_ClearOutboundRecoversDepositsAfterStrayCredit() public {
        depositAndClaim(100e6);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.processAll();
        vault.claimRedeem();
        sim.processAll();
        sim.creditStray(1);

        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);

        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        vault.clearOutbound();

        vault.clearOutbound(); // owner escape hatch
        vm.prank(user);
        vault.deposit(100e6);
        assertEq(vault.nextOpId(), 3);
    }

    /// The dwell guards the deposit baseline, so it must read the Core side.
    /// Donated EVM quote satisfies "what we sent has shown up" without the Core
    /// debit having landed, and clearing on that would re-open the wedge: the
    /// baseline records an unlanded debit and cancelDeposit's refund proof
    /// becomes unsatisfiable, which clearOutbound cannot undo.
    function test_DonatedQuoteCannotSatisfyTheDwell() public {
        depositAndClaim(100e6);
        sim.setDeferSpotSends(true);
        vm.prank(user);
        vault.requestRedeem(100e6);
        sim.processAll();
        vault.claimRedeem(); // send queued
        sim.processActions(); // held, not landed

        quote.mint(other, 100e6);
        vm.prank(other);
        quote.transfer(address(vault), 100e6); // donation covers what the send owes

        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);
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

    /// The attack the pruned-only relay closes: a keeper fixing a payout on a
    /// market Core has not resolved.
    function test_SettleOnLiveMarketRevertsEvenForKeeper() public {
        outcomeStatus.set(CoreConstants.OUTCOME_ACTIVE, 0, QUESTION);
        vm.expectRevert(bytes("NOT_SETTLED_ON_CORE"));
        vault.settle(1e18); // keeper == address(this)

        outcomeStatus.set(0, 0, QUESTION); // never existed
        vm.expectRevert(bytes("NOT_SETTLED_ON_CORE"));
        vault.settle(1e18);
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

    /// If the settled quote lands short, every holder takes the same haircut.
    /// Paying the first redeemer in full would leave the last one unable to
    /// redeem at all.
    function test_SettledRedemptionIsProRataWhenShort() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(100); // settlement credit lands 1% short
        vault.settle(0.5e18);
        sim.creditSettlement();
        vault.pullSettledFunds();
        sim.processAll();

        uint256 available = quote.balanceOf(address(vault));
        assertEq(available, 99e6);

        vm.startPrank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 49.5e6, "early redeemer did not take the pro-rata haircut");
        vault.redeemSettled(false, 100e6); // tail redeemer must still be payable
        vm.stopPrank();

        assertEq(quote.balanceOf(user), 900e6 + available);
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    /// The sweep gate must key off quote the vault actually received, not off
    /// an absolute Core-balance read: a 1-wei credit is cheap, repeatable, and
    /// would otherwise hold settlement redemption shut forever.
    function test_StrayCoreCreditCannotHoldSettlementShut() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();
        vault.pullSettledFunds();
        sim.processAll(); // sweep has genuinely arrived
        sim.creditStray(1); // griefer credits the vault's Core account

        vm.prank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 50e6);

        sim.creditStray(1); // and again, between redemptions
        vm.prank(user);
        vault.redeemSettled(false, 100e6);
        assertEq(quote.balanceOf(user), 1_000e6);
    }

    /// Pricing a payout against the raw Core balance counts quote a previous
    /// unlanded send has already claimed. Core then drops the oversized send in
    /// silence, leaving `owed` — and `totalOwed`, which reserves quote out of
    /// the settlement pool — pointing at money that never arrives.
    function test_StackedPayoutsCreditOnlyWhatCoreWillDeliver() public {
        depositAndClaim(100e6);
        sim.setMergeFeeBps(50); // 0.5% Core fee on each merge
        sim.setDeferSpotSends(true);

        vm.prank(user);
        vault.requestRedeem(60e6);
        sim.processAll();
        vault.claimRedeem(); // A: 60 asked, 59.7 available

        vm.prank(user);
        vault.requestRedeem(40e6);
        sim.processAll(); // A is still in the air
        vault.claimRedeem(); // B must price against 39.8, not the full 99.5
        sim.processActions();
        sim.processSpotSends(2); // both sends land

        assertEq(vault.owed(user), 99.5e6, "credited more than Core delivers");
        assertEq(vault.totalOwed(), quote.balanceOf(address(vault)), "phantom quote reserved");
        vm.prank(user);
        vault.withdraw();
        assertEq(quote.balanceOf(user), 900e6 + 99.5e6);
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    function test_ConstructorRequiresDepositWalletCode() public {
        vm.etch(CoreConstants.CORE_DEPOSIT_WALLET, hex"");
        vm.expectRevert(bytes("NO_DEPOSIT_WALLET"));
        new OutcomeVault(
            IERC20(address(quote)), SYSTEM_ADDR, TOKEN_INDEX, QUESTION, OUTCOME, keeper, verifier, "BTC100K", DECIMALS
        );
    }

    /// Settled payouts round down — the remainder stays with the vault — and a
    /// payout that rounds to nothing is refused rather than burning the
    /// position for free.
    function test_SettledRedemptionRoundsDownToVault() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();
        vault.pullSettledFunds();
        sim.processAll();

        uint256 before = quote.balanceOf(user);
        vm.prank(user);
        vault.redeemSettled(true, 3); // 3 * 0.5 rounds down to 1
        assertEq(quote.balanceOf(user), before + 1);
        assertEq(vault.oYes().balanceOf(user), 100e6 - 3);

        vm.prank(user);
        vm.expectRevert(bytes("NOTHING_TO_REDEEM"));
        vault.redeemSettled(true, 1); // 1 * 0.5 rounds to 0
        assertEq(vault.oYes().balanceOf(user), 100e6 - 3, "position burned for nothing");
    }

    /// The settlement sweep is async. Redeeming inside that window used to burn
    /// the position for a zero (or haircut) payout; it must wait instead.
    function test_SettledRedemptionBlockedUntilSweepLands() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();

        vm.prank(user);
        // Pull not even requested: the gate is unarmed, whatever the pool
        // holds — the arrival check alone would pass trivially here.
        vm.expectRevert(bytes("SWEEP_PENDING"));
        vault.redeemSettled(true, 100e6);

        vault.pullSettledFunds();
        vm.prank(user);
        vm.expectRevert(bytes("SWEEP_PENDING")); // queued, not landed
        vault.redeemSettled(true, 100e6);
        assertEq(vault.oYes().balanceOf(user), 100e6, "position survived the window");

        sim.processAll();
        vm.prank(user);
        vault.redeemSettled(true, 100e6);
        assertEq(quote.balanceOf(user), 900e6 + 50e6);
    }

    /// Before anyone cranks the pull, `_unlandedEvm() == 0` holds trivially,
    /// and a 2-wei quote donation used to defeat the zero-payout backstop:
    /// obligation 100e6, pool 2 wei, payout 1 wei — full position burned for
    /// dust. The gate must be armed by the pull itself, not by arrivals.
    function test_DonationBeforePullCannotForceSettledRedemption() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        sim.creditSettlement();

        quote.mint(other, 2);
        vm.prank(other);
        quote.transfer(address(vault), 2); // griefer's dust donation

        vm.prank(user);
        vm.expectRevert(bytes("SWEEP_PENDING"));
        vault.redeemSettled(true, 100e6);
        assertEq(vault.oYes().balanceOf(user), 100e6, "position burned for dust");
    }

    /// Pulling with nothing on Core still arms the gate: "nothing left to
    /// sweep" IS the swept state, and the crank stays permissionless — the
    /// zero-payout backstop (not the gate) is what guards an empty pool.
    function test_PullWithZeroCoreBalanceArmsTheGate() public {
        depositAndClaim(100e6);
        vault.settle(0.5e18);
        // Core never credits: its balance is already 0 at pull time.

        vm.prank(user);
        vm.expectRevert(bytes("SWEEP_PENDING"));
        vault.redeemSettled(true, 100e6);

        vault.pullSettledFunds(); // nothing to sweep, but the gate arms
        vm.prank(user);
        vm.expectRevert(bytes("NOTHING_TO_REDEEM")); // past the gate now
        vault.redeemSettled(true, 100e6);
        assertEq(vault.oYes().balanceOf(user), 100e6);
    }

    /// Unwithdrawn `owed` is not part of the settlement pool: paying it out
    /// pro rata would leave the earlier claimant's withdraw() reverting.
    function test_ProRataDoesNotSpendUnwithdrawnOwed() public {
        vm.prank(user);
        vault.deposit(200e6);
        sim.processAll();
        vault.claimDeposit();

        sim.setMergeFeeBps(50); // 0.5% Core fee, inside payout tolerance
        vm.prank(user);
        vault.requestRedeem(50e6);
        sim.processAll();
        vault.claimRedeem(); // owed credited, deliberately not withdrawn
        sim.processAll();
        assertEq(vault.totalOwed(), 49.75e6);

        vault.settle(0.5e18);
        sim.creditSettlement();
        vault.pullSettledFunds();
        sim.processAll();

        vm.startPrank(user);
        vault.redeemSettled(true, 150e6);
        vault.redeemSettled(false, 150e6);
        vault.withdraw(); // must still be funded
        vm.stopPrank();

        assertEq(quote.balanceOf(user), 999e6);
        assertEq(quote.balanceOf(address(vault)), 0);
        assertEq(vault.totalOwed(), 0);
    }

    /// Stacked outbounds: a second payout queued before the first debit lands.
    /// The dwell must not clear when only the first has landed, or the next
    /// deposit records an inflated baseline and its refund proof is
    /// unsatisfiable — which clearOutbound cannot undo.
    function test_StackedOutboundsHoldTheDwell() public {
        depositAndClaim(100e6);
        sim.setDeferSpotSends(true);

        vm.prank(user);
        vault.requestRedeem(60e6);
        sim.processAll();
        vault.claimRedeem(); // outbound A queued (60)

        vm.prank(user);
        vault.requestRedeem(40e6);
        sim.processAll(); // merge credits 40 while A is still unlanded
        vault.claimRedeem(); // outbound B queued (40)
        sim.processActions(); // both sends are now held, neither has landed

        sim.processSpotSends(1); // only A lands
        vm.prank(user);
        vm.expectRevert(bytes("OUTBOUND_IN_FLIGHT"));
        vault.deposit(100e6);

        sim.processSpotSends(1); // B lands too
        vm.prank(user);
        vault.deposit(100e6);
        (,,, uint64 baseline) = vault.pendingDeposit();
        assertEq(baseline, 0, "baseline recorded over an unlanded transfer");
    }
}
