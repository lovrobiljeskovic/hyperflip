# Testnet Correlation Multivariate Improvement Handoff

Updated: 2026-09-01

Status: design and investigation only; no implementation from this document has been applied.
Production remains on the static rollback described in
`docs/research/testnet-correlation-handover.md`.

Mathematical definitions and derivations are collected in
`docs/research/testnet-correlation-multivariate-math.md`.

## Decision

The product must support tickets with more than two distinct underlyings. The target is ten distinct
underlyings, with five to six as the minimum acceptable boundary. A pairwise-only product restriction
is therefore rejected.

Keep the sparse hierarchical Gaussian factor copula, but replace the current uniform-per-cluster fit
with asset-specific signed factor loadings. The resulting correlation matrix must be positive
semidefinite by construction, and promotion must prove that the fitted runtime model still represents
the admitted direct-pair evidence.

Do not reactivate the champion path until the rotation-compatibility incident in the main handover and
the model-fit and uncertainty findings below are resolved.

## Current relevant settings

- Active data window: 180 days.
- Exponential half-life: 45 days.
- Minimum hourly/daily observations: 1,000/90.
- Minimum coverage: 80%.
- Candidate projection-error gate: 0.10.
- Champion maximum age: seven days.
- Replay: 20,000 draws, 24-hour origin stride, 2,000 bootstrap samples in 96-hour blocks.
- Runtime correlation uncertainty default: `RHO_BAND_PCT=0.2`.
- Runtime quadrature ceiling: 4,000,000 points.
- Correlation worker: queue 16, timeout 1,000 ms.
- Quote request maximum: ten legs.

The actual deployed environment may override repository defaults; do not print or copy environment
secrets while confirming public numeric settings.

## Evidence requiring correction

### 1. The runtime fit does not preserve direct-pair evidence

The supported candidate records these six measured crypto correlations:

| Pair | Direct correlation | Current runtime-implied correlation |
|---|---:|---:|
| BTC/ETH | `0.4820301407807348` | `0.212225` |
| BTC/HYPE | `-0.035233305987373204` | `0.212225` |
| BTC/SOL | `0.38379767563644` | `0.212225` |
| ETH/HYPE | `-0.007088306614043628` | `0.212225` |
| ETH/SOL | `0.40257857652651635` | `0.212225` |
| HYPE/SOL | `0.006721482766762755` | `0.212225` |

This reconstruction used the recorded direct values, the checked-in baseline, the four recorded ZEC
quarantines, and the current `fitHierarchical` implementation. The current fitter assigns one global
loading and one loading per cluster, so all distinct members of a cluster receive the same implied
correlation.

The 0.10 projection gate only measures movement needed to make the assembled pair matrix PSD. It does
not constrain the later error introduced by the lower-dimensional runtime factor fit. A candidate can
therefore pass projection and replay while its live pair correlations differ materially from its own
direct evidence.

### 2. The fixed correlation-band endpoint rule is not valid for general multivariate tickets

Runtime pricing evaluates only loading scales `1 - band` and `1 + band`, then takes the higher joint
probability. For two variables, the direction-adjusted bivariate Gaussian probability is monotone in
correlation, so an endpoint is sufficient. For mixed-direction events with three or more variables,
the probability need not be monotone along this scale.

A counterexample using the checked-in correlation table is:

- BTC up with marginal probability 0.85;
- ETH up with marginal probability 0.50; and
- NVDA down with marginal probability 0.30.

| Loading scale | Joint probability |
|---:|---:|
| 0.80 | `0.137117320390844` |
| 0.95 | `0.13770786042946592` |
| 1.20 | `0.13717848214066466` |

The interior value exceeds both endpoints. The current result described as house-favorable can
therefore understate joint probability and overpay. The existing endpoint test proves only that the
larger endpoint is returned, not that either endpoint maximizes the interval.

The fixed relative band is also not a statistical confidence interval. In particular, it gives a
negligible uncertainty range to correlations near zero even when their sampling uncertainty is not
negligible.

### 3. Ten distinct underlyings are computationally feasible in the existing sparse tree

A local point-estimate benchmark using ten distinct checked-in underlyings, multiple clusters, and
mixed directions completed successfully in about 11 ms on the development machine. This is a single
local measurement, not a production latency SLA, but it establishes that distinct-underlying count is
not the current integration bottleneck.

Repeated markets on the same underlying introduce the deeper underlying-factor nesting and are more
likely to hit the quadrature budget. Admission and benchmarking should therefore be based on factor
tree cost, not merely leg or distinct-underlying count.

### 4. Replay and immutable storage need bounded-growth work before unattended operation

