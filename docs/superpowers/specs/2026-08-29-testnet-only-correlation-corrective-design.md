# Testnet-only correlation corrective design

**Date:** 2026-08-29
**Status:** Approved direction; implementation pending
**Branch baseline:** `2aa8d4043680f3b8b1abd720dfee5a89a6189578`

## 1. Decision

The correlation system will operate exclusively from Hyperliquid testnet data
while the application is deployed on testnet. It will not query, backfill,
combine, or label mainnet candles as testnet evidence.

This document supersedes the network and sampling assumptions in
`2026-08-27-testnet-correlation-system-design.md`. The existing collector,
return builder, calibration, replay, artifact, journal, join, report, backup,
and writer integration remain the implementation base. This is a corrective
wave, not a rewrite.

The implementation must also preserve a deliberate future mainnet boundary:
the algorithms are network-neutral, while profiles, source mappings, state,
artifacts, deployments, and evidence are network-specific and fail closed when
mixed.

## 2. Evidence behind the correction

A read-only probe against only
`https://api.hyperliquid-testnet.xyz/info` on 2026-08-28 established:

| Source | Testnet metadata | Returned hourly history |
|---|---|---:|
| BTC | active | 5,002 rows / 208.42 days |
| ETH | active | 5,002 rows / 208.42 days |
| SOL | active | 5,002 rows / 208.42 days |
| HYPE | active | 5,001 rows / 208.37 days |
| ZEC | delisted | 2 rows |
| `xyz:NVDA` | active | 5,008 rows / 208.67 days |
| `xyz:SP500` | delisted | 0 rows |
| `xyz:SNDK` | active | 2,413 rows / 100.54 days |
| `xyz:TSLA` | active | 5,000 rows / 208.33 days, last row 2026-08-22 |
| `xyz:AAPL` | active | 1,245 rows / 51.87 days |
| `xyz:GOLD` | active | 4,511 rows / 187.96 days |

The collector's exact initial request shape returned 5,001 rows for both BTC
and `xyz:NVDA`: one candle opened before the unaligned requested start, and the
last candle was still open after the requested end. The current parser rejects
the whole response because it caps the raw response at 5,000 and rejects both
boundary rows. Normal endpoint behavior can therefore starve collection.

The fixed 180-day New York session calendar contains 880 expected hourly
intervals and only 754 adjacent within-session hourly returns. The existing
1,000-hour minimum can never pass for a session-backed pair, even with perfect
coverage.

## 3. Goals and non-goals

### Goals

1. Collect, derive, calibrate, replay, promote, and report using testnet inputs
   only.
2. Keep the testnet application quotable while measured evidence is sparse by
   using an explicit, labeled, operator-approved static testnet fallback.
3. Quarantine unavailable, stale, or insufficient measured sources without
   substituting mainnet history.
4. Resolve the six merge blockers recorded at HEAD.
5. Make a later mainnet rollout a reviewed profile and deployment replacement,
   not a rewrite or an unsafe URL toggle.
6. Preserve all existing quote, EIP-712, Solidity, keeper, exposure, and
   durability safety behavior.

### Non-goals

1. No mainnet request, backfill, artifact, deployment, or profitability claim.
2. No new database, dependency, provider, service, or generalized plugin
   system.
3. No automatic mainnet activation or reuse of testnet artifacts on mainnet.
4. No compatibility adapter for undeployed `returns-v1` research state.
5. No change to marginal leg pricing from live testnet outcome books.

## 4. Network profile boundary

All network-specific public values are loaded through one validated profile:

```ts
interface ResearchNetworkProfile {
  schemaVersion: 1;
  network: "testnet" | "mainnet";
  infoApiUrl: string;
  evmChainId: number;
  sourceRegistryFile: string;
  marketRegistryFile: string;
  deploymentRegistryFile: string;
  baselineCorrelationFile: string;
}
```

The repository ships one active profile: testnet. It identifies the testnet
Info API, HyperEVM chain 998, the testnet source and market registries, and the
public deployed-contract registry and static testnet baseline. Private keys and
credential-bearing RPC URLs remain outside the profile. A single
enabled-network allowlist contains only `testnet` during this beta.

Profile validation must enforce all of the following before network or
persistence work:

- the selected profile network is enabled;
- the Info API hostname matches the profile network;
- the EVM client chain ID matches the profile chain ID;
- live public contract addresses and deploy blocks match the profile's hashed
  deployment registry;
- every source record, market, manifest, return set, candidate, validation
  sidecar, champion, journal record, joined event, and report identifies the
  same network;
- referenced source, market, and baseline bytes match the hashes carried by
  their immutable consumers.

