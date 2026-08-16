// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KeeperVerifier} from "../src/KeeperVerifier.sol";
import {IExecutionVerifier} from "../src/IExecutionVerifier.sol";

contract KeeperVerifierTest is Test {
    KeeperVerifier internal verifier;
    address internal owner;
    address internal keeper;
    address internal other;

    bytes32 internal constant OP_KEY = keccak256("op-1");

    function setUp() public {
        owner = address(this);
        keeper = makeAddr("keeper");
        other = makeAddr("other");
        verifier = new KeeperVerifier(keeper);
    }

    function test_AttestByNonKeeperReverts() public {
        vm.prank(other);
        vm.expectRevert(bytes("NOT_KEEPER"));
        verifier.attest(OP_KEY, true);
    }

    function test_ReAttestationReverts() public {
        vm.prank(keeper);
        verifier.attest(OP_KEY, true);
        vm.prank(keeper);
        vm.expectRevert(bytes("ALREADY_ATTESTED"));
        verifier.attest(OP_KEY, false);
    }

    function test_StatusOfPendingBeforeMinDelay() public {
        vm.prank(keeper);
        verifier.attest(OP_KEY, true);
        assertEq(uint8(verifier.statusOf(OP_KEY)), uint8(IExecutionVerifier.Status.Pending));
    }

    function test_StatusOfExecutedAfterMinDelay() public {
        vm.prank(keeper);
        verifier.attest(OP_KEY, true);
        vm.warp(block.timestamp + verifier.minDelay() + 1);
        assertEq(uint8(verifier.statusOf(OP_KEY)), uint8(IExecutionVerifier.Status.Executed));
    }

    function test_StatusOfFailedAfterMinDelay() public {
        vm.prank(keeper);
        verifier.attest(OP_KEY, false);
        vm.warp(block.timestamp + verifier.minDelay() + 1);
        assertEq(uint8(verifier.statusOf(OP_KEY)), uint8(IExecutionVerifier.Status.Failed));
    }

    function test_StatusOfUnattestedIsPending() public view {
        assertEq(uint8(verifier.statusOf(OP_KEY)), uint8(IExecutionVerifier.Status.Pending));
    }

    function test_PauseForcesPendingEvenIfAttestedAndMature() public {
        vm.prank(keeper);
        verifier.attest(OP_KEY, true);
        vm.warp(block.timestamp + verifier.minDelay() + 1);
        verifier.pause();
        assertEq(uint8(verifier.statusOf(OP_KEY)), uint8(IExecutionVerifier.Status.Pending));
    }

    function test_UnpauseRestoresStatus() public {
        vm.prank(keeper);
        verifier.attest(OP_KEY, true);
        vm.warp(block.timestamp + verifier.minDelay() + 1);
        verifier.pause();
        verifier.unpause();
        assertEq(uint8(verifier.statusOf(OP_KEY)), uint8(IExecutionVerifier.Status.Executed));
    }

    function test_SetKeeperByNonOwnerReverts() public {
        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        verifier.setKeeper(other);
    }

    function test_SetKeeperByOwnerWorks() public {
        verifier.setKeeper(other);
        assertEq(verifier.keeper(), other);
    }

    function test_SetMinDelayByNonOwnerReverts() public {
        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        verifier.setMinDelay(1 hours);
    }

    function test_SetMinDelayByOwnerWorks() public {
        verifier.setMinDelay(1 hours);
        assertEq(verifier.minDelay(), 1 hours);
    }

    function test_PauseByNonOwnerReverts() public {
        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        verifier.pause();
    }

    function test_UnpauseByNonOwnerReverts() public {
        verifier.pause();
        vm.prank(other);
        vm.expectRevert(bytes("NOT_OWNER"));
        verifier.unpause();
    }
}
