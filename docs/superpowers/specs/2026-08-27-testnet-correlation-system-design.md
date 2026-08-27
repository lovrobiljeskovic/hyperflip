# Testnet Evidence-Based Correlation System

**Status:** Approved brainstorming design; implementation plan intentionally deferred
to a new orchestrator session.

**Date:** 2026-08-27

**Repository baseline:** `d10ba86`

**Companion artifacts:**

- [`docs/research/correlation-research-history.html`](../../research/correlation-research-history.html)
  records the research and decision history.
- [`docs/research/correlation-research-facts.json`](../../research/correlation-research-facts.json)
  preserves the factual claims, measured values, citations, and caveats used by
  this design.

## 1. Executive decision

Build a low-cost, evidence-based correlation pipeline for the HyperEVM testnet
beta, capped at 20 underlyings. The pipeline will use free mainnet HyperCore
hourly candle history to calibrate a versioned correlation artifact, while the
existing writer continues to use live testnet outcome books for marginal leg
prices.

The beta is an operational and statistical replay proof. It is not evidence of
mainnet profitability because testnet books, user incentives, and resolution
counts do not reproduce a real-money market.

The first live beta champion remains the existing hierarchical Gaussian factor
copula, but its hand-set loadings are replaced by measured, shrunk loadings. A
signed-correlation t-copula runs offline as a challenger. Filtered historical
simulation remains a stress challenger. A challenger is promoted only after
walk-forward evidence justifies the additional production complexity.

The design adds no Solidity changes, no paid data provider, and no live research
database dependency. Expected incremental infrastructure cost is USD 0-20 per
month using the existing fixed-price VPS and free object-storage allowance.

## 2. Goals

1. Replace hypothesis-only factor loadings with reproducible financial data.
2. Prove that collection, calibration, artifact promotion, quote recording, and
   realized evaluation work end to end on testnet.
3. Compare a measured champion, the existing hand-set baseline, and richer
   challengers without putting an unvalidated model in the signing path.
4. Make every returned signed quote reproducible from durable inputs.
5. Preserve hard facts and research decisions outside conversational context.
6. Keep the beta within 20 underlyings and USD 0-20/month incremental
   infrastructure cost.
7. Fail conservatively when data, mappings, or artifacts are missing or stale.

## 3. Non-goals

1. Proving production profitability, adverse-selection resistance, or mainnet
   liquidity behavior from testnet results.
2. Running a HyperCore archival node or recording every L1 block/order-book
   update.
3. Buying institutional real-time equity, commodity, or options feeds.
4. Building a managed data warehouse, public analytics API, or live dashboard.
5. Changing `ParlayVault`, `OutcomeVault`, keeper settlement semantics, escrow,
   or quote EIP-712 types.
6. Automatically promoting a candidate model without an explicit operator
   review during beta.
7. Treating price-level correlation or raw outcome-book co-movement as asset
   return correlation.

## 4. Existing system and invariants

### 4.1 HyperEVM is contract truth

`ParlayVault` verifies a signed quote, escrows the taker's premium plus the
writer's full risk, and emits `ParlayMinted`. Resolution and payouts are driven
by `OutcomeVault` settlement state. The model is deliberately off-chain and the
contract is quote-model agnostic.

The writer allowance remains the hard solvency ceiling. Correlation work must
not weaken allowance, per-market, per-cluster, freshness, dominance, or
complexity gates.

### 4.2 HyperCore supplies live marginal prices

The writer obtains a depth-covering outcome ask from `l2Book`. On testnet, it may
fall back to the live `0x808` outcome price under the existing testnet freshness
policy. Correlation calibration must not replace or block this live path.

### 4.3 Historical EVM calls cannot reconstruct HyperCore history

The repository has empirically established that pinned `eth_call` requests to
HyperCore precompiles can return live Core state instead of historical Core
state. A HyperEVM archive RPC is useful for mints and settlements, but it is not
a historical HyperCore price source.

### 4.4 Current writer interface

`writer/src/config.ts` loads `registry/correlations.json`. The file contains
non-negative `global`, `cluster`, and `underlying` loadings. Pairwise dependence
is produced by products of shared loadings, and `RHO_BAND_PCT` evaluates a
house-favorable uncertainty endpoint.

