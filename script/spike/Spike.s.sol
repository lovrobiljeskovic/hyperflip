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
contract Spike is Script {
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
        ICoreWriter(CoreConstants.CORE_WRITER).sendRawAction(
            CoreConstants.encodeOutcomeOp(CoreConstants.OP_SPLIT_OUTCOME, outcome, w)
        );
        vm.stopBroadcast();
    }

    /// Verifies: OP_MERGE_OUTCOME numbering (UNVERIFIED = 1).
    function merge(uint32 outcome, uint64 w) external {
        vm.startBroadcast();
        ICoreWriter(CoreConstants.CORE_WRITER).sendRawAction(
            CoreConstants.encodeOutcomeOp(CoreConstants.OP_MERGE_OUTCOME, outcome, w)
        );
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
