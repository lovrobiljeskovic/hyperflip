// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

/// HyperCore interop constants and payload encoding. Every value here was
/// verified live on testnet (docs/spike-findings.md).
library CoreConstants {
    address internal constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    address internal constant SPOT_BALANCE_PRECOMPILE = 0x0000000000000000000000000000000000000801;
    address internal constant OUTCOME_STATUS_PRECOMPILE = 0x0000000000000000000000000000000000000814;

    /// EVM→Core USDC path is `approve` + `deposit(amount, SENTINEL)` on this proxy
    /// (spotMeta `evmContract`); an ERC-20 transfer to the system address reverts.
    address internal constant CORE_DEPOSIT_WALLET = 0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206;
    /// Second `deposit` arg seen on every successful deposit; meaning unconfirmed.
    uint32 internal constant CORE_DEPOSIT_SENTINEL = 4294967295;

    uint8 internal constant ENCODING_VERSION = 1;
    uint24 internal constant ACTION_OUTCOME_OP = 17;
    /// spotSend fee is charged on top of the amount, never netted: in Core HYPE
    /// when the sender holds any, else in the sent token; amount + fee > balance
    /// is a silent drop. Core→EVM amounts must be whole EVM units (multiple of
    /// 100 for USDC's 8 Core vs 6 EVM decimals) or the send is silently dropped.
    uint24 internal constant ACTION_SPOT_SEND = 6;

    uint8 internal constant OP_SPLIT_OUTCOME = 0;
    uint8 internal constant OP_MERGE_OUTCOME = 1;

    /// Outcome wei is 5-decimal: 1 share = 1e5 outcome wei = 1 USDC. Split/merge
    /// amounts use this, never the quote conversion.
    uint256 internal constant OUTCOME_WEI_PER_SHARE = 1e5;

    /// Quote wei is 8-decimal: 1 share = 1 USDC = 1e8 quote wei.
    uint256 internal constant QUOTE_WEI_PER_SHARE = 1e8;

    /// 0x814 status codes: 0 never existed, 1 active, 2 settled (settledValue
    /// readable), 3 settled-and-pruned (settledValue gone; Core prunes within
    /// ~10 minutes).
    uint8 internal constant OUTCOME_ACTIVE = 1;
    uint8 internal constant OUTCOME_SETTLED = 2;
    uint8 internal constant OUTCOME_PRUNED = 3;
    /// settledValue scale: 1e8 == fraction 1.0.
    uint64 internal constant SETTLED_VALUE_ONE = 1e8;

    /// 1 version byte ++ 3-byte big-endian action ID ++ abi-encoded params.
    function encodeAction(uint24 actionId, bytes memory params) internal pure returns (bytes memory) {
        return abi.encodePacked(ENCODING_VERSION, actionId, params);
    }

    /// Params are (op, question, outcome, wei) but the question word must be 0:
    /// CoreWriter silently drops a split/merge whose unused field is non-zero.
    function encodeOutcomeOp(uint8 op, uint32 outcome, uint64 wei_) internal pure returns (bytes memory) {
        return encodeAction(ACTION_OUTCOME_OP, abi.encode(op, uint32(0), outcome, wei_));
    }

    function encodeSpotSend(address destination, uint64 token, uint64 wei_) internal pure returns (bytes memory) {
        return encodeAction(ACTION_SPOT_SEND, abi.encode(destination, token, wei_));
    }

    /// `deposit(uint256,uint32)` calldata for CORE_DEPOSIT_WALLET (after approve).
    function encodeDeposit(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("deposit(uint256,uint32)", amount, CORE_DEPOSIT_SENTINEL);
    }

    /// EVM quote units → outcome wei. Reverts on dust instead of truncating: a
    /// truncated split would mint more shares than the collateral backs.
    function evmToOutcomeWei(uint256 amountEvm, uint256 evmUnitsPerShare) internal pure returns (uint64) {
        return _convert(amountEvm, OUTCOME_WEI_PER_SHARE, evmUnitsPerShare);
    }

    function evmToQuoteWei(uint256 amountEvm, uint256 evmUnitsPerShare) internal pure returns (uint64) {
        return _convert(amountEvm, QUOTE_WEI_PER_SHARE, evmUnitsPerShare);
    }

    /// Core quote wei → EVM quote units, rounded down (dust stays with the vault).
    function quoteWeiToEvm(uint64 quoteWei, uint256 evmUnitsPerShare) internal pure returns (uint256) {
        return uint256(quoteWei) * evmUnitsPerShare / QUOTE_WEI_PER_SHARE;
    }

    function _convert(uint256 amountEvm, uint256 weiPerShare, uint256 evmUnitsPerShare) internal pure returns (uint64) {
        uint256 scaled = amountEvm * weiPerShare;
        uint256 w = scaled / evmUnitsPerShare;
        require(w > 0 && w <= type(uint64).max, "BAD_AMOUNT");
        require(w * evmUnitsPerShare == scaled, "DUST");
        return uint64(w);
    }

    /// Reverts when the precompile is absent (not HyperEVM, or a test without the mock).
    function spotBalance(address user, uint64 token) internal view returns (uint64 total) {
        (bool ok, bytes memory ret) = SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(user, token));
        require(ok, "SPOT_BALANCE_READ_FAILED");
        (total,,) = abi.decode(ret, (uint64, uint64, uint64));
    }

    /// `question` is the outcome's parent question, for binding validation.
    function outcomeStatus(uint32 outcome) internal view returns (uint8 status, uint64 settledValue, uint32 question) {
        (bool ok, bytes memory ret) = OUTCOME_STATUS_PRECOMPILE.staticcall(abi.encode(outcome));
        require(ok, "OUTCOME_STATUS_READ_FAILED");
        (status, settledValue, question) = abi.decode(ret, (uint8, uint64, uint32));
    }
}
