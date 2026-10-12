// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreConstants, ICoreWriter} from "./CoreConstants.sol";
import {IExecutionVerifier} from "./IExecutionVerifier.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// Per-market vault wrapping a HIP-4 binary outcome as oYES/oNO ERC-20s.
///
/// Claims and cancels are gated on an `IExecutionVerifier` attestation (today a
/// keeper), never on elapsed time: a dead or lying keeper is replaced through
/// `setVerifier`, and cancel needs an explicit `Failed` verdict. The vault reads
/// Core itself only for its own quote balance (0x801) and the settlement fraction
/// (0x814). Known pre-mainnet issue M1 (a deposit Core never credits wedges the
/// vault) is documented in DEPLOY.md.
contract OutcomeVault {
    using SafeERC20 for IERC20;

    enum OpType {
        Split,
        Merge
    }

    IERC20 public immutable quote;
    /// Core→EVM spotSend destination: the quote token's system address, never address(this).
    address public immutable coreSystemAddress;
    uint64 public immutable quoteTokenCoreIndex;
    /// 10**quoteDecimals — EVM quote units in one share (1 share = 1 USDC).
    uint256 public immutable evmUnitsPerShare;
    uint32 public immutable question;
    uint32 public immutable outcome;
    /// Settle authority for the pruned branch only; owner-rotatable.
    address public keeper;
    OutcomeToken public immutable oYes;
    OutcomeToken public immutable oNo;

    address public owner;
    IExecutionVerifier public verifier;

    /// Unused by the vault; read by the frozen test/anchor suite.
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
    /// Sum of `owed`; settlement redemption must not pay out of it.
    uint256 public totalOwed;
    uint256 public nextOpId;
    bool public settled;
    uint256 public settleFractionWad;

    /// Core-side dwell: a spotSend debits Core later, and a deposit baseline taken
    /// in that window would be stale, so deposits wait until the debit is observed.
    uint64 internal outboundTarget;
    uint64 internal outboundWei;

    /// EVM-side arrival tracker: what our sends should have delivered vs what has
    /// left the vault. Derived from our own transfers, so a stray Core credit cannot
    /// perturb it; the excess over balance + paid out is still in the air.
    uint256 internal outboundExpectedEvm;
    uint256 internal totalPaidOutEvm;

    /// "A settlement sweep was sent." Armed only by `pullSettledFunds` and
    /// `clearOutbound`, never by arrivals: before any pull `_unlandedEvm() == 0`
    /// holds trivially and a dust donation could burn a full position for nothing.
    bool internal swept;

    /// Fee tolerance for the payout credit (`_payOut`) and the settlement pool floor (`redeemSettled`).
    uint256 internal constant PAYOUT_MIN_BPS = 9_900;

    /// Everything a keeper needs to attest: opKey is keccak256(abi.encode(vault, opId)).
    event OpQueued(uint256 indexed opId, OpType opType, uint32 question, uint32 outcome, uint64 weiAmount);
    event VerifierChanged(address indexed verifier);
    event KeeperChanged(address indexed keeper);
    event OwnerChanged(address indexed owner);
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
        // A raw call to a codeless address succeeds silently, sending every deposit into the void.
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
        oYes = new OutcomeToken(
            string.concat("Outcome Yes ", marketSymbol), string.concat("oYES-", marketSymbol), quoteDecimals
        );
        oNo = new OutcomeToken(
            string.concat("Outcome No ", marketSymbol), string.concat("oNO-", marketSymbol), quoteDecimals
        );
    }

    function setVerifier(IExecutionVerifier verifier_) external {
        require(msg.sender == owner, "NOT_OWNER");
        verifier = verifier_;
        emit VerifierChanged(address(verifier_));
    }

    function setKeeper(address keeper_) external {
        require(msg.sender == owner, "NOT_OWNER");
        keeper = keeper_;
        emit KeeperChanged(keeper_);
    }

    function setOwner(address owner_) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(owner_ != address(0), "ZERO_ADDRESS");
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    /// Owner escape hatch for both outbound trackers: a stray Core credit can hold
    /// the dwell shut forever, and a sweep Core dropped would keep redemption shut.
    function clearOutbound() external {
        require(msg.sender == owner, "NOT_OWNER");
        outboundWei = 0;
        outboundExpectedEvm = quote.balanceOf(address(this)) + totalPaidOutEvm;
        // A dropped settlement sweep can never land; writing reality down opens the gate.
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
        // EVM→Core is approve + deposit() on the deposit wallet (see CoreConstants).
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

    /// Refund after a dropped split. Needs a Failed attestation AND proof the
    /// EVM→Core credit landed, else the refund spotSend would itself be dropped.
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

    /// Re-mint after a dropped merge; the complement of claimRedeem's proof.
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

    /// At Core status 2 anyone settles and `fractionWad` is ignored (read from
    /// 0x814). At status 3 the value is pruned, so only there may the keeper relay
    /// the fraction it observed. A live market can never be settled by anyone.
    /// Pending slots must clear first or the sweep would strand their proofs.
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

    /// Sweep the settled quote from Core to the EVM side. Permissionless, and the
    /// thing that arms `swept`. A zero-balance pull must not arm: Core holds
    /// nothing until it credits settlement, and an armed gate with nothing swept
    /// reopens the dust-donation burn. Pull again once the credit lands.
    function pullSettledFunds() external {
        require(settled, "NOT_SETTLED");
        // Floor to whole EVM units (Core drops non-representable sends, see
        // CoreConstants) and strand fee dust; a sub-unit stray cannot arm the gate.
        uint64 bal = _quoteCoreBalance();
        uint256 evm = CoreConstants.quoteWeiToEvm(bal, evmUnitsPerShare);
        if (evm > 0) {
            swept = true;
            _spotSendOut(_toQuoteWei(evm));
        }
    }

    /// Pays pro rata against the pool actually here, and only once the sweep was
    /// sent (`swept`) and has landed on the EVM side (`_unlandedEvm() == 0`):
    /// paying early redeemers in full from a pool still in the air would haircut
    /// the last ones. Arrival is measured on the EVM side, never from the Core
    /// balance, which anyone can perturb with a 1-wei credit.
    function redeemSettled(bool isYes, uint256 amount) external {
        require(settled, "NOT_SETTLED");
        require(swept && _unlandedEvm() == 0, "SWEEP_PENDING");
        uint256 fraction = isYes ? settleFractionWad : 1e18 - settleFractionWad;
        uint256 payout = amount * fraction / 1e18;
        uint256 obligation = _settlementObligation();
        uint256 available = _unreservedBalance();
        // Pool must cover PAYOUT_MIN_BPS of the obligation: `payout > 0` is no
        // backstop under pro-rata (a 2-wei pool still pays 1 wei for a full burn).
        // A genuine >1% shortfall reverts; recovery is the owner topping up.
        require(available * 10_000 >= obligation * PAYOUT_MIN_BPS, "SETTLEMENT_POOL_SHORT");
        if (obligation > available) payout = payout * available / obligation;
        require(payout > 0, "NOTHING_TO_REDEEM");
        (isYes ? oYes : oNo).burn(msg.sender, amount);
        totalPaidOutEvm += payout;
        quote.safeTransfer(msg.sender, payout);
    }

    /// Balance less what withdraw() still owes; saturates because `owed` is
    /// credited before the quote lands.
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

    /// Only `deposit` takes a Core baseline, so only `deposit` dwells; redeem and
    /// settle must never be blockable by a third party. A stray credit can only
    /// hold the dwell shut (safe direction, escapable by `clearOutbound`). The
    /// accumulator is a conservative ratchet; money decisions use `_unlandedEvm`.
    function _requireOutboundLanded() internal {
        if (outboundWei == 0) return;
        require(_quoteCoreBalance() <= outboundTarget, "OUTBOUND_IN_FLIGHT");
        outboundWei = 0;
    }

    /// EVM quote our sends still owe us. Donations retire it early, but a
    /// donation is quote actually here, so nothing uncoverable is credited.
    function _unlandedEvm() internal view returns (uint256) {
        uint256 arrived = quote.balanceOf(address(this)) + totalPaidOutEvm;
        return outboundExpectedEvm > arrived ? outboundExpectedEvm - arrived : 0;
    }

    /// Queue the Core→EVM leg of a payout and record what the user may withdraw.
    /// Credits only what was actually sent, so a shortfall is never paid from
    /// another user's collateral. A fee-sized gap (~7 bps live) is absorbed;
    /// below PAYOUT_MIN_BPS the credit has not landed yet, so revert and keep the
    /// pending slot for a retry.
    function _payOut(address user, uint256 amount) internal {
        // Quote promised to an unlanded send is not ours to pay with.
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

    /// Core charges the spotSend fee on top of `w` (see CoreConstants), so the
    /// runbook keeps HYPE dust on the vault's Core account. Sends stack: the
    /// balance read here still contains every unlanded debit, so target = live
    /// balance minus all counted sends and the dwell cannot clear on a partial
    /// landing. Saturating at 0 only makes the target harder to reach.
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
