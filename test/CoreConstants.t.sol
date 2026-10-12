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

    /// Library calls are inlined, so expectRevert needs a real external call.
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

    /// Live evidence: a 5.0 EVM USDC deposit credited exactly 500,000,000 Core wei.
    function test_QuoteWeiMatchesSpikeEvidence() public pure {
        assertEq(uint256(CoreConstants.evmToQuoteWei(5e6, ONE_USDC_EVM)), 500_000_000);
    }

    /// The question word stays in the layout but is always 0 (CoreWriter drops non-zero).
    function test_EncodeOutcomeOpHardcodesQuestionZero() public pure {
        bytes memory payload = CoreConstants.encodeOutcomeOp(CoreConstants.OP_SPLIT_OUTCOME, 12385, 1e5);
        bytes memory expected = abi.encodePacked(
            CoreConstants.ENCODING_VERSION,
            CoreConstants.ACTION_OUTCOME_OP,
            abi.encode(CoreConstants.OP_SPLIT_OUTCOME, uint32(0), uint32(12385), uint64(1e5))
        );
        assertEq(payload, expected);
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
