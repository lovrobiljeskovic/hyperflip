// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {IOutcomeLeg} from "./IOutcomeLeg.sol";

/// Parlay positions (ERC-721) over OutcomeVault / OutcomeLeg legs.
///
/// The contract blindly trusts a quote signed by `quoteSigner`. Exposure is
/// bounded structurally: escrow comes from `writer`'s ERC-20 allowance (the
/// house approves only the bankroll it will risk) and `minPremiumBps` floors
/// the worst quote. Pausing mints = revoking that allowance; there is no pause
/// switch. Full max payout is escrowed at mint.
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
        /// Snapshotted at mint so `setWriter` cannot redirect escrow mid-flight.
        address writer;
        uint96 premium;
        uint96 maxPayout;
        Status status;
    }

    /// Bounds resolveParlay's loop gas; every other cap is writer-service policy.
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
    /// Online rotation key that may only *add* legs: its worst case is "lists a
    /// vault", never "moves money".
    address public legRegistrar;
    mapping(address => bool) public allowedLeg;

    mapping(uint256 => Parlay) internal _parlays;
    mapping(bytes32 => bool) public usedQuotes;
    uint256 public nextId;

    event ParlayMinted(uint256 indexed id, address indexed taker, bytes32 quoteId, uint96 premium, uint96 maxPayout);
    event ParlayResolved(uint256 indexed id, Status status);
    event QuoteSignerChanged(address indexed quoteSigner);
    event WriterChanged(address indexed writer);
    event MinPremiumBpsChanged(uint16 minPremiumBps);
    event LegRegistrarChanged(address indexed legRegistrar);
    event LegAllowed(address indexed leg);
    event OwnerChanged(address indexed owner);

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

    function setQuoteSigner(address quoteSigner_) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(quoteSigner_ != address(0), "ZERO_SIGNER");
        quoteSigner = quoteSigner_;
        emit QuoteSignerChanged(quoteSigner_);
    }

    function setWriter(address writer_) external {
        require(msg.sender == owner, "NOT_OWNER");
        writer = writer_;
        emit WriterChanged(writer_);
    }

    /// A floor at or above 100% would brick minting (premium < maxPayout).
    function setMinPremiumBps(uint16 minPremiumBps_) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(minPremiumBps_ < 10_000, "BAD_BPS");
        minPremiumBps = minPremiumBps_;
        emit MinPremiumBpsChanged(minPremiumBps_);
    }

    function setLegRegistrar(address legRegistrar_) external {
        require(msg.sender == owner, "NOT_OWNER");
        legRegistrar = legRegistrar_;
        emit LegRegistrarChanged(legRegistrar_);
    }

    /// Add-only: the registrar key cannot strand open tickets.
    function allowLeg(address leg) external {
        require(msg.sender == owner || msg.sender == legRegistrar, "NOT_REGISTRAR");
        allowedLeg[leg] = true;
        emit LegAllowed(leg);
    }

    function setOwner(address owner_) external {
        require(msg.sender == owner, "NOT_OWNER");
        require(owner_ != address(0), "ZERO_OWNER");
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    function parlay(uint256 id) external view returns (Parlay memory) {
        return _parlays[id];
    }

    /// Public: the writer service hashes quotes exactly this way (EIP-712 "ParlayVault" v1).
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

    /// Escrow = premium from the taker + (maxPayout − premium) from the writer's
    /// allowance. Duplicate legs are not checked: house-signed garbage only
    /// hurts the house.
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
            require(allowedLeg[q.legs[i].vault], "LEG_NOT_ALLOWED");
            require(!IOutcomeLeg(q.legs[i].vault).settled(), "LEG_SETTLED");
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

    /// Permissionless. YES hits iff fraction == 1e18, NO iff == 0, between is
    /// fractional. Lost beats fractional. Dead: full pot to the snapshotted
    /// writer, token kept as receipt. Void: premium back to the holder, rest to
    /// the writer, token burned. Won: paid on claim so payout follows ownership.
    /// Leg reads are `view` on IOutcomeLeg, so the loop is STATICCALL-only.
    function resolveParlay(uint256 id) public {
        Parlay storage p = _parlays[id];
        require(p.status == Status.Open && p.maxPayout != 0, "NOT_OPEN");
        bool anyFractional;
        bool allSettled = true;
        for (uint256 i; i < p.legs.length; i++) {
            IOutcomeLeg v = IOutcomeLeg(p.legs[i].vault);
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

    /// Auto-resolves, then pays maxPayout to the current owner. The burn is the
    /// double-pay guard. An auto-resolve that lands on Dead/Void is rolled back
    /// by NOT_WON; call resolveParlay directly for those.
    function claim(uint256 id) external {
        Parlay storage p = _parlays[id];
        if (p.status == Status.Open) resolveParlay(id);
        require(p.status == Status.Won, "NOT_WON");
        require(msg.sender == ownerOf(id), "NOT_OWNER_OF");
        _burn(id);
        usdc.safeTransfer(msg.sender, p.maxPayout);
    }
}
