# Testnet Evidence-Based Correlation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, file-backed testnet research pipeline that calibrates and manually promotes measured correlation artifacts, journals every returned signed quote, joins quotes to HyperEVM outcomes, and reports champion-versus-challenger evidence without changing contracts or live marginal pricing.

**Architecture:** Keep the live writer isolated from research I/O: it reads one locally promoted, schema-validated champion artifact at startup and continues to price legs from testnet `l2Book`/`0x808`. Add batch research commands under the existing `writer` TypeScript package for source mapping, candle collection, return construction, calibration, replay, promotion, event joining, and static HTML reporting; all durable state lives below `RESEARCH_ROOT` in append-only partitions, journals, manifests, artifacts, and reports. Reuse Node built-ins and the already-installed `viem`; add no package dependency, Solidity change, paid provider, database, or live calibration call in `handleQuote`.

**Tech Stack:** TypeScript 5.7, Node.js 22 standard library (`fs`, `crypto`, `zlib`, `http`/`fetch`), `viem` 2.55, `tsx --test`, Foundry

**Spec:** `docs/superpowers/specs/2026-08-27-testnet-correlation-system-design.md`

## Global Constraints

- Testnet beta only; operational success must never be presented as mainnet profitability evidence.
- Track at most **20** explicitly mapped underlyings.
- Use public mainnet HyperCore `candleSnapshot` at interval **`1h`**, initially requesting at most **5,000** candles per underlying, then backfilling from the last durable open time.
- Use the most recent **180 days** for active calibration, exponential half-life **45 days**, and unweighted diagnostics at **30, 90, and 180 days**.
- Require **1,000** synchronized hourly observations for hourly within-cluster estimates, **90** synchronized daily observations for cross-session/cross-cluster estimates, and **80%** expected-observation coverage.
- A candidate whose `dataAsOf` age exceeds **30 hours** cannot be promoted; a champion age of **7 days or more** disables affected multi-asset quotes.
- Preserve the writer's existing allowance, per-market, per-cluster, freshness, dominance, and quadrature-complexity gates.
- No Solidity or EIP-712 quote field changes; `ParlayVault`, `OutcomeVault`, settlement, escrow, and keeper semantics remain unchanged.
- No automatic promotion, live t-copula signing, public real-time decision feed, managed SQL warehouse, QuickNode dependency, commercial feed, band-dispersion model, or mainnet rollout.
- Keep incremental infrastructure within **USD 0-20/month**; ask before adding dependencies, paid services, or touching production/shared state.
- Never persist `.env`, private keys, invite codes, emails, IP addresses, or raw private signatures in research facts, manifests, or reports.
- Preserve `/opt/hype/research` across deployment rsync and nightly market rotation; research jobs must not restart or stop the keeper.
- Every implementation task follows red-green-refactor and ends with its focused runnable check before a commit.

## Planned File Structure

- `registry/correlation-sources.json` — explicit logical-underlying to mainnet candle-coin mapping and operator eligibility/fallback decisions.
- `writer/src/research/types.ts` — versioned source, candle, manifest, artifact, quote, event, and report record types plus strict parsers.
- `writer/src/research/store.ts` — canonical JSON, SHA-256, durable append, gzip partition read/write, atomic state/artifact replacement, and manifest verification.
- `writer/src/research/candles.ts` — `candleSnapshot` parsing/validation, gap requests, idempotency, conflict quarantine, and hourly collection.
- `writer/src/research/returns.ts` — stale-bar classification, hourly/daily alignment, log returns, coverage/sample gates, and exclusion records.
- `writer/src/research/matrix.ts` — deterministic weighted statistics, structured pair shrinkage, Higham nearest-correlation projection, Cholesky, and matrix checks for at most 20 assets.
- `writer/src/research/calibration.ts` — diagnostics, non-negative hierarchical-factor fitting, structural same-underlying loading, immutable candidate creation, and candidate validation summary.
- `writer/src/research/replay.ts` — walk-forward synthetic-event replay, independence/static/measured/t-copula/FHS scoring, block bootstrap, and Supported/Inconclusive/Rejected decision.
- `writer/src/research/artifacts.ts` — artifact schema/freshness validation and manual atomic promotion after manifest/report verification.
- `writer/src/research/journal.ts` — durable quote decisions, redacted exports, resumable chain-event joins, and final settlement fractions.
- `writer/src/research/report.ts` — escaped static HTML report with explicit observed/estimate/operator labels.
- `writer/src/research/backup.ts` — optional standard-library S3-compatible SigV4 upload/verification with no credential logging.
- `writer/src/research/cli.ts` — non-interactive `collect`, `derive`, `calibrate`, `replay`, `promote`, `join`, `report`, `backup`, `daily`, and `check` command dispatcher.
- `writer/src/config.ts` — load the source registry and validated champion metadata; expose quote eligibility state.
- `writer/src/correlation.ts` — return both best-estimate and rho-band risk-adjusted joint probability without changing the factor model.
- `writer/src/correlationWorker.ts` — compute only the extra unbiased probability off the shared event loop with the existing per-integration work cap.
- `writer/src/infoApi.ts`, `writer/src/spotPx.ts` — retain book/precompile pricing while returning journalable source, time, depth, VWAP, and freshness metadata.
- `writer/src/server.ts`, `writer/src/index.ts` — enforce correlation quarantine/staleness, persist a signed decision before HTTP 200, and expose model/journal health.
- `writer/package.json`, `writer/.env.example` — add research commands/configuration using existing packages only.
- `tools/rotate-markets.mjs`, `tools/rotate-lib.mjs` — prevent rotation from activating unmapped or over-cap underlyings.
- `ops/systemd/hype-research-*.{service,timer}` — separate bounded collector and daily batch units.
- `DEPLOY.md` — persistent layout, install/promotion/runbook, backup, resource limits, and full testnet verification.
- `writer/test/research-*.test.ts`, `writer/test/fixtures/research/**` — focused unit/fixture/integration coverage discovered by the existing `test/*.test.ts` script.

---

### Task 1: Lock the Source Registry and Shared Schemas

**Files:**
- Create: `registry/correlation-sources.json`
- Create: `writer/src/research/types.ts`
- Create: `writer/test/research-types.test.ts`
- Create: `writer/test/fixtures/research/sources-invalid-over-cap.json`
- Modify: `tools/rotate-lib.mjs`
- Modify: `tools/rotate-markets.mjs`
- Modify: `tools/rotate-lib.test.mjs`

**Interfaces:**
- Produces: `parseSourceRegistry(raw: string): SourceRegistry`, `sourceFor(registry: SourceRegistry, underlying: string): SourceEntry | undefined`, and `filterMappedPicks(picks, registry, activeUnderlyings, max = 20)`.
- Produces exact record types used by every later task: `CandleRecord`, `ExclusionRecord`, `DataManifest`, `CorrelationArtifact`, `QuoteDecision`, and `JoinedEventRecord`.
- Consumes: current `registry/markets.json` `underlying`/`cluster` values and `tools/rotate-lib.mjs` pick shape.

- [ ] **Step 1: Write failing parser and rotation tests**

```ts
test("source registry rejects duplicates and more than twenty underlyings", () => {
  assert.throws(() => parseSourceRegistry(readFileSync(fixture("sources-invalid-over-cap.json"), "utf8")), /at most 20/);
});
```

In `tools/rotate-lib.test.mjs`, pass a plain parsed structure rather than importing TypeScript:

```js
test("rotation keeps only explicit source mappings without exceeding the active cap", () => {
  const sources = { schemaVersion: 1, sources: [btcSource] };
  assert.deepEqual(filterMappedPicks([{ perp: "BTC" }, { perp: "DOGE" }], sources, new Set(), 20), [{ perp: "BTC" }]);
});
```

- [ ] **Step 2: Run both focused suites and confirm the new exports are missing**

Run: `cd writer && npm test -- --test-name-pattern='source registry'`

Run: `node --test tools/rotate-lib.test.mjs`

Expected: the writer test FAILS because `../src/research/types.js` does not exist, and the rotation suite FAILS because `filterMappedPicks` does not exist.

- [ ] **Step 3: Add strict versioned parsers and the explicit mapping**

Define these exact source fields and reject unknown schema versions, duplicate underlyings, duplicate `(sourceNetwork, sourceCoin)`, malformed clusters/calendars, and source counts above 20:

```ts
export interface SourceEntry {
  schemaVersion: 1;
  underlying: string;
  sourceNetwork: "mainnet";
  sourceCoin: string;
  cluster: "crypto" | "equity" | "commodity";
  calendar: "continuous" | "session";
  session?: {
    timeZone: string;
    weekdays: number[];
    openLocal: string;
    closeLocal: string;
    closedDates: string[];
  };
  eligible: boolean;
  fallbackEligible: boolean;
}
export interface SourceRegistry { schemaVersion: 1; sources: SourceEntry[] }

export interface CandleRecord {
  schemaVersion: 1; source: "hyperliquid-info"; sourceNetwork: "mainnet";
  underlying: string; sourceCoin: string; interval: "1h";
  openTimeMs: number; closeTimeMs: number;
  open: string; high: string; low: string; close: string; volume: string;
  tradeCount: number; retrievedAtMs: number;
}

export interface ExclusionRecord {
  schemaVersion: 1; stage: "collect" | "returns" | "calibration" | "replay";
  underlying: string; peerUnderlying: string | null; timestampMs: number | null;
  reason: "missing-interval" | "non-positive-close" | "stale-session-bar" |
    "no-synchronized-peer" | "insufficient-sample" | "coverage-below-80pct" |
    "conflicting-observation" | "ineligible-source" | "insufficient-stress-sample" |
    "projection-failure" | "structurally-unavailable";
  sourceKeys: string[];
}

export interface DataManifest {
  schemaVersion: 1; createdAt: string; sourceRegistrySha256: string;
  sourceRange: { fromMs: number; toMs: number };
  underlyings: Record<string, { rows: number; firstUsableObservationMs: number | null;
    lastUsableObservationMs: number | null; missingIntervals: number[] }>;
  files: { path: string; bytes: number; sha256: string; rows: number; schemaVersion: 1 }[];
}
```

Populate the registry explicitly for the currently active logical set: `BTC`, `ETH`, `SOL`, `HYPE`, `ZEC`, `NVDA`, `SP500`, `SNDK`, `TSLA`, `AAPL`, and `GOLD`. Use unprefixed source coins for crypto and the documented `xyz:` prefix for HIP-3 equity/commodity coins. Session entries must declare an IANA time zone, weekdays, local open/close, and the beta window's explicit exchange-closure dates; continuous entries must omit `session`. Set `fallbackEligible` to `false` unless the approved artifacts explicitly record an operator-reviewed fallback.

Add the common record schemas with `schemaVersion: 1`, numeric market values stored as strings, millisecond timestamps as safe integers, hashes as lowercase 64-character hex, and an `assertNever` exhaustiveness helper. Do not add a schema library.

- [ ] **Step 4: Gate market rotation before any deploy call**

Load `registry/correlation-sources.json` beside `markets.json`, run `filterMappedPicks` immediately after `pickBinaries`, and exit non-zero before `bigBlocks("on")` if adding the picks would take the distinct active-underlying set above 20. Log skipped unmapped candidates by underlying only; do not guess mappings from titles. Keep the TS parser test in `writer/test/research-types.test.ts`; test the `.mjs` rotation helper separately with a plain structural registry object in `tools/rotate-lib.test.mjs`.

- [ ] **Step 5: Run the parser and rotation checks**

Run: `cd writer && npm test -- --test-name-pattern='source registry' && cd .. && node --test tools/rotate-lib.test.mjs`

Expected: PASS; output includes the source-registry tests and all existing rotation tests.

- [ ] **Step 6: Commit the independently testable registry slice**

Run: `git add registry/correlation-sources.json writer/src/research/types.ts writer/test/research-types.test.ts writer/test/fixtures/research/sources-invalid-over-cap.json tools/rotate-lib.mjs tools/rotate-markets.mjs tools/rotate-lib.test.mjs`

Then invoke `/caveman:caveman-commit` with intent `feat: lock correlation source registry`.

---

### Task 2: Build the Durable Store and Idempotent Candle Collector

**Files:**
- Create: `writer/src/research/store.ts`
- Create: `writer/src/research/candles.ts`
- Create: `writer/test/research-store.test.ts`
- Create: `writer/test/research-candles.test.ts`
- Create: `writer/test/fixtures/research/candle-snapshot.json`
- Create: `writer/test/fixtures/research/candle-conflict.json`
- Modify: `writer/src/research/cli.ts` (create with `collect` command only in this task)
- Modify: `writer/package.json`
- Modify: `writer/.env.example`

**Interfaces:**
- Consumes: `SourceRegistry` and `CandleRecord` from Task 1.
- Produces: `canonicalJson(value): string`, `sha256(bytes: string | Uint8Array): string`, `durableAppend(file, line): void`, `atomicWrite(file, bytes, hooks?): void`, `readCandlePartition(file): CandleRecord[]`, `buildDailyManifest(root, day): DataManifest`, `verifyManifest(root, manifest): void`.
- Produces: `parseCandleSnapshot(source, body, retrievedAtMs): CandleRecord[]`, `nextCandleRequest(source, lastOpenTimeMs, nowMs): CandleRequest`, and `collectSources(deps): Promise<CollectionSummary>`.

- [ ] **Step 1: Write failing storage durability and deterministic-hash tests**

```ts
test("canonical JSON and manifest hashes do not depend on object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256(canonicalJson({ a: 1, b: 2 })));
});

test("a failed atomic replacement leaves the prior champion bytes intact", () => {
  writeFileSync(champion, "old");
  assert.throws(() => atomicWrite(champion, "new", { beforeRename: () => { throw new Error("boom"); } }));
  assert.equal(readFileSync(champion, "utf8"), "old");
});
```

- [ ] **Step 2: Write failing collector fixture tests**

Cover exact Hyperliquid fields `t`, `T`, `s`, `i`, `o`, `h`, `l`, `c`, `v`, `n`; invalid OHLC ordering/non-finite numeric strings; reverse time; duplicate-identical idempotency; duplicate-different quarantine; initial 5,000-hour range; and gap start at `lastOpenTimeMs + 3_600_000`.

- [ ] **Step 3: Run focused tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='canonical JSON|candle snapshot|candle conflict|candle request'`

Expected: FAIL because store and collector functions are not implemented.

- [ ] **Step 4: Implement standard-library storage primitives**

Use `openSync`/`writeSync`/`fsyncSync`/`closeSync` for JSONL decisions and request journals, `gzipSync`/`gunzipSync` for immutable candle request shards, a sibling temporary file plus `renameSync` for atomic state replacement, and a directory `fsync` after promotion. Canonical JSON recursively sorts object keys, preserves array order, rejects `undefined`, `NaN`, infinities, and bigint, and writes exactly one trailing newline when used as a record.

Manifest entries must be sorted by relative path and contain `path`, `bytes`, `sha256`, `rows`, and `schemaVersion`; the manifest also stores each underlying's earliest/latest usable timestamp and missing expected intervals. Canonicalize the parsed source registry once per collection into immutable `facts/source-registries/<sha256>.json`, include that file in `manifest.files`, and set `sourceRegistrySha256` to its content hash; reproduction must never depend on the later contents of mutable `registry/correlation-sources.json`. The manifest hash is the SHA-256 of canonical JSON excluding no fields; derive `createdAt` from the maximum durable `retrievedAtMs` so repeated fixture runs are byte-identical.

- [ ] **Step 5: Implement bounded collector behavior**

Post this exact request shape to the mainnet URL from `RESEARCH_INFO_API_URL` (default `https://api.hyperliquid.xyz/info`):

```ts
{
  type: "candleSnapshot",
  req: { coin: source.sourceCoin, interval: "1h", startTime, endTime: nowMs }
}
```

Use `AbortSignal.timeout(10_000)` and three attempts at `250`, `1_000`, then `4_000` ms. A run first snapshots the exact canonical source registry as described above, then starts each source from the last durable open time, never from mutable in-memory progress. Key rows by `(sourceNetwork, sourceCoin, interval, openTimeMs)` and compare only immutable source observation fields (`openTimeMs`, `closeTimeMs`, OHLC, volume, trade count), not `retrievedAtMs`. Skip identical observations; write accepted new rows once to immutable `raw/candles/YYYY/MM/DD/<underlying>/<requestStart>-<requestEnd>-<retrievedAt>.jsonl.gz` shards; append differing observations to `quarantine/candles/YYYY/MM/DD.jsonl` without changing the accepted row. Persist every request range, retrieval time, HTTP status/error, and returned row count in `journal/requests/YYYY/MM/DD.jsonl`, and atomically persist per-source last durable timestamp in `state/collector.json`. Never append to or rewrite a sealed gzip shard.

