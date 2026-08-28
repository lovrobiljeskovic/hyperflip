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