The beta should preserve that interface for the first live champion. Metadata
may be added beside `clusters`; the current parser reads `clusters` and ignores
unrelated top-level metadata.

## 5. Architecture

```text
Mainnet HyperCore candleSnapshot
             |
             v
      Candle collector --------> immutable candle partitions
             |                              |
             |                              v
             |                       daily calibrator
             |                        /      |      \
             |               baseline   champion   challengers
             |                              |
             |                        validation report
             |                              |
             |                      manual promotion gate
             |                              |
Testnet l2Book/0x808 -----------------> writer + champion artifact
                                             |
                                      durable quote journal
                                             |
Testnet HyperEVM ParlayMinted/Resolved ------+
                                             |
                                      realized evaluation
                                             |
                                      HTML research report
```

The architecture has two deliberately separate paths:

- **Live quote path:** current testnet book/precompile reads plus a local,
  previously approved artifact. It has no QuickNode, external market-data, or
  calibration service dependency.
- **Research path:** public historical candles, append-only files, daily batch
  calibration, replay, and reports. Failure here leaves the last approved live
  artifact untouched.

## 6. Components

### 6.1 Underlying source registry

A source registry maps at most 20 logical underlyings from
`registry/markets.json` to mainnet HyperCore candle coins.

Required fields:

```json
{
  "schemaVersion": 1,
  "underlying": "BTC",
  "sourceNetwork": "mainnet",
  "sourceCoin": "BTC",
  "cluster": "crypto",
  "calendar": "continuous",
  "eligible": true
}
```

HIP-3 coins must include the documented DEX prefix. Mapping is explicit; the
collector must never guess a coin from display text. A registry rotation may add
a new underlying only while the distinct active set remains at or below 20.

Eligibility requires:

- an explicit source coin and cluster;
- an economically comparable underlying and settlement reference;
- sufficient synchronized history under Section 8;
- no unresolved symbol migration, corporate action, or stale-price condition.

An ineligible asset remains visible in the market registry but is denied for
multi-asset slips by a quarantine gate before correlation lookup. The existing
cluster fallback may be used only when the source-registry entry explicitly sets
`fallbackEligible: true` after operator review; an unknown asset never becomes
quotable merely because the writer can compute a fallback.

### 6.2 Candle collector

The collector calls the public mainnet `candleSnapshot` endpoint at one-hour
resolution. The initial request asks for the most recent 5,000 candles per
underlying, which provides about 208 days of hourly history. Thereafter it runs
hourly and requests only the gap since the last durable candle.

Collector rules:

1. Use candle open time plus `(sourceNetwork, sourceCoin, interval)` as the
   idempotency key.
2. Never overwrite a differing observation silently. Quarantine the conflict and
   surface it in the next report.
3. Preserve source values as strings in the raw partition. Convert to numeric
   values only in derived calibration inputs.
4. Store retrieval time, requested range, and HTTP outcome.
5. Retry transient failures with bounded backoff; the next run must backfill the
   gap from the last durable timestamp.
6. Do not share a failure budget with the testnet writer's live Info API calls.
7. Reject observations with invalid OHLC ordering, non-finite values, duplicate
   conflicting timestamps, or time moving backward.

Normalized candle record:

```json
{
  "schemaVersion": 1,
  "source": "hyperliquid-info",
  "sourceNetwork": "mainnet",
  "underlying": "BTC",
  "sourceCoin": "BTC",
  "interval": "1h",
  "openTimeMs": 1787788800000,
  "closeTimeMs": 1787792399999,
  "open": "1.0",
  "high": "1.0",
  "low": "1.0",
  "close": "1.0",
  "volume": "0.0",
  "tradeCount": 0,
  "retrievedAtMs": 1787792500000
}
```

The numeric strings above illustrate schema shape, not factual market values.

### 6.3 File-based facts store

Beta storage is append-only and file-based. No PostgreSQL or managed warehouse
is required.

Recommended production-box layout:

```text
/opt/hype/research/
  raw/candles/YYYY/MM/DD/*.jsonl.gz
  derived/returns/YYYY/MM/DD/*.jsonl.gz
  journal/quotes/YYYY/MM/DD.jsonl
  journal/events/YYYY/MM/DD.jsonl
  artifacts/candidates/*.json
  artifacts/champion.json
  manifests/*.json
  reports/*.html
  state/collector.json
```