- [ ] **Step 6: Add a non-interactive collector command**

Add scripts without adding dependencies:

```json
"research": "tsx src/research/cli.ts",
"research:check": "tsx --test test/research-*.test.ts"
```

`collect` reads `RESEARCH_ROOT`, `CORRELATION_SOURCES_FILE`, and `RESEARCH_INFO_API_URL`; it exits non-zero if any source fails after bounded retries but retains successful partitions so the next hourly run resumes gaps independently from writer Info API calls.

- [ ] **Step 7: Verify collector and deterministic fixture integration**

Run: `cd writer && npm run research:check -- --test-name-pattern='store|candle'`

Expected: PASS; two identical fixture collections produce the same partition and manifest hashes, and the conflict fixture leaves the accepted partition unchanged.

- [ ] **Step 8: Commit the collection slice**

Stage the Task 2 files, then invoke `/caveman:caveman-commit` with intent `feat: collect immutable correlation candles`.

---

### Task 3: Construct Session-Aware Returns and Quality Gates

**Files:**
- Create: `writer/src/research/returns.ts`
- Create: `writer/test/research-returns.test.ts`
- Create: `writer/test/fixtures/research/candles-continuous.jsonl`
- Create: `writer/test/fixtures/research/candles-session.jsonl`
- Modify: `writer/src/research/cli.ts`

**Interfaces:**
- Consumes: verified candle partitions and source metadata from Tasks 1-2.
- Produces: `classifyCandle(candle, source, previous): "active" | "stale"`, `trailingFresh(source, observedTimes, asOfMs, graceMs = 6 * HOUR): boolean`, `buildHourlyReturns(candles, source, window): ReturnRecord[]`, `buildDailyReturns(candles, source, window): ReturnRecord[]`, and `alignPair(a, b, sourceA, sourceB, window, mode): PairSample`.
- Produces: `QualityResult = { eligible, observations, expected, coverage, exclusions, mode }` with modes `hourly-within-cluster` and `daily-cross-session`.

- [ ] **Step 1: Write failing behavior tests**

```ts
test("missing intervals stay missing and are never forward-filled", () => {
  const returns = buildHourlyReturns([candle(0, "100"), candle(2 * HOUR, "121")], continuousSource, window(0, 2 * HOUR));
  assert.deepEqual(returns, []);
});

test("zero-volume repeated session close is stale", () => {
  assert.equal(classifyCandle(candle(1, "100", "0", 0), sessionSource, candle(0, "100")), "stale");
});

test("quality gates enforce 1000 hourly, 90 daily, and 80 percent coverage", () => {
  assert.equal(quality(sample(999, 1_000), "hourly-within-cluster").eligible, false);
  assert.equal(quality(sample(90, 100), "daily-cross-session").eligible, true);
  assert.equal(quality(sample(90, 120), "daily-cross-session").eligible, false);
});

test("daily session returns bridge weekends and declared holidays, not missing sessions", () => {
  assert.deepEqual(sessionDates(fridayThroughTuesday, nyseCalendar), ["2026-09-04", "2026-09-08"]);
  assert.equal(buildDailyReturns(fridayAndTuesdayCandles, sessionSource, fridayThroughTuesday).length, 1);
});

test("trailing freshness follows expected sessions instead of global dataAsOf", () => {
  assert.equal(trailingFresh(sessionSource, [fridayClose], saturdayNoon), true);
  assert.equal(trailingFresh(continuousSource, [fridayClose], saturdayNoon), false);
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='missing intervals|session close|quality gates'`

Expected: FAIL because return builders do not exist.

- [ ] **Step 3: Implement exact return/alignment rules**

Compute `Math.log(close_t / close_t-1)` only for positive finite closes. Anchor every expected-observation denominator to the fixed requested calibration window `[asOfMs - lookbackMs, asOfMs]`, never to the first/last shared observation. Continuous pairs use the complete one-hour grid in that window and the exact intersection of observed timestamps. For session sources, use `Intl.DateTimeFormat` with the registry's IANA zone plus declared weekdays/open/close/closed dates to enumerate expected active intervals, including DST; mark an observed bar active when `volume > 0`, `tradeCount > 0`, or close changes. Same-session hourly observations are the intersection of both assets over the explicit expected-session grid. Cross-session/cross-cluster daily returns use the final active close of each scheduled session and compute between consecutive active sessions, so Friday-to-Monday and holiday-to-next-session returns remain valid while a missing scheduled session creates an exclusion instead of a multi-day bridge. Manifest gaps, including simultaneous provider outages and leading/trailing gaps, reduce coverage even when both assets are absent.

Trailing freshness is a separate hard gate: enumerate the source's expected intervals and require the latest interval whose close is at or before `asOfMs - 6h` to be present and usable. Continuous assets therefore quarantine after a trailing gap over six hours; session assets remain fresh across declared closures/weekends but quarantine when the last expected session bar is missing. Apply this before pair estimation so a fresh crypto row cannot hide a stale equity source, and repeat the same schedule-aware check at promotion time in addition to the global 30-hour candidate-age gate.

Every dropped value emits an `ExclusionRecord` with one of: `missing-interval`, `non-positive-close`, `stale-session-bar`, `no-synchronized-peer`, `insufficient-sample`, or `coverage-below-80pct`. Add fixtures for Friday-to-Monday, a declared holiday, simultaneous provider outage, and leading/trailing window gaps. Write derived rows under `derived/returns/YYYY/MM/DD/*.jsonl.gz` and include exact source candle keys and transformation version.

- [ ] **Step 4: Add `derive` CLI command and fixture-level determinism test**

The command verifies the input manifest before reading partitions, refuses corrupt/missing files, writes immutable derived partitions plus a derived manifest, and is a no-op when the canonical derived output already exists.

- [ ] **Step 5: Run focused and research checks**

Run: `cd writer && npm run research:check -- --test-name-pattern='return|quality|derive'`

Expected: PASS; the fixture proves gaps are not forward-filled and repeated session closes do not become zero returns.

- [ ] **Step 6: Commit the return-quality slice**

Stage the Task 3 files, then invoke `/caveman:caveman-commit` with intent `feat: build session-aware correlation returns`.

---

### Task 4: Calibrate the Measured Hierarchical Champion

**Files:**
- Create: `writer/src/research/matrix.ts`
- Create: `writer/src/research/calibration.ts`
- Create: `writer/test/research-matrix.test.ts`
- Create: `writer/test/research-calibration.test.ts`
- Create: `writer/test/fixtures/research/returns-small.jsonl`
- Create: `writer/test/fixtures/research/expected-candidate.json`
- Modify: `writer/src/research/cli.ts`

**Interfaces:**
- Consumes: verified derived-return manifest and source registry.
- Produces: `weightedCorrelation(rows, halfLifeDays, asOfMs): { correlation: number; effectiveN: number }`, `structuredTargets(estimates, sources): { global: number; clusters: Record<string, number> }`, `shrinkPair(estimate, target): number`, `nearestCorrelation(matrix): number[][]`, `isPsd(matrix, tolerance = 1e-10): boolean`, and `cholesky(matrix): number[][]`.
- Produces: `fitHierarchical(target, sources): FactorFit`, `calibrate(input): CorrelationArtifact`, and an immutable candidate at `artifacts/candidates/<modelVersion>.json`.

- [ ] **Step 1: Write failing numeric tests with fixed tolerances**

Test log-return weights (`2 ** (-ageDays / 45)`), hand-calculated two-series weighted correlation/effective sample size, global/cluster structured targets, the exact scalar shrinkage formula below, a known indefinite 3x3 matrix becoming the expected Higham nearest correlation matrix, Cholesky reconstruction within `1e-10`, negative target preservation in `signedTarget`, and non-negative factor outputs whose squared loadings never exceed `0.99`.

