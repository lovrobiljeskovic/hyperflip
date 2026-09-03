# Testnet Correlation Multivariate Implementation Plan

Updated: 2026-09-03

Status: approved implementation plan; implementation and production reactivation have not started.

Execution is divided into session-sized work packages in
`docs/research/testnet-correlation-multivariate-roadmap.md`. Use that roadmap to choose exactly one
package per session; this document remains the complete requirements reference.

## Objective

Replace the current lossy correlation fit with a deterministic, asset-specific signed Gaussian
factor model that preserves admitted evidence, supports mixed crypto and TradFi tickets, remains PSD
by construction, survives routine market rotation, and can be promoted and activated unattended.

Production remains on the static writer rollback described in
`docs/research/testnet-correlation-handover.md`. Removing that rollback is the final deployment step,
not an implementation shortcut.

## Accepted product scope

- Support up to ten distinct underlyings in one ticket.
- Initially model eleven registered underlyings across three clusters:
  - crypto: `BTC`, `ETH`, `SOL`, `HYPE`, `ZEC`;
  - equity: `NVDA`, `SP500`, `SNDK`, `TSLA`, `AAPL`;
  - commodity: `GOLD`.
- `ZEC` and `SP500` are currently measurement-disabled and may participate only through explicitly
  labeled, approved fallback evidence.
- The other nine underlyings are measurement-enabled, but a pair is direct evidence only when the
  normal freshness, synchronization, coverage, and sample gates pass.
- A rotating market for an already-supported underlying reuses that underlying's validated model
  when its cluster and direction semantics remain compatible.
- A genuinely new underlying or a taxonomy change requires a reviewed source/policy change and a
  fresh candidate. It must never silently inherit another asset's loadings.

## Confirmed failure mechanisms

1. `writer/src/research/calibration.ts` clips negative targets and gives all assets in a cluster the
   same global and cluster loading. The six measured crypto correlations consequently collapse to
   one runtime-implied value (`0.212225`).
2. The `0.10` Higham projection gate applies before the lower-dimensional runtime fit. The later fit
   residual is recorded but does not gate promotion.
3. The runtime correlation band checks only two scale endpoints. That is not a valid worst-case rule
   for three-or-more-leg mixed-direction tickets, and one of those integrations currently runs on
   the HTTP event loop.
4. Champion startup requires the historical candidate market-registry hash to equal the current
   live market-registry hash. Normal changes to vaults, coin IDs, titles, strikes, and expiries can
   therefore disable all multi-asset pricing.
5. The daily research pipeline validates candidates but does not promote, activate, smoke-check, or
   roll back automatically.
6. Replay repeats expensive prefix calculations and the complete computation twice. Hourly
   collection also creates per-source shards and republishes a complete rolling manifest every run.

## Non-negotiable boundaries

- Testnet only: no mainnet endpoints, data, profiles, deployments, or relabeling.
- Keep `maxProjectionError = 0.10`, `vMax = 0.99`, and the seven-day champion age limit unless the
  repository owner separately approves a policy change.
- Preserve immutable candidate, validation, manifest, return, exclusion, profile, source,
  deployment, baseline, promotion, quote, and operation evidence.
- Never manually edit a generated candidate or promote a `Rejected`, `Inconclusive`, stale,
  mismatched, or incomplete candidate.
- Never restart keeper for correlation candidate activation.
- Do not add dependencies without approval. Use the existing TypeScript and numerical machinery.
- Do not upload backups, spend money, mint, rotate shared markets, or mutate shared testnet/VPS
  state without separate explicit authorization.
- Never print secrets or include them in evidence.

## Policy checkpoint before producing a promotable candidate

The source documents intentionally did not choose every numerical statistical policy. The
repository owner approved the following fixed values on 2026-09-03 (`R0`); calibration may emit an
activation-eligible candidate only under exactly these values:

1. `maxDirectResidual = 0.05`, absolute on the correlation scale, applied to every admitted direct
   pair as `abs(rho_ij(B) - r_hat_ij) <= 0.05`. Rationale: half the approved `0.10` projection
   gate; catches the confirmed `0.2698` BTC/ETH runtime discrepancy with margin; by Plackett's
   identity a `0.05` correlation error moves a bivariate joint probability by at most about
   `0.009` absolute, inside the existing pricing edge.