This directory must not be deleted by the existing deployment rsync or nightly
market rotation. Local files are backed up daily to an off-box S3-compatible
bucket. Secrets, invite codes, and private keys never enter facts, manifests, or
reports.

Every daily manifest contains file paths, byte lengths, SHA-256 hashes, source
range, row count, earliest/latest timestamps, missing intervals, and schema
versions. A model artifact references the exact manifest hash it used.

### 6.4 Return builder and data-quality gate

Use log returns, never correlations of price levels.

- Crypto-to-crypto dependence uses synchronized one-hour returns.
- Same-session equity/commodity dependence uses intervals where both sources are
  active and non-stale.
- Cross-session and cross-cluster dependence uses settlement-aligned daily
  returns so closed-market stale candles are not interpreted as zero returns.
- Missing intervals remain missing. They are not forward-filled into returns.
- A zero-volume repeated close is treated as stale for non-continuous assets
  unless its source metadata proves it was an active, unchanged interval.

Each calibration input stores the exact assets, timestamps, transformations,
excluded rows, and exclusion reasons.

Minimum beta sample requirements:

- 1,000 synchronized hourly observations for an hourly within-cluster estimate;
- 90 synchronized daily observations for cross-session or cross-cluster
  estimates;
- at least 80% coverage of the expected observations in the selected window.

Below these thresholds, the exact pair is not directly estimated. The model must
shrink to an eligible cluster/global estimate or mark the combination
unquotable; it must not extend to an economically incompatible proxy merely to
reach a sample count.

### 6.5 Champion calibrator

The live beta champion is the current hierarchical Gaussian factor model with
measured loadings.

Calibration policy:

- Active history: most recent 180 days.
- Exponential half-life: 45 days.
- Diagnostics: unweighted 30-, 90-, and 180-day correlations.
- Older captured observations: retained for stress/research, not equally
  weighted into the current estimate.
- Slow one-year anchor: omitted during the no-cost beta because the public
  endpoint exposes only 5,000 recent candles; cluster shrinkage is the beta
  stabilizer.

Loadings are obtained by fitting the current non-negative hierarchical factor
form to the shrunk empirical target matrix under the existing explained-variance
cap. The fit must output:

- target pairwise correlations;
- factor-implied pairwise correlations;
- residual/error per pair;
- the maximum absolute projection error;
- any target correlation clipped because the current model cannot represent it;
- the nearest valid positive-semidefinite target used for challenger simulation.

The existing model cannot represent a negative base correlation between two
different underlyings because loadings are constrained to `[0, 1]`. The beta
must not conceal this. Negative targets are recorded, their live champion
projection is zero or the nearest valid non-negative fit, and the signed-matrix
challenger retains them. Material clipping is a reason not to promote the
champion beyond beta.

For multiple markets on the same underlying, the underlying factor represents
their shared price driver. Its loading may use the remaining variance under the
0.99 explained-variance ceiling, but the artifact must record that this value is
structural rather than an independently observed second return series.

### 6.6 Challengers

#### Signed t-factor copula

The offline t-copula challenger consumes the shrunk positive-semidefinite signed
correlation matrix and fitted degrees of freedom. It exists to test:

- negative cross-asset dependence;
- fat-tailed joint moves;
- whether the Gaussian champion understates joint extremes.

It is report-only in the first beta stage. It cannot sign quotes until the writer
has a separately approved implementation design and replay evidence passes the
promotion gate.

#### Filtered historical simulation

Filtered historical simulation replays standardized residual vectors scaled by
current volatility. It is a challenger and stress model, not the first live
quote engine. It highlights empirical joint moves and model misspecification,
but sparse tails prevent it from being the sole estimator of rare multi-leg
probabilities.

### 6.7 Model artifact and promotion

Candidate artifact shape:

```json
{
  "schemaVersion": 1,
  "modelVersion": "2026-08-27.1",
  "modelFamily": "hierarchical-gaussian-factor",
  "createdAt": "2026-08-27T00:00:00.000Z",
  "dataAsOf": "2026-08-26T23:00:00.000Z",
  "dataManifestSha256": "...",
  "policy": {
    "lookbackDays": 180,
    "halfLifeDays": 45,
    "diagnosticWindowsDays": [30, 90, 180]
  },
  "quality": {
    "eligibleUnderlyings": [],
    "quarantinedUnderlyings": [],
    "maxProjectionError": 0.0,
    "clippedNegativePairs": []
  },
  "validation": {},
  "clusters": {}
}
```

