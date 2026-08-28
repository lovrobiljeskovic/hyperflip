# Testnet Correlation Verification

Evidence date: 2026-08-28
Scope: local fixture acceptance only; shared testnet/VPS operations were not authorized.

## Acceptance state

- Local fixture acceptance: **Passed** in both complete seven-command sequences.
- Testnet operational acceptance: **Pending separate approval**.
- Statistical acceptance: **Pending approved testnet evidence**; no Supported, Inconclusive, or Rejected determination has been made from local fixtures.
- Mainnet promotion: **Not authorized**. Operational success would not establish production expected value.

## Local acceptance evidence

The fixture-only `correlation beta acceptance` integration covers:

- missing and corrupt raw partitions fail before champion replacement;
- valid champion parsing and invalid champion rejection;
- durable quote journaling with matching quote ID and EIP-712 digest before a quote is returned;
- the same quote ID joining to a confirmed mint and void resolution;
- byte-identical collect/derive/calibrate/replay/report reruns;
- collector and calibrator failures stopping locally without writer or keeper control calls; and
- execution of the research suite by the non-interactive repository gate.

TDD evidence:

- RED: exit 1; the repository-gate probe observed `forge fmt --check`, `forge build`, and `forge test`, but expected and did not observe `npm run research:check`.
- GREEN: exit 0 after adding only `(cd writer && npm run research:check)` to `scripts/verify.sh`; acceptance subtest `ok 151`.

### First local gate run

The worktree reused the already-installed main-checkout submodule metadata at the exact recorded commits. A preceding `forge build --force` compiled 66 files with Solc 0.8.28 and printed `Compiler run successful!`, proving the later cache-backed exact commands were not false green skips.

| Command | Exit | Concise exact output |
|---|---:|---|
| `forge build` | 0 | `Compiling 2 files with Solc 0.8.28`; `Compiler run successful!` |
| `forge test` | 0 | `Ran 7 test suites ...: 172 tests passed, 0 failed, 0 skipped (172 total tests)` |
| `(cd writer && npm run check)` | 0 | `tsc --noEmit`; acceptance `ok 151`; final subtest `ok 163` |
| `(cd writer && npm run research:check)` | 0 | acceptance `ok 36`; final subtest `ok 48` |
| `(cd keeper && npm run check)` | 0 | `tests 25`; `pass 25`; `fail 0` |
| `node --test tools/rotate-lib.test.mjs` | 0 | `tests 14`; `pass 14`; `fail 0` |
| `./scripts/verify.sh` | 0 | Forge `172 tests passed, 0 failed`; research acceptance `ok 36`; final research subtest `ok 48` |

Failed attempts retained for verification honesty:

- Initial `forge build` exited 0 after failed dependency clone attempts and `No files changed, compilation skipped`; it was rejected as evidence. Existing local submodule metadata was reused, then `forge build --force` performed a genuine 66-file compile.
- The first writer check exited 2 on two `JoinedEventRecord.quoteId` TypeScript narrowing errors in the new test; the union was narrowed before access and `tsc --noEmit` then passed.
- The first repository gate exited 1 because `forge fmt --check` found three pre-existing comment-spacing differences in `test/ParlayVault.t.sol`; only those three mechanical spaces were changed before the complete green sequence above.

### Final local gate run

Run after the first evidence table was written:

| Command | Exit | Concise exact output |
|---|---:|---|
| `forge build` | 0 | `No files changed, compilation skipped` against the previously proven successful Solc build |
| `forge test` | 0 | `Ran 7 test suites ...: 172 tests passed, 0 failed, 0 skipped (172 total tests)` |
| `(cd writer && npm run check)` | 0 | `tsc --noEmit`; acceptance `ok 151`; final subtest `ok 163` |
| `(cd writer && npm run research:check)` | 0 | acceptance `ok 36`; final subtest `ok 48` |
| `(cd keeper && npm run check)` | 0 | `tests 25`; `pass 25`; `fail 0` |
| `node --test tools/rotate-lib.test.mjs` | 0 | `tests 14`; `pass 14`; `fail 0` |
| `./scripts/verify.sh` | 0 | Forge `172 tests passed, 0 failed`; research acceptance `ok 36`; final research subtest `ok 48` |

## Operational acceptance criteria

All operational evidence below is **Pending separate approval**. No VPS files, systemd units, timers, buckets, champions, services, quotes, mints, resolutions, or shared testnet state were read or changed for this record.

| # | Criterion | State | Required approved evidence |
|---|---|---|---|
| 1 | At most 20 explicitly mapped underlyings | Pending separate approval | Installed source-registry hash and mapped count |
| 2 | Initial 5,000-candle backfill and idempotent hourly public updates | Pending separate approval | Collector output, ranges, row counts, and manifest hashes |
| 3 | Every promoted artifact references a verified immutable manifest | Pending separate approval | Candidate, manifest, validation, promotion, and champion hashes |
| 4 | Every returned signed quote is durably recorded first | Pending separate approval | Quote ID/digest, journal record, and response ordering evidence |
| 5 | Every minted testnet quote joins to resolution or void | Pending separate approval | Mint and resolution transaction hashes plus joined records |
| 6 | Replay is deterministic and free of detected look-ahead leakage | Pending separate approval | Repeated artifact/report hashes and replay validation state |
| 7 | Missing, stale, conflicting, or insufficient data fails conservatively | Pending separate approval | Coverage, quarantine, failure, freshness, and clipping output |
| 8 | Report shows all required evidence without unsupported profitability claims | Pending separate approval | Secret-free report hash and reviewed statistical state |
| 9 | Calibration cannot starve or restart keeper | Pending separate approval | Resource limits, runtime/RSS, and writer/keeper unit health during outage |
| 10 | Incremental infrastructure remains within USD 0-20/month | Pending separate approval | Deployed resource inventory and cost record |

## Permission-gated evidence record

The following fields intentionally remain unpopulated until the corresponding shared-state actions are separately approved and executed:

- installed source-registry hash;
- data manifest and artifact hashes;
- champion version, hash, and data-as-of;
- replay/report hashes, wall time, peak RSS, and statistical state;
- quote ID and digest;
- mint and resolution/void transaction hashes;
- writer/keeper/systemd health and timer timestamps;
- nightly rotation/restart persistence hashes; and
- off-box object checksum.

No automatic promotion, live t-copula/FHS writer integration, new statistics dependency, band-dispersion model, paid provider, managed database, public dashboard, QuickNode, mainnet bankroll change, or production action was added.
