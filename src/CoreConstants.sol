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
    address internal constant OUTCOME_STATUS_PRECOMPILE = 0x0000000000000000000000000000000000000814;

    /// EVM→Core USDC deposit proxy (spotMeta's `evmContract` for USDC) — NOT
    /// the token address. `approve` + `deposit(amount, 4294967295)` here is
    /// the real EVM→Core USDC path; an ERC-20 transfer straight to the system
    /// address reverts (blacklisted). See FINDINGS.md #3.
    address internal constant CORE_DEPOSIT_WALLET = 0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206;
    /// Second arg observed on every successful spike deposit; meaning
    /// unconfirmed (uint32 max — possibly "no referral/sub-account id").
    uint32 internal constant CORE_DEPOSIT_SENTINEL = 4294967295;

    uint8 internal constant ENCODING_VERSION = 1;
    uint24 internal constant ACTION_OUTCOME_OP = 17;
    uint24 internal constant ACTION_SPOT_SEND = 6; // UNVERIFIED: action ID and param layout

    // UNVERIFIED: operation numbering within action 17
    uint8 internal constant OP_SPLIT_OUTCOME = 0;
    uint8 internal constant OP_MERGE_OUTCOME = 1;
    uint8 internal constant OP_MERGE_QUESTION = 2;
    uint8 internal constant OP_NEGATE_OUTCOME = 3;

    /// Outcome wei is 5-decimal: 1 share (1e6 EVM units, matching the 6-dec
    /// USDC/oYES/oNO amount minted 1:1 on deposit) = 1e5 outcome wei = 1 USDC.
    /// FINDINGS.md #2 — the vault's prior quote-wei multiplier was 1000x wrong
    /// here; split/merge amounts must go through this conversion, not the
    /// quote one below.
    uint256 internal constant OUTCOME_WEI_PER_SHARE = 1e5;
    uint256 internal constant EVM_UNITS_PER_SHARE = 1e6;

    /// Quote wei is 8-decimal, EVM USDC is 6-decimal, so EVM→Core is x100.
    /// Confirmed live: a 5.0 EVM USDC deposit credited exactly 500,000,000
    /// Core wei (FINDINGS.md "wei ratio").
    uint256 internal constant QUOTE_EVM_TO_CORE = 100;

    /// 1 version byte ++ 3-byte big-endian action ID ++ abi-encoded params.
    function encodeAction(uint24 actionId, bytes memory params) internal pure returns (bytes memory) {
        return abi.encodePacked(ENCODING_VERSION, actionId, params);
    }

    /// The question word is hardcoded to 0 regardless of the caller's input:
    /// CoreWriter silently drops split/merge payloads with a non-zero unused
    /// field (FINDINGS.md #1 — our first live split with question=976 no-oped
    /// with no error). The parameter is intentionally unnamed/ignored rather
    /// than removed, keeping call sites unchanged.
    function encodeOutcomeOp(uint8 op, uint32, uint32 outcome, uint64 wei_) internal pure returns (bytes memory) {
        return encodeAction(ACTION_OUTCOME_OP, abi.encode(op, uint32(0), outcome, wei_));
    }

    // UNVERIFIED param layout: (destination, token index, wei)
    function encodeSpotSend(address destination, uint64 token, uint64 wei_) internal pure returns (bytes memory) {
        return encodeAction(ACTION_SPOT_SEND, abi.encode(destination, token, wei_));
    }

    /// `deposit(uint256,uint32)` calldata for CORE_DEPOSIT_WALLET — call after
    /// `quote.approve(CORE_DEPOSIT_WALLET, amount)`. This is the EVM→Core
    /// USDC path (FINDINGS.md #3), not a CoreWriter action.
    function encodeDeposit(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("deposit(uint256,uint32)", amount, CORE_DEPOSIT_SENTINEL);
    }

    /// EVM units (6-dec, 1:1 with shares minted) → outcome wei (5-dec) for
    /// split/merge amounts.
    function evmToOutcomeWei(uint256 amountEvm) internal pure returns (uint64) {
        uint256 w = amountEvm * OUTCOME_WEI_PER_SHARE / EVM_UNITS_PER_SHARE;
        require(w <= type(uint64).max, "OUTCOME_WEI_OVERFLOW");
        return uint64(w);
    }

    /// Outcome wei (5-dec) → EVM units (6-dec).
    function outcomeWeiToEvm(uint64 outcomeWei) internal pure returns (uint256) {
        return uint256(outcomeWei) * EVM_UNITS_PER_SHARE / OUTCOME_WEI_PER_SHARE;
    }

    /// EVM USDC (6-dec) → Core quote wei (8-dec) for deposit/transfer amounts.
    function evmToQuoteWei(uint256 amountEvm) internal pure returns (uint64) {
        uint256 w = amountEvm * QUOTE_EVM_TO_CORE;
        require(w <= type(uint64).max, "QUOTE_WEI_OVERFLOW");
        return uint64(w);
    }

    /// Core quote wei (8-dec) → EVM USDC (6-dec).
    function quoteWeiToEvm(uint64 quoteWei) internal pure returns (uint256) {
        return uint256(quoteWei) / QUOTE_EVM_TO_CORE;
    }

    /// Order-book asset id (coin `#<id>`, token name `+<id>`), confirmed by
    /// docs: 100_000_000 + 10*outcome + side. This is NOT a spot token index —
    /// there is no spot-balance read for outcome tokens (FINDINGS.md
    /// kill-switch: 0x801 reverts for every candidate outcome encoding, and
    /// spotClearinghouseState lists outcome coins with no numeric token id).
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

    /// Read outcome settlement status via the 0x814 precompile: status 0
    /// never existed, 1 active, 2 settled (settledValue readable, scaled 1e8
    /// = fraction 1.0), 3 settled-and-pruned (settledValue GONE). `question`
    /// is the outcome's parent question, for binding validation.
    function outcomeStatus(uint32 outcome) internal view returns (uint8 status, uint64 settledValue, uint32 question) {
        (bool ok, bytes memory ret) = OUTCOME_STATUS_PRECOMPILE.staticcall(abi.encode(outcome));
        require(ok, "OUTCOME_STATUS_READ_FAILED");
        (status, settledValue, question) = abi.decode(ret, (uint8, uint64, uint32));
    }
}
