// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoreConstants} from "../src/CoreConstants.sol";
import {MockOutcomeStatus} from "./mocks/Mocks.sol";

contract CoreConstantsTest is Test {
    // 1 share = 1e5 outcome wei = 1 USDC (1e6 evm) = 1e8 quote wei.
    uint256 internal constant ONE_USDC_EVM = 1e6;

    function test_OutcomeWeiIsFiveDecimalPerShare() public pure {
        assertEq(
            uint256(CoreConstants.evmToOutcomeWei(ONE_USDC_EVM, ONE_USDC_EVM)), CoreConstants.OUTCOME_WEI_PER_SHARE
        );
        // A 5-dec quote maps one EVM unit to one outcome wei.
        assertEq(uint256(CoreConstants.evmToOutcomeWei(7, 1e5)), 7);
    }

    /// Conversions reject dust rather than truncating: a truncated split would
    /// mint shares the collateral does not back. Rounding never favors the user.
    /// (Library calls are inlined, so expectRevert needs a real external call.)
    function toOutcomeWei(uint256 amountEvm, uint256 evmUnitsPerShare) external pure returns (uint64) {
        return CoreConstants.evmToOutcomeWei(amountEvm, evmUnitsPerShare);
    }

    function test_ConversionRejectsDust() public {
        vm.expectRevert(bytes("DUST"));
        this.toOutcomeWei(ONE_USDC_EVM + 1, ONE_USDC_EVM);
        vm.expectRevert(bytes("BAD_AMOUNT"));
        this.toOutcomeWei(0, ONE_USDC_EVM);
    }

    function test_QuoteWeiConversionRoundTrips() public pure {
        uint64 quoteWei = CoreConstants.evmToQuoteWei(ONE_USDC_EVM, ONE_USDC_EVM);
        assertEq(uint256(quoteWei), 1e8);
        assertEq(CoreConstants.quoteWeiToEvm(quoteWei, ONE_USDC_EVM), ONE_USDC_EVM);
    }

    /// FINDINGS.md: "5.0 EVM USDC deposit credited exactly 500,000,000 Core wei".
    function test_QuoteWeiMatchesSpikeEvidence() public pure {
        assertEq(uint256(CoreConstants.evmToQuoteWei(5e6, ONE_USDC_EVM)), 500_000_000);
    }

    /// FINDINGS.md #1: non-zero unused fields (question, on split/merge) are
    /// silently dropped by CoreWriter. The word is still in the payload layout,
    /// but encodeOutcomeOp takes no question argument and always writes 0.
    function test_EncodeOutcomeOpHardcodesQuestionZero() public pure {
        bytes memory payload = CoreConstants.encodeOutcomeOp(CoreConstants.OP_SPLIT_OUTCOME, 12385, 1e5);
        bytes memory expected = abi.encodePacked(
            CoreConstants.ENCODING_VERSION,
            CoreConstants.ACTION_OUTCOME_OP,
            abi.encode(CoreConstants.OP_SPLIT_OUTCOME, uint32(0), uint32(12385), uint64(1e5))
        );
        assertEq(payload, expected);
    }

    function test_EncodeDepositMatchesSelectorAndArgs() public pure {
        bytes memory got = CoreConstants.encodeDeposit(123e6);
        bytes memory want = abi.encodeWithSignature("deposit(uint256,uint32)", uint256(123e6), uint32(4294967295));
        assertEq(got, want);
    }

    function test_CoreDepositWalletAddress() public pure {
        assertEq(CoreConstants.CORE_DEPOSIT_WALLET, 0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206);
    }

    function test_OutcomeStatusReadsPrecompile() public {
        vm.etch(CoreConstants.OUTCOME_STATUS_PRECOMPILE, type(MockOutcomeStatus).runtimeCode);
        MockOutcomeStatus(CoreConstants.OUTCOME_STATUS_PRECOMPILE).set(2, 1e8, 976);
        (uint8 status, uint64 settledValue, uint32 question) = CoreConstants.outcomeStatus(12385);
        assertEq(status, 2);
        assertEq(uint256(settledValue), 1e8);
        assertEq(question, 976);
    }
}
