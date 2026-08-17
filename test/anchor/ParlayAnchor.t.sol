// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ParlayVault} from "../../src/ParlayVault.sol";
import {ParlayVaultTest} from "../ParlayVault.t.sol";

/// Definition-of-done anchors for ParlayVault (design spec
/// 2026-08-17-parlay-contract-design.md). Do not edit: these pin the beta
/// contract's user-facing behavior end to end.
contract ParlayAnchor is ParlayVaultTest {
    /// Full winning lifecycle: quote → mint → both legs hit → claim.
    function test_anchor_lifecycleWon() public {
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        uint256 id = plv.mint(q, sig);
        settleLeg(vault, 1e18);
        settleLeg(vaultB, 0);
        uint256 before = quote.balanceOf(user);
        vm.prank(user);
        plv.claim(id);
        assertEq(quote.balanceOf(user), before + MAX_PAYOUT);
    }

    /// Losing lifecycle: one lost leg returns the full pot to the writer
    /// immediately; the ticket survives as a receipt and never pays.
    function test_anchor_lifecycleDead() public {
        uint256 id = mintDefault();
        uint256 houseBefore = quote.balanceOf(house);
        settleLeg(vault, 0);
        plv.resolveParlay(id);
        assertEq(quote.balanceOf(house), houseBefore + MAX_PAYOUT);
        assertEq(plv.ownerOf(id), user);
        vm.prank(user);
        vm.expectRevert("NOT_WON");
        plv.claim(id);
    }

    /// Void lifecycle: ambiguous leg settlement voids the ticket, premium
    /// refunded in full, remainder back to the writer.
    function test_anchor_lifecycleVoid() public {
        uint256 id = mintDefault();
        uint256 userBefore = quote.balanceOf(user);
        settleLeg(vaultB, 0.5e18);
        plv.resolveParlay(id);
        assertEq(quote.balanceOf(user), userBefore + PREMIUM);
        assertEq(quote.balanceOf(address(plv)), 0);
    }

    /// A quote is one-shot.
    function test_anchor_quoteReplayRejected() public {
        mintDefault();
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert("QUOTE_USED");
        plv.mint(q, sig);
    }

    /// Positions are transferable and pay the holder, not the minter.
    function test_anchor_transferredPositionPaysHolder() public {
        uint256 id = mintDefault();
        vm.prank(user);
        plv.transferFrom(user, other, id);
        settleLeg(vault, 1e18);
        settleLeg(vaultB, 0);
        vm.prank(other);
        plv.claim(id);
        assertEq(quote.balanceOf(other), MAX_PAYOUT);
    }

    /// Escrow is full: from mint until resolution the contract holds exactly
    /// maxPayout, so a winner can always be paid.
    function test_anchor_fullEscrowHeld() public {
        mintDefault();
        assertEq(quote.balanceOf(address(plv)), MAX_PAYOUT);
    }

    /// Solvency isolation: resolving one parlay never touches another's
    /// escrow — the contract always holds the sum of open maxPayouts.
    function test_anchor_resolvingOneParlayNeverTouchesAnothers() public {
        uint256 idA = mintDefault();
        ParlayVault.Quote memory q = makeQuote();
        q.quoteId = keccak256("q2");
        bytes memory sig = signQuote(q);
        vm.prank(user);
        uint256 idB = plv.mint(q, sig);
        assertEq(quote.balanceOf(address(plv)), 2 * uint256(MAX_PAYOUT));

        settleLeg(vault, 0); // kills the YES leg of BOTH parlays
        plv.resolveParlay(idA);
        // B still fully escrowed after A's pot left
        assertEq(quote.balanceOf(address(plv)), MAX_PAYOUT);
        plv.resolveParlay(idB);
        assertEq(quote.balanceOf(address(plv)), 0);
        assertEq(uint8(plv.parlay(idB).status), uint8(ParlayVault.Status.Dead));
    }
}
