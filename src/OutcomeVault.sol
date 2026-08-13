// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreConstants, ICoreWriter} from "./CoreConstants.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// Per-market vault wrapping a HIP-4 binary outcome as oYES/oNO ERC-20s.
/// See ~/docs/superpowers/specs/2026-08-12-hyperevm-outcome-composability-design.md for the design spec.
/// All mutating functions are stubs; the harness task graph implements them.
contract OutcomeVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable quote;
    address public immutable coreSystemAddress;
    uint64 public immutable quoteTokenCoreIndex;
    uint256 public immutable weiMultiplier;
    uint256 public immutable weiDivisor;
    uint32 public immutable question;
    uint32 public immutable outcome;
    address public immutable keeper;
    OutcomeToken public immutable oYes;
    OutcomeToken public immutable oNo;

    uint256 public constant CANCEL_TIMEOUT = 1 hours;

    struct PendingDeposit {
        address user;
        uint256 amount;
        uint64 quoteCoreBefore;
        uint64 outcomeYesBefore;
        uint256 timestamp;
    }

    struct PendingRedeem {
        address user;
        uint256 amount;
        uint64 outcomeYesBefore;
    }

    PendingDeposit public pendingDeposit;
    PendingRedeem public pendingRedeem;
    mapping(address => uint256) public owed;
    bool public settled;
    uint256 public settleFractionWad;

    constructor(
        IERC20 quote_,
        address coreSystemAddress_,
        uint64 quoteTokenCoreIndex_,
        uint256 weiMultiplier_,
        uint256 weiDivisor_,
        uint32 question_,
        uint32 outcome_,
        address keeper_,
        string memory marketSymbol,
        uint8 tokenDecimals
    ) {
        quote = quote_;
        coreSystemAddress = coreSystemAddress_;
        quoteTokenCoreIndex = quoteTokenCoreIndex_;
        weiMultiplier = weiMultiplier_;
        weiDivisor = weiDivisor_;
        question = question_;
        outcome = outcome_;
        keeper = keeper_;
        oYes = new OutcomeToken(
            string.concat("Outcome Yes ", marketSymbol), string.concat("oYES-", marketSymbol), tokenDecimals
        );
        oNo = new OutcomeToken(
            string.concat("Outcome No ", marketSymbol), string.concat("oNO-", marketSymbol), tokenDecimals
        );
    }

    function deposit(uint256 amount) external {
        require(!settled, "SETTLED");
        _requireIdle();
        uint64 w = _toWei(amount);
        pendingDeposit = PendingDeposit({
            user: msg.sender,
            amount: amount,
            quoteCoreBefore: _quoteCoreBalance(),
            outcomeYesBefore: _outcomeYesBalance(),
            timestamp: block.timestamp
        });
        quote.safeTransferFrom(msg.sender, address(this), amount);
        quote.safeTransfer(coreSystemAddress, amount);
        _sendRawAction(CoreConstants.encodeOutcomeOp(CoreConstants.OP_SPLIT_OUTCOME, question, outcome, w));
    }

    function claimDeposit() external {
        PendingDeposit memory p = pendingDeposit;
        require(p.user != address(0), "NO_PENDING");
        require(_outcomeYesBalance() >= p.outcomeYesBefore + _toWei(p.amount), "SPLIT_NOT_CONFIRMED");
        delete pendingDeposit;
        oYes.mint(p.user, p.amount);
        oNo.mint(p.user, p.amount);
    }

    /// Recovery when Core silently dropped the split: refund the depositor
    /// from the vault's Core quote balance. Requires proof the split did not
    /// execute AND that the EVM→Core credit landed (else the refund spotSend
    /// would itself be silently rejected).
    function cancelDeposit() external {
        PendingDeposit memory p = pendingDeposit;
        require(p.user != address(0), "NO_PENDING");
        require(block.timestamp > p.timestamp + CANCEL_TIMEOUT, "TOO_EARLY");
        uint64 w = _toWei(p.amount);
        require(_outcomeYesBalance() < p.outcomeYesBefore + w, "SPLIT_EXECUTED");
        require(_quoteCoreBalance() >= p.quoteCoreBefore + w, "CREDIT_NOT_ARRIVED");
        delete pendingDeposit;
        owed[p.user] += p.amount;
        _sendRawAction(CoreConstants.encodeSpotSend(address(this), quoteTokenCoreIndex, w));
    }

    function requestRedeem(uint256 amount) external {
        require(!settled, "SETTLED");
        _requireIdle();
        uint64 w = _toWei(amount);
        oYes.burn(msg.sender, amount);
        oNo.burn(msg.sender, amount);
        pendingRedeem = PendingRedeem({user: msg.sender, amount: amount, outcomeYesBefore: _outcomeYesBalance()});
        _sendRawAction(CoreConstants.encodeOutcomeOp(CoreConstants.OP_MERGE_OUTCOME, question, outcome, w));
    }

    function claimRedeem() external {
        PendingRedeem memory p = pendingRedeem;
        require(p.user != address(0), "NO_PENDING");
        uint64 w = _toWei(p.amount);
        require(_outcomeYesBalance() + w <= p.outcomeYesBefore, "MERGE_NOT_CONFIRMED");
        delete pendingRedeem;
        owed[p.user] += p.amount;
        _sendRawAction(CoreConstants.encodeSpotSend(address(this), quoteTokenCoreIndex, w));
    }

    function withdraw() external {
        uint256 amount = owed[msg.sender];
        require(amount > 0, "NOTHING_OWED");
        owed[msg.sender] = 0;
        quote.safeTransfer(msg.sender, amount);
    }

    function settle(uint256 fractionWad) external {
        fractionWad;
        revert("NOT_IMPLEMENTED");
    }

    function pullSettledFunds() external {
        revert("NOT_IMPLEMENTED");
    }

    function redeemSettled(bool isYes, uint256 amount) external {
        isYes;
        amount;
        revert("NOT_IMPLEMENTED");
    }

    function _requireIdle() internal view {
        require(pendingDeposit.user == address(0) && pendingRedeem.user == address(0), "BUSY");
    }

    /// EVM units → Core wei; reverts on zero, uint64 overflow, or dust that
    /// would not round-trip.
    function _toWei(uint256 amount) internal view returns (uint64) {
        uint256 w = amount * weiMultiplier / weiDivisor;
        require(w > 0 && w <= type(uint64).max, "BAD_AMOUNT");
        require(w * weiDivisor / weiMultiplier == amount, "DUST");
        return uint64(w);
    }

    function _quoteCoreBalance() internal view returns (uint64) {
        return CoreConstants.spotBalance(address(this), quoteTokenCoreIndex);
    }

    function _outcomeYesBalance() internal view returns (uint64) {
        return CoreConstants.spotBalance(address(this), CoreConstants.outcomeTokenIndex(outcome, true));
    }

    function _sendRawAction(bytes memory payload) internal {
        ICoreWriter(CoreConstants.CORE_WRITER).sendRawAction(payload);
    }
}
