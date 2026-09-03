# Testnet Correlation Multivariate Execution Roadmap

Updated: 2026-09-03

Status: approved roadmap; `R0`–`R6` complete, `R7` next.

Canonical requirements:
`docs/research/testnet-correlation-multivariate-implementation-plan.md`

This roadmap divides the implementation into bounded work packages. Complete at most one package in
a session. Each package ends with focused checks and a durable handoff so the next session can begin
without reconstructing the entire history.

## Current execution state

- Current package: `R7` — replay performance and enforced resources (not started).
- Last completed package: `R6` (2026-09-03): the champion's market registry hash is candidate-time
  provenance (snapshot asserted at load, promotion still pins it to the current registry) and no
  longer part of the live-profile identity; one pure helper `registryCompatibility` in
  `tools/registry-compat.mjs` (re-exported by `tools/rotate-lib.mjs`, imported by
  `writer/src/config.ts`) compares the live registry against the champion taxonomy per market;
  incompatible markets (`unknown-underlying`, `quarantined-underlying`, `cluster-remapped`,
  `direction-unsupported`) are refused on their own cross-underlying tickets via
  `ArtifactModelMetadata.incompatibleMarkets` while the champion stays enabled; the writer records
  the live registry as an immutable fact at boot; the join and report verify every quote's registry
  hashes against those snapshots instead of the registry current at run time; `/health` reports
  champion and live registry hashes and incompatible markets separately.
- Implementation branch/worktree: `feat/correlations` in the main working tree, based on mainline
  `main` at `dc7147005f6cbfe4c566e0ffb60fca435b03fe6f`. `R1`–`R6` committed as `a148095` and
  pushed to `origin/feat/correlations` (2026-09-03). Left uncommitted on purpose: `.DS_Store`,
  `session-report-20260818-2001.html`.
- Last verified commit: `a148095` (checks below, all exit 0, run on the identical tree before committing).
- Production state: static rollback assumed active; not reverified this session (no shared-state
  access); reverify before any shared-state work.
- Open decision gate: none.
- Shared-state authorization: none.

Update this block at the end of every package. Keep it factual and short; code details belong in the
commit and tests.

## Roadmap

| Package | Outcome | Depends on | Shared state | Expected exit |
|---|---|---|---|---|
| `R0` | Clean base, baseline evidence, statistical policy approved | none | no | checks recorded; decisions fixed |
| `R1` | Versioned artifacts, registry snapshots, legacy read-only evidence | `R0` | no | schema/identity tests green |
| `R2` | Weighted estimates, Fisher intervals, fallback policy representation | `R1` | no | estimator/gate tests green |
| `R3` | Deterministic signed asset-specific fitter and PSD construction | `R2` | no | pure model tests green |
| `R4` | Calibrator and replay use the same fitted model and promotion gates | `R3` | no | research integration tests green |
| `R5` | One point-model worker pricing path; correlation band removed | `R4` | no | runtime/worker matrix green |
| `R6` | Rotation-compatible activation and dual registry evidence | `R5` | no | compatibility/report tests green |
| `R7` | Replay runtime and memory bounded by enforced policy | `R6` | no | determinism/resource gate green |
| `R8` | Batch collection shards and daily-only manifest publication | `R7` | no | storage/closure measurements green |
| `R9` | Transactional promotion, activation, smoke rollback, and rotation | `R8` | no | failure/recovery fixtures green |
| `R10` | Full repository verification and final evidence/UI contract | `R9` | no | complete gate matrix green |
| `R11` | Approved testnet cutover and rollback override removal | `R10` | **yes** | live smoke green or auto-restored |

The dependency order is intentional. Do not skip forward because a later package appears easier.

## Session protocol

### At session start

1. Read repository `AGENTS.md`.
2. Read this roadmap's Current execution state and the current package only.
3. Read the named sections of the canonical implementation plan.
4. Read the previous package's handoff below.
5. Inspect `git status`, current branch/worktree, and recent commits before editing.
6. Re-run the smallest check that proves the previous package's exit state if the current package
   depends directly on it.

`R0` is the only package that must read the full handover, verification, multivariate improvement,
and math documents. Later packages should reopen only the source sections they need unless the
handoff identifies an unresolved cross-cutting question.

### During the session

