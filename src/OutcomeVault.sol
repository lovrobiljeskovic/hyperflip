// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// Per-market vault wrapping a HIP-4 binary outcome as oYES/oNO ERC-20s.
/// See docs/harness/spec.md §4.3 for the state machine and invariants.
/// All mutating functions are stubs; the harness task graph implements them.
contract OutcomeVault {
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
        uint64 coreBalanceBefore;
        uint256 timestamp;
    }

    struct PendingRedeem {
        address user;
        uint256 amount;
        uint64 coreBalanceBefore;
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
        amount;
        revert("NOT_IMPLEMENTED");
    }

    function claimDeposit() external {
        revert("NOT_IMPLEMENTED");
    }

    function cancelDeposit() external {
        revert("NOT_IMPLEMENTED");
    }

    function requestRedeem(uint256 amount) external {
        amount;
        revert("NOT_IMPLEMENTED");
    }

    function claimRedeem() external {
        revert("NOT_IMPLEMENTED");
    }

    function withdraw() external {
        revert("NOT_IMPLEMENTED");
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
}