- [ ] **Step 2: Run numeric tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='weighted correlation|structured shrinkage|nearest correlation|hierarchical fit'`

Expected: FAIL because matrix/calibration functions are absent.

- [ ] **Step 3: Implement small-matrix numerics without a dependency**

Use one coherent pairwise pipeline because session-aware pairs do not form one rectangular panel:

1. For each pair, use the Task 3 alignment mode over the fixed 180-day window, exponential weights `w = 2 ** (-ageDays / 45)`, two-pass centered sums, and `effectiveN = (sum(w) ** 2) / sum(w ** 2)`.
2. Admit a direct estimate only when its mode's sample and 80% coverage gates pass. Build the signed global target as the Fisher-z weighted mean of eligible cross-cluster correlations weighted by `effectiveN - 3` (zero if none), and each cluster target from eligible within-cluster pairs by the same rule (falling back to the global target if none).
3. For a direct pair correlation `r` and structured target `t`, use `variance = (1 - r * r) ** 2 / max(1, effectiveN - 1)` and `lambda = clamp(variance / max(variance, (r - t) ** 2), 0, 1)`, then `shrunk = (1 - lambda) * r + lambda * t`. For a pair below direct gates, use `t` only when both source entries have operator-reviewed `fallbackEligible: true`; otherwise quarantine the affected combination.
4. Assemble the signed symmetric target with diagonal one. Run Higham alternating projections with Dykstra correction: project onto the PSD cone by symmetric Jacobi eigendecomposition/eigenvalue floor `1e-10`, project onto unit diagonal, and stop at Frobenius delta `<= 1e-10` or fail after 1,000 iterations. Assert symmetry, unit diagonal, and PSD before returning.

This is a deterministic, structured reliability shrinkage inspired by the cited shrinkage research; do not call it Ledoit-Wolf. Record raw pair estimates, targets, `effectiveN`, lambda, shrunk values, fallback decisions, and the Higham projection delta so the target is reproducible.

- [ ] **Step 4: Implement the exact champion fit**

Use only pairs admitted by the pipeline above. Fit `global` and cluster loadings in `[0, sqrt(0.99)]` by deterministic coordinate descent over a `0.01` grid followed by `0.001` refinement, minimizing equal-weight squared residuals between `max(0, signedPsdTarget[i][j])` and the existing product-of-shared-loadings form. For each underlying set the structural loading to `sqrt(max(0, 0.99 - global^2 - cluster^2))`; label it `structural-underlying`, never as a second observed series. Pairs without direct eligibility use their explicit structured fallback only under the rule above; otherwise quarantine the underlying/combination.

Persist every canonical unordered pair (`min(underlying) + ":" + max(underlying)`) as `direct`, `fallback`, or `quarantined` with its reason. Quarantine an entire underlying only when its own source/freshness fails or it has no admissible pair; do not widen one bad pair into unrelated pairs.

Emit exact target/implied/residual values per pair, `maxProjectionError`, all original negative targets in `clippedNegativePairs`, and the nearest PSD signed matrix for challengers. Diagnostics are unweighted 30/90/180-day correlations; active fit uses 180 days and 45-day half-life.

- [ ] **Step 5: Make artifact bytes deterministic**

Derive `dataAsOf` from the latest included close, `createdAt` from the input manifest's deterministic timestamp, and `modelVersion` as `<YYYY-MM-DD>.<first-8-manifest-hash>`. Persist this artifact shape; all diagnostic matrices share the sorted `quality.matrixOrder`:

```ts
export interface CorrelationArtifact {
  schemaVersion: 1; modelVersion: string;
  modelFamily: "hierarchical-gaussian-factor"; createdAt: string; dataAsOf: string;
  dataManifestSha256: string; sourceRegistrySha256: string;
  policy: { lookbackDays: 180; halfLifeDays: 45; diagnosticWindowsDays: [30, 90, 180];
    minHourly: 1000; minDaily: 90; minCoverage: 0.8; maxProjectionError: 0.10 };
  quality: {
    matrixOrder: string[]; eligibleUnderlyings: string[];
    quarantinedUnderlyings: { underlying: string; reason: string }[];
    pairEligibility: { pair: [string, string]; status: "direct" | "fallback" | "quarantined";
      reason: string }[];
    lastUsableObservationMs: Record<string, number | null>;
    pairDiagnostics: { pair: [string, string]; mode: string; observations: number;
      expected: number; coverage: number; effectiveN: number | null;
      raw: number | null; shrinkTarget: number; shrinkLambda: number;
      target: number; implied: number; residual: number; fallbackUsed: boolean }[];
    maxProjectionError: number; highamProjectionDelta: number;
    clippedNegativePairs: { pair: [string, string]; target: number }[];
    signedPsdTarget: number[][];
  };
  validation: { status: "pending" };
  clusters: Record<string, Record<string, { global: number; cluster: number;
    underlying: number; underlyingBasis: "structural-underlying" }>>;
}
```

Refuse to overwrite an existing candidate with different bytes; accept an identical rerun as a no-op.

- [ ] **Step 6: Add `calibrate` command and byte-identical fixture assertion**

Run the fixture twice in separate temporary roots and compare candidate bytes, not parsed objects.

- [ ] **Step 7: Verify calibration**

Run: `cd writer && npm run research:check -- --test-name-pattern='matrix|calibrat|candidate'`

Expected: PASS; `expected-candidate.json` matches byte-for-byte and the signed challenger matrix retains its negative fixture pair.

- [ ] **Step 8: Commit the calibrator slice**

Stage Task 4 files, then invoke `/caveman:caveman-commit` with intent `feat: calibrate measured factor artifacts`.

---

### Task 5: Add Walk-Forward Replay and Offline Challengers

**Files:**
- Create: `writer/src/research/replay.ts`
- Create: `writer/test/research-replay.test.ts`
- Create: `writer/test/fixtures/research/replay-series.jsonl`
- Create: `writer/test/fixtures/research/replay-expected.json`
- Modify: `writer/src/research/cli.ts`

**Interfaces:**
- Consumes: training-slice returns, candidate signed PSD matrix, an immutable content-addressed snapshot of current `registry/correlations.json`, and existing Gaussian factor functions.
- Produces: `syntheticEvents(origin, training, future): SyntheticTicket[]`, `studentTCdf(x, df): number`, `studentTInv(p, df): number`, `scoreForecasts(rows): ScoreSummary`, `blockBootstrap(origins, blockHours = 96, samples = 2_000, seed): Interval`, and `runReplay(input): ValidationReport`.
- Produces model probabilities for `independence`, `static-hierarchical-gaussian`, `measured-hierarchical-gaussian`, `signed-t-copula`, and `filtered-historical-simulation`.

- [ ] **Step 1: Write failing look-ahead and scoring tests**

```ts
test("future mutation cannot change an earlier forecast", () => {
  const before = forecastAt(origin, series);
  const changed = forecastAt(origin, mutateAfter(series, origin));
  assert.deepEqual(changed, before);
});

test("log loss and Brier score match hand calculations", () => {
  assert.ok(Math.abs(logLoss([{ p: 0.8, y: 1 }, { p: 0.25, y: 0 }]) - 0.2554128) < 1e-6);
  assert.ok(Math.abs(brier([{ p: 0.8, y: 1 }, { p: 0.25, y: 0 }]) - 0.05125) < 1e-8);
});
```

Also test `studentTCdf(studentTInv(p, df), df)` within `1e-8` for tail/interior probabilities, t-copula simulated marginals within Monte Carlo tolerance, signed negative correlation changes opposite-direction probability, zero-hit batches remain finite after smoothing, exact ticket counts by leg count/stratum, four-leg same-underlying exclusion, causal FHS behavior under a volatility regime shift and non-zero mean, band tickets excluded from statistical success, the same seed producing identical bootstrap intervals, whole forecast-origin groups remaining together, and thresholds/regime cutoffs/degree-of-freedom selection coming solely from nested training slices.

- [ ] **Step 2: Run replay tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='future mutation|log loss|signed negative|block bootstrap'`

Expected: FAIL because replay functions are absent.

- [ ] **Step 3: Implement the synthetic event grid exactly**

At each forecast origin, refit every transformation from observations with close time `<= origin`. Use one origin every 24 hours after the minimum training window. For each leg count 2-4 and quantile tuple from `[0.25, 0.5, 0.75]`, enumerate three direction vectors: all-up, alternating up/down starting with up in sorted leg order, and all-down. Same-underlying tickets repeat one asset at distinct quantiles and are available only for two or three legs; record four-leg same-underlying as `structurally-unavailable` because only three distinct quantiles exist. Same-cluster tickets use distinct sorted assets from one cluster; cross-cluster tickets use distinct sorted assets spanning at least two clusters, and both retain two-to-four-leg coverage. Deduplicate identical events and discard logical contradictions where the same asset requires `return > upperThreshold` and `return < lowerThreshold` with `upperThreshold >= lowerThreshold`.

