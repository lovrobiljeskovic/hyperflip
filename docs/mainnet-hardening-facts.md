# Key Facts for Mainnet Hardening

Load-bearing facts and invariants an implementer must respect while working the
tasks in `mainnet-hardening-handoff.md`. These are scattered across code comments,
FINDINGS, and testnet spikes; collected here so a fix does not silently break one.
Verify against the code before relying on any single line number.

---

## Solvency & exposure model

- **The on-chain writer allowance is the hard solvency cap.** `ParlayVault.mintParlay`
  escrows the **full `maxPayout − premium`** from the writer's ERC-20 allowance at
  mint (`src/ParlayVault.sol:171`). `premium == stake`. Pausing the house = revoking
  the allowance; there is no pause switch. Any exposure-accounting change must keep
  this as the ceiling — the in-memory book only refines *below* it.
- **`ExposureBook` is in-memory and lost on restart by design** (`writer/src/exposure.ts:12-16`).
  Reservations expire within `quoteTtlMs` + a grace period (`writer/src/exposure.ts`
  `reservationGraceMs`, mainnet-hardening P1-7); open per-market/cluster exposure is
  rebuilt from on-chain state (`nextId` + `parlay(id)`) at startup via `Poker.seed()`
  (`writer/src/poker.ts`, mainnet-hardening P1-6), not from replaying
  `ParlayMinted`/`ParlayResolved` from genesis. It tracks
  reservations (pre-mint) and opens (post-mint) *on top of* the allowance.
- `check` order: global (allowance − reservedGlobal) → per-market → per-cluster.
  `headroom` is returned so the caller can suggest a fitting stake. Risk is linear
  in stake (`premium == stake`, `maxPayout == stake × mult`).
- Vault membership is tested with `includes/some`, not summed per entry, so a
  duplicated vault does not double-count today (`server.ts:118` dedupe is defensive).

## Pricing / quoting engine

- **Edge is split, not correlated:** base `edgeBps` (flat in leg count) +
  `legEdgeBps` per leg past the first. Correlation lives in the **joint
  probability** (the copula), never in the edge — billing it in both places would
  double-charge (`writer/src/pricing.ts`, `edgeBreakdown`).
- `jointProbWad` evaluates the copula at `(1 ± rhoBandPct)` × every pairwise rho
  and quotes the **house-favorable end** (higher joint ⇒ lower payout). Default
  `rhoBandPct = 0.2`. The band exists because the loadings table is **hand-set, not
  measured** (`writer/src/correlation.ts`, `config.ts`).
- The correlation table must be non-empty or the writer refuses to boot — an empty
  table silently prices every parlay as independent (`config.ts:159`).
- `minPremiumBps` is **owner-settable on-chain**; the env value is only a startup
  default and the chain value always wins (`index.ts:31-51`). A fix touching
  pricing must read the chain value, not the env.
- The copula runs on the **shared event loop** and is bounded by
  `MAX_QUADRATURE_POINTS = 4_000_000` (~180ms/call, ~360ms/quote — both band ends).
  Over-budget tickets are **refused** (`TooComplexError` → `400 ticket-too-complex`),
  never silently coarsened (`writer/src/copula.ts:225-262`). Do not loosen this to
  admit a ticket; move the integral off-loop (worker thread) if that is ever needed.
- Quote TTL = deadline = `quoteTtlMs` (default 30s). `lockoutMs` (default 600s)
  refuses legs inside a market's expiry window.
- `dominatingLeg` refuses a parlay that pays no more than one of its own legs traded
  alone on Core — strictly dominated, refuse regardless of correlation table
  (`pricing.ts:69`).

## Core / precompile semantics (do not re-learn the hard way)

- **Precompiles serve LIVE Core state only.** A pinned `eth_call` with a block tag
  is **ignored** by 0x800–0x814 — it returns current Core state regardless of the
  block number given (0x809 probe, 2026-08-25). Never try to read a historical /
  pre-op baseline by pinning a precompile call to a block
  (`keeper/src/core814.ts:34-40`, `writer/src/spotPx.ts` header). This is the whole
  reason the keeper uses ambient sampling for baselines.
- **0x80e bbo serves encoded outcome ids** (`uint32` = `outcomeTokenIndex`): returns
  `(bid, ask)` 1e8-scaled; the NO book is the complement of the YES book (YES bid 0.55 ⇒
  NO ask 0.45). Hedge spike 2026-09-16, `script/spike/FINDINGS-hedge.md`. No open-order
  precompile exists; resting state is only visible as 0x801 `hold`.
- **0x808 spotPx = last-trade price**, a 1e8-scaled `uint64`; WAD = `raw × 1e10`.
  Can be stale on a dead market — this is the root of handoff task P0-1
  (`writer/src/spotPx.ts`).
- **0x801 spot balance** returns Core wei (5-decimal for outcome coins), live state
  only (`keeper/src/core814.ts:41`).
- **Outcome asset id encoding:** `100_000_000 + 10×outcome + side` (side: 0 = yes,
  1 = no). Used by both 0x801 and 0x808 since the 2026-08 testnet update
  (`keeper/src/pure.ts:29`).
- **allMids carries no outcome coins** (verified 2026-08-25) — it can never price a
  leg, which is why the writer falls through to spotPx, not allMids
  (`writer/src/infoApi.ts` header).
- Outcome status: 1 = ACTIVE, 2 = SETTLED, 3 = PRUNED. `settledValue` scale 1e8;
  `fractionWad = settledValue × 1e18 / 1e8`.
