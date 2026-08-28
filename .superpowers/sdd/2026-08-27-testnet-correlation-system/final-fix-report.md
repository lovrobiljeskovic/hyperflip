# Final fix report: testnet correlation system

Date: 2026-08-28

Status: **DONE**

Fix-wave starting head: `9cbf4892ad6ccaf9114d3218ace30a87f2b360c9`

Implementation commit: `20edde121d1c181e0292d203fe9ab0fde294bb9a` (`fix(research): close evidence pipeline gaps`)

This was one coherent final fix wave. It changes 31 tracked files, adds no dependency, and leaves the live writer, keeper, EIP-712 quote shape, Solidity contracts, promotion rules, and operational safety gates intact. The untracked `writer/node_modules` and `keeper/node_modules` symlinks were never staged.

## Finding disposition

All six Critical and all nine Important findings are resolved in the implementation commit above.

### 1. Critical — unattended immutable input closure

Fix:

- Collection now builds a fixed 180-day, mapping-epoch-specific rolling manifest from sealed candle partitions.
- The immutable manifest is content-addressed at `manifests/<sha256>.json`; `manifests/current.json` is an atomic pointer containing the manifest, source-registry, as-of, and fixed-lookback identities.
- `derive` defaults to the collector pointer and derives its as-of/window from the final closed candle instead of mutable environment pins.
- `daily` passes the exact data manifest, derived manifest, and candidate emitted by the preceding steps.
- Deployment documentation now requires the replay seed and documents pointer-driven derivation; it no longer documents manual manifest/as-of/lookback pins.
- The end-to-end fixture consumes the collector-produced manifest instead of synthesizing one.

Files: `writer/src/research/store.ts`, `writer/src/research/candles.ts`, `writer/src/research/cli.ts`, `writer/src/research/daily.ts`, `DEPLOY.md`, `writer/test/research-candles.test.ts`, `writer/test/research-operations.test.ts`, `writer/test/research-end-to-end.test.ts`.

Regression proof: `collector publishes a content-addressed rolling manifest and current mapping-epoch pointer`; `research daily derives immutable inputs from the collector pointer without manual window pins`; deterministic end-to-end test.

### 2. Critical — replay source-registry identity

Fix:

- Replay loads and verifies the manifest's canonical, content-addressed source-registry fact.
- Mutable pretty-printed registry bytes are no longer an input to replay identity verification.
- The shared fact reader re-parses through the existing exact source-registry validator.

Files: `writer/src/research/store.ts`, `writer/src/research/replay.ts`, `writer/src/research/cli.ts`, `writer/test/research-replay.test.ts`.

Regression proof: `replay loads the immutable canonical source-registry fact instead of mutable pretty bytes`.

### 3. Critical — candle batch validation and conflict sealing

Fix:

- A response is capped at 5,000 rows and must be strictly increasing, timestamp-unique, exactly hourly, within the issued request, and closed before retrieval.
- Identical duplicate timestamps are rejected; conflicting duplicate observations become a typed batch conflict.
- A same-response conflict is quarantined before any shard or checkpoint from that response is sealed.
- Request construction remains bounded to the existing 5,000-hour initial range and resumes after durable state/sealed data.

Files: `writer/src/research/candles.ts`, `writer/test/research-candles.test.ts`.

Regression proof: `candle snapshot rejects oversized, unordered, duplicate, non-hourly, out-of-range, and unclosed batches`; `same-response conflicting duplicates are quarantined before any shard or checkpoint is sealed`.

### 4. Critical — request-time champion age

Fix:

- `currentModelStatus` recomputes age from request/health time.
- Multi-asset correlation is disabled at the exact seven-day boundary (`ageMs >= 7 days`) without a restart; same-underlying behavior is unchanged.
- Health reports current `ageMs` and `multiAssetEnabled`.

Files: `writer/src/server.ts`, `writer/src/index.ts`, `writer/test/server.test.ts`.

Regression proof: `model age and multi-asset eligibility advance at request and health time without a restart`.

