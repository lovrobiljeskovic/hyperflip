// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./BaseTest.sol";

/// Unit tests beyond the anchor suite: input validation, serialization,
/// cancel/settle edges. Anchors stay the oracle; these pin revert paths.
contract OutcomeVaultTest is BaseTest {
    function test_DepositZeroReverts() public {
        vm.prank(user);
        vm.expectRevert(bytes("BAD_AMOUNT"));
        vault.deposit(0);
    }

    function test_DepositWhilePendingReverts() public {
        vm.prank(user);
        vault.deposit(100e6);
        vm.prank(user);
        vm.expectRevert(bytes("BUSY"));
        vault.deposit(1e6);
    }

    function test_ClaimDepositTwiceReverts() public {
        depositAndClaim(100e6);
        vm.expectRevert(bytes("NO_PENDING"));
        vault.claimDeposit();
    }
}