- Work only on the current package.
- Add the smallest regression before changing nontrivial behavior.
- Reuse existing helpers and dependencies.
- Do not weaken a gate to make a fixture pass.
- Do not mix unrelated cleanup, UI redesign, dependency upgrades, or mainnet work into the package.
- If a newly discovered requirement changes later work, update the canonical plan and roadmap, but
  do not implement the later package early.

### At session end

1. Run every focused exit check listed for the package and show its exact output.
2. Run `git diff --check` for tracked changes.
3. Report red checks plainly. A red package remains current; do not advance its status.
4. Update the Current execution state and Latest handoff sections.
5. Advance to the next package only when the current package's exit criteria are green.
6. Stop. Do not begin the next package in the remaining context window.

If a commit is requested, use `/caveman:caveman-commit` as required by `AGENTS.md`. A work package is
a natural commit boundary, but committing is not implied by this roadmap.

## R0 — Baseline and policy lock

Read:

- the complete canonical implementation plan;
- `docs/research/testnet-correlation-handover.md`;
- `docs/research/testnet-correlation-verification.md`;
- `docs/research/testnet-correlation-multivariate-improvements.md`; and
- `docs/research/testnet-correlation-multivariate-math.md`.

Work:

1. Create a dedicated branch/worktree from current mainline without disturbing existing user edits.
2. Record current focused and full gate outputs.
3. Reconfirm the eleven-underlying scope and ten-distinct-underlying ticket limit from the registries.
4. Turn the four open statistical choices into explicit fixed candidate-policy decisions:
   `maxDirectResidual`, Fisher coverage, fallback weighting/range, and structural `u_i` treatment.
5. Add the ignored roadmap/design documents explicitly only if a commit is requested.

Do not change model behavior.

Exit checks:

- baseline gate commands have exact recorded exit codes/output;
- the implementation branch/worktree and base commit are recorded; and
- all four policy choices are approved and written into the canonical plan.

Stop condition: policy is unresolved. Leave `R0` current and ask only for the missing decisions.

## R1 — Artifact schemas and immutable evidence

Read canonical plan: Phase 2 and the immutable-evidence boundaries.

Primary scope:

- `writer/src/research/types.ts`;
- `writer/src/research/artifacts.ts`;
- immutable registry snapshot storage; and
- corresponding artifact/type/report fixtures.

Work:

1. Add the new activation-eligible artifact and quote-decision schemas.
2. Store and verify candidate-time market-registry snapshots by content hash.
3. Add fields for approved fit policy and pair evidence/gate results.
4. Keep legacy artifacts/journals verifiable read-only while preventing old-model activation.
5. Prove malformed, ambiguous, foreign, or rewritten evidence fails closed.

Out of scope: estimator math, fitting, runtime pricing, compatibility decisions, production data.

Exit: focused type/artifact/report tests and typecheck are green; historical bytes remain untouched.

## R2 — Estimation, uncertainty, and pair gates

Read canonical plan: Policy checkpoint, Phase 3 steps 1–3 and 8; math sections 8–11.

Primary scope:

- `writer/src/research/matrix.ts`;
- estimator/gate types introduced in `R1`; and
- focused matrix/calibration tests.

Work:

1. Preserve the existing exponentially weighted correlation estimator.
2. Add Fisher-z intervals using effective sample size and the approved coverage policy.
3. Implement reliability weights and the approved fallback prior/range representation.
4. Implement pure direct/fallback residual gate evaluation.
5. Test near-zero, negative, rail-adjacent, insufficient-effective-sample, and non-finite inputs.

Out of scope: optimizing factor loadings or changing live pricing.

Exit: estimator results, intervals, weights, and pair gates are deterministic and focused tests pass.

## R3 — Signed factor fitter and PSD model

Read canonical plan: Phase 3; math sections 2–4, 10–12, and 15.

Primary scope:

- a pure shared fitter in the existing research model code;
- `writer/src/research/matrix.ts` only where existing numerical helpers are reused; and
- pure fitting/PSD tests.

Work:

1. Fit asset-specific signed `g_i` and `c_i` under the approved `u_i` and variance policy.
2. Use the `R2` direct weights and weaker fallback policy.
3. Canonicalize source order and factor signs.
4. Construct `R = BB^T + D` directly.
5. Independently check finite loadings, residual variance, symmetry, diagonal, and PSD.
6. Reproduce the six recorded crypto pairs without flattening positive, near-zero, and negative
   behavior.