### 5. Critical — recursive directory durability

Fix:

- Shared `durableMkdir` creates one directory at a time and fsyncs every parent whose directory entry changed.
- Atomic/durable writes and quote/event journals reuse it.
- File writes use `O_NOFOLLOW`; the redundant journal pre-open that could touch a symlink target was removed.
- The leaf directory is still fsynced after the new daily file is appended.

Files: `writer/src/research/store.ts`, `writer/src/research/journal.ts`, `writer/test/research-journal.test.ts`.

Regression proof: `journal: fsyncs the daily directory after appending a new file`; `journal: rejects a symlinked daily file without touching its target`.

### 6. Critical — deployment excludes research implementation

Fix:

- Removed the unanchored `--exclude research` from both relevant rsync commands. `/opt/hype/research` remains outside the writer/repository deployment targets.

Files: `DEPLOY.md`, `writer/test/research-operations.test.ts`.

Regression proof: `deployment rsync never excludes the writer research implementation`.

### 7. Important — research dotenv isolation

Fix:

- Removed `dotenv/config` from the research CLI entry point. Research services now receive only their explicit process environment.

Files: `writer/src/research/cli.ts`, `writer/test/research-artifacts.test.ts`.

Regression proof: `research CLI never loads a working-directory dotenv file` uses a real temporary `.env` and child process.

### 8. Important — observation-close causality and origin-local fits

Fix:

- New return records persist `observationCloseTimeMs`, the first time both prices are knowable; old fixtures retain a read-compatible timestamp fallback.
- Every causal training filter uses observation-close time.
- Replay refits dependence at each origin, including nested degree-of-freedom training, and the signed-t challenger uses the origin's fitted matrix rather than the terminal candidate PSD target.
- Future and terminal-matrix mutations cannot change an earlier forecast.

Files: `writer/src/research/returns.ts`, `writer/src/research/calibration.ts`, `writer/src/research/replay.ts`, `writer/test/research-returns.test.ts`, `writer/test/research-replay.test.ts`.

Regression proof: `returns persist the close time at which the return becomes observable`; `future mutation cannot change an earlier forecast`; `runReplay signed t probabilities use each origin's fitted matrix, not the terminal candidate PSD`.

### 9. Important — replay/calibration/live policy equivalence

Fix:

- Exported and reused the existing calibration pair-sample/quality kernel at every replay origin.
- Origin fits enforce the fixed 180-day window, schedule-aware freshness, candidate eligible/quarantined sets, direct-pair quality, and explicit operator-approved fallback policy.
- Inadmissible cross-underlying combinations are pruned before synthetic grid expansion and are not scored.
- Replay caches schedule alignment, origin fits, and repeated t thresholds; no dependency or new subsystem was introduced.

Files: `writer/src/research/calibration.ts`, `writer/src/research/replay.ts`, `writer/test/research-replay.test.ts`, `writer/test/fixtures/research/replay-expected.json`.

Regression proof: `historical dependence enforces candidate quarantine, pair quality, and explicit fallback policy`; the representative 20-underlying resource fixture passes in 11.452 seconds against a 30-second policy.

### 10. Important — immutable exclusion partition

Fix:

- Return derivation persists a deterministic gzip exclusion partition next to returns.
- The derived manifest contains typed `returns` and `exclusions` entries with bytes, SHA-256, row counts, and schema versions.
- Calibration verifies the complete derived closure and exact exclusion wire records; replay verifies the manifest closure and reads only the typed returns entry.

Files: `writer/src/research/returns.ts`, `writer/src/research/calibration.ts`, `writer/src/research/cli.ts`, `writer/test/research-returns.test.ts`, `writer/test/research-calibration.test.ts`, `writer/test/research-end-to-end.test.ts`.

Regression proof: `derived partitions are immutable and deterministic after manifest verification`; `calibration rejects a derived return whose immutable manifest closure changed`.

### 11. Important — immutable output collision

Fix:

