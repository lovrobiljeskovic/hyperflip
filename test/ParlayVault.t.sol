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
}
