# Task 5 Report: Walk-Forward Replay and Offline Challengers

## Status

Implemented the bounded offline replay in `writer/src/research/replay.ts`, exposed it through the research CLI, and added deterministic fixtures/tests. The live writer path, Solidity, dependencies, network behavior, candidate artifact, and champion were not changed.

## Files changed

- `writer/src/research/replay.ts`: causal synthetic grid, Gaussian/independence/t-copula/FHS probabilities, nested degree selection, scores, stress buckets, bootstrap decision, immutable validation output, and resource metrics.
- `writer/src/research/cli.ts`: explicit-input `replay` command with candidate/manifest/source/return byte and path verification.
- `writer/test/research-replay.test.ts`: causality, exact grid, scores, t distribution/copula, FHS, bootstrap, immutable output, rejected-output, CLI, and resource-bound coverage.
- `writer/test/fixtures/research/replay-series.jsonl`: representative twenty-underlying fixture specification.
- `writer/test/fixtures/research/replay-expected.json`: byte-exact selected-ticket golden output.
- `.superpowers/sdd/2026-08-27-testnet-correlation-system/task-5-report.md`: this report.

## TDD evidence

Initial RED command:

```text
cd writer && npm test -- --test-name-pattern='future mutation|log loss|signed negative|block bootstrap'
```

The first sandboxed attempt stopped before tests because tsx could not create its IPC socket (`listen EPERM`). Re-running the same command with permission to create that local socket produced the expected behavioral RED: `ERR_MODULE_NOT_FOUND` for `src/research/replay.js`, with 196 existing tests passing and the new module load failing.

During implementation, strengthening the future-mutation test exposed a real look-ahead defect: outcome bytes were included in the ticket-selection hash, so changing future returns changed the selected ticket keys. The selection serialization was changed to exclude outcomes, and the strengthened test then passed.

Self-review RED command:

```text
node --import tsx --test --test-name-pattern='replay snapshots|failed dependence' test/research-replay.test.ts
```

Expected failures were observed:

```text
not ok 1 - replay snapshots the baseline and immutable reruns ignore later registry edits
assert.ok(Object.values(first.modelElapsedMs).every((elapsedMs) => elapsedMs > 0))
not ok 2 - failed dependence fit yields a serializable Rejected report
error: bootstrap origins do not span one complete block
tests 2; pass 0; fail 2
```

Minimal GREEN after recording actual timing/RSS, excluding non-finite forecast rows while retaining the Rejected gate, and explicitly handling an insufficient bootstrap span:

```text
ok 1 - replay snapshots the baseline and immutable reruns ignore later registry edits
ok 2 - failed dependence fit yields a serializable Rejected report
tests 2; pass 2; fail 0
duration_ms 3265.158917
```

Required research GREEN command:

```text
cd writer && npm run research:check -- --test-name-pattern='replay|score|bootstrap|challenger'
```

Output:

```text
tests 54; pass 54; fail 0; skipped 0
duration_ms 43638.510958
```

The final full writer gate below reran all Task 5 tests after the self-review fixes.

## Verification

```text
cd writer && npm run typecheck
> tsc --noEmit
exit 0

cd writer && npm run check
> npm run typecheck && npm run test
tests 210; pass 210; fail 0; skipped 0
duration_ms 44271.138667

forge test --offline
Ran 7 test suites: 172 tests passed, 0 failed, 0 skipped
```

`forge build` was also attempted normally, with escalation, and with `--offline`. In this worktree it exits zero after printing `No files changed, compilation skipped`, because the declared dependency directories contain source files but their Git submodule metadata is uninitialized (`git submodule status` prefixes both entries with `-`). It therefore was not a valid fresh compilation check. Task 5 changes only writer TypeScript; the writer typecheck/full test gate is valid and green.

## Performance and RSS

Command:

```text
cd writer && /usr/bin/time -l node --import tsx --test --test-name-pattern='representative 20-underlying' test/research-replay.test.ts
```

Output:

```text
ok 1 - representative 20-underlying replay fixture is deterministic within local resource bounds
duration_ms: 40166.431208
40.33 real
231571456 maximum resident set size
```

The test performs two byte-compared deterministic fixture runs; its measured first run passed the `< 30,000 ms` assertion. The complete two-run test took 40.17 seconds, and process maximum RSS was 231,571,456 bytes (about 221 MiB), below 512 MiB.

## Self-review

