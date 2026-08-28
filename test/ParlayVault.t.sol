// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./BaseTest.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

contract ParlayVaultTest is BaseTest {
    ParlayVault internal plv;
    OutcomeVault internal vaultB;
    address internal house;
    address internal signer;
    uint256 internal signerKey;

    uint96 internal constant PREMIUM = 10e5; // 10 mUSD (5-dec quote)
    uint96 internal constant MAX_PAYOUT = 100e5;

    function setUp() public virtual override {
        super.setUp();
        (signer, signerKey) = makeAddrAndKey("quoteSigner");
        house = makeAddr("house");
        vaultB = newVault(4);
        plv = new ParlayVault(IERC20(address(quote)), house, signer, 100); // 1% floor
        quote.mint(house, 10_000e5);
        vm.prank(house);
        quote.approve(address(plv), type(uint256).max);
        vm.prank(user);
        quote.approve(address(plv), type(uint256).max);
    }

    /// Extra Layer-1 vault on a different outcome; the test contract is its
    /// keeper, so settleLeg can relay any fraction (mock status is PRUNED).
    function newVault(uint32 outcomeId) internal returns (OutcomeVault) {
        return new OutcomeVault(
            IERC20(address(quote)), SYSTEM_ADDR, TOKEN_INDEX, QUESTION, outcomeId, keeper, verifier, "MKT", DECIMALS
        );
    }

    function settleLeg(OutcomeVault v, uint256 fractionWad) internal {
        v.settle(fractionWad);
    }

    /// Compile-time anchor for resolveParlay's reentrancy argument: the leg
    /// reads must be STATICCALLs. If OutcomeVault.settled/settleFractionWad
    /// ever stop being view getters, this helper stops compiling and the
    /// resolveParlay loop must be restructured (status write before external
    /// calls) before the change lands.
    function _legReadsAreView(OutcomeVault v) internal view returns (bool, uint256) {
        return (v.settled(), v.settleFractionWad());
    }

    /// Default slip: 2 legs (YES on vault, NO on vaultB), 10 → 100.
    function makeQuote() internal view returns (ParlayVault.Quote memory q) {
        ParlayVault.Leg[] memory legs = new ParlayVault.Leg[](2);
        legs[0] = ParlayVault.Leg(address(vault), true);
        legs[1] = ParlayVault.Leg(address(vaultB), false);
        q = ParlayVault.Quote({
            taker: user,
            legs: legs,
            premium: PREMIUM,
            maxPayout: MAX_PAYOUT,
            deadline: block.timestamp + 30,
            quoteId: keccak256("q1")
        });
    }

    function signQuote(ParlayVault.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, plv.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    // --- config ---

    function test_configInitial() public view {
        assertEq(plv.owner(), address(this));
        assertEq(plv.writer(), house);
        assertEq(plv.quoteSigner(), signer);
        assertEq(plv.minPremiumBps(), 100);
    }

    function test_settersOnlyOwner() public {
        vm.startPrank(other);
        vm.expectRevert("NOT_OWNER");
        plv.setQuoteSigner(other);
        vm.expectRevert("NOT_OWNER");
        plv.setWriter(other);
        vm.expectRevert("NOT_OWNER");
        plv.setMinPremiumBps(1);
        vm.stopPrank();
    }

    function test_setQuoteSignerRejectsZero() public {
        vm.expectRevert("ZERO_SIGNER");
        plv.setQuoteSigner(address(0));
    }

    function test_constructorRejectsZeroSigner() public {
        vm.expectRevert("ZERO_SIGNER");
        new ParlayVault(IERC20(address(quote)), house, address(0), 100);
    }

    function test_setMinPremiumBpsRejectsAbove100Pct() public {
        vm.expectRevert("BAD_BPS");
        plv.setMinPremiumBps(10_000);
        plv.setMinPremiumBps(9_999);
        assertEq(plv.minPremiumBps(), 9_999);
    }

    function test_quoteDigestBindsFields() public view {
        ParlayVault.Quote memory q = makeQuote();
        bytes32 d1 = plv.quoteDigest(q);
        q.premium = PREMIUM + 1;
        assertTrue(plv.quoteDigest(q) != d1);
        q = makeQuote();
        q.legs[0].isYes = false;
        assertTrue(plv.quoteDigest(q) != d1);
    }

    // --- mint ---

    function mintDefault() internal returns (uint256 id) {
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        id = plv.mint(q, sig);
    }

    function test_mintHappyPath() public {
        uint256 userBefore = quote.balanceOf(user);
        uint256 id = mintDefault();
        assertEq(id, 1);
        assertEq(plv.ownerOf(1), user);
        assertEq(quote.balanceOf(user), userBefore - PREMIUM);
        assertEq(quote.balanceOf(house), 10_000e5 - (MAX_PAYOUT - PREMIUM));
        assertEq(quote.balanceOf(address(plv)), MAX_PAYOUT);
        assertTrue(plv.usedQuotes(keccak256("q1")));
        ParlayVault.Parlay memory p = plv.parlay(1);
        assertEq(p.writer, house);
        assertEq(p.premium, PREMIUM);
        assertEq(p.maxPayout, MAX_PAYOUT);
        assertEq(uint8(p.status), uint8(ParlayVault.Status.Open));
        assertEq(p.legs.length, 2);
        assertEq(p.legs[0].vault, address(vault));
        assertTrue(p.legs[0].isYes);
        assertEq(p.legs[1].vault, address(vaultB));
        assertFalse(p.legs[1].isYes);
    }

    function test_mintRejectsReplay() public {
        mintDefault();
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert("QUOTE_USED");
        plv.mint(q, sig);
    }

    function test_mintRejectsExpiredQuote() public {
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.warp(q.deadline + 1);
        vm.prank(user);
        vm.expectRevert("QUOTE_EXPIRED");
        plv.mint(q, sig);
    }

    function test_mintRejectsWrongTaker() public {
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(other);
        vm.expectRevert("NOT_TAKER");
        plv.mint(q, sig);
    }

    function test_mintRejectsWrongSigner() public {
        ParlayVault.Quote memory q = makeQuote();
        (, uint256 wrongKey) = makeAddrAndKey("mallory");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, plv.quoteDigest(q));
        vm.prank(user);
        vm.expectRevert("BAD_SIG");
        plv.mint(q, abi.encodePacked(r, s, v));
    }

    function test_mintRejectsTamperedQuote() public {
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        q.maxPayout = MAX_PAYOUT * 10;
        vm.prank(user);
        vm.expectRevert("BAD_SIG");
        plv.mint(q, sig);
    }

    function test_mintRejectsPremiumBelowFloor() public {
        // floor is 1% of maxPayout = 1e5
        ParlayVault.Quote memory q = makeQuote();
        q.premium = 1e5 - 1;
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert("PREMIUM_TOO_LOW");
        plv.mint(q, sig);
    }

    /// Premium exactly at the 1% floor mints.
    function test_mintAcceptsPremiumExactlyAtFloor() public {
        ParlayVault.Quote memory q = makeQuote();
        q.premium = 1e5; // 1% of MAX_PAYOUT
        bytes memory sig = signQuote(q);
        vm.prank(user);
        uint256 id = plv.mint(q, sig);
        assertEq(plv.parlay(id).premium, 1e5);
    }

    /// A 1-leg parlay is allowed on-chain (design Q3: min-legs is frontend policy).
    function test_mintAcceptsSingleLeg() public {
        ParlayVault.Quote memory q = makeQuote();
        ParlayVault.Leg[] memory legs = new ParlayVault.Leg[](1);
        legs[0] = ParlayVault.Leg(address(vault), true);
        q.legs = legs;
        bytes memory sig = signQuote(q);
        vm.prank(user);
        uint256 id = plv.mint(q, sig);
        assertEq(plv.parlay(id).legs.length, 1);
    }

    function test_mintRejectsPremiumGteMaxPayout() public {
        ParlayVault.Quote memory q = makeQuote();
        q.premium = q.maxPayout;
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert("BAD_PREMIUM");
        plv.mint(q, sig);
    }

    function test_mintRejectsBadLegCount() public {
        ParlayVault.Quote memory q = makeQuote();
        q.legs = new ParlayVault.Leg[](0);
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert("BAD_LEG_COUNT");
        plv.mint(q, sig);

        q.legs = new ParlayVault.Leg[](11);
        for (uint256 i; i < 11; i++) {
            q.legs[i] = ParlayVault.Leg(address(vault), true);
        }
        sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert("BAD_LEG_COUNT");
        plv.mint(q, sig);
    }

    function test_mintRejectsSettledLeg() public {
        settleLeg(vault, 1e18);
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert("LEG_SETTLED");
        plv.mint(q, sig);
    }

    /// "At capacity": writer allowance revoked = mint reverts in transferFrom.
    /// No special handling — this IS the pause mechanism.
    function test_mintRevertsWhenWriterAllowanceExhausted() public {
        vm.prank(house);
        quote.approve(address(plv), 0);
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert(); // OZ ERC20InsufficientAllowance
        plv.mint(q, sig);
    }

    // --- resolveParlay: Dead ---

    function test_resolveDeadYesLegLost() public {
        uint256 id = mintDefault();
        settleLeg(vault, 0); // YES leg lost
        uint256 houseBefore = quote.balanceOf(house);
        plv.resolveParlay(id);
        ParlayVault.Parlay memory p = plv.parlay(id);
        assertEq(uint8(p.status), uint8(ParlayVault.Status.Dead));
        assertEq(quote.balanceOf(house), houseBefore + MAX_PAYOUT); // full pot
        assertEq(quote.balanceOf(address(plv)), 0);
        assertEq(plv.ownerOf(id), user); // token kept as receipt
    }

    function test_resolveDeadNoLegLost() public {
        uint256 id = mintDefault();
        settleLeg(vaultB, 1e18); // NO leg lost (YES resolved true)
        plv.resolveParlay(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Dead));
    }

    /// One lost settled leg kills the ticket even while the other is unsettled.
    function test_resolveDeadWithUnsettledSibling() public {
        uint256 id = mintDefault();
        settleLeg(vault, 0);
        assertFalse(vaultB.settled());
        plv.resolveParlay(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Dead));
    }

    /// Dead pot goes to the writer snapshotted at mint, not current config.
    function test_resolveDeadPaysSnapshottedWriter() public {
        uint256 id = mintDefault();
        address newHouse = makeAddr("newHouse");
        plv.setWriter(newHouse);
        settleLeg(vault, 0);
        plv.resolveParlay(id);
        assertEq(quote.balanceOf(newHouse), 0);
        assertEq(quote.balanceOf(house), 10_000e5 - (MAX_PAYOUT - PREMIUM) + MAX_PAYOUT);
    }

    function test_resolveRevertsWhenNoLegSettled() public {
        uint256 id = mintDefault();
        vm.expectRevert("NOT_RESOLVABLE");
        plv.resolveParlay(id);
    }

    function test_resolveRevertsOnDeadParlay() public {
        uint256 id = mintDefault();
        settleLeg(vault, 0);
        plv.resolveParlay(id);
        vm.expectRevert("NOT_OPEN");
        plv.resolveParlay(id);
    }

    function test_resolveRevertsOnNonexistentId() public {
        vm.expectRevert("NOT_OPEN");
        plv.resolveParlay(999);
    }

    // --- resolveParlay: Void ---

    function test_resolveVoidFractionalLeg() public {
        uint256 id = mintDefault();
        settleLeg(vault, 1e18); // YES leg hit
        settleLeg(vaultB, 0.5e18); // NO leg ambiguous
        uint256 userBefore = quote.balanceOf(user);
        uint256 houseBefore = quote.balanceOf(house);
        plv.resolveParlay(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Void));
        assertEq(quote.balanceOf(user), userBefore + PREMIUM); // full refund
        assertEq(quote.balanceOf(house), houseBefore + (MAX_PAYOUT - PREMIUM));
        assertEq(quote.balanceOf(address(plv)), 0);
        vm.expectRevert(); // ERC721NonexistentToken — voided token is burned
        plv.ownerOf(id);
    }

    /// Design: whole-parlay void fires on any settled fractional leg even
    /// while a sibling is unsettled (no waiting for the open leg).
    function test_resolveVoidWithUnsettledSibling() public {
        uint256 id = mintDefault();
        settleLeg(vaultB, 0.5e18);
        plv.resolveParlay(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Void));
    }

    /// Lost beats fractional: one leg lost + one leg ambiguous = Dead, no refund.
    function test_resolveOrderLostBeatsFractional() public {
        uint256 id = mintDefault();
        settleLeg(vault, 0); // YES leg lost
        settleLeg(vaultB, 0.5e18); // NO leg ambiguous
        uint256 userBefore = quote.balanceOf(user);
        plv.resolveParlay(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Dead));
        assertEq(quote.balanceOf(user), userBefore); // no premium refund
    }

    /// Void refund follows token ownership at resolution time.
    function test_resolveVoidPaysCurrentTokenOwner() public {
        uint256 id = mintDefault();
        vm.prank(user);
        plv.transferFrom(user, other, id);
        settleLeg(vaultB, 0.5e18);
        plv.resolveParlay(id);
        assertEq(quote.balanceOf(other), PREMIUM);
    }

    // --- Won + claim ---

    function winLegs() internal {
        settleLeg(vault, 1e18); // YES hit
        settleLeg(vaultB, 0); // NO hit
    }

    function test_resolveWonHoldsFunds() public {
        uint256 id = mintDefault();
        winLegs();
        plv.resolveParlay(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Won));
        assertEq(quote.balanceOf(address(plv)), MAX_PAYOUT); // pays on claim
        assertEq(plv.ownerOf(id), user);
    }

    function test_claimPaysMaxPayoutAndBurns() public {
        uint256 id = mintDefault();
        winLegs();
        plv.resolveParlay(id);
        uint256 userBefore = quote.balanceOf(user);
        vm.prank(user);
        plv.claim(id);
        assertEq(quote.balanceOf(user), userBefore + MAX_PAYOUT);
        assertEq(quote.balanceOf(address(plv)), 0);
        vm.expectRevert(); // burned
        plv.ownerOf(id);
    }

    /// claim auto-resolves an Open parlay whose legs are all settled.
    function test_claimAutoResolves() public {
        uint256 id = mintDefault();
        winLegs();
        uint256 userBefore = quote.balanceOf(user);
        vm.prank(user);
        plv.claim(id);
        assertEq(quote.balanceOf(user), userBefore + MAX_PAYOUT);
    }

    function test_claimRevertsForNonOwner() public {
        uint256 id = mintDefault();
        winLegs();
        vm.prank(other);
        vm.expectRevert("NOT_OWNER_OF");
        plv.claim(id);
    }

    /// claim on an unresolved Dead parlay reverts and rolls the auto-resolve
    /// back: still Open, escrow untouched — resolveParlay is the right call.
    function test_claimAutoResolveToDeadRevertsAndRollsBack() public {
        uint256 id = mintDefault();
        settleLeg(vault, 0);
        vm.prank(user);
        vm.expectRevert("NOT_WON");
        plv.claim(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Open));
        assertEq(quote.balanceOf(address(plv)), MAX_PAYOUT);
    }

    function test_claimAutoResolveToVoidRevertsAndRollsBack() public {
        uint256 id = mintDefault();
        settleLeg(vaultB, 0.5e18);
        vm.prank(user);
        vm.expectRevert("NOT_WON");
        plv.claim(id);
        assertEq(uint8(plv.parlay(id).status), uint8(ParlayVault.Status.Open));
        assertEq(plv.ownerOf(id), user); // burn rolled back too
        assertEq(quote.balanceOf(address(plv)), MAX_PAYOUT);
    }

    function test_claimRevertsWhenDead() public {
        uint256 id = mintDefault();
        settleLeg(vault, 0);
        plv.resolveParlay(id);
        vm.prank(user);
        vm.expectRevert("NOT_WON");
        plv.claim(id);
    }

    function test_claimRevertsWhenUnresolvable() public {
        uint256 id = mintDefault();
        vm.prank(user);
        vm.expectRevert("NOT_RESOLVABLE");
        plv.claim(id);
    }

    /// Transferred position pays the new owner; old owner can no longer claim.
    function test_transferThenClaimPaysNewOwner() public {
        uint256 id = mintDefault();
        vm.prank(user);
        plv.transferFrom(user, other, id);
        winLegs();
        vm.prank(user);
        vm.expectRevert("NOT_OWNER_OF");
        plv.claim(id);
        vm.prank(other);
        plv.claim(id);
        assertEq(quote.balanceOf(other), MAX_PAYOUT);
    }

    /// Double-pay guard is the burn: second claim cannot find an owner.
    function test_claimTwiceReverts() public {
        uint256 id = mintDefault();
        winLegs();
        vm.prank(user);
        plv.claim(id);
        vm.prank(user);
        vm.expectRevert(); // ERC721NonexistentToken from ownerOf
        plv.claim(id);
    }
}
