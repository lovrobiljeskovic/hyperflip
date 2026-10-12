// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CoreConstants} from "../src/CoreConstants.sol";
import {KeeperVerifier} from "../src/KeeperVerifier.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";
import {MockCoreDepositWallet, MockCoreWriter, MockSpotBalance, MockQuote} from "./mocks/Mocks.sol";

/// Applies HyperCore semantics to the actions MockCoreWriter recorded, with the
/// async gap modeled: nothing happens until a test calls processAll() /
/// processTransfersOnly() / processActions(). Also plays the keeper, attesting
/// the verdict it just applied to the KeeperVerifier.
///
/// Simplifications: a Core→EVM spotSend mints fresh MockQuote to the vault, and
/// creditSettlement() turns all outstanding split collateral into quote.
contract CoreSim {
    MockCoreWriter public immutable writer = MockCoreWriter(CoreConstants.CORE_WRITER);
    MockSpotBalance public immutable spot = MockSpotBalance(payable(CoreConstants.SPOT_BALANCE_PRECOMPILE));
    MockCoreDepositWallet public immutable depositWallet = MockCoreDepositWallet(CoreConstants.CORE_DEPOSIT_WALLET);
    MockQuote public immutable quote;
    uint64 public immutable tokenIndex;
    /// EVM quote units → Core quote wei (8-dec).
    uint256 public immutable weiMultiplier;

    OutcomeVault public vault;
    KeeperVerifier public verifier;
    uint256 public creditedTransferUnits;
    /// Quote wei locked inside outstanding splits.
    uint256 public splitOutstandingWei;
    mapping(uint256 => bool) public attested;
    /// Core still executes, the keeper just stops reporting.
    bool public keeperSilent;
    /// Hold Core→EVM sends back so a test can land them one at a time.
    bool public deferSpotSends;
    bytes[] internal deferredSends;
    uint256 public landedSends;
    /// A live split+merge round trip lost 7 bps; off by default so anchors stay exact.
    uint256 public mergeFeeBps;

    constructor(MockQuote quote_, uint64 tokenIndex_, uint256 mult) {
        quote = quote_;
        tokenIndex = tokenIndex_;
        weiMultiplier = mult;
    }

    function setVault(OutcomeVault vault_) external {
        vault = vault_;
    }

    function setVerifier(KeeperVerifier verifier_) external {
        verifier = verifier_;
    }

    function setKeeperSilent(bool silent) external {
        keeperSilent = silent;
    }

    function setDeferSpotSends(bool defer) external {
        deferSpotSends = defer;
    }

    /// Land the next `n` held-back sends, in queue order.
    function processSpotSends(uint256 n) external {
        for (uint256 i = 0; i < n && landedSends < deferredSends.length; i++) {
            _applySpotSend(deferredSends[landedSends++]);
        }
    }

    function setMergeFeeBps(uint256 bps) external {
        mergeFeeBps = bps;
    }

    /// Anyone can spotSend to the vault's Core account.
    function creditStray(uint64 quoteWei) external {
        _setCoreBalance(coreBalance() + quoteWei);
    }

    function coreBalance() public view returns (uint64) {
        return spot.total(address(vault), tokenIndex);
    }

    /// Credit EVM→Core deposits without executing queued actions.
    function processTransfersOnly() public {
        uint256 bal = quote.balanceOf(address(depositWallet));
        uint256 newUnits = bal - creditedTransferUnits;
        if (newUnits == 0) return;
        creditedTransferUnits = bal;
        _setCoreBalance(coreBalance() + toWei(newUnits));
    }

    function processActions() public {
        uint256 n = writer.payloadCount();
        for (uint256 i = writer.processedCount(); i < n; i++) {
            (bool isOutcomeOp, bool executed) = _apply(writer.getPayload(i));
            if (isOutcomeOp) _attest(executed);
        }
        writer.markProcessed(n);
    }

    function processAll() external {
        processTransfersOnly();
        processActions();
    }

    /// Core silently discards everything queued; the keeper reports Failed.
    function dropPendingActions() external {
        uint256 n = writer.payloadCount();
        for (uint256 i = writer.processedCount(); i < n; i++) {
            if (_actionId(writer.getPayload(i)) == CoreConstants.ACTION_OUTCOME_OP) _attest(false);
        }
        writer.markProcessed(n);
    }

    /// Stand-in for Core settling the vault's outcome tokens into quote.
    function creditSettlement() external {
        uint256 fee = splitOutstandingWei * mergeFeeBps / 10_000;
        _setCoreBalance(coreBalance() + uint64(splitOutstandingWei - fee));
        splitOutstandingWei = 0;
    }

    function toWei(uint256 evmUnits) public view returns (uint64) {
        return uint64(evmUnits * weiMultiplier);
    }

    function toUnits(uint64 wei_) public view returns (uint256) {
        return uint256(wei_) / weiMultiplier;
    }

    /// Split/merge amounts travel as 5-dec outcome wei; the collateral they
    /// move is 8-dec quote wei.
    function quoteWeiFor(uint64 outcomeWei) public pure returns (uint64) {
        return uint64(uint256(outcomeWei) * CoreConstants.QUOTE_WEI_PER_SHARE / CoreConstants.OUTCOME_WEI_PER_SHARE);
    }

    /// Ops are serialized, so the open pending slot names the op just processed.
    function _attest(bool executed) internal {
        if (keeperSilent) return;
        (,, uint256 depositOpId,) = vault.pendingDeposit();
        (,, uint256 redeemOpId) = vault.pendingRedeem();
        uint256 opId = depositOpId != 0 ? depositOpId : redeemOpId;
        if (opId == 0 || attested[opId]) return;
        attested[opId] = true;
        verifier.attest(keccak256(abi.encode(address(vault), opId)), executed);
    }

    function _setCoreBalance(uint64 amount) internal {
        spot.set(address(vault), tokenIndex, amount);
    }

    function _actionId(bytes memory p) internal pure returns (uint24) {
        require(p.length >= 4 && uint8(p[0]) == CoreConstants.ENCODING_VERSION, "CoreSim: bad payload");
        return (uint24(uint8(p[1])) << 16) | (uint24(uint8(p[2])) << 8) | uint24(uint8(p[3]));
    }

    function _apply(bytes memory p) internal returns (bool isOutcomeOp, bool executed) {
        uint24 actionId = _actionId(p);
        bytes memory params = new bytes(p.length - 4);
        for (uint256 i = 0; i < params.length; i++) {
            params[i] = p[i + 4];
        }

        if (actionId == CoreConstants.ACTION_OUTCOME_OP) {
            (uint8 op,,, uint64 wei_) = abi.decode(params, (uint8, uint32, uint32, uint64));
            uint64 collateral = quoteWeiFor(wei_);
            if (op == CoreConstants.OP_SPLIT_OUTCOME) {
                uint64 bal = coreBalance();
                if (bal < collateral) return (true, false); // Core rejects silently
                _setCoreBalance(bal - collateral);
                splitOutstandingWei += collateral;
                return (true, true);
            }
            if (op == CoreConstants.OP_MERGE_OUTCOME) {
                if (splitOutstandingWei < collateral) return (true, false); // silent rejection
                splitOutstandingWei -= collateral;
                _setCoreBalance(coreBalance() + collateral - uint64(uint256(collateral) * mergeFeeBps / 10_000));
                return (true, true);
            }
            return (true, false);
        }

        if (actionId == CoreConstants.ACTION_SPOT_SEND) {
            if (deferSpotSends) {
                deferredSends.push(params);
            } else {
                _applySpotSend(params);
            }
        }
        return (false, false);
    }

    function _applySpotSend(bytes memory params) internal {
        (,, uint64 wei_) = abi.decode(params, (address, uint64, uint64));
        uint64 bal = coreBalance();
        if (bal < wei_) return; // silent rejection
        if (toWei(toUnits(wei_)) != wei_) return; // not a whole EVM unit: silent drop
        _setCoreBalance(bal - wei_);
        quote.mint(address(vault), toUnits(wei_));
    }
}