7. Widen the schemaVersion 3 loading range to signed `[-1, 1]` in both
   `writer/src/research/artifacts.ts` and `writer/src/correlation.ts` (`R1` kept `[0, 1]` because the
   runtime parser still rejects negatives, so a signed candidate fails closed until then).

Out of scope: artifact emission, replay loops, server/worker code.

Exit: pure fitter is deterministic, PSD by construction, and all focused fit regressions are green.

## R4 — Calibration and replay model integration

Read canonical plan: Phase 2 evidence fields, Phase 3 shared-fitter requirements, replay identity
requirements, and Definition of done model gates.

Primary scope:

- `writer/src/research/calibration.ts`;
- `writer/src/research/replay.ts` model construction;
- candidate validation/promotion gates; and
- research integration fixtures.

Work:

1. Replace the uniform fit with the `R3` fitter.
2. Emit complete `R1` evidence populated by `R2` estimates/gates.
3. Reject any candidate with failed direct evidence, fallback bounds, variance, PSD, or deterministic
   model construction.
4. Make replay call the same fitter and artifact interpretation rather than reconstructing a divergent
   projected model.
5. Keep Higham projection diagnostic-only and retain `maxProjectionError = 0.10`.

Out of scope: replay performance optimization and live runtime pricing.

Exit: focused calibration/replay/artifact integration tests and research typecheck are green.

## R5 — Point-model runtime and worker isolation

Read canonical plan: Phase 4; math sections 5–7, 13, and 15.

Primary scope:

- `writer/src/correlation.ts`;
- `writer/src/copula.ts` only if an invariant requires it;
- `writer/src/correlationWorker.ts`;
- `writer/src/server.ts` and pricing evidence; and
- runtime/worker tests.

Work:

1. Accept validated signed loadings.
2. Add the multivariate interior-band counterexample, then delete the two-endpoint band path and its
   claims.
3. Use one point-model integration for the signed quote probability.
4. Keep all nontrivial integration in the worker, including repeated-underlying shapes.
5. Canonically order legs and preserve duplicate/opposite-side exactness.
6. Test 2, 3, 4, 5, 6, and 10 distinct underlyings across crypto, TradFi, and mixed clusters.
7. Test fast cost refusal, queue/timeout recovery, marginals, independence, and permutation invariance.
8. Emit schemaVersion 4 quote decisions (`championMarketRegistrySha256`, `liveMarketRegistrySha256`,
   `pricingMode: "point-model"`, `rhoBandPct: 0`) and tighten the report check in
   `writer/src/research/report.ts` so a schemaVersion 3 candidate accepts only schemaVersion 4 quotes
   (`R1` left it one-directional because the band runtime still writes schemaVersion 3).

Out of scope: registry rotation and replay optimization.

Exit: writer typecheck and focused correlation/copula/worker/server tests are green; no live band path
or main-thread integration remains.

## R6 — Runtime compatibility and dual registry evidence

Read canonical plan: Phase 5 and rotation requirements in Phase 7.

Primary scope:

- writer configuration/startup compatibility;
- quote journal, join, and report identity checks;
- a pure compatibility helper shared with `tools/rotate-lib.mjs`; and
- compatibility/history tests.

Work:

1. Separate historical champion provenance from current live-registry compatibility.
2. Accept address, coin, title, strike, and expiry rotation for known compatible taxonomy.
3. Reject unknown/remapped underlying, cluster, direction, or pair locally.
4. Record and verify champion and live registry hashes/snapshots independently.
5. Keep historical quotes reportable and joinable after later rotations.

Out of scope: changing the live registry or service processes.

Exit: config, journal, report, end-to-end, and rotate-lib compatibility tests are green.

## R7 — Replay performance and enforced resources

Read canonical plan: Phase 6 steps 1–5; math section 14.

Primary scope: replay/calibration caches, streaming weighted moments, deterministic rerun, and resource
measurement.

Work:

1. Add equivalence tests between batch and streaming statistics, including irregular gaps and
   180-day expiration.
2. Reuse alignment, cumulative moments, residuals, stress inputs, and origin fits.
3. Retain two genuine computations while sharing immutable preprocessing only.
4. Record and enforce measured wall time and peak RSS.
5. If the approved resource limit cannot be met, stop with evidence; changing it requires approval.

