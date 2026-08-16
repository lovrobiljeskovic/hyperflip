// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreConstants, ICoreWriter} from "./CoreConstants.sol";
import {IExecutionVerifier} from "./IExecutionVerifier.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// Per-market vault wrapping a HIP-4 binary outcome as oYES/oNO ERC-20s.
/// See ~/docs/superpowers/specs/2026-08-12-hyperevm-outcome-composability-design.md for the design spec.
///
/// Split/merge execution is NOT observable from the EVM (script/spike/FINDINGS.md
/// kill-switch: outcome balances have no precompile and no token index), so
/// every claim/cancel is gated on an `IExecutionVerifier` attestation instead
/// of an on-chain balance proof. Today that verifier is a keeper; the owner can
/// swap it for anything else — a dead or lying keeper is recovered by
/// `setVerifier`, not by a timeout. Cancel therefore requires an explicit
/// `Failed` verdict: elapsed time proves nothing about a Core action.
///
/// The one thing the vault still reads on-chain is its own Core *quote*
/// balance (token 0 at 0x801), used to prove a refund is actually funded, and
/// the settlement fraction at 0x814.
contract OutcomeVault {
    using SafeERC20 for IERC20;

    enum OpType {
        Split,
        Merge
    }

    IERC20 public immutable quote;
    /// spotSend destination for Core→EVM: the quote token's system address,
    /// never address(this) (FINDINGS.md #4).
    address public immutable coreSystemAddress;
    uint64 public immutable quoteTokenCoreIndex;
    /// 10**quoteDecimals — EVM quote units in one share (1 share = 1 USDC).
    uint256 public immutable evmUnitsPerShare;
    uint32 public immutable question;
    uint32 public immutable outcome;
    address public immutable keeper;
    OutcomeToken public immutable oYes;
    OutcomeToken public immutable oNo;

    address public owner;
    IExecutionVerifier public verifier;

    /// Vestigial. Cancel is gated on a Failed attestation, never on elapsed
    /// time; this constant survives only because the do-not-edit anchor suite
    /// warps by it. Delete when that file is next regenerated.
    uint256 public constant CANCEL_TIMEOUT = 1 hours;

    struct PendingDeposit {
        address user;
        uint256 amount;
        uint256 opId;
        uint64 quoteCoreBefore;
    }

    struct PendingRedeem {
        address user;
        uint256 amount;
        uint256 opId;
    }

    PendingDeposit public pendingDeposit;
    PendingRedeem public pendingRedeem;
    mapping(address => uint256) public owed;
    /// Sum of `owed`: quote already promised to earlier claimants, which
    /// settlement redemption must not treat as part of its pool.
    uint256 public totalOwed;
    uint256 public nextOpId;
    bool public settled;
    uint256 public settleFractionWad;

    /// spotSend is asynchronous and the Core-side debit lands later. A pending
    /// deposit's `quoteCoreBefore` baseline taken in that window would be
    /// stale, making a later refund proof unsatisfiable (the wedge bug), so
    /// new operations wait until the debit is observed.
    uint64 internal outboundTarget;
    uint64 internal outboundWei;

    /// Cumulative EVM quote our Core→EVM sends should have delivered, and
    /// cumulative EVM quote that has left the vault. Whatever the first exceeds
    /// the second plus the balance on hand is still in the air. Both are
    /// derived from the vault's own transfers, so unlike a Core-balance read
    /// nobody can hold them false with a stray credit.
    uint256 internal outboundExpectedEvm;
    uint256 internal totalPaidOutEvm;

    /// Armed only by `pullSettledFunds` (and the owner's `clearOutbound`),
    /// never by arrivals: before any pull, `_unlandedEvm() == 0` holds
    /// trivially and a 2-wei quote donation (or stray EVM dust) would slip
    /// past the zero-payout backstop, burning a full position for dust. The
    /// flag says "a sweep was actually sent"; `_unlandedEvm()` then says it
    /// landed. It never un-arms — a later stray can at most be swept again.
    bool internal swept;

    /// A payout is credited in full unless Core returned less than asked; both
    /// numbers are logged so a shortfall is visible off-chain.
    uint256 internal constant PAYOUT_MIN_BPS = 9_900;

    /// Everything a keeper needs to attest: opKey is keccak256(abi.encode(vault, opId)).
    event OpQueued(uint256 indexed opId, OpType opType, uint32 question, uint32 outcome, uint64 weiAmount);
    event VerifierChanged(address indexed verifier);
    event Payout(address indexed user, uint64 requestedWei, uint64 creditedWei);

    constructor(
        IERC20 quote_,
        address coreSystemAddress_,
        uint64 quoteTokenCoreIndex_,
        uint32 question_,
        uint32 outcome_,
        address keeper_,
        IExecutionVerifier verifier_,
        string memory marketSymbol,
        uint8 quoteDecimals
    ) {
        // A raw call to a codeless address succeeds silently, which would send
        // every deposit into the void while reporting success (FINDINGS.md #3).
        require(CoreConstants.CORE_DEPOSIT_WALLET.code.length > 0, "NO_DEPOSIT_WALLET");
        quote = quote_;
        coreSystemAddress = coreSystemAddress_;
        quoteTokenCoreIndex = quoteTokenCoreIndex_;
        evmUnitsPerShare = 10 ** quoteDecimals;
        question = question_;
        outcome = outcome_;
        keeper = keeper_;
        owner = msg.sender;
        verifier = verifier_;
        // oYES/oNO are minted 1:1 with quote units, so they carry its decimals.
        oYes = new OutcomeToken(
            string.concat("Outcome Yes ", marketSymbol), string.concat("oYES-", marketSymbol), quoteDecimals
        );
        oNo = new OutcomeToken(
            string.concat("Outcome No ", marketSymbol), string.concat("oNO-", marketSymbol), quoteDecimals
        );
    }

    /// The swap seam: if the keeper dies or lies, the owner points the vault at
    /// a different attestation source and stuck funds become claimable again.
    function setVerifier(IExecutionVerifier verifier_) external {
        require(msg.sender == owner, "NOT_OWNER");
        verifier = verifier_;
        emit VerifierChanged(address(verifier_));
    }

    /// Escape hatch for both outbound trackers. An unsolicited Core credit can
    /// hold the unlanded accumulator above zero indefinitely (it masks the
    /// balance drop that retires it), and a sweep whose spotSend Core dropped
    /// on the floor would otherwise keep settlement redemption shut.
    function clearOutbound() external {
        require(msg.sender == owner, "NOT_OWNER");
        outboundWei = 0;
        outboundExpectedEvm = quote.balanceOf(address(this)) + totalPaidOutEvm;
        // Core-has-nothing-left corner: a settlement sweep Core dropped can
        // never land, so the owner writing reality down also opens the gate.
        if (settled) swept = true;
    }

    function deposit(uint256 amount) external {
        require(!settled, "SETTLED");
        _requireIdle();
        _requireOutboundLanded();
        uint64 w = _toOutcomeWei(amount);
        uint256 opId = ++nextOpId;
        pendingDeposit =
            PendingDeposit({user: msg.sender, amount: amount, opId: opId, quoteCoreBefore: _quoteCoreBalance()});
        quote.safeTransferFrom(msg.sender, address(this), amount);
        // EVM→Core is approve + deposit() on the Core deposit wallet; an ERC-20
        // transfer to the system address reverts, it is blacklisted (FINDINGS.md #3).
        quote.forceApprove(CoreConstants.CORE_DEPOSIT_WALLET, amount);
        (bool ok,) = CoreConstants.CORE_DEPOSIT_WALLET.call(CoreConstants.encodeDeposit(amount));
        require(ok, "CORE_DEPOSIT_FAILED");
        _sendRawAction(CoreConstants.encodeOutcomeOp(CoreConstants.OP_SPLIT_OUTCOME, outcome, w));
        emit OpQueued(opId, OpType.Split, question, outcome, w);
    }

    function claimDeposit() external {
        PendingDeposit memory p = pendingDeposit;
        require(p.user != address(0), "NO_PENDING");
        require(_statusOf(p.opId) == IExecutionVerifier.Status.Executed, "SPLIT_NOT_CONFIRMED");
        delete pendingDeposit;
        oYes.mint(p.user, p.amount);
        oNo.mint(p.user, p.amount);
    }

    /// Recovery when Core dropped the split: refund the depositor from the
    /// vault's Core quote balance. Requires an explicit Failed attestation AND
    /// proof the EVM→Core credit landed (else the refund spotSend would itself
    /// be silently rejected).
    function cancelDeposit() external {
        PendingDeposit memory p = pendingDeposit;
        require(p.user != address(0), "NO_PENDING");
        require(_statusOf(p.opId) == IExecutionVerifier.Status.Failed, "SPLIT_NOT_FAILED");
        require(_quoteCoreBalance() >= p.quoteCoreBefore + _toQuoteWei(p.amount), "CREDIT_NOT_ARRIVED");
        delete pendingDeposit;
        _payOut(p.user, p.amount);
    }

    function requestRedeem(uint256 amount) external {
        require(!settled, "SETTLED");
        _requireIdle();
        uint64 w = _toOutcomeWei(amount);
        oYes.burn(msg.sender, amount);
        oNo.burn(msg.sender, amount);
        uint256 opId = ++nextOpId;
        pendingRedeem = PendingRedeem({user: msg.sender, amount: amount, opId: opId});
        _sendRawAction(CoreConstants.encodeOutcomeOp(CoreConstants.OP_MERGE_OUTCOME, outcome, w));
        emit OpQueued(opId, OpType.Merge, question, outcome, w);
    }

    function claimRedeem() external {
        PendingRedeem memory p = pendingRedeem;
        require(p.user != address(0), "NO_PENDING");
        require(_statusOf(p.opId) == IExecutionVerifier.Status.Executed, "MERGE_NOT_CONFIRMED");
        delete pendingRedeem;
        _payOut(p.user, p.amount);
    }

    /// Recovery when Core never delivered the merge: re-mint the burned pair to
    /// the redeemer. Proof is the exact complement of claimRedeem's, so the two
    /// paths can never both fire.
    function cancelRedeem() external {
        PendingRedeem memory p = pendingRedeem;
        require(p.user != address(0), "NO_PENDING");
        require(_statusOf(p.opId) == IExecutionVerifier.Status.Failed, "MERGE_NOT_FAILED");
        delete pendingRedeem;
        oYes.mint(p.user, p.amount);
        oNo.mint(p.user, p.amount);
    }

    function withdraw() external {
        uint256 amount = owed[msg.sender];
        require(amount > 0, "NOTHING_OWED");
        owed[msg.sender] = 0;
        totalOwed -= amount;
        totalPaidOutEvm += amount;
        quote.safeTransfer(msg.sender, amount);
    }

    /// Settlement comes from the 0x814 precompile: at status 2 anyone can
    /// settle and the caller's `fractionWad` is ignored. Core prunes settled
    /// outcomes fast (FINDINGS.md: 2→3 within ~10 minutes) and status 3 has no
    /// value left, so that — and only that — is where the keeper may relay the
    /// fraction it observed. A live market (status 0/1) can never be settled by
    /// anyone, keeper included: relaying a payout for a market Core has not
    /// resolved is the whole attack. Crank early.
    /// Reverts while an operation is in flight — pending slots must clear
    /// first, else the settlement sweep would strand their recovery proofs.
    function settle(uint256 fractionWad) external {
        require(!settled, "ALREADY_SETTLED");
        _requireIdle();
        (uint8 status, uint64 settledValue, uint32 question_) = CoreConstants.outcomeStatus(outcome);
        if (status == CoreConstants.OUTCOME_SETTLED) {
            require(question_ == question, "QUESTION_MISMATCH");
            fractionWad = uint256(settledValue) * 1e18 / CoreConstants.SETTLED_VALUE_ONE;
        } else {
            require(status == CoreConstants.OUTCOME_PRUNED, "NOT_SETTLED_ON_CORE");
            require(msg.sender == keeper, "NOT_KEEPER");
        }
        require(fractionWad <= 1e18, "BAD_FRACTION");
        settled = true;
        settleFractionWad = fractionWad;
    }

    /// Move the settled quote from the vault's Core account to the EVM side so
    /// redeemSettled can pay. Permissionless — and (with the owner's
    /// clearOutbound) the only thing that arms the redemption gate, so
    /// cranking it is part of settling. A zero-balance pull must NOT arm:
    /// Core's balance is zero by construction until it credits settlement, so
    /// a free premature pull would arm the gate with nothing swept and hand
    /// the 2-wei donation attack right back. Pull again once the credit
    /// lands; if Core never credits, recovery is the owner's clearOutbound.
    function pullSettledFunds() external {
        require(settled, "NOT_SETTLED");
        uint64 bal = _quoteCoreBalance();
        if (bal > 0) {
            swept = true;
            _spotSendOut(bal);
        }
    }

    /// Payouts round down and, if the settled quote that came back is short of
    /// what the outstanding supply is owed, scale pro rata against what is
    /// actually here. Paying the early redeemers in full would leave the last
    /// one holding tokens the vault cannot honor at all.
    ///
    /// Blocked until a settlement sweep was requested (`swept`) AND is no
    /// longer in the air (`_unlandedEvm() == 0`): pro-rata against a pool that
    /// has not arrived would haircut (or wipe out) whoever redeems first while
    /// the stragglers over-collect. Without the flag the arrival check holds
    /// trivially before any pull, and dust donated to the vault defeats the
    /// zero-payout backstop. Arrival is measured on the EVM side — the quote
    /// the sweep owes has shown up — never by reading the Core balance, which
    /// anyone can perturb with a 1-wei credit. Once observed, the expectation
    /// is retired, so a later stray cannot re-lock redemption; a fresh
    /// `pullSettledFunds` is the only thing that arms it again.
    function redeemSettled(bool isYes, uint256 amount) external {
        require(settled, "NOT_SETTLED");
        require(swept && _unlandedEvm() == 0, "SWEEP_PENDING");
        uint256 fraction = isYes ? settleFractionWad : 1e18 - settleFractionWad;
        uint256 payout = amount * fraction / 1e18;
        uint256 obligation = _settlementObligation();
        uint256 available = _unreservedBalance();
        if (obligation > available) payout = payout * available / obligation;
        // Never burn a position for nothing.
        require(payout > 0, "NOTHING_TO_REDEEM");
        (isYes ? oYes : oNo).burn(msg.sender, amount);
        totalPaidOutEvm += payout;
        quote.safeTransfer(msg.sender, payout);
    }

    /// EVM quote that settlement may pay out: the balance less what withdraw()
    /// still owes earlier claimants. Saturates because a payout's `owed` is
    /// credited when it is queued, before the quote lands on the EVM side.
    function _unreservedBalance() internal view returns (uint256) {
        uint256 bal = quote.balanceOf(address(this));
        return bal > totalOwed ? bal - totalOwed : 0;
    }

    /// What every outstanding oYES/oNO is entitled to at the settled fraction.
    function _settlementObligation() internal view returns (uint256) {
        return (oYes.totalSupply() * settleFractionWad + oNo.totalSupply() * (1e18 - settleFractionWad)) / 1e18;
    }

    function _statusOf(uint256 opId) internal view returns (IExecutionVerifier.Status) {
        return verifier.statusOf(keccak256(abi.encode(address(this), opId)));
    }

    function _requireIdle() internal view {
        require(pendingDeposit.user == address(0) && pendingRedeem.user == address(0), "BUSY");
    }

    /// Only `deposit` records a Core-balance baseline, so only `deposit` has to
    /// wait for outbound debits to land. Kept off `requestRedeem`/`settle`,
    /// which take no baseline and must never be blockable by a third party.
    /// The dwell reads the Core side because that is where a stale baseline
    /// would do its damage, and a stray credit can only hold it SHUT — the safe
    /// direction, escapable by `clearOutbound`. Note the accumulator is a
    /// conservative ratchet, not an exact figure: it counts every send since
    /// the last successful check, and a stray credit masks the balance drop
    /// that would retire it. Nothing else may price against it; money
    /// decisions use `_unlandedEvm`, which no third party can perturb.
    function _requireOutboundLanded() internal {
        if (outboundWei == 0) return;
        require(_quoteCoreBalance() <= outboundTarget, "OUTBOUND_IN_FLIGHT");
        outboundWei = 0;
    }

    /// EVM quote our own sends still owe us: what they should have delivered,
    /// less what is on hand plus what has already been paid out. Donated quote
    /// makes this retire early, but a donation is quote actually sitting in the
    /// vault, so nothing is credited that cannot be honored.
    function _unlandedEvm() internal view returns (uint256) {
        uint256 arrived = quote.balanceOf(address(this)) + totalPaidOutEvm;
        return outboundExpectedEvm > arrived ? outboundExpectedEvm - arrived : 0;
    }

    /// Queue the Core→EVM leg of a payout and record what the user may
    /// withdraw once it lands. Sends at most the vault's free Core quote
    /// balance and credits only what was actually sent, so a shortfall is never
    /// paid out of another user's collateral. A fee-sized gap (FINDINGS.md #5
    /// measured 7 bps) is absorbed; anything below PAYOUT_MIN_BPS is a credit
    /// that has not landed yet rather than a fee, so the call reverts and the
    /// pending slot survives for a retry instead of burning the user's claim.
    function _payOut(address user, uint256 amount) internal {
        // Quote already promised to a send that has not arrived is not ours to
        // pay with: pricing against the raw Core balance would credit `owed`
        // for quote that never lands (Core drops the oversized send in
        // silence) and reserve it out of the settlement pool forever.
        uint256 coreEvm = CoreConstants.quoteWeiToEvm(_quoteCoreBalance(), evmUnitsPerShare);
        uint256 unlanded = _unlandedEvm();
        uint256 available = coreEvm > unlanded ? coreEvm - unlanded : 0;
        uint256 credit = amount > available ? available : amount;
        require(credit * 10_000 >= amount * PAYOUT_MIN_BPS, "CORE_CREDIT_SHORT");
        uint64 credited = _toQuoteWei(credit);
        owed[user] += credit;
        totalOwed += credit;
        emit Payout(user, _toQuoteWei(amount), credited);
        _spotSendOut(credited);
    }

    /// Sends stack: a second payout can be queued before the first debit lands,
    /// and the balance read here still contains every unlanded debit. Summing
    /// them and subtracting from the live balance therefore gives the balance
    /// expected once all counted sends land, so the dwell cannot clear on a
    /// partial landing. Saturating at 0 rather than reverting only makes the
    /// target harder to reach — never easier.
    function _spotSendOut(uint64 w) internal {
        outboundExpectedEvm += CoreConstants.quoteWeiToEvm(w, evmUnitsPerShare);
        outboundWei += w;
        uint64 bal = _quoteCoreBalance();
        outboundTarget = bal > outboundWei ? bal - outboundWei : 0;
        _sendRawAction(CoreConstants.encodeSpotSend(coreSystemAddress, quoteTokenCoreIndex, w));
    }

    function _toOutcomeWei(uint256 amount) internal view returns (uint64) {
        return CoreConstants.evmToOutcomeWei(amount, evmUnitsPerShare);
    }

    function _toQuoteWei(uint256 amount) internal view returns (uint64) {
        return CoreConstants.evmToQuoteWei(amount, evmUnitsPerShare);
    }

    function _quoteCoreBalance() internal view returns (uint64) {
        return CoreConstants.spotBalance(address(this), quoteTokenCoreIndex);
    }

    function _sendRawAction(bytes memory payload) internal {
        ICoreWriter(CoreConstants.CORE_WRITER).sendRawAction(payload);
    }
}