- Replay calls the complete deterministic computation twice in the same process. The recorded live
  run took about 56 minutes and roughly 400 MiB RSS, while the validation artifact reports a nominal
  30-second resource policy.
- Filtered historical simulation repeatedly recomputes exponentially weighted statistics over
  growing prefixes, producing roughly quadratic work where an exact linear recurrence is available.
- Hourly collection writes a shard plus provenance per successful source and republishes a complete
  180-day content-addressed manifest each hour. At steady state this duplicates tens of thousands of
  manifest entries thousands of times per year.
- Backup traverses and verifies every retained historical manifest closure, compounding the manifest
  duplication.

Do not add a database solely for these problems. First fix computation reuse, shard granularity, and
manifest publication frequency.

## Target correlation model

For each underlying `i`, fit signed asset-specific loadings:

- `g_i`: loading on the global factor;
- `c_i`: loading on the factor for the underlying's cluster; and
- optionally `u_i`: loading on an underlying-specific factor used when multiple markets share the
  underlying.

For distinct underlyings `i` and `j`, the implied return correlation is:

```text
rho(i,j) = g_i * g_j
           + sameCluster(i,j) * c_i * c_j
```

For repeated markets on one underlying, the shared underlying term is also present.

Let `B` contain the global, cluster, and underlying factor loadings, and let:

```text
D[i,i] = 1 - ||B[i]||^2
```

with every `D[i,i] >= 0`. The model correlation matrix is:

```text
R = B * transpose(B) + D
```

For every vector `x`:

```text
x' R x = ||transpose(B) * x||^2 + sum(D[i,i] * x[i]^2) >= 0
```

The matrix is therefore PSD by construction for two, six, ten, or more underlyings. Higham projection
should remain only as an independent diagnostic or bug detector, not as routine model repair.

The artifact format already stores loadings per underlying. The current parser and fallback builder
assume non-negative loadings and must be updated deliberately if signed factor loadings are adopted.
The numerical factor integration already squares loadings for residual variance and uses their signed
value in conditional means, so validate that path with explicit negative-loading tests rather than
creating a second pricing engine.

## Calibration policy

1. Build direct pair estimates from the existing synchronized, freshness-gated return samples.
2. Derive statistical uncertainty from Fisher-z intervals using the recorded effective sample size.
3. Treat reviewed static fallback values as labeled priors or approved ranges, not exact pair entries
   spliced into a measured matrix.
4. Fit the sparse global-plus-cluster loading model directly. A deterministic weighted low-rank fit is
   sufficient; do not introduce a general optimization dependency without evidence it is needed.
5. Record every target, weight, implied value, confidence interval, and residual.
6. Fail the candidate when admitted direct evidence cannot be represented within its approved
   statistical interval or residual threshold.
7. Verify the constructed matrix independently with Cholesky/eigenvalue checks.
8. Replay using the exact same artifact interpretation and Gaussian pricing implementation used by
   live quotes.

Fallback evidence currently dominates pair count: the supported candidate has six direct pairs,
45 retained static fallbacks, and four quarantines. Reports and product claims must continue to state
that boundary plainly.

## Runtime uncertainty policy

Remove the claim that the current fixed `RHO_BAND_PCT` endpoint maximum is robust for multivariate
tickets.

The minimal runtime should quote the validated point factor model and leave the existing explicit
pricing edge and exposure caps as the risk margin. If parameter uncertainty must affect live prices,
the next bounded option is a small deterministic set of bootstrap-derived factor scenarios with the
maximum joint probability taken across that declared set. That guarantee applies only to the scenario
set; do not describe it as a continuous worst-case bound.

Do not add a continuous robust optimizer until it has a defined uncertainty set, a global-optimum
argument, and measured need.

## Runtime and performance work

1. Return point pricing from the correlation worker so numerical integration never blocks the HTTP
   event loop.
2. Retain the quadrature cost gate and test actual tree shapes.
3. Require successful mixed-direction pricing for 2 through 10 distinct underlyings.
4. Separately test repeated-underlying shapes; refusal remains acceptable when a shape exceeds the
   proven quadrature budget.
5. Pass the existing `CalibrationAlignmentCache` through calibration and diagnostic calculations.
6. Replace repeated exponentially weighted prefix scans with the exact recurrence:

   ```text
   weightSum = decay * weightSum + 1
   valueSum  = decay * valueSum  + value
   squareSum = decay * squareSum + value * value
   ```

   This preserves the estimator while reducing prefix statistics from quadratic to linear work.