Out of scope: collection file layout and systemd installation.

Exit: deterministic outputs match, focused research tests pass, and measured resources fit the
approved limit with margin.

## R8 — Collection and manifest growth

Read canonical plan: Phase 6 steps 6–8.

Primary scope:

- `writer/src/research/candles.ts`;
- rolling manifest publication in the daily/CLI path;
- storage/backup closure tests; and
- file-growth measurements.

Work:

1. Write one immutable batch shard/provenance record for all successful sources in an hourly run.
2. Publish the rolling manifest once in the daily pipeline.
3. Preserve conflict quarantine, crash recovery, content addressing, and immutable closure checks.
4. Measure file count, manifest bytes, daily verification time, and backup traversal before/after.

Out of scope: databases, manifest DAGs, uploads, and service installation.

Exit: collection/store/backup/daily tests are green and before/after measurements are recorded.

## R9 — Transactional automation and recovery

Read canonical plan: Phase 7 in full.

Primary scope:

- daily promotion decision;
- activation/rollback orchestration;
- staged rotation and partial-deployment recovery receipts;
- operation evidence; and
- systemd definitions without installing them.

Work:

1. Preserve the displaced champion/release before atomic promotion.
2. Activate only a fresh exact `Supported` candidate.
3. Restart writer only for correlation activation.
4. Smoke-check health, identities, markets, and a controlled quote.
5. Restore the prior champion/release automatically after any failed smoke.
6. Retain the valid champion and alert on failed scheduled research.
7. Stage and compatibility-check rotations; record landed partial deployments without exposing a
   half-built live registry.
8. Prove crash points and idempotent recovery with local fixtures.

Out of scope: installing/enabling units or touching the VPS.

Exit: automation, promotion, failure injection, rotation, and recovery tests are green.

## R10 — Full local gate and final repository evidence

Read canonical plan: Phase 8, Definition of done, and Phase 9 preconditions.

Work:

1. Review the complete diff for requirement coverage and accidental scope.
2. Run the full exact gate matrix from the canonical plan at one commit.
3. Record exact commands, exit codes, test counts, resource measurements, and artifact schema facts.
4. Update handover/verification documents without claiming live activation.
5. Restore the small UI correlation-evidence display only if the new response contract is stable;
   run the exact Next.js build/tests under `web/AGENTS.md`.
6. Prepare, but do not execute, the testnet cutover/automatic restoration runbook.

Exit: all relevant local checks are green at the reviewed commit and the cutover runbook names exact
rollback targets. Any red check leaves `R10` current.

## R11 — Separately approved testnet cutover

Read canonical plan: Phase 9 and Definition of done. Re-read the current production handover and
reverify external state; it may have changed since this roadmap was written.

This package requires explicit approval because it changes shared VPS/testnet state.

Work:

1. Reconfirm every testnet, identity, service, filesystem, and rollback precondition.
2. Deploy the reviewed writer code without changing keeper/contracts/web/research history.
3. Produce and review a fresh new-schema candidate.
4. Promote only an exact `Supported` candidate.
5. Remove only the rollback override and restart writer only.
6. Require healthy services, exact champion/live identities, current markets, and a controlled
   cross-underlying quote without minting.
7. Automatically restore the override and prior champion/release on any failure.
8. Retain the static release until one natural rotation and one scheduled daily cycle succeed.

Exit: either the new champion path is live with all smoke checks green, or the old static path has
been fully restored. Never leave a half-transition.

## Latest handoff

- Package attempted: `R6` (session 2026-09-03, after `R5`).
- Result: `R6` complete. Regressions were added first and failed for the intended reasons (a
  title/vault/coin/expiry rotation degraded the champion with `artifact profile identity
  mismatch`; a remapped ETH market degraded the whole champion with `source/market cluster
  disagreement for ETH`; the server accepted a ticket on a remapped market; the report skipped a
  quote from another registry instead of verifying its snapshot and rendered a corrupt champion as
  `not promoted`; `rotate-lib.mjs` had no `registryCompatibility` export), then the runtime landed.
  No shared state, dependency, mainnet, or secret involved. No registry, research evidence, or
  immutable fixture bytes rewritten: `expected-candidate.json`, `replay-expected.json`, and
  `report-expected.html` are unchanged by this package.
