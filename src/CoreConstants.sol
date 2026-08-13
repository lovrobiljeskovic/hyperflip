// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

/// HyperCore interop constants and payload encoding.
/// Values marked UNVERIFIED are confirmed or patched by the testnet spike
/// (script/spike/) before any mainnet use. Keep every unverified value in this
/// file so a spike finding is a one-line patch.
library CoreConstants {
    address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address internal constant SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;

    uint8 internal constant ENCODING_VERSION = 1;
    uint24 internal constant ACTION_OUTCOME_OP = 17;
    uint24 internal constant ACTION_SPOT_SEND = 6; // UNVERIFIED: action ID and param layout

    // UNVERIFIED: operation numbering within action 17
    uint8 internal constant OP_SPLIT_OUTCOME = 0;
    uint8 internal constant OP_MERGE_OUTCOME = 1;
    uint8 internal constant OP_MERGE_QUESTION = 2;
    uint8 internal constant OP_NEGATE_OUTCOME = 3;

    /// 1 version byte ++ 3-byte big-endian action ID ++ abi-encoded params.
    function encodeAction(uint24 actionId, bytes memory params) internal pure returns (bytes memory) {
        return abi.encodePacked(ENCODING_VERSION, actionId, params);
    }

    function encodeOutcomeOp(uint8 op, uint32 question, uint32 outcome, uint64 wei_)
        internal
        pure
        returns (bytes memory)
    {
        return encodeAction(ACTION_OUTCOME_OP, abi.encode(op, question, outcome, wei_));
    }

    // UNVERIFIED param layout: (destination, token index, wei)
    function encodeSpotSend(address destination, uint64 token, uint64 wei_) internal pure returns (bytes memory) {
        return encodeAction(ACTION_SPOT_SEND, abi.encode(destination, token, wei_));
    }

    /// UNVERIFIED: outcome spot-token index formula (design spec §4: asset id
    /// = 100_000_000 + 10*outcome + side) and whether the spot-balance
    /// precompile serves outcome-token balances at all. Spike questions; the
    /// async-verification design depends on the answer.
    function outcomeTokenIndex(uint32 outcome, bool yes) internal pure returns (uint64) {
        return 100_000_000 + 10 * uint64(outcome) + (yes ? 0 : 1);
    }

    /// Read a Core spot balance via the precompile. Reverts if the precompile
    /// is absent (i.e. not running on HyperEVM or a test without the mock).
    function spotBalance(address user, uint64 token) internal view returns (uint64 total) {
        (bool ok, bytes memory ret) = SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(user, token));
        require(ok, "SPOT_BALANCE_READ_FAILED");
        (total,,) = abi.decode(ret, (uint64, uint64, uint64));
    }
}
