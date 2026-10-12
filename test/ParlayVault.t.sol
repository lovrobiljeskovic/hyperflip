// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./BaseTest.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

abstract contract ParlayVaultTest is BaseTest {
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
        plv.allowLeg(address(vault));
        plv.allowLeg(address(vaultB));
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

    function expectMintRevert(ParlayVault.Quote memory q, bytes memory err) internal {
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert(err);
        plv.mint(q, sig);
    }

    function mintDefault() internal returns (uint256 id) {
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        id = plv.mint(q, sig);
    }

    function winLegs() internal {
        settleLeg(vault, 1e18); // YES hit
        settleLeg(vaultB, 0); // NO hit
    }
}

contract ParlayVaultUnitTest is ParlayVaultTest {
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

    /// An unlisted leg cannot be minted against; the registrar can only add.
    function test_legAllowList() public {
        OutcomeVault rogue = newVault(9);
        ParlayVault.Quote memory q = makeQuote();
        q.legs[1] = ParlayVault.Leg(address(rogue), true);
        expectMintRevert(q, "LEG_NOT_ALLOWED");

        address registrar = makeAddr("registrar");
        vm.prank(registrar);
        vm.expectRevert("NOT_REGISTRAR");
        plv.allowLeg(address(rogue));
        vm.prank(registrar);
        vm.expectRevert("NOT_OWNER");
        plv.setLegRegistrar(registrar);

        plv.setLegRegistrar(registrar);
        vm.prank(registrar);
        plv.allowLeg(address(rogue));
        assertTrue(plv.allowedLeg(address(rogue)));
        bytes memory sig = signQuote(q);
        vm.prank(user);
        plv.mint(q, sig);
    }

    function test_setOwner() public {
        vm.prank(user);
        vm.expectRevert("NOT_OWNER");
        plv.setOwner(user);
        vm.expectRevert("ZERO_OWNER");
        plv.setOwner(address(0));
        plv.setOwner(user);
        assertEq(plv.owner(), user);
        vm.expectRevert("NOT_OWNER");
        plv.setWriter(user);
        vm.prank(user);
        plv.setWriter(user);
        assertEq(plv.writer(), user);
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

    function test_mintRejectsExpiredQuote() public {
        ParlayVault.Quote memory q = makeQuote();
        vm.warp(q.deadline + 1);
        expectMintRevert(q, "QUOTE_EXPIRED");
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
        ParlayVault.Quote memory q = makeQuote();
        q.premium = 1e5 - 1; // floor is 1% of MAX_PAYOUT
        expectMintRevert(q, "PREMIUM_TOO_LOW");
    }

    function test_mintAcceptsPremiumExactlyAtFloor() public {
        ParlayVault.Quote memory q = makeQuote();
        q.premium = 1e5;
        bytes memory sig = signQuote(q);
        vm.prank(user);
        uint256 id = plv.mint(q, sig);
        assertEq(plv.parlay(id).premium, 1e5);
    }

    /// Min legs is frontend policy; one leg is valid on-chain.
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
        expectMintRevert(q, "BAD_PREMIUM");
    }

    function test_mintRejectsBadLegCount() public {
        ParlayVault.Quote memory q = makeQuote();
        q.legs = new ParlayVault.Leg[](0);
        expectMintRevert(q, "BAD_LEG_COUNT");

        q.legs = new ParlayVault.Leg[](11);
        for (uint256 i; i < 11; i++) {
            q.legs[i] = ParlayVault.Leg(address(vault), true);
        }
        expectMintRevert(q, "BAD_LEG_COUNT");
    }

    function test_mintRejectsSettledLeg() public {
        settleLeg(vault, 1e18);
        expectMintRevert(makeQuote(), "LEG_SETTLED");
    }

    /// Revoking the writer allowance is the pause mechanism.
    function test_mintRevertsWhenWriterAllowanceExhausted() public {
        vm.prank(house);
        quote.approve(address(plv), 0);
        ParlayVault.Quote memory q = makeQuote();
        bytes memory sig = signQuote(q);
        vm.prank(user);
        vm.expectRevert(); // OZ ERC20InsufficientAllowance
        plv.mint(q, sig);
    }

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

    /// Void fires on a settled fractional leg without waiting for the open one.
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

    function test_claimRevertsForNonOwner() public {
        uint256 id = mintDefault();
        winLegs();
        vm.prank(other);
        vm.expectRevert("NOT_OWNER_OF");
        plv.claim(id);
    }

    /// An auto-resolve landing on Dead is rolled back: still Open, escrow untouched.
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