2. Fisher intervals: record a two-sided unadjusted `95%` Fisher-z interval per admitted direct pair
   from its Kish effective sample size. The promotion gate uses the Bonferroni-adjusted
   simultaneous `95%` interval (`alpha = 0.05 / m`, `m` = number of admitted direct pairs) and
   rejects when `rho_ij(B)` lies outside that adjusted interval **or** rule 1 fails. Both the
   unadjusted and adjusted bounds, `m`, and the gate result are immutable per-pair evidence. Daily-
   mode pairs have much wider intervals, so rule 1 is expected to bind there; that asymmetry is
   intended.
3. Static fallback: each retained fallback value enters the weighted fit as a labeled point prior
   with fixed pseudo-sample weight `omegaFallback = 30` (not Fisher-derived), and an approved
   absolute residual range of `0.15`: `abs(rho_ij(B) - r_fallback_ij) <= 0.15`. A fallback pair
   outside its range is quarantined with reason `fallback-residual-out-of-range`, the fit is rerun
   without it until the admitted set is stable, and every fallback residual is recorded. Fallback
   evidence never satisfies a direct-pair gate and is never relabeled as measured.
4. Structural `u_i`: `u_i = sqrt(vMax - g_i^2 - c_i^2)` with `vMax = 0.99`, recorded with
   `underlyingBasis: "structural-underlying"`. It is a labeled structural prior for legs sharing one
   underlying, is excluded from every direct and fallback residual gate, and is never described as
   measured. Horizon-mismatch shrinkage between legs on one underlying is a separately approved
   future refinement, not part of this policy.

These are immutable candidate policy fields, not runtime environment switches. Changing any of them
requires fresh repository-owner approval and a new candidate.

## Ordered implementation

### Phase 0: establish a clean implementation base

1. Start a dedicated branch/worktree from the current mainline. The old
   `feature/testnet-correlation-system` branch has already landed and should not be treated as the
   integration base.
2. Preserve unrelated working-tree changes, including the existing handover edit and UI work.
3. Explicitly add this plan and the multivariate design/math documents when committing because the
   repository's `docs/` ignore rule otherwise hides new documentation.
4. Capture baseline outputs for the full gate matrix before editing.

Exit: clean scoped branch, baseline results recorded, no shared-state mutation.

### Phase 1: add regressions that expose the unsafe behavior

Add focused tests for:

- the six recorded crypto direct pairs being flattened to `0.212225`;
- negative direct evidence being clipped;
- the BTC-up/ETH-up/NVDA-down band counterexample whose interior probability exceeds both endpoints;
- signed loading parsing and conditional-mean use;
- compatible registry rotation changing only vault, outcome coin, title, strike, or expiry;
- incompatible underlying, cluster, and direction changes;
- an incompatible market failing locally without disabling unrelated eligible pairs; and
- old quote/report evidence remaining verifiable after a later rotation.

Exit: the new regressions fail for the intended reasons on the old implementation.

### Phase 2: version the immutable model and evidence

1. Introduce a new correlation artifact schema/model version for asset-specific signed loadings.
2. Add immutable policy fields for the approved direct residual, Fisher interval, fallback, and
   structural-underlying rules.
3. For every pair, record target/evidence type, effective sample size, reliability weight, confidence
   interval, fitted value, residual, and gate result.
4. Save the candidate-time market registry at
   `facts/market-registries/<marketRegistrySha256>.json` and verify its bytes during replay,
   promotion, startup, and reporting.
5. Version quote decisions to record both `championMarketRegistrySha256` and
   `liveMarketRegistrySha256`, plus an explicit point-model pricing mode.
6. Keep legacy artifacts and journals readable for historical evidence, but never activation-
   eligible under the new model. Do not rewrite historical bytes.

Exit: malformed, ambiguous, old-model, and identity-mismatched artifacts fail closed; historical
reports remain readable.

### Phase 3: implement one deterministic signed factor fitter

Create one shared fitter used by calibration and replay:

1. Sort sources and canonical pairs lexically.
2. Estimate direct correlations with the existing exponentially weighted estimator and calculate
   Fisher-z intervals from effective sample size.
3. Fit signed asset-specific `g_i` and `c_i` values using deterministic weighted least squares.
   Direct evidence uses its declared reliability weight; static fallback values enter only as weaker,
   labeled priors or approved ranges.
4. Resolve factor-sign ambiguity canonically so the same immutable inputs produce byte-identical
   loadings.
5. Enforce `g_i^2 + c_i^2 + u_i^2 <= vMax` for every underlying.
6. Construct `R = B * transpose(B) + D`, where `D[i,i] = 1 - ||B[i]||^2`.
7. Verify finite values, symmetry, unit diagonal, non-negative residual variance, Cholesky/eigenvalue
   PSD, and deterministic output.
