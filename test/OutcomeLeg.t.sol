// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ParlayVaultTest} from "./ParlayVault.t.sol";
import {ParlayVault} from "../src/ParlayVault.sol";
import {OutcomeLeg} from "../src/OutcomeLeg.sol";
import {SettlementRelay, IInbox} from "../src/SettlementRelay.sol";

/// Records the one retryable call; `deliver()` replays it from the relay's L2 alias.
contract MockInbox is IInbox {
    address public to;
    uint256 public value;
    uint256 public gasLimit;
    address public refund;
    bytes public data;

    function createRetryableTicket(
        address to_,
        uint256,
        uint256,
        address excessFeeRefundAddress,
        address,
        uint256 gasLimit_,
        uint256,
        bytes calldata data_
    ) external payable returns (uint256) {
        to = to_;
        value = msg.value;
        refund = excessFeeRefundAddress;
        gasLimit = gasLimit_;
        data = data_;
        return 42;
    }
}

/// 998 vault → SettlementRelay → bridge → OutcomeLeg → ParlayVault resolves off
/// the leg. Same parlay fixture with `vaultB` mirrored by `leg`.
contract OutcomeLegTest is ParlayVaultTest {
    MockInbox internal inbox;
    SettlementRelay internal relay;
    OutcomeLeg internal leg;
    address internal aliasedRelay;

    function setUp() public override {
        super.setUp();
        inbox = new MockInbox();
        relay = new SettlementRelay(inbox);
        leg = new OutcomeLeg(address(vaultB), address(relay));
        plv.allowLeg(address(leg));
        aliasedRelay = leg.aliasedRelay();
    }

    function deliver() internal {
        address to = inbox.to();
        bytes memory data = inbox.data();
        vm.prank(aliasedRelay);
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function test_relayRejectsUnsettledVault() public {
        vm.expectRevert("NOT_SETTLED");
        relay.relay(address(vaultB), address(leg), 1, 100_000, 1 gwei);
    }

    function test_roundTrip() public {
        settleLeg(vaultB, 1e18);
        vm.deal(user, 1 ether);
        vm.prank(user);
        uint256 id = relay.relay{value: 0.01 ether}(address(vaultB), address(leg), 1, 100_000, 1 gwei);
        assertEq(id, 42);
        assertEq(inbox.to(), address(leg));
        assertEq(inbox.value(), 0.01 ether);
        assertEq(inbox.refund(), user);
        assertEq(inbox.gasLimit(), 100_000);
        assertFalse(leg.settled());
        deliver();
        assertTrue(leg.settled());
        assertEq(leg.settleFractionWad(), 1e18);
    }

    function test_legRejectsNonRelay() public {
        vm.prank(address(relay)); // un-aliased, i.e. a direct L2 caller
        vm.expectRevert("NOT_RELAY");
        leg.receiveSettlement(address(vaultB), 1e18);
        vm.prank(user);
        vm.expectRevert("NOT_RELAY");
        leg.receiveSettlement(address(vaultB), 1e18);
    }

    function test_legRejectsWrongVault() public {
        vm.prank(aliasedRelay);
        vm.expectRevert("WRONG_VAULT");
        leg.receiveSettlement(address(vault), 1e18);
    }

    function test_legRejectsBadFractionAndDoubleSettle() public {
        vm.prank(aliasedRelay);
        vm.expectRevert("BAD_FRACTION");
        leg.receiveSettlement(address(vaultB), 1e18 + 1);
        vm.prank(aliasedRelay);
        leg.receiveSettlement(address(vaultB), 5e17);
        vm.prank(aliasedRelay);
        vm.expectRevert("ALREADY_SETTLED");
        leg.receiveSettlement(address(vaultB), 5e17);
    }

    /// The leg is a valid ParlayVault leg: mint on it, settle both, resolve Won.
    function test_parlayResolvesOffLeg() public {
        ParlayVault.Quote memory q = makeQuote();
        q.legs[1] = ParlayVault.Leg(address(leg), false); // NO on the Elysium mirror
        bytes memory sig = signQuote(q);
        vm.prank(user);
        uint256 id = plv.mint(q, sig);
        settleLeg(vault, 1e18); // YES hits
        settleLeg(vaultB, 0); // NO hits on 998...
        relay.relay(address(vaultB), address(leg), 1, 100_000, 1 gwei);
        vm.expectRevert("NOT_RESOLVABLE"); // ...but not yet on Elysium
        plv.resolveParlay(id);
        deliver();
        plv.resolveParlay(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Won));
    }
}