- Commit/base: branch `feat/correlations`, base `dc7147005f6cbfe4c566e0ffb60fca435b03fe6f`
  (equals `main` tip). `R1`–`R6` committed together as `a148095` and pushed; `git add -f` is still
  needed for `docs/` (ignored directory) on every later commit.
- Files changed this package: `tools/registry-compat.mjs` (new), `tools/registry-compat.d.mts`
  (new), `tools/rotate-lib.mjs`, `tools/rotate-lib.test.mjs`; under `writer/`: `src/config.ts`,
  `src/server.ts`, `src/index.ts`, `src/research/artifacts.ts`, `src/research/journal.ts`,
  `src/research/report.ts`; tests `config`, `server`, `research-end-to-end`, `research-report`,
  `research-events` (fixture records the registry fact). Plus this roadmap.
- What landed:
  1. `tools/registry-compat.mjs`: `registryCompatibility(champion, sources, markets)` is pure,
     plain JS, and returns one verdict per live market: `quarantined-underlying`,
     `unknown-underlying` (not in the champion clusters), `cluster-remapped` (live cluster differs
     from the champion's or the source registry's), `direction-unsupported` (anything but `up` or
     `down`), or compatible. Vault, coins, title, strike, and expiry are never inspected.
     `tools/rotate-lib.mjs` re-exports it so rotation preflight and writer startup share one
     function; `tools/registry-compat.d.mts` types it for the writer.
  2. `artifacts.ts`: `ArtifactModelMetadata.incompatibleMarkets: Map<vaultLower, reason>`;
     `parseCorrelationArtifact`'s profile identity check no longer includes the market registry
     hash; `validateArtifact` (the promotion path) pins `artifact.marketRegistrySha256` to the
     current profile explicitly, so `research-artifacts` tests are unchanged;
     `assertValidationArtifactIdentity` compares the validation's market registry hash to the
     artifact's only.
  3. `config.ts`: `loadConfig` records the booted registry with `recordMarketRegistryFact`
     inside the degrade path (a fact that exists with other bytes degrades the champion with
     `immutable market registry fact differs`), parses the champion without live markets, still
     asserts the champion's own snapshot, and fills `model.incompatibleMarkets` from the helper,
     logging `correlation-registry-incompatible` once at boot. `writerProfileIdentityFailure` no
     longer compares the market registry hash.
  4. `server.ts`: `correlationEligibility` returns `correlation-unavailable` for any ticket
     containing an incompatible market; single-underlying tickets are unaffected. Pair admission
     (quarantined pair, fallback needs both underlyings operator-approved) stays request-time here.
  5. `index.ts`: `/health.model` adds `championMarketRegistrySha256`, `liveMarketRegistrySha256`,
     and `incompatibleMarkets` for the `R9` activation smoke.
  6. `journal.ts`: the join asserts an immutable snapshot for every quote's registry hashes
     (schemaVersion 4: champion and live; schemaVersion 3: the single hash) and no longer compares
     them with the current profile.
  7. `report.ts`: `verified()` no longer passes live markets to the artifact parser;
     `verifiedQuote` asserts the quote's live snapshot (`market registry snapshot mismatch` when
     missing) instead of silently skipping; the champion block no longer requires the champion's
     registry to equal the live one, so a champion whose hash differs from its own candidate now
     throws `report champion candidate mismatch` rather than rendering `not promoted`.
- Regression evidence: `config.test.ts` proves a vault/coin/title/strike/expiry rotation keeps
  `multiAssetEnabled: true` with an empty incompatible map, distinct champion and live hashes, and
  both snapshots on disk; a remapped ETH, unknown DOGE, and band ETH market are refused locally
  while a `down` ETH market is accepted; a cluster-rotated BTC market is refused locally; a corrupt
  live fact degrades to the baseline and a deleted snapshot is restored only while live and
  champion registries coincide. `server.test.ts` refuses a ticket on a remapped market and prices an
  unrelated pair under the same model. `research-end-to-end.test.ts` continues after a cosmetic
  rotation: the champion stays, a new quote records the rotated live hash beside the unchanged
  champion hash, the join resolves the earlier quote, the report counts `quotes: 2 · minted: 1 ·
  resolved: 1`; an ETH cluster remap then refuses BTC+ETH with `400 correlation-unavailable` while
  BTC+SOL (operator-approved fallback) still prices. `research-report.test.ts` throws on a quote
  whose registry has no snapshot and counts one whose snapshot exists. `rotate-lib.test.mjs`
  pins the six verdicts and the source-disagreement case.
