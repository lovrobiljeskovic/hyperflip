# Task 6 Report: Validate, Promote, and Load Champions

## Implementation

- Added strict candidate/artifact validation for schema version, model family, ISO timestamps, fixed calibration policy, finite diagnostics, loading variance, exact eligible entries, canonical pair coverage, quarantine reasons, source/market clusters, manifest/source/baseline hashes, validation identity/state, 30-hour age, and Task 3 schedule-aware trailing freshness.
- Added explicit manual promotion. It verifies the referenced manifest closure and immutable source/baseline snapshots, writes and fsyncs the verification record and promotion receipt, writes/fsyncs `champion.json.tmp`, then atomically renames `champion.json` as the final success boundary. A pre-rename failure preserves old champion bytes; directory-fsync failure after rename is a warning, not a false failed-promotion result.
- Replaced production `CORRELATIONS_FILE` loading with required `CORRELATION_ARTIFACT_FILE`, while retaining `CORRELATIONS_FILE` only as the replay command's explicit legacy baseline input. Config exposes the required model metadata and disables multi-underlying quoting at champion age `>= 7 days` without changing same-underlying pricing.
- Added exact source/artifact/pair eligibility checks in `validateQuoteRequest`, including every pair of multi-underlying tickets and explicit pair-level fallback approval. Cross-underlying band tickets remain unavailable.
- Preserved the two live risk-band integrations and all current pricing/exposure gates. Added one scale-one integration in one reusable `worker_threads` worker, bounded to 16 pending tasks and a one-second timeout. Worker/queue failure returns `503 pricing-unavailable`; the unchanged quadrature refusal returns `400 ticket-too-complex`.
- Added explicit `research promote --candidate <absolute-or-RESEARCH_ROOT-relative-path>` outputting version, age, manifest hash, validation state, and champion hash. No latest/automatic selection exists.

## Files

- `writer/src/research/artifacts.ts`
- `writer/test/research-artifacts.test.ts`
- `writer/test/fixtures/research/artifact-valid.json`
- `writer/test/fixtures/research/artifact-stale.json`
- `writer/src/research/cli.ts`
- `writer/src/config.ts`
- `writer/src/correlation.ts`
- `writer/src/correlationWorker.ts`
- `writer/src/server.ts`
- `writer/src/index.ts`
- `writer/test/config.test.ts`
- `writer/test/correlation.test.ts`
- `writer/test/correlationWorker.test.ts`
- `writer/test/server.test.ts`
- `writer/.env.example`

## TDD Evidence

### RED

Initial required command inside the restricted sandbox:

```sh
cd writer && npm test -- --test-name-pattern='artifact|promotion|joint probabilities'
```

Actual output/exit:

```text
Error: listen EPERM: operation not permitted .../T/tsx-501/56351.pipe
code: 'EPERM'
Node.js v22.22.2
exit 1
```

The same command was rerun with permission for tsx's local IPC socket. Actual feature RED failures included:

```text
not ok - loadConfig refuses a malformed champion artifact
error: 'Missing expected exception.'

not ok - a champion age at seven days disables only multi-asset correlation
error: "Cannot read properties of undefined (reading 'ageMs')"

SyntaxError: The requested module '../src/correlation.js' does not provide an export named 'riskAdjustedJointProbWad'

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../writer/src/correlationWorker.js'
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../writer/src/research/artifacts.js'
exit 1
```

These are the expected missing artifact parser/promotion, model metadata, paired probability export, and worker failures. The test bodies existed before production implementation.

### Focused GREEN

```sh
cd writer && ./node_modules/.bin/tsx --test \
  test/research-artifacts.test.ts \
  test/correlationWorker.test.ts \
  test/config.test.ts \
  test/server.test.ts \
  test/correlation.test.ts
```

Actual output:

```text
1..87
# tests 87
# pass 87
# fail 0
# duration_ms 1555.868292
exit 0
```

The worker startup regression was separately rerun after using tsx's installed scoped import API inside the standard-library worker:

```sh
cd writer && ./node_modules/.bin/tsx --test test/correlationWorker.test.ts
```

```text
1..3
# tests 3
# pass 3
# fail 0
# duration_ms 1513.40125
exit 0
```

## Required Verification

```sh
cd writer && npm run research:check -- --test-name-pattern='artifact|promotion'
```

Actual output:

```text
1..72
# tests 72
# pass 72
# fail 0
# duration_ms 35155.682209
exit 0
```

```sh
cd writer && npm test -- --test-name-pattern='correlation|config|correlation eligibility'
```

Actual output:

```text
1..240
# tests 240
# pass 240
# fail 0
# duration_ms 35368.721083
exit 0
```

The npm script's argument placement causes Node 22 to execute the complete globbed suites here, so both required commands provided full-suite rather than partial evidence.

```sh
cd writer && npm run typecheck && git diff --check
```

Actual output:

```text
> parlay-writer@1.0.0 typecheck
> tsc --noEmit
exit 0

git diff --check: no output, exit 0
```

Final pre-commit rerun of the focused GREEN command and typecheck:

```text
1..88
# tests 88
# pass 88
# fail 0
# duration_ms 2163.5455
exit 0

> parlay-writer@1.0.0 typecheck
> tsc --noEmit
exit 0
```

## Self-Review

