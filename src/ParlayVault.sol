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
/// Trust model A: the contract blindly trusts a quote signed by `quoteSigner`.
/// Exposure is bounded structurally — escrow is pulled from `writer`'s ERC-20
/// allowance (the house approves only the bankroll it will risk), and
/// `minPremiumBps` floors the worst quote at a bounded loss ratio. Pausing
/// mints = the house revokes the writer allowance; there is no pause switch.
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
        Leg[] legs;
        uint96 premium;
        uint96 maxPayout;
        uint256 deadline;
        bytes32 quoteId;
    }

    struct Parlay {
        Leg[] legs;
        /// Escrow return address, snapshotted at mint so a `setWriter` config
        /// change mid-flight cannot redirect refunds.
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
        "Quote(address taker,Leg[] legs,uint96 premium,uint96 maxPayout,uint256 deadline,bytes32 quoteId)Leg(address vault,bool isYes)"
    );

    IERC20 public immutable usdc;

    address public owner;
    address public writer;
    address public quoteSigner;
    uint16 public minPremiumBps;

    mapping(uint256 => Parlay) internal _parlays;
    mapping(bytes32 => bool) public usedQuotes;
    uint256 public nextId;

    event ParlayMinted(uint256 indexed id, address indexed taker, bytes32 quoteId, uint96 premium, uint96 maxPayout);
    event ParlayResolved(uint256 indexed id, Status status);

    constructor(IERC20 usdc_, address writer_, address quoteSigner_, uint16 minPremiumBps_)
        ERC721("Parlay Position", "PARLAY")
        EIP712("ParlayVault", "1")
    {
        require(quoteSigner_ != address(0), "ZERO_SIGNER");
        usdc = usdc_;
        owner = msg.sender;
        writer = writer_;
        quoteSigner = quoteSigner_;
        minPremiumBps = minPremiumBps_;
    }

    /// Zero-signer guard: ECDSA.recover reverts on garbage rather than
    /// returning address(0), but a zero signer would still make the intent
    /// ambiguous — pausing is done via the writer allowance, never this.
    function setQuoteSigner(address quoteSigner_) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(quoteSigner_ != address(0), "ZERO_SIGNER");
        quoteSigner = quoteSigner_;
    }

    function setWriter(address writer_) external {
        require(msg.sender == owner, "NOT_OWNER");
        writer = writer_;
    }

    function setMinPremiumBps(uint16 minPremiumBps_) external {
        require(msg.sender == owner, "NOT_OWNER");
        minPremiumBps = minPremiumBps_;
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
                    keccak256(abi.encodePacked(legHashes)),
                    q.premium,
                    q.maxPayout,
                    q.deadline,
                    q.quoteId
                )
            )
        );
    }

    /// Mint a parlay from a house-signed quote. Escrow model: premium from the
    /// taker + (maxPayout − premium) from the writer's allowance, both held
    /// here until resolution. A leg already settled at mint is a stale quote —
    /// frontend requotes. Duplicate/rogue vault addresses are deliberately not
    /// checked: quotes are house-signed and house-signed garbage only hurts
    /// the house (design Q1, model A).
    function mint(Quote calldata q, bytes calldata sig) external returns (uint256 id) {
        require(ECDSA.recover(quoteDigest(q), sig) == quoteSigner, "BAD_SIG");
        require(block.timestamp <= q.deadline, "QUOTE_EXPIRED");
        require(msg.sender == q.taker, "NOT_TAKER");
        require(!usedQuotes[q.quoteId], "QUOTE_USED");
        require(q.legs.length >= 1 && q.legs.length <= MAX_LEGS, "BAD_LEG_COUNT");
        require(q.premium < q.maxPayout, "BAD_PREMIUM");
        require(uint256(q.premium) * 10_000 >= uint256(q.maxPayout) * minPremiumBps, "PREMIUM_TOO_LOW");
        usedQuotes[q.quoteId] = true;
        id = ++nextId;
        Parlay storage p = _parlays[id];
        for (uint256 i; i < q.legs.length; i++) {
            require(!OutcomeVault(q.legs[i].vault).settled(), "LEG_SETTLED");
            p.legs.push(q.legs[i]);
        }
        p.writer = writer;
        p.premium = q.premium;
        p.maxPayout = q.maxPayout;
        usdc.safeTransferFrom(msg.sender, address(this), q.premium);
        usdc.safeTransferFrom(writer, address(this), q.maxPayout - q.premium);
        _mint(msg.sender, id);
        emit ParlayMinted(id, msg.sender, q.quoteId, q.premium, q.maxPayout);
    }
}