Changing only a URL, source registry, artifact path, or chain RPC must fail.
Research state roots are deployment-specific; testnet and future mainnet never
share a `RESEARCH_ROOT`.

The eventual mainnet change is explicit: add and review a mainnet profile and
registries, add `mainnet` to the one enabled-network allowlist, use a fresh
mainnet research root, collect fresh mainnet evidence, deploy mainnet contracts,
and promote only a newly validated mainnet champion. No testnet bytes are
eligible inputs to that process.

## 5. Testnet source and fallback policy

The logical set remains BTC, ETH, SOL, HYPE, ZEC, NVDA, SP500, SNDK, TSLA,
AAPL, and GOLD. Their source coins remain the matching unprefixed testnet perps
and the testnet HIP-3 `xyz:` coins.

Source mapping and measured-data admissibility are separate concerns. A mapped
logical underlying can remain quotable through static fallback while its
measured source is delisted, stale, or short of history.

The v2 source registry therefore uses two independent flags:

- `measurementEnabled` allows collection and direct estimation;
- `fallbackEligible` allows the approved static testnet baseline.

`measurementEnabled` is initially false for delisted ZEC and `xyz:SP500` and
true for the other nine sources. Freshness, sample, and coverage gates decide
whether those nine actually produce direct estimates; current short or stale
history is not hidden in registry configuration. `fallbackEligible` is true for
the current eleven-underlying testnet logical set. Re-enabling measurement for
a source requires a reviewed registry change and fresh testnet evidence.

The current static correlation table becomes the immutable testnet bootstrap
baseline. The user's approval of this design is the operator approval for
testnet fallback eligibility across the current logical set. Fallback must use
the exact content-addressed static baseline value for the pair; it must not
invent a proxy from a different asset or silently relabel a measured estimate.

Pair selection is ordered:

1. Use a direct testnet estimate only when both sources and the exact pair pass
   freshness, sample, and coverage gates.
2. Otherwise use the approved static testnet baseline and label the pair
   `fallback` with reason `operator-reviewed-testnet-bootstrap`.
3. Quarantine the pair only if neither direct evidence nor an approved baseline
   entry exists.

Artifacts and reports must separately show direct, fallback, and quarantined
pairs. Testnet fallback and testnet P&L must never be presented as production
evidence.

## 6. Collector semantics

The collector calculates the last fully closed hourly candle before issuing a
request:

```text
lastOpenTime = floor(now / 1 hour) * 1 hour - 1 hour
endTime      = lastOpenTime + 1 hour - 1 millisecond
```

Each page requests at most 5,000 expected candle opens. Initial backfill and
resume use the same page construction. The collector may receive adjacent
provider boundary rows. It deterministically retains only rows whose complete
hour is inside the issued closed interval, then applies the 5,000-row cap and
strict validation to the retained batch.

Retained rows must have the exact source and interval, safe timestamps and
numbers, one-hour width, strictly increasing unique open times, valid OHLC
ordering, and `closeTime <= endTime < retrievedAt`. Ignored boundary-row counts
are journaled. Malformed or conflicting retained rows fail the batch before any
shard or checkpoint is sealed.

The durable checkpoint advances only through the last retained candle present
in a verified sealed shard. Missing hours remain missing evidence; they are not
forward-filled.

## 7. Return and quality policy

The active lookback remains 180 days and the exponential half-life remains 45
days.

- Continuous-to-continuous pairs in the same crypto cluster use synchronized
  hourly returns with a minimum of 1,000 observations and 80% coverage.
- Any pair containing a session-backed source uses the existing
  settlement-aligned daily-return path with a minimum of 90 observations and
  80% coverage.
- Missing scheduled sessions, stale observations, and unavailable pairs remain
  explicit exclusions.
- Freshness is evaluated from required close-time provenance, never candle open
  time.

This reuses the existing daily path and removes the mathematically impossible
1,000-hour gate for session-backed pairs. Sparse testnet sources naturally use
the approved static fallback until their exact daily gates pass.

## 8. Resolution of the six remaining blockers

### 8.1 Candle request and batch boundaries

Implement the closed, aligned, paged request and deterministic boundary-row
selection in section 6. Regression fixtures must reproduce the observed
5,001-row testnet response and prove that exactly the valid closed range is
sealed.

### 8.2 Strict close-time causality

`observationCloseTimeMs` becomes required on every persisted return and every
causal filter. Replay, calibration, and artifact validation reject records or
manifests without it. No fallback to `timestampMs` is permitted.

### 8.3 Immutable exclusion closure

