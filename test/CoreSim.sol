// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CoreConstants} from "../src/CoreConstants.sol";
import {MockCoreWriter, MockSpotBalance, MockQuote} from "./mocks/Mocks.sol";

/// Applies documented HyperCore semantics to the actions recorded by
/// MockCoreWriter, modeling the async gap: nothing happens until a test calls
/// processAll()/processTransfersOnly()/processActions().
///
/// Simplifications (test model, not production semantics):
/// - Core→EVM spotSend mints fresh MockQuote to the vault instead of moving it
///   from the system address; user-visible amounts are identical.
/// - creditSettlement() converts all outstanding split wei into quote balance,
///   standing in for Core's validator-final settlement of outcome tokens.
contract CoreSim {
    MockCoreWriter public immutable writer = MockCoreWriter(CoreConstants.CORE_WRITER);
    MockSpotBalance public immutable spot = MockSpotBalance(payable(CoreConstants.SPOT_BALANCE_PRECOMPILE));
    MockQuote public immutable quote;
    address public immutable systemAddress;
    uint64 public immutable tokenIndex;
    uint256 public immutable weiMultiplier;
    uint256 public immutable weiDivisor;

    address public vault;
    uint256 public creditedTransferUnits;
    uint256 public splitOutstandingWei;
    uint32 internal lastSplitOutcome;
    bool internal haveSplit;

    constructor(MockQuote quote_, address systemAddress_, uint64 tokenIndex_, uint256 mult, uint256 div) {
        quote = quote_;
        systemAddress = systemAddress_;
        tokenIndex = tokenIndex_;
        weiMultiplier = mult;
        weiDivisor = div;
    }

    function setVault(address vault_) external {
        vault = vault_;
    }

    function coreBalance() public view returns (uint64) {
        return spot.total(vault, tokenIndex);
    }

    /// Credit EVM→Core transfers (quote sitting at the system address) to the
    /// vault's Core balance, without executing queued actions.
    function processTransfersOnly() public {
        uint256 bal = quote.balanceOf(systemAddress);
        uint256 newUnits = bal - creditedTransferUnits;
        if (newUnits == 0) return;
        creditedTransferUnits = bal;
        spot.set(vault, tokenIndex, coreBalance() + toWei(newUnits));
    }

    function processActions() public {
        uint256 n = writer.payloadCount();
        for (uint256 i = writer.processedCount(); i < n; i++) {
            _apply(writer.getPayload(i));
        }
        writer.markProcessed(n);
    }

    function processAll() external {
        processTransfersOnly();
        processActions();
    }

    function dropPendingActions() external {
        writer.dropPending();
    }

    /// Stand-in for Core settling the vault's outcome tokens into quote.
    function creditSettlement() external {
        spot.set(vault, tokenIndex, coreBalance() + uint64(splitOutstandingWei));
        splitOutstandingWei = 0;
        if (haveSplit) {
            spot.set(vault, CoreConstants.outcomeTokenIndex(lastSplitOutcome, true), 0);
            spot.set(vault, CoreConstants.outcomeTokenIndex(lastSplitOutcome, false), 0);
        }
    }

    function toWei(uint256 evmUnits) public view returns (uint64) {
        return uint64(evmUnits * weiMultiplier / weiDivisor);
    }

    function toUnits(uint64 wei_) public view returns (uint256) {
        return uint256(wei_) * weiDivisor / weiMultiplier;
    }

    function _bumpOutcome(uint32 outcome_, uint64 wei_, bool up) internal {
        for (uint256 i = 0; i < 2; i++) {
            uint64 idx = CoreConstants.outcomeTokenIndex(outcome_, i == 0);
            uint64 cur = spot.total(vault, idx);
            spot.set(vault, idx, up ? cur + wei_ : cur - wei_);
        }
    }

    function _apply(bytes memory p) internal {
        require(p.length >= 4 && uint8(p[0]) == CoreConstants.ENCODING_VERSION, "CoreSim: bad payload");
        uint24 actionId = (uint24(uint8(p[1])) << 16) | (uint24(uint8(p[2])) << 8) | uint24(uint8(p[3]));
        bytes memory params = new bytes(p.length - 4);
        for (uint256 i = 0; i < params.length; i++) {
            params[i] = p[i + 4];
        }

        if (actionId == CoreConstants.ACTION_OUTCOME_OP) {
            (uint8 op,, uint32 outcome_, uint64 wei_) = abi.decode(params, (uint8, uint32, uint32, uint64));
            if (op == CoreConstants.OP_SPLIT_OUTCOME) {
                uint64 bal = coreBalance();
                if (bal < wei_) return; // Core rejects silently — no error feedback
                spot.set(vault, tokenIndex, bal - wei_);
                splitOutstandingWei += wei_;
                lastSplitOutcome = outcome_;
                haveSplit = true;
                _bumpOutcome(outcome_, wei_, true);
            } else if (op == CoreConstants.OP_MERGE_OUTCOME) {
                if (splitOutstandingWei < wei_) return; // silent rejection
                splitOutstandingWei -= wei_;
                spot.set(vault, tokenIndex, coreBalance() + wei_);
                _bumpOutcome(outcome_, wei_, false);
            }
        } else if (actionId == CoreConstants.ACTION_SPOT_SEND) {
            (,, uint64 wei_) = abi.decode(params, (address, uint64, uint64));
            uint64 bal = coreBalance();
            if (bal < wei_) return; // silent rejection
            spot.set(vault, tokenIndex, bal - wei_);
            quote.mint(vault, toUnits(wei_));
        }
    }
}
