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
