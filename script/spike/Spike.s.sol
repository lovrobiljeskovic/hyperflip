// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CoreConstants, ICoreWriter} from "../../src/CoreConstants.sol";

/// Testnet verification spike (design spec §9.1). Run each step with:
///   forge script script/spike/Spike.s.sol --rpc-url $TESTNET_RPC \
///     --private-key $PRIVATE_KEY --broadcast --sig "<step>(...)" <args>
/// Read steps use --sig without --broadcast. See script/spike/README.md for
/// the run order and which CoreConstants value each step confirms or kills.
///
/// Hedge spike (Stage 0, README-hedge.md): every write step takes a `via`
/// address. `via == address(0)` sends the CoreWriter action from the EOA
/// (its own Core account); otherwise it goes through a deployed HedgeProbe
/// so the action executes on the CONTRACT's Core account — the case the
/// margin vault design depends on.
contract Spike is Script {
    function _send(address via, bytes memory payload) internal {
        vm.startBroadcast();
        if (via == address(0)) ICoreWriter(CoreConstants.CORE_WRITER).sendRawAction(payload);
        else HedgeProbe(via).exec(payload);
        vm.stopBroadcast();
    }

    /// Deploy the probe contract; its address is the Core account under test.
    function deployProbe() external {
        vm.startBroadcast();
        HedgeProbe p = new HedgeProbe();
        vm.stopBroadcast();
        console.log("HedgeProbe at %s", address(p));
    }

    /// total/hold for both sides of an outcome (encoded asset ids) and quote
    /// token 0. Verifies: hold rises on rest, releases on cancel, total moves
    /// on fill / settlement (UNVERIFIED spotBalanceWithHold semantics).
    function readHold(address who, uint32 outcome) external view {
        uint64[3] memory toks = [
            uint64(0), CoreConstants.outcomeTokenIndex(outcome, true), CoreConstants.outcomeTokenIndex(outcome, false)
        ];
        for (uint256 i = 0; i < 3; i++) {
            (bool ok, bytes memory ret) = CoreConstants.SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(who, toks[i]));
            if (!ok) {
                console.log("token %s: PRECOMPILE REVERTED (pruned?)", toks[i]);
                continue;
            }
            (uint64 total, uint64 hold,) = abi.decode(ret, (uint64, uint64, uint64));
            console.log("token %s: total %s hold %s", toks[i], total, hold);
        }
    }

    /// Item 8: action 9 from the probe (via) or EOA. Empty name = main agent.
    function addApiWallet(address via, address agent, string calldata name) external {
        _send(via, CoreConstants.encodeAddApiWallet(agent, name));
    }

    /// Item 5: action 12. maxFee in decibps (10 = 1 bp).
    function approveBuilderFee(address via, uint64 maxFeeDeciBps, address builder) external {
        _send(via, CoreConstants.encodeApproveBuilderFee(maxFeeDeciBps, builder));
    }

    /// Item 1: action 1 on the encoded outcome asset id. px/sz 1e8-scaled per
    /// docs (UNVERIFIED for outcome coins). tif: 1 Alo, 2 Gtc, 3 Ioc. Pass a
    /// non-zero cloid — it is the only cancel handle a contract has.
    function limitOrder(
        address via,
        uint32 outcome,
        bool yes,
        bool isBuy,
        uint64 limitPx,
        uint64 sz,
        uint8 tif,
        uint128 cloid
    ) external {
        _send(
            via,
            CoreConstants.encodeLimitOrder(
                CoreConstants.outcomeAssetId(outcome, yes), isBuy, limitPx, sz, false, tif, cloid
            )
        );
    }

    /// Item 3: action 10 (oid known off-chain only).
    function cancelByOid(address via, uint32 outcome, bool yes, uint64 oid) external {
        _send(via, CoreConstants.encodeCancelByOid(CoreConstants.outcomeAssetId(outcome, yes), oid));
    }

    /// Item 3: action 11, the contract-side cancel path.
    function cancelByCloid(address via, uint32 outcome, bool yes, uint128 cloid) external {
        _send(via, CoreConstants.encodeCancelByCloid(CoreConstants.outcomeAssetId(outcome, yes), cloid));
    }

    /// Split/merge/spotSend from the probe's Core account (same encoders as
    /// the EOA steps below).
    function splitVia(address via, uint32 outcome, uint64 w) external {
        _send(via, CoreConstants.encodeOutcomeOp(CoreConstants.OP_SPLIT_OUTCOME, outcome, w));
    }

    function spotSendVia(address via, address destination, uint64 token, uint64 w) external {
        _send(via, CoreConstants.encodeSpotSend(destination, token, w));
    }

    /// Read spot balances for a list of token indices. Verifies: quote token
    /// identity (which index credits after an EVM→Core transfer) and whether
    /// outcome-token balances are served by the precompile at
    /// outcomeTokenIndex() (CoreConstants UNVERIFIED formula).
    function readBalances(address who, uint64[] calldata tokens) external view {
        for (uint256 i = 0; i < tokens.length; i++) {
            (bool ok, bytes memory ret) = CoreConstants.SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(who, tokens[i]));
            if (!ok) {
                console.log("token %s: PRECOMPILE REVERTED", tokens[i]);
                continue;
            }
            (uint64 total, uint64 hold, uint64 entryNtl) = abi.decode(ret, (uint64, uint64, uint64));
            console.log("token %s: total %s hold %s", tokens[i], total, hold);
            console.log("  entryNtl %s", entryNtl);
        }
    }

    function outcomeIndexYes(uint32 outcome) external pure returns (uint64) {
        return CoreConstants.outcomeTokenIndex(outcome, true);
    }

    /// Verifies: action 17 op numbering (OP_SPLIT_OUTCOME = 0 UNVERIFIED),
    /// wei units, and silent-rejection behavior (send with insufficient
    /// balance, observe nothing happens and no revert).
    function split(uint32 outcome, uint64 w) external {
        vm.startBroadcast();
        ICoreWriter(CoreConstants.CORE_WRITER)
            .sendRawAction(CoreConstants.encodeOutcomeOp(CoreConstants.OP_SPLIT_OUTCOME, outcome, w));
        vm.stopBroadcast();
    }

    /// Verifies: OP_MERGE_OUTCOME numbering (UNVERIFIED = 1).
    function merge(uint32 outcome, uint64 w) external {
        vm.startBroadcast();
        ICoreWriter(CoreConstants.CORE_WRITER)
            .sendRawAction(CoreConstants.encodeOutcomeOp(CoreConstants.OP_MERGE_OUTCOME, outcome, w));
        vm.stopBroadcast();
    }

    /// Verifies: ACTION_SPOT_SEND id (UNVERIFIED = 6) and param layout
    /// (destination, token index, wei).
    function spotSend(address destination, uint64 token, uint64 w) external {
        vm.startBroadcast();
        ICoreWriter(CoreConstants.CORE_WRITER).sendRawAction(CoreConstants.encodeSpotSend(destination, token, w));
        vm.stopBroadcast();
    }
}

/// Owner-gated CoreWriter forwarder: a throwaway contract whose Core account
/// the hedge spike trades from. Fund it Core-internally (spotSend from the
/// EOA to this address, token 0) — not via CORE_DEPOSIT_WALLET, whose
/// contract-recipient crediting is the open mainnet gate M1.
contract HedgeProbe {
    address public immutable owner = msg.sender;

    function exec(bytes calldata payload) external {
        require(msg.sender == owner, "NOT_OWNER");
        ICoreWriter(CoreConstants.CORE_WRITER).sendRawAction(payload);
    }
}
