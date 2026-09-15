# Mainnet Hardening — Implementation Handoff

Audit date: 2026-08-27. Scope: `writer/` (quoting engine + poker) and `keeper/`.
Target: close the unknown-unknowns that could bleed the bankroll or silently
stop recovery once real money is behind the ParlayVault allowance.

Read `docs/mainnet-hardening-facts.md` first — every task below has an invariant
it must not break, and the facts file is where those live. Line numbers are as of
commit `4c39f59`; re-grep before editing.

Tasks are ranked by mainnet money-loss risk. P0 = fix before any real bankroll.
Each task is independently shippable; they touch mostly disjoint files.

---

## P0-1 — spotPx fallback has no freshness gate (pickoff)

**Files:** `writer/src/index.ts:67-84` (`fetchLegPriceWad`), `writer/src/spotPx.ts`,
`writer/src/index.ts:58` + `:162` (`lastBookFetchMs`, `/health`).

**Problem.** When the Core l2Book is empty or the info API fails, the leg price
falls back to `readSpotPxWad` (0x808), which is Core's **last-trade price** with
no timestamp and no staleness check. On a thin or dead outcome book a taker who
knows the true probability has moved buys a leg priced off a stale mark. `edgeBps`
(5%) only covers the loss if the stale error is under 5%; a market that gapped is
a guaranteed house loss. `/health.lastBookFetchAgeMs` is a single global — it is
updated only on the book path (`index.ts:78`), so one fresh book makes health look
green while another leg silently rides stale spotPx.

**Fix direction.**
- Track a per-coin last-fresh-price timestamp (book fetch OR a spotPx read that we
  choose to trust), not one global.
- When the only available price for a leg is spotPx older than a configurable
  `SPOT_PX_STALE_MS`, either refuse the quote (`503 stale-book`, consistent with
  the existing empty-book path) or widen edge for that leg. Refuse is the honest
  default; widening needs a vol model we do not have (see P1-1).
- Surface per-coin freshness in `/health` so a stale leg is falsifiable from
  outside.

**Test.** Extend `writer/test/spotPx.test.ts` / a server test: book-empty +
spotPx-stale ⇒ leg refused; book-empty + spotPx-fresh ⇒ leg priced. Assert
`/health` exposes the per-coin age.

**Acceptance.** No quote is ever signed off a spotPx read older than the
threshold, and health distinguishes a fresh leg from a stale one.

---

## P0-2 — writer poker can wedge silently (no receipt timeout, no watchdog)

**Files:** `writer/src/index.ts:115-149` (poker wiring, `resolve`), `writer/src/poker.ts`.
Compare against keeper: `keeper/src/keeper.ts:271` (`RECEIPT_TIMEOUT_MS`) and
`:462-476` (watchdog).

**Problem.** The writer poker's `resolve` calls
`publicClient.waitForTransactionReceipt({ hash })` with **no timeout**
(`index.ts:123`). A stuck `resolveParlay` tx makes `poker.tick()` never return, so
the `finally { setTimeout(tick) }` at `index.ts:143` never runs and the poker dies.
Unlike the keeper, the writer `main` has **no watchdog** — nothing exits the process
for systemd to restart. From outside the writer looks healthy while the poker has
stopped recycling escrow and stopped warming the per-market/cluster caps.

**Fix direction.**
- Add `timeout: RECEIPT_TIMEOUT_MS` to the poker's `waitForTransactionReceipt`
  (mirror the keeper's constant).
- Add a last-tick timestamp for the poker and a watchdog `setInterval` that
  `process.exit(1)`s when the stamp is older than the worst legitimate tick, so
  systemd `Restart=always` recovers it. The keeper's watchdog at
  `keeper/src/keeper.ts:462` is the template — lift it.
- Confirm the writer's systemd unit has `Restart=always` (DEPLOY.md shows the
  keeper unit; verify the writer unit matches).

**Test.** Unit: a `resolve` that rejects/times out does not stop subsequent ticks
(the tick loop reschedules). Watchdog logic can be tested pure like the keeper's.

**Acceptance.** A hung resolve tx cannot silently stop the poker; the process
exits and is restarted.

---

## P0-3 — best-ask ignores size (1-lot book spoof moves the quote)

**Files:** `writer/src/infoApi.ts:10-15` (`bestAskWad`), `writer/src/spotPx.ts`.

