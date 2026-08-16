# Testnet verification spike

Kills or confirms every UNVERIFIED value in `src/CoreConstants.sol`
(design spec §9.1). Human-executed: needs a funded Hyperliquid testnet
wallet. Each finding is a one-line patch to CoreConstants; rerun
`forge test` after patching.

Env: `TESTNET_RPC` (HyperEVM testnet RPC), `PRIVATE_KEY` (funded wallet).
Core actions are async (seconds); wait between a write step and its
read-back.
Keeper runbook: after settlement, call pullSettledFunds only once all
previously queued spotSends (cancel refunds, redeem payouts) have landed
on the EVM side — the sweep takes the entire Core balance.

## Run order

1. **Quote token identity** (design spec risk 1). Quote is USDC (USDH is
   sunset). Send a small amount of USDC to the Core system address from
   the wallet, then:
   `--sig "readBalances(address,uint64[])" $WALLET '[0,1,2,3]'`
   → whichever index credited is `quoteTokenCoreIndex`. Also fixes
   `weiMultiplier/weiDivisor` (credited wei vs sent EVM units).
2. **Outcome ids**: pick a live HIP-4 testnet market; question/outcome
   ids come from the HIP-4 frontend/API (no on-chain discovery).
3. **Split round-trip** (risk 2): fund Core account with quote, then
   `--broadcast --sig "split(uint32,uint32,uint64)" $Q $O $WEI` → wait →
   `readBalances($WALLET, [quoteIdx, outcomeIdxYes, outcomeIdxYes+1])`
   with `outcomeIdxYes` from `--sig "outcomeIndexYes(uint32)" $O`.
   - Quote debited + outcome indices credited ⇒ confirms
     `OP_SPLIT_OUTCOME = 0`, wei units, AND the outcome-balance
     read the vault's claim verification depends on.
   - Quote debited, outcome indices zero ⇒ index formula wrong or
     precompile does not serve outcome balances: probe nearby indices;
     if unreadable at any index, the claim-verification design must
     change (keeper attestation fallback) — flag before mainnet work.
   - Nothing debited ⇒ op numbering wrong: retry with op 1,2,3.
4. **Merge back** (risk 2): `merge` the same amount, read back: outcome
   indices debited, quote credited ⇒ confirms `OP_MERGE_OUTCOME = 1`.
5. **Silent rejection** (risk 4): `split` with wei larger than balance →
   tx succeeds, later read-back shows no change, no error anywhere ⇒
   confirms the no-feedback model the cancel path assumes.
6. **spotSend Core→EVM** (refund path): `spotSend($WALLET, quoteIdx, w)`
   → EVM balance credited ⇒ confirms `ACTION_SPOT_SEND = 6` and param
   layout. If not: consult docs for the correct id, patch CoreConstants.
7. **Deposit-shaped ordering** (the product's core assumption): deploy the
   real OutcomeVault to testnet and run one deposit in a single tx
   (transfer to system address + queued split). Read back after a few
   seconds: outcome legs credited ⇒ same-tx EVM→Core credit lands BEFORE
   queued actions execute, and a fresh contract address works as a Core
   account. If the split silently dropped instead, the ordering assumption
   is false — every deposit would need the 1h cancel path; stop and
   redesign before mainnet work.
8. **Send ordering + rejection shape**: queue two spot sends where the
   second overdraws the remaining balance. Confirm FIFO execution and that
   the overdrawn send is rejected in FULL (no partial fill) — the owed[]
   accounting and the settlement sweep both assume this.

## Findings → patches

| Finding | Patch site |
|---|---|
| quote token + index + decimals | vault constructor args at deploy; test fixture unaffected |
| op numbering | `CoreConstants.OP_*` |
| spot send id/layout | `CoreConstants.ACTION_SPOT_SEND`, `encodeSpotSend` |
| outcome index formula | `CoreConstants.outcomeTokenIndex` |
| outcome balances unreadable | redesign claim verification — stop, discuss |
| Core→EVM destination is not address(this) | the three `address(this)` spotSend call sites in `src/OutcomeVault.sol` (cancelDeposit, claimRedeem, pullSettledFunds) |