- **Pruning delay varies; do not assume a ten-minute SLA.** An earlier testnet
  outcome reached 2→3 in roughly ten minutes; outcome 19467 on September 18
  took **109m04s–111m04s** within the observer's read windows. Fresh status-3
  reads corroborated pruning. The keeper must fire settle() promptly on status 2
  and cache the fraction, because after
  pruning the only way to settle is to relay a fraction observed pre-prune
  (`keeper/src/keeper.ts:397-447`). The settlement-fraction cache
  (`SETTLEMENT_CACHE_PATH`) must survive restarts — on a container, mount it.
- **Settlement credit can be net of a fee.** Testnet probe 19467 held 10 YES +
  10 NO: 10 USDC gross, **0.014 USDC settlement fee** in `userFills`, **9.986
  USDC net**. Token-0 total rose from 9 to 18.986 and survived status 3. This
  fixture's status/credit changes first appear in the same one-minute sample;
  exact credit delay/order is unresolved. Outcome-token reads failed with
  `rpc-error`/−32003 after settlement, not proven explicit EVM reverts or zero
  balances. No kickoff/in-play order behavior was tested. These are testnet
  observations, not mainnet guarantees; see
  [September 18 evidence](s8a-testnet-evidence.md#overnight-review--2026-09-18-08050814-utc--10051014-zagreb).

## Keeper attestation trust model

- **`attest(executed=false)` is only ever returned when `confidentBaseline` is
  true** — a provably pre-op ambient sample existed. A rebuilt/low-confidence op
  times out to **`hold`** (wait + alert once), never guesses a drop
  (`keeper/src/pure.ts:49-66`, `keeper.ts:344-364`).
- A confident baseline requires an ambient balance sample read **strictly before**
  the OpQueued block's own timestamp — Core cannot execute before that block exists.
  `CLOCK_SKEW_MARGIN_MS = 2000` assumes the keeper clock is never behind chain time
  by more than that; `MAX_SAMPLE_AGE_MS = 60000` stops a stalled sampler serving an
  ancient sample as "current" (`keeper.ts:31-50`, `pure.ts:88-101`).
- A rejected split/merge on Core is **silent** — no error, no event, no balance
  change (FINDINGS.md step 5). So the no-delta timeout is **keeper-side policy**,
  not chain-trusted. The real recovery anchor is `OutcomeVault.setVerifier` (owner
  can swap out a wrong keeper), never the timeout.

## Infra / operational

- **Nightly rotation restarts both services.** `rotate.timer` fires 03:10 UTC;
  `rotate.service` runs `tools/rotate-markets.mjs`, rewrites
  `registry/markets.json`, then **restarts writer + keeper** (DEPLOY.md). The
  registry is **box-authoritative** — pull it from the box, never push over it. A
  fix that adds in-memory state the services rely on must survive (or cheaply
  rebuild after) this nightly bounce — this is exactly why P1-6 matters.
- **Single source of truth:** both writer and keeper read `registry/markets.json`.
  `VAULT_ADDRESSES` is a keeper override for retired-but-unsettled vaults; the
  registry is the default so a new market can't be quotable-but-unsettleable
  (`keeper/src/config.ts:57-66`).
- **The keeper already has the watchdog pattern the writer needs.** Stall threshold
  = `vaults × RECEIPT_TIMEOUT_MS + 120_000`; a stamp older than that ⇒
  `process.exit(1)` for systemd `Restart=always` (`keeper/src/keeper.ts:462-485`).
  Lift this into the writer for P0-2.
- **Testnet RPC constraints (assume similar shape on any HL RPC):** `getLogs`
  capped at 1000 blocks/query — scans must chunk (`writer/src/pure.ts:blockRanges`,
  `poker.ts:75`); bursts rate-limit with `-32005` (viem-retryable) — both services
  retry hard (retryCount 6, 2s delay) then fall through to the next comma-separated
  endpoint. The writer runs a higher-throughput `WRITER_RPC`; the keeper is pinned
  to the official endpoint because only it needs 0x814/0x801 (`config.ts` headers).
- **Two writer keys, one keeper key.** Writer: `QUOTE_SIGNER_PRIVATE_KEY` (signs
  EIP-712 quotes) and `POKER_PRIVATE_KEY` (sends `resolveParlay`). Keeper:
  `KEEPER_PRIVATE_KEY` (attest + settle). The nonce collision (P1-5) is *within* the
  single keeper key across its two loops.
- **EIP-712 parity is verified by a forge vector.** `writer/src/quotes.ts`
  `quoteTypes` must match `ParlayVault` `QUOTE_TYPEHASH` / `LEG_TYPEHASH` exactly
  (`writer/test/quotes.test.ts`). Do not touch the quote struct without updating
  both sides and the vector.

## Reject-reason vocabulary (keep stable; the UI and metrics key on it)

`bad-invite`, `bad-taker`, `bad-legs`, `bad-leg-count`, `bad-leg`, `unknown-vault`,
`expiry-lockout`, `bad-stake`, `stake-too-big`, `rpc-down`, `leg-settled`,
`stale-book`, `ticket-too-complex`, `dominated`, `no-payout`, `cannot-win`,
`at-capacity`, `market-cap`, `cluster-cap`, `sign-failed`, `rate-limited`,
`no-quotes` (relay: makers disagreed or none answered). New
refusal paths (e.g. a spotPx-stale refusal in P0-1) should reuse `stale-book` or
add a clearly-named reason and register it in the metrics counter.