8. Reject when any admitted direct pair fails either its approved Fisher interval or
   `maxDirectResidual`. Record fallback residuals honestly and quarantine pairs outside their approved
   bounds.

Higham projection remains an independent diagnostic for incompatible input evidence; it must not
repair the fitted runtime model.

Exit: the six-pair regression retains distinct positive, near-zero, and negative fitted behavior;
all pair and matrix gates pass.

### Phase 4: replace the live pricing path with one point-model worker call

1. Accept signed global/cluster loadings while retaining the variance ceiling and finite checks.
2. Remove `RHO_BAND_PCT` pricing and all claims that two endpoints bound multivariate uncertainty.
3. Price exactly one validated point factor model. Keep existing edge and exposure caps as the live
   risk margin.
4. Route every nontrivial Gaussian integration through `CorrelationWorker`, including repeated-
   underlying tickets. The HTTP event loop must not perform an integration first.
5. Canonically order resolved legs before building the factor tree.
6. Preserve exact behavior for duplicate same-side legs and impossible opposite-side legs on one
   market.
7. Keep the quadrature cost ceiling, worker queue ceiling, timeout, and fast `ticket-too-complex`
   refusal.

Required runtime matrix:

- mixed directions with 2, 3, 4, 5, 6, and 10 distinct underlyings;
- crypto-only, TradFi-only, and mixed-cluster tickets;
- leg-order permutation invariance;
- one-leg and independent-product marginal checks;
- repeated-underlying admissible and over-budget shapes; and
- worker timeout/error recovery without blocking health or another request.

Exit: one worker-computed point probability drives pricing and evidence; no band path remains.

### Phase 5: separate immutable provenance from live registry compatibility

Implement one compatibility function shared by writer startup and rotation preflight:

1. Verify the champion against its original market-registry snapshot and all other immutable
   candidate/validation identities.
2. Compare the live registry separately against the champion taxonomy:
   - underlying is present and eligible;
   - cluster mapping is unchanged;
   - direction semantics are supported;
   - requested pair is admitted; and
   - fallback use remains explicitly eligible.
3. Allow vault address, outcome coin, title, strike, and expiry changes without recalibration.
4. Reject an unknown/remapped market or pair locally. Do not set the whole champion unavailable when
   unrelated markets remain compatible.
5. Validate reports and joins using the quote's immutable live-registry snapshot rather than the
   registry that happens to be current when a report is generated.

Exit: a normal nightly rotation retains multi-asset pricing; incompatible inputs fail closed at the
smallest affected boundary.

### Phase 6: bound replay and storage growth

1. Pass the existing alignment cache through every applicable calibration and replay calculation.
2. Replace repeated exponentially weighted prefix scans with tested streaming recurrences, including
   irregular timestamps and 180-day window expiration.
3. Cache aligned rows, cumulative moments, residual series, stress inputs, and origin-scoped fits.
4. Retain two genuine deterministic computations, sharing only immutable preprocessing rather than a
   cached final answer.
5. Measure and enforce wall time and peak RSS. Meet the current declared 30-second/512-MiB policy or
   obtain explicit approval to reconcile that policy with measured systemd limits before unattended
   execution.
6. Write one immutable collection-batch shard and provenance record per hourly run, containing all
   successful sources.
7. Publish the rolling content-addressed manifest once at the start of the daily pipeline, not after
   every hourly collection.
8. Measure file count, manifest bytes, daily verification time, and backup traversal. Do not add a
   database or manifest DAG unless this simpler design still exceeds an approved budget.

Exit: replay fits enforced service limits with margin and storage growth is measured after the two
simple reductions.

### Phase 7: make promotion, activation, and rotation transactional

Change the scheduled daily sequence to:

```text
publish manifest -> derive -> calibrate -> replay
                                      |
                              fixed gates pass?
                            yes              no
                   preserve old champion   retain old champion
                   promote exact candidate record failure + alert
                   restart writer only
                   health/identity/quote smoke
                   keep or restore old champion
                   join -> report
```

Requirements:

1. Promotion preserves the displaced champion bytes/hash and writes existing verification,
   promotion, and operation receipts before switching `champion.json` atomically.
2. Activation restarts writer only. It verifies writer/caddy/keeper health, expected model and hashes,
   `multiAssetEnabled: true`, current `/markets`, and a controlled cross-underlying quote without
   minting.