Serialize each surviving ticket as canonical JSON, sort by `sha256(manifestHash + originMs + stratum + ticketJson)` then by `ticketJson`, and keep the first 12 per stratum/origin across all leg counts/quantiles/directions. Record every selected key; there is no random order hidden behind the cap. Evaluate outcomes only at the future horizon close; keep overlapping origins but group every ticket from one forecast origin together in uncertainty resampling.

- [ ] **Step 4: Implement challengers with bounded deterministic algorithms**

Independence multiplies training marginals. Static and measured champions reuse the existing hierarchical Gaussian engine with `rhoBandPct = 0` for unbiased replay. The signed t-copula uses the candidate PSD signed matrix, `studentTInv(1 - marginalProbability, df)` thresholds (regularized incomplete-beta CDF plus bounded bisection), deterministic seeded Box-Muller normals, integer chi-square scaling, and 20,000 joint draws reused across every ticket at the same origin/df. Select degrees of freedom from `[4, 6, 8, 12, 20, 30]` on the last 20% of the training slice after fitting dependence on the first 80%, then refit on the full training slice; never select ν on the forecast outcome. Convert hits to `(hits + 1) / (draws + 2)` and clamp every model probability to `[1e-6, 1 - 1e-6]` before log loss.

For filtered historical simulation, choose one common time base per ticket: hourly only when every asset is continuous and in one cluster, otherwise settlement-aligned daily. On complete aligned training rows for that ticket, compute causal 45-day EW `mu[i,t]` and `sigma[i,t]` from rows strictly before `t`, then residual `z[i,t] = (return[i,t] - mu[i,t]) / sigma[i,t]`; discard warm-up/non-finite residual rows. At the forecast origin compute `mu[i,origin]`/`sigma[i,origin]` from all available training rows. For horizon `h` containing `k = h / baseInterval` rows, enumerate every contiguous residual block, reconstruct cumulative return `k * mu[i,origin] + sigma[i,origin] * sum(z[i,t:t+k])`, and apply the frozen event thresholds; missing rows invalidate the whole block rather than being filled. The empirical joint rate uses add-one smoothing; fewer than 90 complete daily blocks or 1,000 complete hourly rows produces an explicit unavailable/exclusion result. FHS remains report-only.

- [ ] **Step 5: Implement scores and decision states**

Report log loss, Brier, ten-bin calibration, and sharpness overall and by window, horizon, ticket size, cluster combination, direction, and training-defined stress regime. For stress labels, use an equal-weight portfolio over the ticket's distinct underlyings (each underlying gets `1/n`, repeated same-underlying legs do not add weight). At each origin, compute training-only 24-hour portfolio-volatility terciles and the training 5th-percentile cumulative-return drawdown. Label the future row `drawdown-stress` first when the drawdown cutoff is crossed, otherwise `high-volatility` when the upper volatility tercile is crossed, otherwise `normal`; this precedence is fixed. Buckets below 1,000 forecast rows remain visible but are excluded from the 5% gate with reason `insufficient-stress-sample`.

Define relative degradation as `(measuredLogLoss - baselineLogLoss) / baselineLogLoss`. Bootstrap contiguous groups of forecast origins spanning at least 96 hours for 2,000 deterministic samples. Mark **Supported** only when the point estimate is `< 0`, the 95% interval upper bound is `<= 0.01`, and every adequate stress bucket's relative degradation is `<= 0.05`. Mark **Rejected** when the 95% interval lower bound is `> 0.01`, any score/probability is non-finite, deterministic reruns differ, PSD/Cholesky fails, or `maxProjectionError > 0.10`; otherwise mark **Inconclusive**. Record the `0.10` projection-error threshold as beta policy in the validation artifact rather than hiding it in code.

- [ ] **Step 6: Write immutable validation output beside the candidate**

Before replay, canonicalize the parsed hand-set baseline into immutable `facts/baselines/<sha256>.json`; later edits to `registry/correlations.json` must not change an existing replay. `replay` writes `artifacts/candidates/<modelVersion>.validation.json` and includes the candidate hash, input manifest hash, `baselineSha256`, baseline snapshot path, seed, draw count, model scores, exclusions, decision state, and limitations. Promotion and reporting verify the baseline snapshot bytes/hash. Replay never edits the candidate or champion.

Also record origin stride, canonical ticket counts, per-model elapsed time, peak RSS, stress thresholds, and every bootstrap group. Add a representative 20-underlying performance fixture that must complete under 30 seconds and 512 MB locally; the full VPS acceptance in Task 10 must complete under the systemd limits of two hours and 1 GB.

- [ ] **Step 7: Verify deterministic replay**

Run: `cd writer && npm run research:check -- --test-name-pattern='replay|score|bootstrap|challenger'`

Expected: PASS; two fixture runs match `replay-expected.json` byte-for-byte, mutating `registry/correlations.json` after the snapshot does not change replay bytes, and the look-ahead mutation test remains unchanged.

- [ ] **Step 8: Commit the replay slice**

Stage Task 5 files, then invoke `/caveman:caveman-commit` with intent `feat: replay correlation challengers`.

---

### Task 6: Validate, Manually Promote, and Load Champion Artifacts

**Files:**
- Create: `writer/src/research/artifacts.ts`
- Create: `writer/test/research-artifacts.test.ts`
- Create: `writer/test/fixtures/research/artifact-valid.json`
- Create: `writer/test/fixtures/research/artifact-stale.json`
- Modify: `writer/src/research/cli.ts`
- Modify: `writer/src/config.ts`
- Modify: `writer/src/correlation.ts`
- Create: `writer/src/correlationWorker.ts`
- Modify: `writer/src/server.ts`
- Modify: `writer/src/index.ts`
- Modify: `writer/test/config.test.ts`
- Modify: `writer/test/correlation.test.ts`
- Create: `writer/test/correlationWorker.test.ts`
- Modify: `writer/test/server.test.ts`
- Modify: `writer/.env.example`

**Interfaces:**
- Consumes: candidate, validation report, source registry, and referenced manifest.
- Produces: `validateArtifact(raw, { manifest, sources, markets, validation }, nowMs): ValidatedArtifact`, `promoteCandidate(root, candidatePath, sources, markets, nowMs): PromotionReceipt`, `riskAdjustedJointProbWad(legs, table, bandPct): bigint`, and `CorrelationWorker.bestEstimate(legs, table): Promise<bigint>`.
- Extends `WriterConfig` with `model: { version: string; dataAsOf: string; dataManifestSha256: string; sourceRegistrySha256: string; ageMs: number; multiAssetEnabled: boolean; eligibleUnderlyings: Set<string>; quarantinedUnderlyings: Map<string, string>; fallbackEligible: Set<string>; pairEligibility: Map<string, { status: "direct" | "fallback" | "quarantined"; reason: string }> }`.
- Extends `QuoteDeps` with `bestEstimateJointProbWad(legs: CorrLeg[]): Promise<bigint>`; `index.ts` supplies the reusable worker and `handleQuote` awaits it before reservation/signing.

- [ ] **Step 1: Write failing artifact safety tests**

Cover malformed schema/model family/hash/timestamp, loadings over explained variance, unverified manifest, source-registry or baseline-snapshot hash mismatch, source/market/artifact cluster disagreement, missing exact eligible entries, missing/duplicate canonical pair eligibility, fallback pairs that are not a subset of operator-approved fallbacks, quarantine without reason, validation report candidate-hash mismatch, candidate age over 30 hours, schedule-aware trailing staleness, and a forced pre-rename failure preserving champion bytes. Add writer config tests proving invalid artifacts refuse startup and champion age `>= 7 days` sets `multiAssetEnabled` false without disabling single-underlying quotes.

- [ ] **Step 2: Write failing joint-probability compatibility test**

Assert `CorrelationWorker.bestEstimate(fixtureLegs, fixtureTable) === jointProbWad(fixtureLegs, fixtureTable, 0)` and `riskAdjustedJointProbWad(fixtureLegs, fixtureTable, configuredBand) === jointProbWad(fixtureLegs, fixtureTable, configuredBand)` for existing golden inputs. Add near/over-budget tests proving the two risk-band integrations retain their current combined ceiling of approximately 8 million points and the worker's single unbiased integration retains the current 4-million-point ceiling. Assert pricing/dominance/allowance/per-market/per-cluster outcomes are identical to the current implementation when the same artifact `clusters` are supplied.