Every derived manifest must reference and hash both the return partition and
the exclusion partition. Calibration and replay reject returns-only manifests.
Reports consume the verified exclusion partition and render counts and reasons
for missing, stale, non-positive, unsynchronized, and quarantined evidence.

### 8.4 Persistence containment

Filename identifiers remain restricted to safe canonical values. On the Ubuntu
service target, persistence walks and opens directories through no-follow,
directory-file-descriptor-anchored operations, verifies type/owner/mode, and
opens final files with `O_NOFOLLOW`. It must not validate a pathname and later
reopen the same mutable path from the filesystem root. The service fails closed
if the anchored primitive is unavailable. The implementation uses Node's
standard filesystem API plus the platform descriptor namespace (`/proc/self/fd`
on Ubuntu or the verified platform equivalent); it adds no native dependency.

Local tests cover traversal, leaf symlinks, intermediate-directory replacement,
and a destination swapped between validation and open.

### 8.5 Durable operational history

Daily, collection, calibration, replay, join, report, promotion, and backup
runs write immutable per-run start and terminal records. Terminal records carry
start/end timestamps, success or failure, stage, sanitized detail, and relevant
artifact identities. A mutable convenience pointer may identify the latest
run, but it is never the evidence source.

The report reads immutable history, never a transient `running` pointer. It
shows the latest terminal state plus all failures from the preceding 30 days.
A failed run remains visible after later successes; older immutable records
remain retained even when omitted from the rendered report.

### 8.6 Versioned return and manifest migration

The close-time and network identity changes define `returns-v2` and a matching
derived-manifest schema version. All immutable paths include the new version.
Readers reject `returns-v1` as an input to new calibration, replay, or
promotion.

Any other persisted wire shape that gains a required network identity or hash
also increments its schema version. Changed bytes are never written beneath an
old immutable version/path, and old-version readers never silently accept the
new shape.

No migration adapter is needed because no research state, artifact, or champion
from this branch has been installed or promoted on testnet. Tests regenerate
fixtures under v2. Historical repository evidence remains unchanged.

## 9. Data flow and failure behavior

```text
testnet profile + registries
        |
        v
closed testnet candle pages -> sealed raw shards + request journal
        |
        v
returns-v2 + immutable exclusions -> derived manifest closure
        |
        v
direct testnet estimates + static testnet fallback -> candidate
        |
        v
causal replay + validation -> manual testnet promotion
        |
        v
writer startup validation -> testnet quotes + durable journal/join/report
```

Failures are contained by stage. Collector, calibration, replay, join, report,
or backup failure cannot stop the live writer or keeper. No failed or stale
candidate replaces the champion. A missing or network-mismatched champion
prevents multi-underlying quoting rather than falling through to an unverified
artifact. Same-underlying behavior remains unchanged.

## 10. Verification

Implementation uses strict TDD for every changed behavior. Required local
proof includes:

1. A testnet-profile URL/chain/source/artifact match and every mismatch case.
2. A hard failure when the enabled network is testnet but the mainnet Info URL
   is supplied.
3. The observed 5,001-row boundary response, current open candle, pagination,
   resume, retry, conflict, and checkpoint behavior.
4. Continuous hourly and session daily mode selection with exact minimum and
   coverage boundaries.
5. Direct, static-fallback, and quarantined pair admission and writer behavior.
6. Strict v2 close-time causality and rejection of v1 inputs.
7. Return-plus-exclusion manifest closure and report consumption.
8. Anchored persistence race, traversal, and symlink regressions.
9. Immutable operational failure history surviving later successes.
10. Deterministic end-to-end collect-to-report fixtures followed by all existing
    Forge, writer, research, keeper, rotation, repository, and diff checks.

Network calls are not part of the repository gate. After local checks pass and
separate shared-state approval is granted, operational acceptance must run on
testnet: collect, derive, calibrate, replay, inspect fallbacks/quarantines,
promote, restart only the writer, request and mint a testnet quote, join it to
resolution or void, and verify restart/rotation/backup durability. Exact command
output and identities are recorded in the testnet verification document.

## 11. Definition of done

The corrective wave is complete only when:

- no shipped testnet service, profile, registry, artifact, example, or test
  reads or labels mainnet market data;
- network mixing fails at every persisted and live boundary;
- the six blockers in section 8 have executable regression proof;
- session-backed pairs use the feasible daily policy;
- sparse sources use only the explicitly labeled static testnet fallback;
- all local gates pass with shown output; and
- separately approved testnet operational evidence proves the complete live
  flow.

Local completion alone is not testnet operational acceptance. Testnet
operational acceptance is not mainnet readiness or evidence of production
profitability.