Promotion is manual during beta:

1. Daily calibration writes a new immutable candidate.
2. Replay and schema validation write a report beside it.
3. An operator reviews coverage, projection loss, model scores, quarantines, and
   the manifest hash.
4. Promotion atomically replaces `/opt/hype/research/artifacts/champion.json`.
5. The writer is restarted or explicitly reloaded using the repository's normal
   deployment procedure.
6. Startup logs the model version and data-as-of timestamp.

Candidate creation must never overwrite the champion. A failed promotion leaves
the previous champion byte-for-byte intact.

### 6.8 Writer integration and quote journal

The writer continues its current flow through settled-state checks, live leg
price reads, joint probability, edge, dominance, exposure, and signing.

The correlation change is limited to loading an approved artifact rather than a
hand-edited table. No historical provider or calibration job is called from
`handleQuote`.

After signing but before returning HTTP 200, the writer durably appends a quote
decision. If the append fails, it releases the reservation and returns a service
error; the signature is never returned and therefore cannot be minted.

Required internal quote-decision fields:

```text
schemaVersion
recordedAtMs
quoteId
quoteDigest
chainId
parlayVault
taker
legs[]: vault, isYes, underlying, cluster, direction, outcomeCoin
bookInputs[]: priceWad, source, observedAtMs, depth/VWAP metadata, freshness
modelVersion
dataAsOf
dataManifestSha256
bestEstimateJointProbWad
riskAdjustedJointProbWad
rhoBandPct
edge breakdown
premium
maxPayout
deadline
signature hash (never a private key)
```

The current response breakdown is informational and not EIP-712-signed. The
journal is therefore the canonical record of how the signed premium and payout
were produced.

The raw operational journal may retain the taker address for event joining. A
research/public export hashes or removes the taker address. Invite codes, emails,
IP addresses, and secrets are excluded from both.

### 6.9 HyperEVM event joiner

Reuse the writer's existing `ParlayMinted` and `ParlayResolved` scan semantics,
including RPC block-range limits and resumability. The research journal records:

- `quoteId` to parlay ID and mint transaction;
- premium and maximum payout emitted on mint;
- resolved status and transaction;
- per-leg final settlement fractions read from HyperEVM-attested vault state;
- realized binary result for scoring, with voids reported separately.

Historical precompile calls are never used for this join. HyperEVM events and
vault state provide chain truth; HyperCore price observations come from the
collector.

### 6.10 Report generator

Generate a static HTML report after each daily calibration. It contains:

- data freshness and missing intervals;
- 30/90/180-day empirical correlations;
- champion factor-implied correlations and projection errors;
- clipped negative pairs;
- champion versus baseline versus challenger walk-forward scores;
- calibration buckets and stress-period performance;
- quote/mint/resolution funnel;
- current champion/model manifest identifiers;
- all quarantines and failure events.

The report must distinguish observed facts, model estimates, and operator
decisions visually and in labels. It must not present testnet P&L as evidence of
production expected value.

## 7. Historical replay design

### 7.1 Avoiding look-ahead

Every forecast origin uses only observations whose close time is at or before
that origin. Volatility, shrinkage, factor loadings, t degrees of freedom, and
quantile thresholds are refit from the training slice only.

### 7.2 Synthetic event grid

Resolved testnet markets are too few and their thresholds change over time. The
primary statistical replay therefore constructs synthetic events at each origin:

- horizons: 24, 48, 72, and 96 hours;
- marginal event quantiles: 25%, 50%, and 75%;
- directions: up/up, up/down, and down/down where economically meaningful;
- tickets: two to four legs, sampled across same-underlying, same-cluster, and
  cross-cluster groups.

Thresholds are derived from the training distribution at the origin, never from
future realized returns. Outcomes are evaluated from the future horizon close.
Overlapping horizons are retained for coverage but uncertainty is computed with
time-block bootstrap rather than treating each origin as independent.

### 7.3 Models compared