- Look-ahead: every origin builds a `<= origin` training slice; transformations, quantiles, FHS EW statistics, stress cutoffs, hierarchical loadings, signed dependence, and nested degree selection use it. Future values are used only for outcomes/regime labels. Ticket hashes exclude outcomes, proven by a future-mutation regression.
- RNG/state reuse: deterministic SHA-256-derived RNG seeds are scoped by replay seed/origin/degree. One t draw matrix is generated per origin/degree and reused across all tickets. Bootstrap uses a separate deterministic seeded stream and resamples complete origin groups.
- Finite probabilities: all scored probabilities are clamped to `[1e-6, 1 - 1e-6]`; t-copula/FHS use add-one smoothing. Non-finite model paths are recorded, omitted from scoring, and force a serializable Rejected artifact.
- Artifact immutability: the parsed baseline is canonicalized into `facts/baselines/<sha256>.json`; existing validation verifies candidate/manifest identity and snapshot bytes/hash. Writes use create-new atomic storage. Replay never edits the candidate or champion.
- Runtime/memory: selection is capped at 12 tickets per stratum/origin, draws are reused, bootstrap is fixed at 2,000 samples, supported sources remain capped by the existing twenty-underlying schema, and the local fixture meets both bounds.
- Scope: offline CLI/research files only; no live writer integration, network call, dependency, Solidity change, secret, or production/shared-state operation was added.

## Concerns

- The standalone Forge build could not be validated freshly because of the pre-existing uninitialized submodule metadata described above. Forge tests and every Task 5/writer check pass.

---

## Fix round 1: causal replay gates

This section supersedes the original performance claim above. The earlier fixture timed two calls to `syntheticEvents`, not `runReplay`, so it was not evidence for the complete replay path. The fixed fixture invokes `runReplay` with a twenty-source registry (twelve candidate-eligible and eight explicitly quarantined underlyings) over five forecast origins. It asserts eligible FHS rows and non-empty 96-hour bootstrap groups, and therefore covers ticket construction, all five model paths, scoring, bootstrap, deterministic full recomputation, and validation artifact creation at the mandatory 20,000 draws.

### Review defects fixed

- Signed t-copula draws now use `candidate.quality.signedPsdTarget` directly in `quality.matrixOrder`; degree selection chooses only `df` and cannot replace candidate dependence.
- Nested 80/20 selection derives its cutoff from the common aligned hourly or daily rows actually used. It fits dependence on the first 80%, validates `df` on the final 20%, and the replay separately fits measured champion parameters on the full causal training slice.
- `runReplay` performs two complete in-memory computations and canonical-byte compares them. Measured elapsed time and RSS were removed from the immutable artifact and replaced with deterministic resource policy limits.
- Same-underlying mixed-direction tickets are labeled `band`. They remain visible in score dimensions and exclusion counts but are removed from all score calculations, bootstrap inputs, and decision gates.
- Training and future stress labels now compare the same equal-weight portfolio statistics: 24-hour volatility and cumulative drawdown paths. All three named stress buckets are emitted, including zero-row buckets marked `insufficient-stress-sample`.
- Draw count is fixed at exactly 20,000; the CLI override was removed and legacy programmatic overrides are rejected.
- Origins advance by an exact 24-hour step. Outcomes require every ticket asset at every exact interval through the exact horizon close; a missing or shifted observation leaves the ticket outcome unavailable.
- The bounded ticket-selection hot path precomputes interval/vector facts, maintains only the best twelve candidates per stratum, evaluates future outcomes only after selection, and uses the stdlib one-shot SHA-256 helper for the mandated ranking hash. This brought the genuine replay below the local time limit without changing the specified caps or algorithms.

### Focused TDD RED evidence

All commands ran from `writer/`. Each regression was added before its corresponding production change.

```text
node --import tsx --test --test-name-pattern='visible as bands' test/research-replay.test.ts
not ok 1 - same-underlying mixed-direction tickets are visible as bands
Expected values to be strictly equal: actual 'alternating', expected 'band'
tests 1; pass 0; fail 1; exit 1

node --import tsx --test --test-name-pattern='exactly 20,000' test/research-replay.test.ts
not ok 1 - replay fixes challenger simulation at exactly 20,000 draws
Missing expected exception
tests 1; pass 0; fail 1; exit 1

node --import tsx --test --test-name-pattern='candidate PSD' test/research-replay.test.ts
not ok 1 - runReplay signed t probabilities consume the candidate PSD matrix order
Expected actual to be strictly unequal to: 0.32970050235302695
tests 1; pass 0; fail 1; exit 1

node --import tsx --test --test-name-pattern='hourly degree' test/research-replay.test.ts
not ok 1 - hourly degree selection fits dependence before its validation tail
Expected values to be strictly equal: 30 !== 4
tests 1; pass 0; fail 1; exit 1

node --import tsx --test --test-name-pattern='exact 24-hour|exact horizon-close' test/research-replay.test.ts
not ok 1 - daily replay origins stay on an exact 24-hour UTC cadence
not ok 2 - future outcomes require exact horizon-close alignment across every asset
tests 2; pass 0; fail 2; exit 1

node --import tsx --test --test-name-pattern='future path drawdown' test/research-replay.test.ts
not ok 1 - stress classification compares future path drawdown with training drawdowns
Expected values to be strictly equal: actual 'normal', expected 'drawdown-stress'
tests 1; pass 0; fail 1; exit 1

node --import tsx --test --test-name-pattern='fresh runReplay' test/research-replay.test.ts
not ok 1 - fresh runReplay artifacts are byte-identical and cover full replay determinism
artifact bytes differed because measured timing/RSS fields differed
tests 1; pass 0; fail 1; exit 1

node --import tsx --test --test-name-pattern='representative 20-underlying' test/research-replay.test.ts
not ok 1 - representative 20-underlying replay fixture is deterministic within local resource bounds
fixture took 40474ms
tests 1; pass 0; fail 1; duration_ms 40600; exit 1
```