**Problem.** `bestAskWad` returns `levels[1][0].px` — the best ask **price only**,
discarding `sz`. A single 1-unit ask at a manipulated price sets the leg price for
an arbitrary-size parlay. On mainnet, spoofing the outcome book with a tiny resting
order shifts every quote priced off it.

**Fix direction.**
- Require a minimum depth at (or size-weighted across) the top of book before
  trusting the ask: walk levels until cumulative `sz` covers a configurable
  `MIN_BOOK_DEPTH`, use that volume-weighted price; if the book is too thin, treat
  it as empty and fall through to the spotPx path (which P0-1 now gates on
  freshness).
- Keep the conservative "never sell below the book" property — take the worse of
  the depth-weighted ask and best ask if in doubt.

**Test.** `writer/test/spotPx.test.ts`: a book with a 1-lot top and a fat second
level prices off the depth-covering level, not the spoofed top. Thin book ⇒ null ⇒
fallback.

**Acceptance.** A single small resting order cannot materially move a signed leg
price.

---

## P0-4 — quote-reservation griefing (free liquidity DoS)

**Files:** `writer/src/server.ts:197-214` (check + reserve), `writer/src/index.ts:103`
(`quoteLimiter` 300/hr/IP), `writer/src/exposure.ts`.

**Problem.** Each `/quote` reserves `risk` against the exposure book until TTL
(30s) at zero cost to the caller. 300 quotes/hr/IP × `maxStake` risk — from one IP,
or rotated IPs / shared NAT — can pin the whole allowance headroom for 30s at a
time, returning `at-capacity` to real takers who never mint and never spend. The
existing per-IP limiter caps request rate, not reserved capital.

**Fix direction (pick one, cheapest first):**
- Cap **reserved-but-unminted** risk per taker address (not per IP) — a taker with
  N open reservations and no mints gets throttled on reserved capital, not request
  count. Keyed on `taker`, which is in the request and in the signature.
- Or shorten the reservation TTL well below the quote deadline and require a
  cheap mint-intent signal to extend it.
- Keep the on-chain allowance as the hard solvency cap regardless — this is about
  liveness for honest takers, not solvency.

**Test.** `writer/test/exposure.test.ts` / server test: one taker cannot reserve
more than the per-taker cap of unminted risk; a second taker is unaffected.

**Acceptance.** A caller who never mints cannot exhaust quotable headroom for
everyone else.

---

## P1-5 — keeper nonce collision between the two loops

**Files:** `keeper/src/keeper.ts:485` (`Promise.all([run("balance"…), run("settlement"…)])`),
`:259` (`attest`), `:374` (`settle`) — both use the one `walletClient` / `account`.

**Problem.** `balanceLoop` (attest) and `settlementLoop` (settle) run concurrently
and both send txs from the **same key with no explicit nonce**. viem derives the
nonce from the pending count per call; two writes firing close together fetch the
same nonce, so one reverts (`nonce too low`) or replaces the other. Testnet's low
volume hides it; mainnet op flow will collide.

**Fix direction.**
- Serialize all writes from the keeper account behind a single in-process queue
  (a promise chain / mutex) so attest and settle never race the nonce, OR
- Maintain an explicit nonce counter and pass `nonce` to each `writeContract`,
  resyncing from chain on error.
- Simplest lazy version: one shared `sendTx(fn)` wrapper that awaits the previous
  send before starting the next. Both loops call through it.

**Test.** Simulate two writes issued in the same tick; assert they receive
distinct sequential nonces (or are serialized).

**Acceptance.** attest and settle from the keeper never share a nonce under
concurrent loops.

---

## P1-6 — poker cold rescan under-enforces per-market caps (every night)

**Files:** `writer/src/poker.ts:41-52` (`nextBlock` in-memory), `:58-102`
(`fetchEvents` deployBlock→head chunked scan). Template for the fix:
`keeper/src/keeper.ts:218` (`seedPendingOps`, stateless rebuild).

**Problem.** `nextBlock` is in-memory, so every restart rescans from `deployBlock`
in 1000-block chunks. `rotate.service` restarts writer+keeper **nightly** (DEPLOY.md
"Nightly market rotation"), so this cold scan runs every night. Until it catches
up, `open` is incomplete, so `perMarketCap` / `perClusterCap` see less exposure
than real and bind looser than configured. The global allowance still hard-caps
solvency, but per-market concentration is unenforced during the catch-up window,
which grows with chain age.