- [ ] **Step 3: Run focused tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='artifact|promotion|joint probabilities'`

Expected: FAIL because artifact validation/promotion and paired probabilities do not exist.

- [ ] **Step 4: Implement schema and promotion gates**

Require `schemaVersion: 1`, `modelFamily: "hierarchical-gaussian-factor"`, non-empty exact clusters, ISO `createdAt`/`dataAsOf`, 64-hex data-manifest/source-registry/baseline hashes across candidate and validation sidecar, exact `[180,45,[30,90,180]]` policy, per-underlying freshness, disjoint eligible/quarantined sets with reasons, finite projection diagnostics, and valid loadings. Cross-check the snapshotted source registry, baseline snapshot, active market clusters, exact eligible artifact entries, explicit fallback subsets, and all referenced hashes. Promotion verifies every manifest file/hash and the candidate/validation hashes, refuses validation state `Rejected`, and refuses candidate data age over 30 hours.

Define the commit boundary: build and fsync the promotion receipt and candidate verification record first, write/fsync `champion.json.tmp`, then atomically rename the champion last and fsync the artifact directory. Any failure before the rename leaves the old champion byte-for-byte intact; the rename is success, and any later audit-log warning is recoverable and must not be reported as a failed promotion. Never delete candidates or auto-promote.

- [ ] **Step 5: Load metadata without changing the live marginal path**

Replace `CORRELATIONS_FILE` with required `CORRELATION_ARTIFACT_FILE` in production config and parse both artifact metadata and its `clusters`. Keep `parseCorrelations` compatible with top-level metadata. Change the loader signature to `loadConfig(nowMs = Date.now())` so freshness tests use fixed time. Log model version/data-as-of at startup. Do not call the collector, calibrator, manifest store, or any historical provider from config or `handleQuote`.

- [ ] **Step 6: Enforce source/artifact eligibility before correlation lookup**

Add a pure `correlationEligibility(legs, cfg)` check used by `validateQuoteRequest`: for tickets spanning more than one distinct underlying, reject with `correlation-unavailable` if the champion is seven days old, a source mapping is missing/ineligible, an underlying is quarantined, or any canonical unordered pair among the ticket's distinct underlyings is not artifact status `direct` or explicitly operator-approved `fallback`. An asset-level `fallbackEligible` flag alone never admits a pair absent from the artifact. Same-underlying tickets retain the structural factor behavior; band tickets retain the existing uncorrelated limitation. Test every branch and multi-pair ticket through `validateQuoteRequest`, not only the helper.

Keep the existing two risk-band integrations and their per-call `MAX_QUADRATURE_POINTS = 4_000_000` unchanged on the live path. Run only the extra scale-1 best-estimate integration in one reusable Node `worker_threads` worker, also capped at 4 million points, with a bounded queue of 16 and a 1-second task timeout. Queue/worker failure returns stable `503 pricing-unavailable` before reservation/signing; over-budget work still returns `ticket-too-complex`. Test deterministic work estimates, queue bounds, worker timeout cleanup, and byte-identical probabilities; record wall-clock latency in Task 10 instead of a hardware-dependent unit-test ceiling. Do not loosen dominance or exposure gates.

- [ ] **Step 7: Add `promote` CLI with explicit operator path**

Require `--candidate <absolute-or-RESEARCH_ROOT-relative-path>`; print candidate version, data age, manifest hash, validation state, and resulting champion hash. No `--latest` or automatic selection is allowed.

- [ ] **Step 8: Verify artifact and writer compatibility**

Run: `cd writer && npm run research:check -- --test-name-pattern='artifact|promotion' && npm test -- --test-name-pattern='correlation|config|correlation eligibility' && npm run typecheck`

Expected: PASS; existing correlation golden behavior is unchanged for the same `clusters`, and stale/malformed artifacts fail conservatively.

- [ ] **Step 9: Commit the promotion/writer-loading slice**

Stage Task 6 files, then invoke `/caveman:caveman-commit` with intent `feat: promote validated correlation champions`.

---

### Task 7: Persist Every Returned Signed Quote Before HTTP 200

**Files:**
- Create: `writer/src/research/journal.ts`
- Create: `writer/test/research-journal.test.ts`
- Modify: `writer/src/infoApi.ts`
- Modify: `writer/src/spotPx.ts`
- Modify: `writer/src/server.ts`
- Modify: `writer/src/index.ts`
- Modify: `writer/src/config.ts`
- Modify: `writer/test/infoApi.test.ts`
- Modify: `writer/test/spotPx.test.ts`
- Modify: `writer/test/server.test.ts`
- Modify: `writer/.env.example`

**Interfaces:**
- Produces: `LegPriceObservation = { priceWad: bigint; source: "l2Book" | "spotPx"; observedAtMs: number; depthWad: bigint | null; vwapWad: bigint | null; freshnessMs: number | null }`.
- Produces: `appendQuoteDecision(root, decision): void` and `redactQuoteDecision(decision, resolution: { status: "open" | "won" | "dead" | "void"; allLegsFinal: boolean }, salt): PublicQuoteDecision`.
- Changes `QuoteDeps.fetchLegPriceWad` to `fetchLegPrice(leg): Promise<LegPriceObservation>` and adds `recordQuote(decision): Promise<void>`.

- [ ] **Step 1: Write failing price-metadata tests**

Assert a depth-covering book records actual cumulative depth, VWAP, source, and observation time; a `spotPx` fallback records its per-coin freshness age and no fabricated depth; existing returned `priceWad` values remain identical.

- [ ] **Step 2: Write failing journal-before-return tests**

Add a server test whose `recordQuote` throws after signing. Assert response `503 { error: "journal-failed" }`, reservation release, `metrics.quoted` unchanged, and no signature in the response. Add a success test asserting journal quote ID/digest/premium/payout exactly match the returned quote before the handler resolves.

- [ ] **Step 3: Run focused tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='price metadata|journal'`

Expected: FAIL because the metadata and journal hook are absent.

- [ ] **Step 4: Implement the exact internal decision record**

After signing and before incrementing `metrics.quoted`, calculate `quoteDigest`, hash the signature with `keccak256`, and synchronously durable-append canonical JSON to `journal/quotes/YYYY/MM/DD.jsonl`. Persist this exact JSON-safe shape (all WAD/uint values are decimal strings; unavailable book metadata is `null`):

```ts
export interface QuoteDecision {
  schemaVersion: 1; recordedAtMs: number; quoteId: string; quoteDigest: string;
  chainId: number; parlayVault: string; taker: string;
  legs: { vault: string; isYes: boolean; underlying: string; cluster: string;
    direction: "up" | "down" | "band"; outcomeCoin: string }[];
  bookInputs: { priceWad: string; source: "l2Book" | "spotPx";
    observedAtMs: number; depthWad: string | null; vwapWad: string | null;
    freshnessMs: number | null }[];
  modelVersion: string; dataAsOf: string; dataManifestSha256: string;
  sourceRegistrySha256: string; bestEstimateJointProbWad: string;
  riskAdjustedJointProbWad: string; rhoBandPct: number;
  edge: { baseBps: string; legBps: string; totalBps: string };
  premium: string; maxPayout: string; deadline: string; signatureHash: string;
}
```

Never store invite code, IP, email, private key, or raw signature.

On append failure, call `exposure.release(quoteId)`, increment stable reject reason `journal-failed`, return 503, and do not return the signature. Keep the journal append after signing so its signature hash is canonical, but before HTTP 200 so every usable returned signature is recorded.

- [ ] **Step 5: Add redacted export behavior**

Pass joined resolution state explicitly to `redactQuoteDecision`. Hash the lowercased taker with `sha256(salt + ":" + taker)` or remove it, omit quote/signature hashes until `allLegsFinal === true`, and expose delayed research fields only after every leg has an attested final fraction, regardless of parlay status. Fail if the export salt is absent. Operational journal file/directory modes are `0600`/`0700`.

- [ ] **Step 6: Add journal config and health**

Load `RESEARCH_ROOT`; initialize the quote-journal directory before serving; report last successful append timestamp and current model metadata from `/health`. Do not make report/export work part of the request path.

- [ ] **Step 7: Verify the money path**

Run: `cd writer && npm test -- --test-name-pattern='price metadata|journal|quote' && npm run typecheck`

Expected: PASS; the append-failure test proves no signature can escape without a durable matching record.

- [ ] **Step 8: Commit the journaling slice**

Stage Task 7 files, then invoke `/caveman:caveman-commit` with intent `feat: journal signed quote decisions`.

---

### Task 8: Join Quote, Mint, Resolution, and Attested Leg Outcomes