7. Cache aligned rows, residual series, cumulative samples, and stress inputs per origin and
   underlying set rather than rebuilding them per ticket.
8. Reconcile the validation resource policy, systemd CPU quota, and timeout with measured replay
   behavior before installing unattended timers.

## Storage work

Apply the first two reductions before designing a database or Merkle structure:

1. Write one immutable collection-batch shard containing all successful source rows from an hourly
   run, with one batch provenance record.
2. Publish the rolling research manifest once in the daily pipeline instead of after every hourly
   collection.

Then measure file count, manifest bytes, daily verification time, and backup traversal. Introduce
daily child manifests or a hash-linked manifest DAG only if the measured daily design still exceeds
the operational budget. Preserve immutable candidate and validation closures; do not delete existing
research evidence as part of this optimization.

## Rotation-compatible activation remains required

Model provenance must retain the exact market-registry snapshot used during candidate production, but
runtime compatibility must be evaluated separately against stable taxonomy:

- underlying;
- cluster;
- direction semantics; and
- champion pair/underlying eligibility.

Compatible changes to vault addresses, outcome coin IDs, expiries, and titles must not require
recalibration. Unknown or remapped inputs fail closed locally without disabling unrelated eligible
pairs. Record both champion and live registry identities in quote evidence. Stage registry rotation
and writer activation atomically, and retain automatic rollback after smoke checks.

## Acceptance criteria

Before champion reactivation:

- [ ] Rotation compatibility is separated from immutable candidate provenance.
- [ ] Asset-specific signed loadings replace uniform cluster loadings.
- [ ] The constructed correlation matrix is PSD by construction and independently verified.
- [ ] Every admitted direct pair passes the statistical fit-residual gate.
- [ ] Static fallback use remains explicit and bounded.
- [ ] The invalid fixed-band robustness claim is removed or replaced by a declared scenario policy.
- [ ] Mixed-direction tickets with 2, 3, 4, 5, 6, and 10 distinct underlyings pass correctness and
      latency checks.
- [ ] Permutation of ticket leg order does not change the result.
- [ ] Marginal probabilities are preserved.
- [ ] Duplicate and opposite-side same-market behavior remains exact.
- [ ] Over-budget repeated-underlying shapes fail quickly without blocking the HTTP event loop.
- [ ] Replay uses the exact live model and remains deterministic from immutable inputs.
- [ ] Replay wall time and peak RSS fit enforced service limits with margin.
- [ ] Storage and backup growth are measured after batch shards and daily manifests.
- [ ] Automatic promotion, activation, smoke checking, and rollback satisfy the main handover.
- [ ] Relevant typecheck, writer/research tests, and repository gates pass at the same commit.

## Suggested implementation order

1. Add regression tests for the direct-pair fit discrepancy and the multivariate band interior
   counterexample.
2. Add the direct-pair fit-residual gate so the current lossy fit fails honestly.
3. Implement and validate asset-specific signed factor fitting with PSD-by-construction output.
4. Remove the fixed-band pricing path and price one validated point model in the worker.
5. Add the 2-through-10-distinct-underlying correctness and cost matrix.
6. Optimize replay using exact recurrences and existing caches.
7. Reduce collection shards and manifest publication frequency.
8. Implement rotation-compatible activation and the unattended promotion/smoke/rollback transaction.
9. Run the full local gate matrix, then perform only separately approved testnet deployment work.

## New-session start prompt

> Continue the multivariate testnet correlation redesign from
> `docs/research/testnet-correlation-multivariate-improvements.md`. Read the main correlation handover
> and verification record first. Production is still on the static rollback. The product must support
> up to ten distinct underlyings; pairwise-only pricing is not acceptable. Begin with regression tests
> for the runtime fit discrepancy and the mixed-direction correlation-band counterexample, then
> implement the smallest PSD-by-construction asset-specific signed factor model with a statistical
> direct-pair residual gate. Preserve immutable evidence, testnet-only boundaries, and
> rotation-compatible activation. Do not access mainnet, weaken gates, restart keeper, upload backups,
> print secrets, or mutate shared production state without explicit authorization.

Read in this order:

1. `AGENTS.md`
2. `docs/research/testnet-correlation-handover.md`
3. `docs/research/testnet-correlation-verification.md`
4. `docs/research/testnet-correlation-multivariate-improvements.md`
5. `docs/research/testnet-correlation-multivariate-math.md`
6. `writer/src/research/calibration.ts`
7. `writer/src/research/matrix.ts`
8. `writer/src/correlation.ts`
9. `writer/src/copula.ts`
10. `writer/src/correlationWorker.ts`
11. `writer/src/research/replay.ts`