1. Product of marginals (independence diagnostic).
2. Current hand-set `registry/correlations.json` baseline.
3. Measured hierarchical Gaussian factor champion.
4. Signed t-copula challenger.
5. Filtered historical simulation stress challenger.

### 7.4 Scores and decision states

Report log loss, Brier score, probability calibration, sharpness, and results by
window, horizon, ticket size, cluster combination, direction, and volatility
regime.

The beta produces one of three honest statistical outcomes:

- **Supported:** measured champion improves pooled out-of-sample log loss over
  the hand-set baseline, the block-bootstrap interval rules out degradation
  larger than 1%, and no stress bucket with adequate observations degrades by
  more than 5%.
- **Inconclusive:** point estimates differ but uncertainty spans both useful
  improvement and material degradation.
- **Rejected:** the measured champion is materially worse or unstable, or its
  projection loss makes the existing factor form unsuitable.

An inconclusive or rejected result does not block operational beta completion;
it blocks the claim that the measured champion is more accurate and prevents
automatic migration toward mainnet.

## 8. Staleness and eligibility policy

Provisional beta thresholds:

- Collector gap under six hours: catch up next run; no live effect.
- Data-as-of age over 30 hours: candidate calibration fails and is not promoted.
- Champion age under seven days: last-known-good artifact may continue during a
  research outage, with an operator-visible warning.
- Champion age seven days or more: affected multi-asset combinations are disabled
  until an operator promotes a fresh artifact or explicitly restores the static
  baseline.
- Underlying failing coverage/sample/comparability gates: quarantine it from
  measured multi-asset quoting.

These thresholds affect correlation artifacts only. Existing per-outcome live
book freshness and expiry lockouts remain stricter and unchanged.

## 9. Known limitations and unknown-unknown controls

1. **Testnet economics:** thin or maintained outcome books do not validate
   real-money price discovery.
2. **Non-negative champion:** the existing factor implementation clips or poorly
   projects negative underlying dependence. Reports must quantify this.
3. **Band markets:** the current writer treats `direction = band` as uncorrelated.
   Band markets are excluded from statistical success claims until a level-plus-
   dispersion latent model is designed.
4. **Non-synchronous sessions:** crypto trades continuously while equity and
   commodity sources may close. Closed bars are not zero returns.
5. **Overlapping outcomes:** hourly origins for multi-day events are dependent;
   naive sample counts overstate certainty.
6. **Tail sparsity:** 180 days cannot directly validate very rare multi-leg
   events. Tail claims remain model-dependent and stress-tested.
7. **Instrument drift:** token migrations, HIP-3 DEX changes, index composition,
   stock splits, and settlement reference changes can invalidate old history.
8. **Survivorship:** the source registry must preserve delisted/quarantined assets
   in historical manifests rather than rewriting history around current listings.
9. **Quote gaming:** full model inputs are retained internally but public detail
   is delayed until relevant markets resolve.
10. **Provider corrections:** conflicting candles are quarantined and never
    silently overwritten.
11. **Projection error:** fitting a rich empirical matrix into three positive
    factor axes can create apparently stable but false precision.
12. **Operational contention:** calibration runs with CPU, memory, I/O, and time
    limits so it cannot starve the safety-critical keeper.

## 10. Security and privacy

- Collector uses public read-only endpoints and requires no API key.
- Research processes never read quote-signer, poker, keeper, or deployer private
  keys.
- Facts and reports exclude `.env`, invite codes, emails, IP addresses, and raw
  signatures where they are unnecessary.
- Operational quote records are mode-restricted to the `hype` service user.
- Off-box backups use a dedicated least-privilege bucket credential if enabled.
- Model promotion accepts only schema-valid artifacts whose manifest hash and
  file hashes verify.
- No artifact may change EIP-712 quote fields or contract addresses.

## 11. Operations

Run collection hourly and calibration/reporting daily using separate systemd
units/timers. The calibration service runs at low CPU/I/O priority, with a memory
limit and hard timeout. It does not restart or stop the keeper.

Health/report signals include:

- last successful candle per underlying;
- expected versus present observations;
- last calibration start/end/result;
- current champion version and age;
- last successful quote-journal append;
- backup success and last verified object hash;
- quarantined assets and conflicts.

Daily market rotation must preserve `/opt/hype/research`. Deployment scripts must
not use `--delete` against that directory.