**Files:**
- Modify: `writer/src/research/journal.ts`
- Create: `writer/test/research-events.test.ts`
- Create: `writer/test/fixtures/research/parlay-events.json`
- Modify: `writer/src/research/cli.ts`

**Interfaces:**
- Consumes: quote journal, `ParlayMinted`/`ParlayResolved` logs, `ParlayVault.parlay(id)`, and `OutcomeVault.settled/settleFractionWad`.
- Produces: `scanEventChunk(client, vault, from, to): Promise<ChainEvent[]>`, `joinEvents(root, deps): Promise<JoinSummary>`, and durable `journal/events/YYYY/MM/DD.jsonl` plus `state/event-joiner.json`; `JoinedEventRecord` is a union of chain-log, state-observation, and orphan-correction records.

- [ ] **Step 1: Write failing resumability/join tests**

Use a fake client that refuses ranges above 1,000 blocks. Assert chunks are inclusive/non-overlapping, successful chunk progress persists before the next chunk, rerunning is idempotent, `quoteId` joins the correct parlay ID/transaction, and a simulated second-chunk failure resumes at the first unscanned block.

- [ ] **Step 2: Write failing outcome tests**

Fixture one Won, one Dead, and one Void parlay. Assert per-leg final fractions come only from `settled`/`settleFractionWad`, binary results follow the contract's YES=`1e18` and NO=`0` rules, and fractional settlements are labeled `void` rather than coerced to wins/losses. Include both Dead and Void parlays whose deciding leg is settled at `ParlayResolved` but another leg settles later; assert each join remains pending, public detail stays delayed, and a later run fills the final fraction. Add a reorg fixture that orphans a prior finalized-leg observation and proves the leg returns to pending until re-observed on the canonical chain.

- [ ] **Step 3: Run event tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='event join|event resume|void outcome'`

Expected: FAIL because event joining is absent.

- [ ] **Step 4: Implement chunked, durable chain-truth joining**

Use the same 1,000-block maximum and partial-progress semantics as `Poker`, but stop at `head - 2` confirmations and rescan a 10-block overlap on every run for shallow reorg tolerance. Before accepting overlap logs or trusting prior state observations, compare every stored block hash in the overlap to the canonical hash; append an `orphaned` correction targeting the prior record key and rebuild affected quote/parlay joins from remaining canonical records. Scan mint and resolve events together, append canonical logs idempotently by `(transactionHash, logIndex)`, then persist `nextBlock = scannedTo + 1` atomically. On mint, join by quote ID and record parlay ID, block/transaction, emitted premium/max payout, and taker. On resolution or pending-leg revisit, read `settled`/`settleFractionWad` at one explicit confirmed `blockNumber` and record that block's canonical hash; never mix state reads from different heads. Persist these JSON-safe union members:

```ts
export interface ChainLogRecord {
  schemaVersion: 1; kind: "minted" | "resolved"; eventKey: string;
  blockNumber: string; blockHash: string; transactionHash: string; logIndex: number;
  quoteId: string; parlayId: string; taker: string | null;
  premium: string | null; maxPayout: string | null;
  status: "open" | "won" | "dead" | "void" | null;
  legs: { vault: string; isYes: boolean; settled: boolean;
    settleFractionWad: string | null; result: "win" | "loss" | "void" | "pending" }[];
  recordedAtMs: number;
}

export interface StateObservationRecord {
  schemaVersion: 1; kind: "leg-finalized"; observationKey: string;
  observedBlockNumber: string; observedBlockHash: string; quoteId: string; parlayId: string;
  vault: string; settleFractionWad: string; result: "win" | "loss" | "void";
  recordedAtMs: number;
}

export interface OrphanCorrectionRecord {
  schemaVersion: 1; kind: "orphaned";
  targetKind: "chain-log" | "state-observation"; targetKey: string;
  detectedAtBlockNumber: string; canonicalBlockHash: string; recordedAtMs: number;
}

