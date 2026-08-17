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
}