- Existing return, exclusion, and derived-manifest paths are adopted only after byte-for-byte equality.
- A concurrent/create collision is also byte-compared and fails closed on disagreement.

Files: `writer/src/research/returns.ts`, `writer/test/research-returns.test.ts`.

Regression proof: `derived partitions are immutable and deterministic after manifest verification` mutates both an immutable data partition and its manifest and requires rejection.

### 12. Important — physical reorg identity

Fix:

- Chain-log tombstones now target `eventKey:blockHash`, not the logical transaction/log identity alone.
- A canonical re-inclusion of the same transaction/log index in a different block hash is active and deduplicates normally.
- Report funnel tombstone filtering uses the same physical identity.

Files: `writer/src/research/journal.ts`, `writer/src/research/report.ts`, `writer/test/research-events.test.ts`, `writer/test/research-report.test.ts`.

Regression proof: `orphaning one physical chain log permits the same transaction/log identity to be canonically re-included`.

### 13. Important — persistence containment

Fix:

- Source `underlying` is restricted to a safe filename ID before it can become a shard directory.
- Replay rejects an unsafe `modelVersion` before deriving or writing a validation path.
- Shared `containedPath` enforces lexical containment, rejects symlink components, and verifies real-path containment.
- Manifest, calibration, replay, report, backup, and operational-state references reuse this boundary.
- Durable final-file opens use `O_NOFOLLOW`; quote/event journal code cannot pre-follow a symlink.

Files: `writer/src/research/types.ts`, `writer/src/research/store.ts`, `writer/src/research/calibration.ts`, `writer/src/research/replay.ts`, `writer/src/research/cli.ts`, `writer/src/research/report.ts`, `writer/src/research/backup.ts`, `writer/src/research/journal.ts`; containment regressions in the corresponding test files.

Regression proof: unsafe underlying and model-version tests; `manifest verification rederives metadata, registry content, and contained paths`; backup referenced-baseline symlink rejection; report state symlink rejection; journal target remains byte/mode untouched.

### 14. Important — quote/mint/resolution funnel

Fix:

- The quote-ID set now filters mints.
- Resolutions count only when their parlay joins an active quoted mint.
- Physical orphan corrections remove only the affected log instance.

Files: `writer/src/research/report.ts`, `writer/test/research-report.test.ts`.

Regression proof: `journal funnel joins only quoted canonical mints to their matching parlay resolution` includes unrelated events, unmatched resolution, and orphaned physical logs.

### 15. Important — durable operational evidence

Fix:

- Added one existing-store-based operation-state wire shape for `running`, `succeeded`, and `failed` states.
- Daily, calibration, join, and backup persist start/end/result and bounded, URL-redacted error evidence.
- Backup's total deadline begins before synchronous closure traversal.
- Reports render operational evidence in its own observed-fact section, including backup and join.

Files: `writer/src/research/store.ts`, `writer/src/research/daily.ts`, `writer/src/research/calibration.ts`, `writer/src/research/journal.ts`, `writer/src/research/backup.ts`, `writer/src/research/report.ts`, `writer/test/research-operations.test.ts`, `writer/test/research-backup.test.ts`, `writer/test/research-report.test.ts`.

Regression proof: daily success/failure state assertions; calibration success/failure assertions; join failure state assertion; `research backup total deadline starts before synchronous closure traversal`; explicit operational-evidence report assertions.

## TDD evidence

All behavior changes began with a regression or, for fixture/test-quality corrections, mutation/compatibility evidence. The following is the preserved command/output evidence. Long TAP output is reduced to the failing/passing facts without changing counts or messages.

### Initial RED group: closure, ingestion, durability, deployment, isolation, exclusions, containment

Command:

```bash
npm run research:check -- --test-name-pattern='safe filename|oversized|rolling manifest|same-response|symbolic link|immutable and deterministic|fsyncs the daily|dotenv file|deployment rsync'
```

Actual RED summary:

```text
1..96
# tests 96
# pass 87
# fail 9
```