export type JoinedEventRecord = ChainLogRecord | StateObservationRecord | OrphanCorrectionRecord;
```

Any Won/Dead/Void resolution may precede another leg's settlement; retain unresolved vaults in `state/event-joiner.json` and revisit them on every run until all fractions are attested, appending state-observed `leg-finalized` updates instead of inventing transaction metadata or mutating history. If a state observation is corrected as orphaned, restore that leg to the pending set. These are ordinary confirmed HyperEVM contract-state reads at an explicit block, never historical HyperCore precompile calls.

- [ ] **Step 5: Add `join` command**

Use `WRITER_RPC`, `PARLAY_VAULT_ADDRESS`, and `PARLAY_DEPLOY_BLOCK`; no signer key is required. A network failure exits non-zero after retaining completed chunk progress.

- [ ] **Step 6: Verify join behavior**

Run: `cd writer && npm run research:check -- --test-name-pattern='event|join|resolution'`

Expected: PASS; the 1,001-block fixture produces two scans and an interrupted rerun begins at the saved block.

- [ ] **Step 7: Commit the event slice**

Stage Task 8 files, then invoke `/caveman:caveman-commit` with intent `feat: join quote and parlay outcomes`.

---

### Task 9: Generate the Research Report and Install Isolated Operations

**Files:**
- Create: `writer/src/research/report.ts`
- Create: `writer/src/research/backup.ts`
- Create: `writer/test/research-report.test.ts`
- Create: `writer/test/research-backup.test.ts`
- Create: `writer/test/fixtures/research/report-expected.html`
- Create: `ops/systemd/hype-research-collector.service`
- Create: `ops/systemd/hype-research-collector.timer`
- Create: `ops/systemd/hype-research-daily.service`
- Create: `ops/systemd/hype-research-daily.timer`
- Create: `ops/systemd/hype-research-backup.service`
- Create: `ops/systemd/hype-research-backup.timer`
- Modify: `writer/src/research/cli.ts`
- Modify: `DEPLOY.md`

**Interfaces:**
- Consumes: current manifest/candidate/champion/validation, quote/event journals, collector/calibrator state, and quarantine records.
- Produces: `renderReport(input): string`, `reports/<dataAsOf-date>-<modelVersion>.html`, and `backupResearch(root, s3Config): Promise<BackupSummary>`.

- [ ] **Step 1: Write failing HTML content and escaping tests**

Assert the fixture report contains freshness/missing intervals, 30/90/180 correlations, target/implied/residual/projection error, clipped negatives, all five model scores, calibration/stress buckets, quote-mint-resolution funnel, champion/manifest IDs, quarantines/failures, and the Supported/Inconclusive/Rejected state. Assert a malicious underlying like `<script>` is escaped and the exact warning `Testnet P&L is not evidence of production expected value.` is present.

- [ ] **Step 2: Run report tests and verify red**

Run: `cd writer && npm test -- --test-name-pattern='research report'`

Expected: FAIL because the renderer is absent.

- [ ] **Step 3: Implement one static, self-contained report**

Use a small local `escapeHtml` helper and inline CSS only. Every table/card must carry one label from `Observed fact`, `Model estimate`, or `Operator decision`. Sort underlyings/pairs/buckets deterministically; show exclusions and sample sizes adjacent to scores; show band markets as excluded from statistical claims; delay/redact public quote detail until joined resolution.

- [ ] **Step 4: Add `report` and aggregate `check` commands**

`report` verifies every referenced hash before rendering and refuses corrupt/missing inputs. `check` runs a complete fixture flow (`collect fixture -> derive -> calibrate -> replay -> validate -> report`) twice in temporary directories and exits non-zero unless candidate, validation, manifest, and report bytes match. `daily` runs `derive`, `calibrate`, `replay`, `join`, and `report` sequentially and stops non-zero at the first failure; it never promotes or restarts a service.

- [ ] **Step 5: Add an optional daily off-box backup command**

Use Node `crypto` and `fetch` to sign S3-compatible SigV4 `PUT`/`HEAD` requests; do not add an SDK. Upload files referenced by verified data manifests and validation-sidecar reference closure (including content-addressed source-registry and baseline snapshots), plus artifacts, journals, state, and reports, keyed by their relative paths. Skip objects whose `HEAD` checksum metadata already matches, verify each uploaded object's checksum metadata, then atomically write `state/backup.json` with success time and last verified object hash. Bound each HTTP request to 60 seconds with three attempts and bound the whole command to two hours. Read endpoint, region, bucket, access key, and secret only from environment; never place credentials in arguments, logs, files below `RESEARCH_ROOT`, reports, or tests. If backup configuration is absent, `backup` exits with a clear disabled status; production acceptance still requires configured daily off-box backup.

Test against a local fake HTTP server that validates the credential scope/signature, returns checksum metadata, and proves logs/state contain no access-key or secret value. Delete the temporary local baseline/source snapshots after upload, restore the full reference closure from the fake bucket, and verify candidate/validation/report hashes without consulting mutable registry files.

- [ ] **Step 6: Add separate bounded systemd units/timers**

Deployment pre-creates `/opt/hype/research/state` as `hype:hype` mode `0700` before enabling units. Collector: `Type=oneshot`, `User=hype`, `WorkingDirectory=/opt/hype/writer`, `EnvironmentFile=/opt/hype/research.env`, `ExecStart=/usr/bin/flock -w 300 /opt/hype/research/state/job.lock /usr/bin/npm run research -- collect`, `Nice=10`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, `TimeoutStartSec=15m`, hourly `OnCalendar=hourly`, `Persistent=true`.

Daily: `Type=oneshot`, the same secret-minimal `research.env`, `After=hype-research-collector.service`, `ExecStart=/usr/bin/flock -w 900 /opt/hype/research/state/job.lock /usr/bin/npm run research -- daily`, `Nice=15`, idle I/O, `CPUQuota=50%`, `MemoryMax=1G`, `TimeoutStartSec=2h`, daily at 01:15 UTC after collection. The CLI must not import `writer/src/config.ts`, so it never loads quote-signer, poker, invite, or waitlist secrets.

Backup: a separate `Type=oneshot`, `User=hype` service with `WorkingDirectory=/opt/hype/writer`, `ConditionPathExists=/opt/hype/research-backup.env`, `After=hype-research-daily.service`, `EnvironmentFile=/opt/hype/research.env`, `EnvironmentFile=/opt/hype/research-backup.env`, `ExecStart=/usr/bin/flock -w 7200 /opt/hype/research/state/job.lock /usr/bin/npm run research -- backup`, `Nice=15`, idle I/O, `CPUQuota=25%`, `MemoryMax=512M`, `TimeoutStartSec=4h`, and daily scheduling at 03:30 UTC. A lock/HTTP/total timeout is a failed unit and visible report/health event, never a silent successful skip. Neither research unit has `Requires=keeper.service`, `PartOf=keeper.service`, nor any restart command.

- [ ] **Step 7: Update deployment and recovery documentation**

Document `/opt/hype/research` ownership/mode, source/artifact paths, units/timers, manual promotion command, champion rollback by atomically restoring a previously promoted candidate, health checks, and a daily off-box S3-compatible sync. `/opt/hype/research.env` contains only `RESEARCH_ROOT`, public Info URL, read-only RPC, contract address, deploy block, and source/artifact paths; `/opt/hype/research-backup.env` contains only least-privilege bucket credentials and is never shared with writer/keeper.

The current repo deployment excludes the box-authoritative registry, so document a separately approved non-destructive install that copies only the new immutable mapping while preserving `markets.json`:

```bash
scp -o BatchMode=yes registry/correlation-sources.json root@91.99.94.25:/opt/hype/registry/correlation-sources.json.new
ssh -o BatchMode=yes root@91.99.94.25 'chown hype:hype /opt/hype/registry/correlation-sources.json.new && mv -f /opt/hype/registry/correlation-sources.json.new /opt/hype/registry/correlation-sources.json'
```

Verify the rotation process can read that file before `bigBlocks("on")`. Change all repo/writer rsync examples so `--delete` cannot target `/opt/hype/research`; explicitly verify the directory before/after nightly rotation. Do not execute copying, deployment, unit installation/enabling, promotion, backup configuration, or any other shared-state action without separate user approval.

- [ ] **Step 8: Verify report, backup, and local operations definitions**

Run: `cd writer && npm run research:check -- --test-name-pattern='report|backup|end-to-end' && systemd-analyze verify ../ops/systemd/hype-research-collector.service ../ops/systemd/hype-research-collector.timer ../ops/systemd/hype-research-daily.service ../ops/systemd/hype-research-daily.timer ../ops/systemd/hype-research-backup.service ../ops/systemd/hype-research-backup.timer`

Expected: research tests PASS and `systemd-analyze verify` exits 0. If `systemd-analyze` is unavailable on the development host, report that command as not runnable and verify unit syntax later on the Ubuntu 26.04 target before enabling it; do not claim the ops slice fully verified until that output is shown.

- [ ] **Step 9: Commit the report/ops slice**

Stage Task 9 files, then invoke `/caveman:caveman-commit` with intent `feat: report correlation beta evidence`.

---

### Task 10: Prove the Full Testnet Acceptance Path

**Files:**
- Create: `writer/test/research-integration.test.ts`
- Create: `docs/research/testnet-correlation-verification.md`
- Modify: `scripts/verify.sh`

**Interfaces:**
- Consumes every preceding command/interface.
- Produces one documented non-interactive research gate and a timestamped evidence record that keeps operational and statistical acceptance separate.

- [ ] **Step 1: Write the final failing integration test**

Use only fixtures and temporary directories. Prove: a corrupt/missing raw partition cannot replace champion bytes; writer accepts a valid champion and rejects an invalid one; a returned quote has a durable matching ID/digest before response; event fixtures join the same quote to mint/resolution/void; repeated pipeline runs are byte-identical; and collector/calibrator failure does not call or stop writer/keeper controls.

- [ ] **Step 2: Run the integration test and verify red before final wiring**

Run: `cd writer && npm test -- --test-name-pattern='correlation beta acceptance'`

Expected: FAIL on whichever final cross-component hook is not yet connected; record the exact failure before implementing only that wiring.

- [ ] **Step 3: Add the single repository research gate**

Append this non-interactive command to `scripts/verify.sh` after existing checks:

```bash
(cd writer && npm run research:check)
```

Do not add network calls, live promotion, deployment, or paid-service checks to the repository gate.

- [ ] **Step 4: Run all required local gates and capture exact output**

Run, in order:

```bash
forge build
forge test
(cd writer && npm run check)
(cd writer && npm run research:check)
(cd keeper && npm run check)
node --test tools/rotate-lib.test.mjs
./scripts/verify.sh
```

Expected: every command exits 0. If any is red, report it plainly and do not claim completion.

- [ ] **Step 5: Run the approved testnet operational verification**

Only after explicit user approval for shared testnet/VPS actions: install only `correlation-sources.json` and the dedicated research env/units; collect the initial 5,000-candle history for every eligible mapped source; run derive/calibrate/replay/report within two hours and 1 GB peak RSS; inspect coverage/projection/clipping/quarantine/score evidence; manually promote the reviewed candidate; restart only the writer; request a testnet quote and confirm journal-before-response; mint it; run the joiner through resolution or void and any later-settling unresolved legs; confirm `/opt/hype/research` and champion bytes survive the nightly rotation/restart; confirm the off-box checksum; and confirm collector/calibrator outage leaves writer and keeper healthy.

Record command output, manifest/artifact hashes, champion version/data-as-of, quote ID/digest, mint/resolution transaction hashes, and the statistical state in `docs/research/testnet-correlation-verification.md`. Label operational acceptance independently from Supported/Inconclusive/Rejected statistical acceptance.

- [ ] **Step 6: Re-run the complete gates after testnet evidence**

Run the seven local commands from Step 4 again and show output. Query systemd unit status/timer timestamps and verify the off-box object hash only if those shared-state features were explicitly approved and configured.

- [ ] **Step 7: Commit verification evidence**

Stage `writer/test/research-integration.test.ts`, `scripts/verify.sh`, and the secret-free verification document, then invoke `/caveman:caveman-commit` with intent `test: verify correlation beta end to end`.

---

## Explicit Deferrals

- No automatic champion promotion; add only after beta operator reviews become a measurable bottleneck and a separate approval policy exists.
- No live signed t-copula or filtered-historical quote engine; add only after replay supports it and a separate writer integration design is approved.
- No dependency-backed statistics stack; ask first if the standard-library small-matrix implementation fails numeric verification or runtime limits.
- No band-market dispersion dependence; add only with a separate level-plus-dispersion latent design.
- No managed database, public analytics API/dashboard, QuickNode, commercial feed, or mainnet bankroll changes in this plan.

## Completion Evidence Required

The implementation is complete only when all Task 10 local gates are green with shown output and, after separate approval, the testnet evidence document demonstrates all ten operational acceptance criteria. A statistically Inconclusive or Rejected result may still satisfy operational acceptance, but it must remain labeled as such and must not trigger mainnet promotion.
