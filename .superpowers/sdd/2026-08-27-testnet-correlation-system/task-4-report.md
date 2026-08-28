# Task 4 Report: Measured Hierarchical Calibration

## Implementation

- Added deterministic weighted pair correlation, Fisher-z structured targets, exact scalar shrinkage, Jacobi eigendecomposition, Higham/Dykstra nearest-correlation projection, PSD checks, and Cholesky decomposition without a new dependency.
- Added fixed-grid hierarchical coordinate descent and manifest-verified calibration with pair-local direct/fallback/quarantine decisions, schedule-aware freshness, signed PSD challenger data, non-negative live loadings, unweighted diagnostic matrices, and immutable candidate writes.
- Added `research calibrate` using only explicit raw and derived manifests plus the content-addressed source fact.

## Files Changed

- `writer/src/research/matrix.ts`
- `writer/src/research/calibration.ts`
- `writer/src/research/cli.ts`
- `writer/src/research/types.ts`
- `writer/test/research-matrix.test.ts`
- `writer/test/research-calibration.test.ts`
- `writer/test/fixtures/research/returns-small.jsonl`
- `writer/test/fixtures/research/expected-candidate.json`

## TDD Evidence

Initial numeric RED command:

```sh
cd writer && npm test -- --test-name-pattern='weighted correlation|structured shrinkage|nearest correlation|hierarchical fit'
```

The sandboxed attempt failed before test execution because `tsx` could not create its IPC socket (`listen EPERM`). The approved rerun produced the expected feature failure: 185 passing / 2 failing test files, both `ERR_MODULE_NOT_FOUND` for the absent `matrix.js` and `calibration.js` modules.

Initial numeric GREEN command:

```sh
cd writer && ./node_modules/.bin/tsx --test test/research-matrix.test.ts test/research-calibration.test.ts
```

Output: 5 passing / 0 failing.

Calibration RED command:

```sh
cd writer && ./node_modules/.bin/tsx --test test/research-calibration.test.ts --test-name-pattern='calibration preserves|immutable manifest closure'
```

Output: 0 passing / 1 failing test file with the expected `does not provide an export named 'calibrate'` error.

Perfect-correlation shrinkage RED command:

```sh
cd writer && ./node_modules/.bin/tsx --test --test-name-pattern='structured shrinkage' test/research-matrix.test.ts
```

Output: 0 passing / 1 failing with `NaN != 1`.

Focused GREEN command:

```sh
cd writer && ./node_modules/.bin/tsx --test --test-name-pattern='weighted correlation|structured shrinkage|nearest correlation|hierarchical fit|calibration preserves|immutable manifest closure|calibrate CLI' test/research-matrix.test.ts test/research-calibration.test.ts
```

Output: 7 passing / 0 failing.

Required research verification:

```sh
cd writer && npm run research:check -- --test-name-pattern='matrix|calibrat|candidate'
```

Output: 38 passing / 0 failing.

Fresh full writer verification after self-review:

```sh
cd writer && npm run check
```

Output: `tsc --noEmit` exited 0; 193 tests passed / 0 failed.

## Self-Review

- Candidate-visible ordering uses code-point comparison, canonical JSON, manifest-derived timestamps and hashes, and no clock/random input; independent temporary roots produced byte-identical candidates matching the checked-in fixture.
- Both Jacobi and coordinate-descent loops have deterministic tie/order rules and explicit convergence ceilings; Higham output is checked for symmetry, unit diagonal, and PSD before use.
- Negative signed targets remain only in diagnostics and the challenger matrix. Live factor loadings are non-negative and their squared sum is exactly capped at `0.99` with a structural-underlying basis.
- Existing candidates are accepted only for identical bytes; different bytes are rejected without replacement. Untracked `writer/node_modules` and `keeper/node_modules` symlinks remain unstaged.

## Concerns

- None.
