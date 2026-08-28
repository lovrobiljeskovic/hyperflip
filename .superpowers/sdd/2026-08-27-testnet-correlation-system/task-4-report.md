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

## Fix Round 1

### Changes

- Coordinate descent now rejects every candidate for which the fitted global and cluster loading squares exceed `0.99` together.
- Schedule-aware freshness now sees only usable raw candles referenced by participating derived-return `sourceKeys`, matching `dataAsOf` and last-observation provenance.
- A zero-variance synchronized pair now remains pair-local and follows its configured fallback/quarantine decision instead of aborting calibration.

### Covering Tests and TDD Evidence

Covering file: `writer/test/research-calibration.test.ts`.

Initial RED command:

```sh
cd writer && ./node_modules/.bin/tsx --test --test-name-pattern='jointly caps|freshness ignores|constant synchronized' test/research-calibration.test.ts
```

Output: 0 passing / 3 failing. The joint-loading assertion exceeded `0.99`; the source with a non-participating late raw candle was not quarantined; and the constant-series fixture was incorrectly admitted as direct. Tightening the fixture to an exact zero series produced the intended numerical-failure RED:

```sh
cd writer && ./node_modules/.bin/tsx --test --test-name-pattern='constant synchronized' test/research-calibration.test.ts
```

Output: 0 passing / 1 failing with `weighted correlation requires non-constant series` escaping calibration.

Focused GREEN command:

```sh
cd writer && ./node_modules/.bin/tsx --test --test-name-pattern='jointly caps|freshness ignores|constant synchronized' test/research-calibration.test.ts
```

Output: 3 passing / 0 failing.

All Task 4 focused tests:

```sh
cd writer && ./node_modules/.bin/tsx --test test/research-matrix.test.ts test/research-calibration.test.ts
```

Output: 11 passing / 0 failing.

Required research verification:

```sh
cd writer && npm run research:check -- --test-name-pattern='matrix|calibrat|candidate'
```

Output: 41 passing / 0 failing.

Typecheck:

```sh
cd writer && npm run typecheck
```

Output: `tsc --noEmit` exited 0.

Full writer verification:

```sh
cd writer && npm run check
```

Output: typecheck exited 0; 196 tests passed / 0 failed.

### Self-Review

- The loading constraint is evaluated before every coarse and refinement candidate; the zero/current candidate remains available, so no new convergence hole is introduced.
- Freshness, `dataAsOf`, and `lastUsableObservationMs` now share the same participating immutable provenance.
- Only the named non-constant-series numerical condition is converted into pair-local missing estimation; malformed input errors still propagate.
- The default deterministic fixture still matches `expected-candidate.json` byte-for-byte.

### Concerns

- None.