3. Any activation failure restores the prior champion/release and restarts writer back onto it.
4. A failed scheduled candidate never replaces a still-valid champion. It emits a structured stage
   failure and leaves the existing writer running.
5. Registry rotation stages the complete new registry, runs the shared compatibility check, and
   atomically switches only after validation.
6. Partial deployments are written to an immutable recovery receipt so a failed rotation neither
   loses landed vaults nor exposes a half-built registry.
7. Preserve the prior registry for automatic restoration after failed service smoke checks.
8. Install and monitor collector and daily timers only after their resource gates pass. Backup upload
   and timer enablement remain a separate authorization boundary.

Exit: fixture/integration tests prove successful activation, rejected candidate retention, failed
smoke rollback, compatible rotation, incompatible rotation rejection, and crash recovery.

### Phase 8: full local gate at one commit

Run and retain exact output from:

```bash
forge build
forge test
cd writer && npm run check && npm run research:check
cd ../keeper && npm run check
cd ../web && npm run check
cd .. && node --test tools/rotate-lib.test.mjs
./scripts/verify.sh
git diff --check
```

Also run the focused model, worker, rotation, activation, historical-evidence, resource, and storage
tests added above. Red gates stop deployment and must be reported plainly.

Exit: every relevant gate is green at the exact reviewed commit.

### Phase 9: separately approved testnet reactivation

This phase mutates shared VPS/testnet state and requires fresh explicit approval.

1. Reconfirm chain `998`, testnet profile and Info host, deployment identities, anchored persistence,
   disk/ownership, current service health, rollback override, and preserved rollback release.
2. Deploy the reviewed writer code without changing keeper, contracts, web, waitlist data, or the
   research root.
3. Run a fresh bounded testnet collection/derive/calibrate/replay/report flow using the new schema.
4. Require `Supported`, deterministic rerun equality, all direct-fit/PSD/resource gates, and exact
   immutable identities.
5. Promote the exact candidate and preserve the prior champion/release.
6. Save the current rollback override contents, remove only
   `/etc/systemd/system/writer.service.d/rollback.conf`, run `systemctl daemon-reload`, and restart
   writer only.
7. Require healthy writer/caddy/keeper state, expected champion and both registry hashes,
   `multiAssetEnabled: true`, current `/markets`, and a successful controlled cross-underlying public
   quote without minting.
8. On any failure, recreate/retain the override, restore the prior champion/release, restart writer,
   and record the failed stage.
9. Keep the staged static release recoverable until one natural rotation and one scheduled daily
   cycle succeed. Deleting it is a later explicit cleanup action.
10. Restore the UI correlation-evidence badges only after the new quote evidence contract is stable
    and verified; the existing fair/correlated odds math may continue consuming `jointProbWad`.

## Definition of done

The rollback may be called removed only when all of the following are true:

- a fresh new-schema candidate is `Supported` and deterministic;
- every admitted direct pair passes its approved confidence and residual gates;
- the factor correlation matrix is PSD by construction and independently verified;
- point pricing works for the required 2-through-10-underlying matrix without blocking HTTP;
- compatible rotation preserves champion availability and incompatible inputs fail locally;
- immutable historical and current evidence validates with separate champion/live registry hashes;
- unattended promotion, smoke checking, and automatic restoration are proven;
- replay and storage fit enforced operational budgets;
- the full repository gate is green at the deployed commit; and
- the live writer passes identity, health, markets, and cross-underlying quote smoke checks after the
  rollback override is removed.

This does not prove mainnet validity or profitability, and it does not require waiting for settlement.

## New-session prompt

> Continue the current work package in
> `docs/research/testnet-correlation-multivariate-roadmap.md`. Read its Current execution state,
> Session protocol, and only the selected work-package section, then read the corresponding
> requirements in `docs/research/testnet-correlation-multivariate-implementation-plan.md`.
> First read `AGENTS.md`, `docs/research/testnet-correlation-handover.md`,
> `docs/research/testnet-correlation-verification.md`,
> `docs/research/testnet-correlation-multivariate-improvements.md`, and
> `docs/research/testnet-correlation-multivariate-math.md`. Production is still assumed to be on the
> static rollback until reverified. Keep all work testnet-only, preserve immutable evidence, do not
> add dependencies or mutate shared testnet/VPS state without approval, and never restart keeper for
> correlation activation. Do not begin the next work package. Update the roadmap handoff before
> ending the session. Stop before producing a promotable candidate if the statistical policy
> checkpoint is not approved.