The first hourly regression draft had only 1,000 rows, making its first 80% slice ineligible under the existing 1,000-hour quality gate. The fixture was corrected to 1,250 rows so its nested fit contains exactly 1,000 eligible hourly rows; no production threshold was relaxed.

### Focused GREEN evidence

```text
node --import tsx --test --test-name-pattern='candidate PSD|hourly degree|fresh runReplay|visible as bands|future path drawdown|exactly 20,000|exact 24-hour|exact horizon-close|replay snapshots' test/research-replay.test.ts
tests 9; pass 9; fail 0; skipped 0
duration_ms 11780.786708
```

This combined gate covers the eight exact review defects, including all named zero-row stress buckets in the replay snapshot regression. Existing direct signed-t, band-score, future-mutation, and bootstrap regressions remained green.

Required research check:

```text
npm run research:check -- --test-name-pattern='replay|score|bootstrap|challenger'
tests 63; pass 63; fail 0; skipped 0
duration_ms 26037.538334
```

Final writer verification (the first sandboxed `npm run check` attempt passed typecheck but tsx could not bind its temporary IPC socket with `listen EPERM`; the identical permitted rerun below is authoritative):

```text
npm run typecheck
> tsc --noEmit
exit 0

npm run check
> npm run typecheck && npm run test
tests 218; pass 218; fail 0; skipped 0
duration_ms 28117.096291
exit 0
```

### Genuine full-replay performance and RSS

```text
/usr/bin/time -l node --import tsx --test --test-name-pattern='representative 20-underlying' test/research-replay.test.ts
ok 1 - representative 20-underlying replay fixture is deterministic within local resource bounds
tests 1; pass 1; fail 0
duration_ms 13790.343083
13.82 real
219971584 maximum resident set size
exit 0
```

The fixture asserts total process RSS, not merely growth. The measured complete replay is below 30 seconds and about 210 MiB, below the 512 MiB limit. The timed result contains five origins spanning 96 hours, 180 selected tickets, eligible filtered-historical-simulation forecasts, and non-empty bootstrap groups.

### Fix-round self-review

- Look-ahead: origin construction is a fixed 24-hour cadence. Training slices end at the origin; nested fit cutoff comes from the selected common base; exact future observations are read only for outcomes and comparable stress labels. Missing horizon data cannot shorten a ticket.
- Candidate dependence: Cholesky validation and t draws operate on the candidate signed PSD matrix in its declared order. The full-data fitted matrix is used only by the measured Gaussian champion; `df` selection cannot substitute it into the t challenger.
- RNG and determinism: seeded t draws are created once per origin/df and reused across tickets. Bootstrap has its own seed and retains whole origin groups. Two full `compute()` calls canonicalize identically, and two fresh-root replay artifacts compare byte-for-byte.
- Finite probabilities and gates: all scored probabilities are clamped; t/FHS retain add-one smoothing. Bands are visible but have zero eligible contribution to every score and are absent from bootstrap. Missing stress regimes remain visible and gate-inadequate.
- Immutability: the report contains deterministic policy limits rather than host measurements. Candidate, baseline snapshot, and manifest identities are verified; existing artifacts are returned only after immutable identity and baseline-byte checks.
- Bounds and scope: fixed 20,000 t draws are reused per origin; selection remains capped at twelve tickets per stratum/origin; bootstrap remains 2,000 samples. No dependency, live writer path, network call, Solidity, shared production state, or secret was added.

### Fix-round files changed

- `writer/src/research/replay.ts`
- `writer/src/research/cli.ts`
- `writer/test/research-replay.test.ts`
- `writer/test/fixtures/research/replay-expected.json`
- `.superpowers/sdd/2026-08-27-testnet-correlation-system/task-5-report.md`

### Fix-round concerns

None. The earlier Forge/submodule caveat remains unchanged and is outside this TypeScript-only fix round.
