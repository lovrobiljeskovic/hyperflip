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
    /// VERIFIED live (e2e 2026-08-16, M3 spike 2026-08-17). Fee is charged on
    /// top of the sent amount, sender side, never netted: in Core HYPE
    /// (0.00002 observed) when the sender holds any, else in the sent token
    /// (~$0.00056, floats with HYPE price). amount + fee > balance → silent
    /// drop. Core→EVM sends additionally require the wei amount to be a whole
    /// number of EVM token units (multiple of 100 for USDC's 8 Core vs 6 EVM
    /// decimals, spotMeta `evm_extra_wei_decimals: -2`) — else silent drop.
    uint24 internal constant ACTION_SPOT_SEND = 6;

    // VERIFIED live from a contract's Core account on an outcome asset
    // (Stage 0 hedge spike 2026-09-16, script/spike/FINDINGS-hedge.md):
    // actions 1, 9, 10, 11 accepted with `asset` = encoded outcome id and
    // limitPx/sz = 1e8 * human value (10 YES @ 0.55 held 5.5e8 quote wei).
    // Action 12 stayed UNVERIFIED: the builder EOA is ineligible on testnet
    // ("Builder has insufficient balance to be approved."), so the send
    // dropped silently and the layout is untested. The API names the same
    // book "#<encoded id - 1e8>"; 0x80e (bbo) serves the encoded id.
    uint24 internal constant ACTION_LIMIT_ORDER = 1;
    uint24 internal constant ACTION_ADD_API_WALLET = 9;
    uint24 internal constant ACTION_CANCEL_BY_OID = 10;
    uint24 internal constant ACTION_CANCEL_BY_CLOID = 11;
    uint24 internal constant ACTION_APPROVE_BUILDER_FEE = 12;
    /// Limit-order `encodedTif`: 1 Alo, 2 Gtc, 3 Ioc (docs).
    uint8 internal constant TIF_ALO = 1;
    uint8 internal constant TIF_GTC = 2;
    uint8 internal constant TIF_IOC = 3;

    // UNVERIFIED: operation numbering within action 17
    uint8 internal constant OP_SPLIT_OUTCOME = 0;
    uint8 internal constant OP_MERGE_OUTCOME = 1;
    uint8 internal constant OP_MERGE_QUESTION = 2;
    uint8 internal constant OP_NEGATE_OUTCOME = 3;

    /// Outcome wei is 5-decimal: 1 share = 1e5 outcome wei = 1 USDC.
    /// FINDINGS.md #2 — the vault's prior quote-wei multiplier was 1000x wrong
    /// here; split/merge amounts must go through this conversion, not the
    /// quote one below.
    uint256 internal constant OUTCOME_WEI_PER_SHARE = 1e5;

    /// Quote wei is 8-decimal: 1 share = 1 USDC = 1e8 quote wei. Confirmed
    /// live: a 5.0 EVM USDC deposit (6-dec, so 1e6 EVM units per share)
    /// credited exactly 500,000,000 Core wei (FINDINGS.md "wei ratio").
    uint256 internal constant QUOTE_WEI_PER_SHARE = 1e8;

    /// `outcomeStatus` status codes: 0 never existed, 1 active, 2 settled
    /// (settledValue readable), 3 settled-and-pruned (settledValue GONE).
    uint8 internal constant OUTCOME_ACTIVE = 1;
    uint8 internal constant OUTCOME_SETTLED = 2;
    uint8 internal constant OUTCOME_PRUNED = 3;
    /// settledValue scale: 1e8 == fraction 1.0.
    uint64 internal constant SETTLED_VALUE_ONE = 1e8;

    /// 1 version byte ++ 3-byte big-endian action ID ++ abi-encoded params.
    function encodeAction(uint24 actionId, bytes memory params) internal pure returns (bytes memory) {
        return abi.encodePacked(ENCODING_VERSION, actionId, params);
    }

    /// Params are (op, question, outcome, wei) but the question word must be
    /// 0: CoreWriter silently drops split/merge payloads with a non-zero
    /// unused field (FINDINGS.md #1 — our first live split with question=976
    /// no-oped with no error). There is therefore no question parameter; the
    /// zero word is written unconditionally.
    function encodeOutcomeOp(uint8 op, uint32 outcome, uint64 wei_) internal pure returns (bytes memory) {
        return encodeAction(ACTION_OUTCOME_OP, abi.encode(op, uint32(0), outcome, wei_));
    }

    /// Param layout (destination, token index, wei) — verified live.
    function encodeSpotSend(address destination, uint64 token, uint64 wei_) internal pure returns (bytes memory) {
        return encodeAction(ACTION_SPOT_SEND, abi.encode(destination, token, wei_));
    }

    /// VERIFIED (2026-09-16). Action 1 (asset, isBuy, limitPx, sz, reduceOnly,
    /// encodedTif, cloid). limitPx/sz = 1e8 * human value; cloid 0 = none. The
    /// contract never learns the oid, so a non-zero cloid is the only cancel
    /// handle it has (encodeCancelByCloid). A resting bid locks px*sz quote
    /// wei in `hold`; a fill moves `total` with no fee on the buy side.
    function encodeLimitOrder(
        uint32 asset,
        bool isBuy,
        uint64 limitPx,
        uint64 sz,
        bool reduceOnly,
        uint8 tif,
        uint128 cloid
    ) internal pure returns (bytes memory) {
        return encodeAction(ACTION_LIMIT_ORDER, abi.encode(asset, isBuy, limitPx, sz, reduceOnly, tif, cloid));
    }

    /// VERIFIED (2026-09-16). Action 10 (asset, oid); hold released on cancel.
    function encodeCancelByOid(uint32 asset, uint64 oid) internal pure returns (bytes memory) {
        return encodeAction(ACTION_CANCEL_BY_OID, abi.encode(asset, oid));
    }

    /// VERIFIED (2026-09-16). Action 11 (asset, cloid); hold released on cancel.
    function encodeCancelByCloid(uint32 asset, uint128 cloid) internal pure returns (bytes memory) {
        return encodeAction(ACTION_CANCEL_BY_CLOID, abi.encode(asset, cloid));
    }

    /// VERIFIED (2026-09-16). Action 9 (apiWallet, name). Empty name = main
    /// agent (not listed by the `extraAgents` info call). Lets a contract
    /// delegate an off-chain key to trade its own Core account (roadmap
    /// §13.3); the fill landed on 0x801 for the contract address.
    function encodeAddApiWallet(address apiWallet, string memory name) internal pure returns (bytes memory) {
        return encodeAction(ACTION_ADD_API_WALLET, abi.encode(apiWallet, name));
    }

    /// UNVERIFIED. Action 12 (maxFeeRate in decibps, builder). Sent live
    /// 2026-09-16 but dropped: builder needs a funded perp account first.
    function encodeApproveBuilderFee(uint64 maxFeeDeciBps, address builder) internal pure returns (bytes memory) {
        return encodeAction(ACTION_APPROVE_BUILDER_FEE, abi.encode(maxFeeDeciBps, builder));
    }

    /// CoreWriter `asset` is uint32; the encoded outcome id fits. VERIFIED
    /// (2026-09-16): CoreWriter accepts it in that field for actions 1/10/11.
    function outcomeAssetId(uint32 outcome, bool yes) internal pure returns (uint32) {
        return uint32(outcomeTokenIndex(outcome, yes));
    }

    /// `deposit(uint256,uint32)` calldata for CORE_DEPOSIT_WALLET — call after
    /// `quote.approve(CORE_DEPOSIT_WALLET, amount)`. This is the EVM→Core
    /// USDC path (FINDINGS.md #3), not a CoreWriter action.
    function encodeDeposit(uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("deposit(uint256,uint32)", amount, CORE_DEPOSIT_SENTINEL);
    }

    /// EVM quote units → outcome wei (5-dec) for split/merge amounts.
    /// `evmUnitsPerShare` is 10**quoteDecimals (1 share = 1 quote unit-worth =
    /// 1 USDC), a per-vault value: real USDC is 6-dec, but the conversion is
    /// not allowed to assume it. Reverts on dust instead of truncating —
    /// a truncated split would mint more shares than the collateral backs.
    function evmToOutcomeWei(uint256 amountEvm, uint256 evmUnitsPerShare) internal pure returns (uint64) {
        return _convert(amountEvm, OUTCOME_WEI_PER_SHARE, evmUnitsPerShare);
    }

    /// EVM quote units → Core quote wei (8-dec) for deposit/transfer amounts.
    function evmToQuoteWei(uint256 amountEvm, uint256 evmUnitsPerShare) internal pure returns (uint64) {
        return _convert(amountEvm, QUOTE_WEI_PER_SHARE, evmUnitsPerShare);
    }

    /// Core quote wei (8-dec) → EVM quote units, rounded down (the caller is
    /// the vault crediting a user: dust stays with the vault).
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

    /// Encoded outcome asset id: 100_000_000 + 10*outcome + side (coin
    /// `#<id>`, token name `+<id>`). Accepted as the `token` arg by the 0x801
    /// spot-balance and 0x808 spot-px precompiles since the 2026-08 testnet
    /// update (verified 2026-08-25, keeper/src/core814.ts) — the FINDINGS.md
    /// 2026-08-14 "unreadable" kill-switch is obsolete. Balance is 5-dec
    /// outcome wei. 0x801 REVERTS for a pruned coin (status 3), so never read
    /// it after settlement without checking outcomeStatus first.
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

    /// Same read, keeping `hold` (wei locked under resting orders). VERIFIED
    /// (2026-09-16): a resting bid holds quote wei, a resting ask holds the
    /// outcome token; both release on cancel and move to `total` on fill.
    /// `hold` is never cash: a solvency check must use total - hold. There is
    /// no open-order precompile for outcome ids (0x80e bbo serves the encoded
    /// id), so "not filled and cancelled" is inferable only from hold = 0.
    function spotBalanceWithHold(address user, uint64 token) internal view returns (uint64 total, uint64 hold) {
        (bool ok, bytes memory ret) = SPOT_BALANCE_PRECOMPILE.staticcall(abi.encode(user, token));
        require(ok, "SPOT_BALANCE_READ_FAILED");
        (total, hold,) = abi.decode(ret, (uint64, uint64, uint64));
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
