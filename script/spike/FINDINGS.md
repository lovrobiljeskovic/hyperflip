# Testnet spike findings — 2026-08-14

Session executed README steps 1–4 against Hyperliquid testnet, then stopped
at the step-3 kill-switch (outcome balances unreadable from the EVM).
Steps 5–8 not run. Wallet `0xC1b15e354D5E4561B5692735070d874727001e48`;
market: question 976 (daily BTC price bucket), outcome 12385 ("above",
index:2), expiry 2026-08-15 06:00 UTC.

## Confirmed as-is (no patch needed)

| Constant | Value | Evidence |
|---|---|---|
| `ACTION_OUTCOME_OP` | 17 | split debited quote, minted outcome tokens; also in official CoreWriter action table |
| `OP_SPLIT_OUTCOME` | 0 | split of 1e6 wei debited exactly 10 USDC, minted 10.0 `+123850` and 10.0 `+123851` |
| `OP_MERGE_OUTCOME` | 1 | merge of 1e6 wei burned both sides, credited 10 USDC back |
| `ACTION_SPOT_SEND` id 6, layout `(address,uint64,uint64)` | matches official docs | not yet exercised live (step 6 pending) |
| `quoteTokenCoreIndex` | 0 (USDC) | wallet Core balance sits at token 0; spotMeta confirms |
| wei ratio | EVM USDC 6 decimals, Core wei 8 → multiplier 100, divisor 1 | 5.0 EVM USDC deposit credited exactly 500,000,000 Core wei, zero fee |
| Encoding: 1 version byte + 3-byte BE action id + abi params | verified via CoreWriter event log bytes |

Asset id formula `100_000_000 + 10*outcome + side` is confirmed by docs as
the ORDER-BOOK asset id (coin `#<enc>`, token name `+<enc>`), but it is NOT
a spot token index — see kill-switch below.

## Findings that break current vault code (patches NOT applied — kill-switch rule)

1. **Split/merge must send `question = 0`.** Docs: "Payloads with non-zero
   unused fields are dropped." Our first split with question=976 was
   silently dropped. `OutcomeVault.deposit`/`requestRedeem` pass the real
   question id — every vault split/merge would no-op.
2. **Outcome wei has 5 decimals** (1 share = 1e5 outcome wei = 1 USDC).
   Quote wei has 8. The vault passes quote-derived wei to split/merge —
   1000x too many shares → silent drop on insufficient balance, every time.
   `_toWei` needs a separate outcome-wei conversion for split/merge amounts.
3. **USDC EVM→Core is NOT an ERC20 transfer to the system address.**
   - Native testnet USDC ERC20: `0x2B3370eE501B4a559b57D449569354196457D8Ab`
     (6 decimals). The system address `0x2000...0000` is BLACKLISTED in it —
     transfer reverts `Blacklistable: account is blacklisted`.
   - Real path: `approve` + `deposit(uint256 amount, uint32 4294967295)` on
     the CoreDepositWallet `0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206`
     (this is what spotMeta's `evmContract` points at — a proxy deposit
     wallet, not the token; all ERC20 calls on it revert).
   - Vault's `quote.safeTransfer(coreSystemAddress, amount)` would revert
     for USDC. Deposit flow needs the approve+deposit shape (or a quote
     token whose linked-token transfer mechanism works — verify per token).
4. **Core→EVM = spotSend with destination = token system address**
   (`0x2000...0` for USDC), confirmed from funding-transaction ledger
   entries. The three `spotSend(address(this))` call sites in OutcomeVault
   (cancelDeposit, claimRedeem, pullSettledFunds) use the wrong
   destination. Not yet exercised live (step 6 pending).
5. Split+merge round trip lost 0.007 USDC on 10 (7 bps), not itemized in
   the ledger. Fee model unconfirmed; check before sizing amounts.

## Kill-switch: outcome balances are NOT readable from the EVM

- Spot-balance precompile 0x801 reverts for every candidate outcome index:
  encoding 123850, asset id 100123850, and exotic variants.
- Outcome balances have NO numeric token index anywhere: the API returns
  them as coin `"+123850"` with no `token` field
  (`spotClearinghouseState`).
- Official `L1Read.sol` (attachment on the Interacting-with-HyperCore docs
  page; copy in scratchpad) lists every precompile 0x800–0x814. The only
  balance read is `spotBalance`. No outcome-balance precompile exists.
  Empirical probe of 0x800–0x81f agrees.

Consequence: `claimDeposit` / `cancelDeposit` / `claimRedeem` /
`cancelRedeem` proofs (`_outcomeYesBalance`) cannot work as designed.
Redesign options, in preference order:

1. Quote-balance deltas (split debits / merge credits quote, readable at
   0x801 token 0; vault Core account is single-purpose so deltas are
   attributable).
2. Keeper attestation of `spotClearinghouseState` (trust added).

**Asked the Hyperliquid team** (2026-08-14): is an outcome-balance read
supported at some input we missed, or planned? Waiting on answer before
redesigning.

## New discovery: outcomeStatus precompile (0x814)

`outcomeStatus(uint32 outcome)` → `(uint8 status, uint64 settledValue,
uint32 question)`; settledValue scaled 1e8 = fraction 1.0. Status: 0 never
existed, 1 active, 2 settled (value available), 3 settled-and-pruned
(value GONE). Verified live: outcome 12385 → (1, 0, 976).

Implications:

- Settlement fraction is trustlessly readable on-chain → `settle()` can
  drop the keeper-relay and read 0x814 (removes the keeper trust
  assumption for settlement).
- Validates outcome→question binding at deploy time.
- NEW RISK: pruning. Observed on testnet: settled outcomes get pruned
  FAST — of ids 12200–12400, 158 were already status 3 and only 2 status 2;
  one pair transitioned 2→3 within ~10 minutes of being observed. If the
  vault reads settlement lazily it may find the value gone.
- Unknown: whether pruning waits for zero outstanding token supply (the
  vault always holds tokens at settlement, so this decides viability of
  reading 0x814 at leisure vs. capturing immediately). Second question
  sent to the Hyperliquid team. Decisive local experiment available:
  split on 12385, hold through tonight's 06:00 UTC settlement, watch
  status-2 duration and post-settle redemption mechanics.

## State / next steps

- Wallet end state: ~361.5 USDC Core spot, 95 native USDC on EVM,
  ~3 HYPE gas. All split positions merged back.
- Steps 5–8 pending (silent-rejection probe, spotSend live test, vault
  deposit-ordering test, FIFO/full-rejection test). Steps 5, 6, 8 are
  runnable independent of the kill-switch; step 7 needs the redesigned
  deposit flow first.
- Blocked on: Hyperliquid team answers (outcome-balance read; pruning
  trigger), then claim-verification redesign.
- Ids churn daily: refetch question/outcome ids at next session start
  (see HANDOVER.md for the curl).