- Checks (working tree on `dc71470`; keeper and web untouched and not rerun):

  | Command | Exit | Exact result |
  |---|---:|---|
  | `cd writer && npm run check` (entry, before edits) | 0 | typecheck clean; `# tests 386 / # pass 386 / # fail 0` |
  | `node --test tools/rotate-lib.test.mjs` (entry) | 0 | `# tests 15 / # pass 15 / # fail 0` |
  | `node --test tools/rotate-lib.test.mjs` (regression before code) | 1 | `SyntaxError: ... does not provide an export named 'registryCompatibility'`; `# pass 0 / # fail 1` |
  | `cd writer && npx tsx --test test/config.test.ts test/server.test.ts test/research-report.test.ts test/research-end-to-end.test.ts` (regressions before code) | 1 | `# tests 80 / # pass 74 / # fail 6` (the intended reasons above) |
  | `cd writer && npm run typecheck` (after code) | 0 | clean |
  | `node --test tools/rotate-lib.test.mjs` | 0 | `# tests 16 / # pass 16 / # fail 0` |
  | `cd writer && npm run check` | 0 | typecheck clean; `# tests 387 / # pass 387 / # fail 0` |
  | `./scripts/verify.sh` | 0 | Solidity `172 tests passed, 0 failed`; research `# tests 182 / # pass 182 / # fail 0` |
  | `git diff --check` | 0 | no output |

- Decisions made: market-level compatibility lives in the shared helper and pair-level admission
  stays in `correlationEligibility`, both local to the ticket; promotion stays strict on the
  registry hash (a candidate is promotable only against the registry it was fitted on); a corrupt
  live-registry fact degrades the writer to the baseline rather than refusing to boot, matching the
  other identity failures; the report verifies snapshot existence and hash, not leg-by-leg
  reconciliation against the snapshot (report and journal fixtures use synthetic vaults);
  `tools/rotate-markets.mjs` is not wired to the helper yet because `R9` makes rotation staged and
  transactional, and the helper is exported ready for it. Two pre-`R6` tests that pinned the
  opposite behavior (whole-champion degradation on a cluster rotation; skip-on-foreign-registry
  in the report funnel) were rewritten to the Phase 5 contract; no gate was weakened. No
  canonical-plan change needed.
- Caveats to carry forward:
  1. The join and report now fail closed when any quote names a registry hash with no snapshot in
     `facts/market-registries/`. The box's band-era quotes predate `R1` snapshots; before `R11`
     enables join/report on the box, record each historical `registry/markets.json` (canonical
     JSON, from git history) as a fact or prune that history deliberately. Verify on the box first.
  2. `R5` caveat 1 is resolved by construction: a ticket with an underlying the champion does not
     know is refused before pricing, so a fallback-derived pair correlation never reaches a quote
     decision; `pairDecisions.status` already labels the champion's own fallback pairs.
  3. `writer/src/config.ts` imports `../../tools/registry-compat.mjs`; the writer must run from a
     checkout that includes `tools/` (the box's systemd unit does).
  4. The band-era `RHO_BAND_PCT` may still be set in the box's writer env; ignored, remove at `R11`.
  5. Byte identity remains per engine build (`R3` caveat 1).
- Decisions pending: none.
- Next action: execute `R7` only, in a fresh session. Its first check is `cd writer && npm run
  check` (expect 387/387 on the uncommitted tree) before touching replay resources.

## Copy-ready next-session prompt

> Continue `R7` from `docs/research/testnet-correlation-multivariate-roadmap.md`. Read `AGENTS.md`,
> the roadmap's Current execution state, Session protocol, `R7`, and Latest handoff, then the
> canonical plan's Phase 6 and the sections `R7` names.
> Work only on `R7`, add the smallest regressions first, run long checks in the foreground one at
> a time, show exact check output, update the roadmap handoff, and stop before `R8`. Do not mutate
> shared testnet/VPS state, add dependencies, access mainnet, or print secrets.