**Fix direction.**
- Seed `open` from on-chain state instead of replaying logs from genesis: read
  `nextId` and `parlay(id)` for currently-open parlays (the same stateless-rebuild
  trick the keeper uses in `seedPendingOps`), then start the log scan at head.
- The existing chunked, resumable scan stays as the going-forward sync; only the
  cold-start seed changes.

**Test.** `writer/test/` poker: a restart with N open parlays on-chain rebuilds
`open` (and thus the caps) without scanning from `deployBlock`.

**Acceptance.** After restart the per-market/cluster caps reflect true open
exposure within one tick, independent of chain age.

---

## P1-7 — reserve→mint accounting gap

**Files:** `writer/src/server.ts:213-214` (reserve, TTL = `quoteTtlMs`),
`writer/src/poker.ts:115-131` (mint detection on tick), `writer/src/exposure.ts`.

**Problem.** The reservation TTL equals the quote deadline (30s). A taker who mints
on-chain near t=30 is picked up by the poker only on its next tick (≤ `pokerIntervalMs`
later). Between reservation expiry and mint detection the risk is uncounted, so the
writer can transiently sign past a per-market cap. Bounded by the allowance, and
partly overlapping with P1-6.

**Fix direction.** Lowest-effort: fold into P1-6 (a fast, accurate open-set rebuild
shrinks the window). If it still bites, hold an expired reservation as "pending
mint" for a grace period rather than pruning it exactly at deadline.

**Acceptance.** No per-market cap breach across the reserve→mint handoff under
normal tick latency.

---

## P2-8 — `/quote` CORS is `*` + invite codes never expire

**Files:** `writer/src/server.ts:301-313` (CORS headers),
`writer/src/waitlist.ts` (code issuance), `writer/src/server.ts:60-67` (invite gate).

**Problem.** `Access-Control-Allow-Origin: *` lets any origin request quotes with a
shared or leaked invite code, and codes are permanent. The invite gate is the only
wall in front of the exposure book.

**Fix direction.** Lock CORS to the known frontend origin(s) for `/quote` (leave
`/markets` open if the UI needs it cross-origin). Consider code expiry / revocation
once beta ends. Low urgency — the exposure caps bound the blast radius — but cheap.

---

## P2-9 — no per-taker exposure cap (concentration)

**Files:** `writer/src/exposure.ts` (`check`), `writer/src/server.ts:201`.

**Problem.** Caps are per-market and per-cluster, globally. One taker can
legitimately consume an entire market's cap — a concentration risk, not an
insolvency one. If per-taker limits are wanted for mainnet, add a per-taker
dimension to `ExposureBook.check` keyed on `taker`. Largely subsumed by P0-4's
per-taker reservation cap if that lands.

---

## P1-10 — in-play sports quoting off a lagging Core mid (OPEN, added 2026-09-11)

**Files:** `writer/src/server.ts` (`validateQuoteRequest`, `lockAtMs`), `tools/rotate-lib.mjs`
(`inWindow`), `web/app/build/page.tsx` (board filter).

**Problem.** Commit 42cf8f5 moved the sports lockout from kickoff (`startMs`) to the
resolution deadline (`expiryMs`) so matches stay on the board and quotable in-play — a
product decision. In-play, the true probability jumps at a goal/red card but the Core
mid only moves when someone repositions an order; on a thin book that window is seconds
to minutes. A taker on a live feed buys the winning side at the stale price. `EDGE_BPS`
covers noise, not a 30-point mispricing; exposure caps only bound the loss per event.
Harmless on testnet, a standard bot target on mainnet.

**Fix (any one, before real bankroll):** once `now >= market.startMs`, (a) widen the edge
for that leg, (b) cut the per-market cap, or (c) refuse for N seconds after a large mid
move. Reverting to kickoff lockout is the one-line fallback.

---

## Suggested sequencing

1. **P0-2** (watchdog) first — it protects you while you ship the rest; a wedge
   during hardening is the worst time to be blind.
2. **P0-1** and **P0-3** together — both are the "price off a bad number" family
   and touch the same `fetchLegPriceWad` / book path.
3. **P0-4**, then **P1-6** (which also relieves **P1-7**).
4. **P1-5** standalone in the keeper.
5. **P2** items as cleanup.

P1-1 (measured correlations, replacing the hand-set table) is tracked separately in
the `parlay-pricing-deferred` note — it is the dominant model risk but a larger
piece of work than this hardening pass; keep it on the roadmap, not this branch.