The nine failures were the real dotenv child-process test (expected exit 2, got 0), missing candle batch rejection, absent rolling-manifest output, same-response conflict sealing, missing directory-chain fsyncs, unanchored deployment exclusion, absent typed exclusion partition, missing symlink rejection, and missing traversal rejection.

GREEN evidence: those named tests are all `ok` in the final `npm run research:check` result (103/103), including tests 11, 23, 27, 34, 42–43, 54, 91, 96, and the source-registry validation cases.

### Daily pointer RED

Command:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='collector pointer' test/research-operations.test.ts
```

Actual RED:

```text
not ok - research daily derives immutable inputs from the collector pointer without manual window pins
Expected values to be strictly equal: 2 !== 1
# pass 0
# fail 1
```

GREEN: final research test 50 is `ok`; daily derives and propagates the collector's exact immutable pointer closure.

### Causality, policy, age, reorg, funnel, operations, and deadline RED group

Command:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='observable|immutable canonical source|historical dependence|terminal candidate|unsafe modelVersion|without a restart|physical chain log|journal funnel|total deadline|same derivation|collector pointer|preserves signed negatives|event resume' test/research-returns.test.ts test/research-replay.test.ts test/server.test.ts test/research-events.test.ts test/research-report.test.ts test/research-backup.test.ts test/research-operations.test.ts test/research-calibration.test.ts
```

Actual RED failures:

```text
backup failure state: state file absent
physical chain-log re-inclusion: re-included record remained tombstoned
daily success/failure evidence: state file absent (2 cases)
replay policy/registry helpers: requested exports absent
journal funnel: requested export absent
return observationCloseTimeMs: undefined
currentModelStatus: requested export absent
# fail 8
```

Focused GREEN after minimum implementations:

```text
1..13
# tests 13
# pass 13
# fail 0
# duration_ms 38800 (approximately)
```

The final complete suite independently re-ran every case.

### Representative resource-policy RED/GREEN

Command:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='representative 20-underlying' test/research-replay.test.ts
```

Actual RED:

```text
not ok - representative 20-underlying replay fixture is deterministic within local resource bounds
duration_ms: 47884
```

It also exposed that the fixed-window policy-admissible fixture should contain 12 same-underlying tickets and no inadmissible same-/cross-cluster tickets.

Actual GREEN after early policy pruning and reuse of existing schedule/fit primitives:

```text
ok 1 - representative 20-underlying replay fixture is deterministic within local resource bounds
# pass 1
# fail 0
# duration_ms 11324.7
```

The final full run repeated this case in 11,452.149 ms, below the 30,000 ms policy.

### Full-suite compatibility and failure-path RED

Command:

```bash
npm run research:check
```

The first integration run exposed five compatibility regressions after the new boundaries: the old backup skip expectation, candles with old retrieval timestamps, retry fixture source identity, same-response fixture count, and integration error wording. The fixtures/assertions were corrected without weakening the new production checks.

The next run produced:

```text
# tests 102
# pass 101
# fail 1
not ok - failed dependence fit yields a serializable Rejected report
```

Root cause: a one-source failed fit could incorrectly become `Inconclusive`. The smallest production correction requires two eligible fresh sources before an origin dependence fit.

Focused GREEN:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='failed dependence fit' test/research-replay.test.ts
```

```text
ok 1 - failed dependence fit yields a serializable Rejected report
# pass 1
# fail 0
# duration_ms 429 (approximately)
```

### Self-review containment RED/GREEN

Journal no-follow target:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='symlinked daily file' test/research-journal.test.ts
```

RED:

```text
not ok 1 - journal: rejects a symlinked daily file without touching its target
Expected values to be strictly equal: 384 !== 420
# fail 1
```

The target mode had been changed from `0644` to `0600` by the legacy pre-open. GREEN after removing it:

```text
ok 1 - journal: rejects a symlinked daily file without touching its target
# pass 1
# fail 0
# duration_ms 263.028791
```

Backup referenced symlink:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='research backup signs' test/research-backup.test.ts
```

