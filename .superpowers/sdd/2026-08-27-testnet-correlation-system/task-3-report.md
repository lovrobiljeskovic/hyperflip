# Task 3 Report: Session-Aware Returns and Quality Gates

## Implementation

- Added `writer/src/research/returns.ts` with schedule-aware expected intervals (IANA zones and declared exchange closures), active/stale classification, hourly and daily log returns, fixed-window pair alignment, quality gates, exclusion records, and schedule-aware trailing freshness.
- Added immutable, manifest-verified derivation under `derived/returns/YYYY/MM/DD/`, including source candle keys, transformation version `returns-v1`, and a derived manifest. Re-running the same canonical input is a no-op.
- Added `research derive`, which requires `RESEARCH_ROOT`, `RESEARCH_MANIFEST_FILE`, `RESEARCH_AS_OF_MS`, and `RESEARCH_LOOKBACK_MS`.

## Files Changed

- `writer/src/research/returns.ts`
- `writer/src/research/cli.ts`
- `writer/test/research-returns.test.ts`
- `writer/test/fixtures/research/candles-continuous.jsonl`
- `writer/test/fixtures/research/candles-session.jsonl`

## TDD Evidence

RED command:

```sh
cd writer && ./node_modules/.bin/tsx --test test/research-returns.test.ts --test-name-pattern='missing intervals|session close|quality gates'
```

RED output: `ERR_MODULE_NOT_FOUND` for `src/research/returns.js`; 0 passing, 1 failing test file. This was the expected missing-builder failure.

GREEN commands:

```sh
cd writer && npm test -- --test-name-pattern='missing intervals|session close|quality gates'
cd writer && npm run typecheck
cd writer && npm run research:check -- --test-name-pattern='return|quality|derive'
```

GREEN output: focused `npm test` 185 passing / 0 failing; `tsc --noEmit` exited 0; research check 30 passing / 0 failing.

## Self-Review

- Fixed-window denominators are derived from the requested window, including shared outages and edge gaps; no candle is forward-filled.
- Daily session returns only bridge consecutive scheduled sessions, so weekends and declared holidays bridge while a missing scheduled session does not.
- Derivation verifies manifest file bytes/hashes before any partition read and uses immutable writes.

## Concerns

- None. Promotion-time consumers can reuse exported `trailingFresh` with their own 30-hour candidate-age gate.