## 12. Cost envelope

For at most 20 underlyings:

- Hyperliquid public candles: USD 0 subscription cost.
- Existing Hetzner VPS: USD 0 incremental if current capacity is sufficient.
- QuickNode: not used in beta.
- Managed database: not used.
- Commercial live feeds: not used.
- Object backup: expected within a free 10 GB allowance initially.
- Optional monitoring/backup overhead: USD 0-20/month.

Expected incremental infrastructure total: **USD 0-20/month**.

The principal cost is implementation and review time, estimated during
brainstorming at one to three engineer-weeks. The implementation orchestrator
must not add dependencies or paid services without user approval.

## 13. Verification requirements

### 13.1 Unit and fixture tests

- Candle response parsing, validation, deduplication, and conflict quarantine.
- Gap detection and idempotent backfill.
- Session-aware alignment and missing-data behavior.
- Log-return and exponential-weight calculations.
- Shrinkage, positive-semidefinite checks, and factor projection.
- Deterministic artifact and manifest hashing.
- Artifact schema, version, freshness, and atomic promotion.
- Quote-journal serialization, append failure, rotation, and redaction.
- Replay look-ahead guards and scoring formulas.
- Signed/negative-correlation and band-market limitation fixtures.

### 13.2 Integration tests

- Recorded API fixtures produce a byte-identical candidate on repeated runs.
- A missing/corrupt source partition cannot replace the champion.
- Writer starts with a valid champion and refuses an invalid artifact.
- Returned quote has a durable journal entry with matching quote ID and digest.
- Mint/resolution events join to the correct quote.
- Collector/calibrator outage does not interrupt the live writer or keeper.
- Daily rotation/restart preserves facts and selects the same champion.

### 13.3 Repository gates

Before completion claims, run and show output for:

```bash
forge build
forge test
cd writer && npm run check
cd keeper && npm run check
```

The research subsystem must also have one documented non-interactive check that
runs all of its unit, fixture, schema, and deterministic replay tests.

## 14. Beta acceptance criteria

Operational acceptance requires all of the following:

1. At most 20 explicitly mapped underlyings are tracked.
2. Initial 5,000-candle backfill and hourly idempotent updates work from public
   endpoints without a paid provider.
3. Every promoted artifact references a verified immutable data manifest.
4. Every returned signed quote has a durable decision record created first.
5. Every minted testnet quote can be joined to its eventual resolution or void.
6. Replay is deterministic and free of detected look-ahead leakage.
7. Missing, stale, conflicting, or insufficient data fails conservatively.
8. The report shows baseline, champion, challengers, uncertainty, projection
   error, and all exclusions without claiming unsupported profitability.
9. Calibration cannot starve or restart the keeper.
10. Incremental infrastructure remains within USD 0-20/month unless the user
    explicitly approves a higher tier.

Statistical acceptance is reported separately as Supported, Inconclusive, or
Rejected under Section 7.4. Operational acceptance must never be relabeled as
statistical support.

## 15. Deliberate deferrals

The beta does not implement:

- automatic champion promotion;
- a live t-copula quote engine;
- implied-correlation/options inputs;
- full order-book archival;
- a public real-time decision feed;
- a managed SQL warehouse;
- band-market dispersion dependence;
- mainnet rollout or real-bankroll limits.

Each is a separate post-beta design decision backed by beta evidence.

## 16. New-orchestrator handoff

The new orchestrator should:

1. Read this spec, the facts JSON, the HTML history, `AGENTS.md`,
   `docs/mainnet-hardening-facts.md`, and the current code before planning.
2. Re-grep all cited code because line numbers and behavior may have changed
   after repository baseline `d10ba86`.
3. Use the `superpowers:writing-plans` skill to produce the implementation plan;
   do not begin implementation in the planning turn.
4. Decompose implementation into reversible slices: facts/collector, calibrator,
   artifact validation, journal/event join, report, and testnet verification.
5. Ask before adding any dependency, paid service, or production/shared-state
   change.
6. Preserve unrelated worktree changes and the untracked session report.
7. Run and show every relevant verification command before claiming completion.

No unresolved product decision is required to begin the implementation plan.
Numerical thresholds in this spec are beta defaults; changing them is a design
change and must be documented with evidence.
