// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {OutcomeVault} from "./OutcomeVault.sol";

/// Layer-2 parlay over Layer-1 OutcomeVaults (design spec:
/// ~/docs/superpowers/specs/2026-08-17-parlay-contract-design.md).
///
/// Trust model A: the contract blindly trusts a quote signed by
/// `signerOf[q.maker]`. Exposure is bounded structurally — escrow is pulled
/// from `q.maker`'s ERC-20 allowance, so each maker's exposure is capped by its
/// own allowance ∧ balance, and `minPremiumBps` floors the worst quote at a
/// bounded loss ratio. The owner invites makers with `setMaker`; there is no
/// global pause.
///
/// Each position is an ERC-721. Full max payout is escrowed at mint: the
/// house-as-writer beta has no other solvency guarantee users can check.
contract ParlayVault is ERC721, EIP712 {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Won,
        Dead,
        Void
    }

    struct Leg {
        address vault;
        bool isYes;
    }

    struct Quote {
        address taker;
        address maker;
        Leg[] legs;
        uint96 premium;
        uint96 maxPayout;
        uint256 deadline;
        bytes32 quoteId;
    }

    struct Parlay {
        Leg[] legs;
        /// Escrow return address, snapshotted at mint so a `setMaker` change
        /// mid-flight cannot redirect refunds.
        address writer;
        uint96 premium;
        uint96 maxPayout;
        Status status;
    }

    /// Bounds resolveParlay's settlement-loop gas. All other risk caps
    /// (max stake, exposure, min legs) are writer-service policy.
    uint256 public constant MAX_LEGS = 10;

    bytes32 internal constant LEG_TYPEHASH = keccak256("Leg(address vault,bool isYes)");
    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(address taker,address maker,Leg[] legs,uint96 premium,uint96 maxPayout,uint256 deadline,bytes32 quoteId)Leg(address vault,bool isYes)"
    );

    IERC20 public immutable usdc;

    address public owner;
    mapping(address maker => address signer) public signerOf;
    uint16 public minPremiumBps;

    mapping(uint256 => Parlay) internal _parlays;
    mapping(bytes32 => bool) public usedQuotes;
    uint256 public nextId;

    event ParlayMinted(
        uint256 indexed id,
        address indexed taker,
        address indexed maker,
        bytes32 quoteId,
        uint96 premium,
        uint96 maxPayout
    );
    event ParlayResolved(uint256 indexed id, Status status);
    event MakerSet(address indexed maker, address indexed signer);
    event MinPremiumBpsChanged(uint16 minPremiumBps);

    constructor(IERC20 usdc_, uint16 minPremiumBps_) ERC721("Parlay Position", "PARLAY") EIP712("ParlayVault", "2") {
        usdc = usdc_;
        owner = msg.sender;
        minPremiumBps = minPremiumBps_;
    }

    /// signer == 0 removes the maker. Pausing one maker = that maker revokes its
    /// allowance or the owner zeroes its signer; there is still no global pause.
    function setMaker(address maker, address signer) external {
        require(msg.sender == owner, "NOT_OWNER");
        signerOf[maker] = signer;
        emit MakerSet(maker, signer);
    }

    /// Bounded below 100%: a floor at or above 100% would brick minting,
    /// since premium < maxPayout is also required.
    function setMinPremiumBps(uint16 minPremiumBps_) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(minPremiumBps_ < 10_000, "BAD_BPS");
        minPremiumBps = minPremiumBps_;
        emit MinPremiumBpsChanged(minPremiumBps_);
    }

    /// Explicit getter: the auto-generated one cannot return the legs array.
    function parlay(uint256 id) external view returns (Parlay memory) {
        return _parlays[id];
    }

    /// Public so the writer service and tests hash quotes the exact same way
    /// the contract does.
    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        bytes32[] memory legHashes = new bytes32[](q.legs.length);
        for (uint256 i; i < q.legs.length; i++) {
            legHashes[i] = keccak256(abi.encode(LEG_TYPEHASH, q.legs[i].vault, q.legs[i].isYes));
        }
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.taker,
                    q.maker,
                    keccak256(abi.encodePacked(legHashes)),
                    q.premium,
                    q.maxPayout,
                    q.deadline,
                    q.quoteId
                )
            )
        );
    }

    /// Mint a parlay from a maker-signed quote. Escrow model: premium from the
    /// taker + (maxPayout − premium) from the maker's allowance, both held
    /// here until resolution. A leg already settled at mint is a stale quote —
    /// frontend requotes. Duplicate/rogue vault addresses are deliberately not
    /// checked: quotes are maker-signed and maker-signed garbage only hurts
    /// that maker (design Q1, model A).
    function mint(Quote calldata q, bytes calldata sig) external returns (uint256 id) {
        address signer = signerOf[q.maker];
        require(signer != address(0), "UNKNOWN_MAKER");
        require(ECDSA.recover(quoteDigest(q), sig) == signer, "BAD_SIG");
        require(block.timestamp <= q.deadline, "QUOTE_EXPIRED");
        require(msg.sender == q.taker, "NOT_TAKER");
        bytes32 key = keccak256(abi.encode(q.maker, q.quoteId));
        require(!usedQuotes[key], "QUOTE_USED");
        require(q.legs.length >= 1 && q.legs.length <= MAX_LEGS, "BAD_LEG_COUNT");
        require(q.premium < q.maxPayout, "BAD_PREMIUM");
        require(uint256(q.premium) * 10_000 >= uint256(q.maxPayout) * minPremiumBps, "PREMIUM_TOO_LOW");
        usedQuotes[key] = true;
        id = ++nextId;
        Parlay storage p = _parlays[id];
        for (uint256 i; i < q.legs.length; i++) {
            require(!OutcomeVault(q.legs[i].vault).settled(), "LEG_SETTLED");
            p.legs.push(q.legs[i]);
        }
        p.writer = q.maker;
        p.premium = q.premium;
        p.maxPayout = q.maxPayout;
        usdc.safeTransferFrom(msg.sender, address(this), q.premium);
        usdc.safeTransferFrom(q.maker, address(this), q.maxPayout - q.premium);
        _mint(msg.sender, id);
        emit ParlayMinted(id, msg.sender, q.maker, q.quoteId, q.premium, q.maxPayout);
    }

    /// Permissionless — the writer service pokes dead parlays to recycle its
    /// bankroll. Leg-hit rule: YES hits iff fraction == 1e18, NO hits iff
    /// == 0; strictly between is ambiguous. Resolution order: lost beats
    /// fractional — a lost leg kills the ticket even when another leg voided.
    /// Void (design decision A): whole-parlay void, premium back to holder,
    /// remainder to writer, token burned. Dead: full pot to the snapshotted
    /// writer immediately, token kept as receipt (never pays again — status
    /// gate). Won: funds move on claim so the payout follows token ownership.
    /// CEI: status write / burn before every transfer; USDC has no hooks.
    function resolveParlay(uint256 id) public {
        Parlay storage p = _parlays[id];
        require(p.status == Status.Open && p.maxPayout != 0, "NOT_OPEN");
        bool anyFractional;
        bool allSettled = true;
        // Reentrancy safety for this loop rests on settled/settleFractionWad
        // being public state-variable getters -> view -> STATICCALL, so a
        // rogue leg vault cannot write state or reenter here even though the
        // status write hasn't happened yet. If Layer 1 ever makes either
        // getter state-mutating, this loop must be restructured to write
        // status before any external call.
        for (uint256 i; i < p.legs.length; i++) {
            OutcomeVault v = OutcomeVault(p.legs[i].vault);
            if (!v.settled()) {
                allSettled = false;
                continue;
            }
            uint256 f = v.settleFractionWad();
            bool lost = p.legs[i].isYes ? f == 0 : f == 1e18;
            if (lost) {
                p.status = Status.Dead;
                emit ParlayResolved(id, Status.Dead);
                usdc.safeTransfer(p.writer, p.maxPayout);
                return;
            }
            bool hit = p.legs[i].isYes ? f == 1e18 : f == 0;
            if (!hit) anyFractional = true;
        }
        if (anyFractional) {
            p.status = Status.Void;
            address holder = ownerOf(id);
            emit ParlayResolved(id, Status.Void);
            _burn(id);
            usdc.safeTransfer(holder, p.premium);
            usdc.safeTransfer(p.writer, p.maxPayout - p.premium);
            return;
        }
        require(allSettled, "NOT_RESOLVABLE");
        p.status = Status.Won;
        emit ParlayResolved(id, Status.Won);
    }

    /// Pays maxPayout to the token's current owner. Auto-resolve means the
    /// winner never needs a separate resolve tx. Burn before transfer is the
    /// double-pay guard (status stays Won, but ownerOf reverts forever after).
    /// If the auto-resolve lands on Dead or Void, the NOT_WON require below
    /// reverts the whole transaction — the writer payout / premium refund /
    /// burn that resolveParlay just did is rolled back with it. The parlay
    /// stays Open; call resolveParlay directly to settle a Dead or Void
    /// ticket, claim only ever pays a Won one.
    function claim(uint256 id) external {
        Parlay storage p = _parlays[id];
        if (p.status == Status.Open) resolveParlay(id);
        require(p.status == Status.Won, "NOT_WON");
        require(msg.sender == ownerOf(id), "NOT_OWNER_OF");
        _burn(id);
        usdc.safeTransfer(msg.sender, p.maxPayout);
    }
}
