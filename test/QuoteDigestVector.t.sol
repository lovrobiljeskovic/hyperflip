// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

/// Prints a fixed-quote digest for the writer service's signature-parity test
/// (writer/test/quotes.test.ts). Forge test deploys are nonce-deterministic, so
/// the vault address and digest are stable across runs.
contract QuoteDigestVectorTest is Test {
    function test_quoteDigestVector() public {
        ParlayVault v = new ParlayVault(IERC20(address(0xDEAD)), address(0xBEEF), address(0xCAFE), 100);
        ParlayVault.Leg[] memory legs = new ParlayVault.Leg[](2);
        legs[0] = ParlayVault.Leg(0x1111111111111111111111111111111111111111, true);
        legs[1] = ParlayVault.Leg(0x2222222222222222222222222222222222222222, false);
        ParlayVault.Quote memory q = ParlayVault.Quote({
            taker: 0x3333333333333333333333333333333333333333,
            legs: legs,
            premium: 5_000_000,
            maxPayout: 20_000_000,
            deadline: 1_755_500_000,
            quoteId: bytes32(uint256(42))
        });
        console2.log("vault:", address(v));
        console2.log("chainid:", block.chainid);
        console2.logBytes32(v.quoteDigest(q));
    }
}