- **Atomic boundary:** candidate bytes are held in memory after verification; receipt and verification records are durable before the champion temp file; `renameSync` is the only champion-changing operation and the success boundary. Pre-rename exceptions remove only the temp file. Post-rename directory fsync errors warn and return the successful receipt.
- **Hash/reference closure:** promotion recomputes candidate, manifest, source snapshot, validation, and baseline hashes; `verifyManifest` rechecks every referenced manifest file's containment, size, rows, schema, and hash. Candidate/validation/model/manifest/source identities must agree.
- **Freshness/pair eligibility:** candidate age is `<= 30h`; per-eligible-underlying trailing freshness reuses Task 3 calendars; eligible/quarantined entries are disjoint; all canonical pairs occur exactly once; fallback requires both operator flags. Runtime checks every distinct-underlying pair and never admits a missing pair from an asset flag alone.
- **Worker cleanup:** 16 pending tasks maximum; every task owns a timer; response clears its timer; timeout/error/exit rejects and clears every pending task, terminates the stuck worker, and permits a clean replacement worker. Tests cover equality, near/over-budget behavior, queue overflow, timeout cleanup, and reuse after timeout.
- **Live invariants:** `riskAdjustedJointProbWad` is the old `jointProbWad` body and `jointProbWad` remains a compatibility alias. Existing golden payouts, dominance, allowance, per-market, per-cluster, per-code, reservation, and signing tests all passed unchanged. The worker estimate is awaited before reservation/signing and does not feed price or gate calculations.
- **Scope:** no dependency, network collection, service restart, deployment/testnet/VPS mutation, Solidity, EIP-712, secret, automatic promotion, or reload/config framework was added. The two existing `node_modules` symlinks remain untracked and unstaged.

## Concerns

None.

## Fix Round 1: Champion Loading Hardening

### Covering files

- `writer/test/research-artifacts.test.ts`: realistic latest-hour continuous freshness, session closure/staleness, and research CLI import side effects.
- `writer/test/config.test.ts`: current source-registry hash, source/market/artifact cluster closure, and future champion rejection.
- `writer/test/correlationWorker.test.ts`: deterministic timeout/termination overlap with one-worker maximum.
- `writer/test/fixtures/research/artifact-valid.json`: latest contributing 11:00 candle for a 12:00 `dataAsOf`.

The pure `MarketInfo`/`parseMarkets` code moved to `writer/src/markets.ts`; `config.ts` re-exports both for caller compatibility, while research imports the side-effect-free module directly.

### RED

```sh
cd writer && ./node_modules/.bin/tsx --test test/research-artifacts.test.ts test/config.test.ts test/correlationWorker.test.ts
```

Actual output/exit:

```text
not ok 15 - loadConfig rejects a champion from a different current source registry
error: 'Missing expected exception.'
not ok 16 - loadConfig rejects source, market, and artifact cluster disagreement
error: 'Missing expected exception.'
not ok 17 - loadConfig rejects a future-dated champion
error: 'Missing expected exception.'
not ok 24 - CorrelationWorker refuses overlap until a timed-out worker has terminated
error: 'Missing expected rejection.'
not ok 25 - artifact validation accepts the exact schema and immutable reference closure
error: 'artifact: trailing freshness failed for BTC'
not ok 30 - artifact validation repeats schedule-aware trailing freshness
error: 'Got unwanted exception.'
not ok 34 - research CLI import does not initialize live dotenv config
actual: '◇ injected env (0) from ../.env ...'
1..34
# tests 34
# pass 23
# fail 11
# duration_ms 3212.03225
exit 1
```

After the minimal implementation, the same command exposed an over-broad `isAddress` import removal and the superseded immediate-restart assumption in the old queue test:

```text
1..34
# tests 34
# pass 31
# fail 3
# duration_ms 3078.218458
exit 1
```

The address validator import was restored; the queue test continues to prove the cap/timeout contract, while the new deterministic test proves restart only after termination.

### GREEN

Focused amended tests:

```sh
cd writer && ./node_modules/.bin/tsx --test test/research-artifacts.test.ts test/config.test.ts test/correlationWorker.test.ts
```

```text
1..34
# tests 34
# pass 34
# fail 0
# duration_ms 3079.898167
exit 0
```

Task 6 research checks:

```sh
cd writer && npm run research:check -- --test-name-pattern='artifact|promotion'
```

```text
1..73
# tests 73
# pass 73
# fail 0
# duration_ms 35081.232167
exit 0
```

Full writer check:

```sh
cd writer && npm run check
```

```text
> parlay-writer@1.0.0 typecheck
> tsc --noEmit

1..245
# tests 245
# pass 245
# fail 0
# duration_ms 35552.589833
exit 0
```

### Fix-round self-review

- **Freshness:** the same Task 3 schedule derives the minimum acceptable observation, but a later contributing candle now satisfies it; continuous stale hours and session closures remain distinct and tested.
- **Live identity:** startup recomputes the canonical current source-registry hash, requires exact matrix/source membership, and rejects source/artifact or source/market cluster divergence before returning config. Future `dataAsOf` is rejected rather than clamped.
- **Import boundary:** the research CLI no longer imports dotenv-backed live config; writer callers retain the existing config exports.
- **Worker lifecycle:** timeout/error/exit clears pending timers immediately, retains the worker identity during asynchronous termination, returns stable `worker cleanup pending`, and creates a replacement only after termination settles.
- **Preserved invariants:** promotion/rename code, quote ordering, queue limit, one-second timeout, quadrature budgets, pricing inputs, golden payouts, and exposure/allowance/dominance gates were not changed. No dependency or external state was added or touched.