RED: `Missing expected rejection.` GREEN: `ok 1`, 1 pass, 0 fail, 402.241875 ms. The shared contained-path boundary now protects candidate, manifest, baseline, and closure references.

Report state symlink:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='verifies every immutable reference' test/research-report.test.ts
```

RED: `Missing expected exception.` GREEN: `ok 1`, 1 pass, 0 fail, 187.149209 ms.

## Final verification

These commands were run from the worktree after the last production edit unless explicitly noted.

| Check | Actual result |
|---|---|
| `cd writer && npm run typecheck` | exit 0; `tsc --noEmit` |
| `cd writer && npm run research:check` | exit 0; 103 tests, 103 pass, 0 fail; 54,884.906708 ms |
| `cd writer && npm run check` | exit 0; typecheck plus 280 tests, 280 pass, 0 fail; 56,131.292833 ms |
| `forge build` | exit 0; `No files changed, compilation skipped` |
| `forge test` | exit 0; 7 suites, 172 tests passed, 0 failed, 0 skipped |
| `git diff --check` | exit 0, no output before the implementation commit |
| focused 20-underlying replay | exit 0; 1 pass, 0 fail; 11,452.149166 ms in final full run |

No keeper TypeScript files or rotation code were touched, so their conditional dedicated checks were not required. `forge test` did run all `KeeperVerifier` Solidity tests (14/14) as part of the 172-test contract result.

## Self-review

- Immutable identity: raw manifests, derived returns/exclusions/manifests, candidates, validation sidecars, source-registry facts, and baseline snapshots are hash/byte checked at their owning boundaries.
- Causality: return visibility is close-time-based; each replay origin fits its own quality-admissible dependence; terminal candidate matrices are not used for challenger draws.
- Live safety: request-time age can only disable cross-underlying quoting; it does not widen eligibility. Existing pair/quarantine/fallback and complexity gates remain fail-closed.
- Persistence: newly created directory links and daily files are fsynced; final durable files use no-follow opens; referenced reads reject traversal and symlink components.
- Operational secrecy: research no longer loads the writer `.env`; persisted errors redact URLs and are bounded; backup credential values were checked absent from summaries/state.
- Scope: no dependency, contract, EIP-712 field, signer, keeper, rotation, promotion, or shared-state behavior was added.
- Resource policy: the explicit representative 20-underlying gate is 11.45 seconds. The separate long immutable-rerun snapshot test remains about 34 seconds and is not the 30-second representative resource gate; this report does not conflate them.
- Git hygiene: only tracked fix files entered `20edde1`; the two untracked `node_modules` symlinks remain untracked.

## Deferred minors

Fixed opportunistically because the owning code was already touched:

1. `durableAppend` now normalizes to exactly one trailing newline.
2. Manifest path ordering is bytewise/code-point, not locale-sensitive.
9. Backup traversal/`lastVerifiedObjectHash` ordering is bytewise.

Partially strengthened but still deferred:

6. Exact persisted-wire validation was strengthened for source-registry facts, return close provenance, exclusion records, and referenced manifests, but a complete audit of every historical disk boundary remains.

Still deferred and non-blocking, as authorized by the findings document:

3. Make the fake event client assert every explicit `blockNumber` read.
4. Sort calibration buckets independently in `renderReport`.
5. Display full candidate/manifest/champion identities rather than compact report identities.
7. Deduplicate economically identical synthetic events when quantiles tie.
8. Require replay seed equality when reusing an existing validation sidecar.

Unresolved Critical/Important findings: **none**.

## Permission-gated omissions

No production/shared-state/network/VPS/testnet/systemd/bucket/promotion/restart action was performed. In particular, this wave did not:

- deploy, rsync, SSH, restart, enable, or trigger a service/timer;
- collect from the real information API or query a real RPC;
- upload to or restore from a real off-box bucket;
- promote or replace a live champion;
- run native-Ubuntu/off-box cost evidence or real testnet/statistical acceptance gates.

Those remain Pending separate approval. Restored general network connectivity was not needed for any local verification and was not treated as authorization for an external action.
