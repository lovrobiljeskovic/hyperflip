# Testnet-only Correlation Corrective Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing correlation research and quote path work end to end on Hyperliquid testnet only, close the six final review blockers, and preserve a fail-closed profile boundary for a later clean-room mainnet rollout.

**Architecture:** Correct the existing file-backed pipeline in place. One checked-in testnet profile binds the Info API, chain, source registry, market registry, deployment registry, baseline, and research root identities; all immutable outputs carry that network closure. Collection admits only verified closed testnet candles, returns-v2 closes both observations and exclusions, calibration chooses direct evidence or the exact approved static testnet baseline, and promotion/writer/report paths reject mixed identities. Persistence remains standard-library-only: Linux services require descriptor-anchored `/proc/self/fd` access, while local macOS tests use an explicitly non-production compatibility backend.

**Tech Stack:** TypeScript 5.7, Node.js 22 standard library (`fs`, `crypto`, `path`, `url`), `viem` 2.55, `tsx --test`, Foundry, systemd

**Spec:** `docs/superpowers/specs/2026-08-29-testnet-only-correlation-corrective-design.md`

## Global Constraints

- Testnet only: no implementation step or verification command may query, backfill, combine, or relabel mainnet candles.
- Keep the live marginal pricing, quote schema, EIP-712 fields, Solidity contracts, keeper, allowance/exposure gates, and same-underlying behavior unchanged.
- Add no dependency, database, provider, service, generic plugin system, migration adapter, or automatic promotion.
- The repository enables only `testnet`. A later mainnet launch requires a reviewed mainnet profile and registries, fresh root and evidence, a mainnet deployment, and a newly promoted mainnet champion.
- Use the current static table only as the approved testnet bootstrap baseline, label it `operator-reviewed-testnet-bootstrap`, and never proxy a missing pair through another asset.
- `measurementEnabled` and `fallbackEligible` are independent. ZEC and `xyz:SP500` start measurement-disabled; all eleven mapped underlyings remain fallback-eligible.
- Persist changed wire formats under new schema/version paths. `returns-v1` is rejected; no compatibility adapter is needed because branch research state was never deployed or promoted.
- No local repository gate makes a network request. Ubuntu testnet acceptance is a separate, explicitly approved shared-state step.
- Every task follows RED-GREEN-REFACTOR, runs the smallest relevant check, and commits only its scoped files. Never stage `keeper/node_modules` or `writer/node_modules`.

---

### Task 1: Bind Every Public Input to One Testnet Profile

**Files:**
- Create: `registry/research-network.testnet.json`
- Create: `registry/deployment.testnet.json`
- Create: `writer/src/research/network.ts`
- Create: `writer/test/research-network.test.ts`
- Modify: `registry/correlation-sources.json`
- Modify: `registry/markets.json`
- Modify: `registry/correlations.json`
- Modify: `writer/src/research/types.ts`
- Modify: `tools/rotate-markets.mjs`
- Modify: `tools/rotate-lib.test.mjs`

**Interfaces and persisted shapes:**

```ts
export type ResearchNetwork = "testnet" | "mainnet";

export interface ResearchNetworkProfile {
  schemaVersion: 1;
  network: ResearchNetwork;
  infoApiUrl: string;
  evmChainId: number;
  sourceRegistryFile: string;
  marketRegistryFile: string;
  deploymentRegistryFile: string;
  baselineCorrelationFile: string;
}

export interface DeploymentRegistry {
  schemaVersion: 1;
  network: ResearchNetwork;
  evmChainId: number;
  parlayVault: `0x${string}`;
  parlayDeployBlock: string;
}

export interface LoadedResearchNetworkProfile {
  profile: ResearchNetworkProfile;
  profileSha256: string;
  sources: SourceRegistry;
  sourceRegistrySha256: string;
  marketRegistryRaw: string;
  marketRegistrySha256: string;
  deployment: DeploymentRegistry;
  deploymentRegistrySha256: string;
  baselineCorrelationRaw: string;
  baselineCorrelationSha256: string;
}
```

- [ ] **Step 1: Write failing profile-closure tests**

Create temporary profile and registry copies in `research-network.test.ts`. Cover the valid checked-in testnet profile, disabled `mainnet`, testnet with `https://api.hyperliquid.xyz/info`, wrong chain ID, a registry with the wrong network, and an escaping relative registry path.

```ts
test("testnet profile rejects the mainnet Info API", () => {
  const file = copyProfile({ infoApiUrl: "https://api.hyperliquid.xyz/info" });
  assert.throws(() => loadResearchNetworkProfile(file), /testnet Info API hostname/);
});

test("only testnet is enabled", () => {
  const file = copyProfile({ network: "mainnet", evmChainId: 999 });
  assert.throws(() => loadResearchNetworkProfile(file), /network mainnet is not enabled/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-network.test.ts`

Expected: FAIL because `loadResearchNetworkProfile` does not exist.

- [ ] **Step 3: Add the checked-in profile and deployment registry**

`registry/research-network.testnet.json` contains only public testnet values and relative filenames:

```json
{
  "schemaVersion": 1,
  "network": "testnet",
  "infoApiUrl": "https://api.hyperliquid-testnet.xyz/info",
  "evmChainId": 998,
  "sourceRegistryFile": "correlation-sources.json",
  "marketRegistryFile": "markets.json",
  "deploymentRegistryFile": "deployment.testnet.json",
  "baselineCorrelationFile": "correlations.json"
}
```

`registry/deployment.testnet.json` records the existing public testnet deployment:

```json
{
  "schemaVersion": 1,
  "network": "testnet",
  "evmChainId": 998,
  "parlayVault": "0x407cdc0b15e8d81f4d122481ecf92dbe07dc0169",
  "parlayDeployBlock": "61906227"
}
```

Add top-level `"network": "testnet"` to the source, market, and correlation registries. Upgrade the source registry to schema 2, replace `eligible` with `measurementEnabled`, and add `fallbackEligible`. Set measurement false only for ZEC and SP500; set fallback true for all current entries.

- [ ] **Step 4: Implement one strict loader using existing parsers and canonical hashing**

In `network.ts`, resolve referenced filenames relative to the profile directory, reject absolute paths and `..`, enforce exact host mappings, and reuse `canonicalJson`/`sha256` plus `parseSourceRegistry`, `parseMarkets`, and `parseCorrelations`. Keep the one activation gate literal and obvious:

```ts
const ENABLED_RESEARCH_NETWORKS = new Set<ResearchNetwork>(["testnet"]);

const INFO_HOSTS: Record<ResearchNetwork, string> = {
  testnet: "api.hyperliquid-testnet.xyz",
  mainnet: "api.hyperliquid.xyz",
};
```

Validate the `network` field before returning each parsed registry. Do not add a provider interface or environment override for these public values.

- [ ] **Step 5: Preserve network identity during market rotation**

Change `tools/rotate-markets.mjs` to write `{ network: "testnet", markets, archived }`; update its fixture registry to schema 2 and the two new eligibility flags. Assert rotation cannot silently remove or change the top-level network.

- [ ] **Step 6: Run focused checks and confirm GREEN**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-network.test.ts test/research-types.test.ts`

Run: `node --test tools/rotate-lib.test.mjs`

Expected: both commands exit 0.

- [ ] **Step 7: Commit the profile boundary**

```bash
git add registry/research-network.testnet.json registry/deployment.testnet.json registry/correlation-sources.json registry/markets.json registry/correlations.json writer/src/research/network.ts writer/src/research/types.ts writer/test/research-network.test.ts tools/rotate-markets.mjs tools/rotate-lib.test.mjs
git commit -m "feat(research): bind testnet network profile"
```

---

### Task 2: Root Persistence in the Opened Research Directory

**Files:**
- Create: `writer/src/research/persistence.ts`
- Create: `writer/test/research-persistence.test.ts`
- Modify: `writer/src/research/store.ts`
- Modify: `writer/src/research/candles.ts`
- Modify: `writer/src/research/returns.ts`
- Modify: `writer/src/research/calibration.ts`
- Modify: `writer/src/research/replay.ts`
- Modify: `writer/src/research/artifacts.ts`
- Modify: `writer/src/research/journal.ts`
- Modify: `writer/src/research/daily.ts`
- Modify: `writer/src/research/backup.ts`
- Modify: `writer/src/research/report.ts`
- Modify: `writer/src/research/cli.ts`

**Minimal API:**

```ts
export interface ResearchPersistence {
  read(relativePath: string): Buffer;
  readText(relativePath: string): string;
  exists(relativePath: string): boolean;
  list(relativePath: string): string[];
  append(relativePath: string, line: string): void;
  writeAtomic(relativePath: string, bytes: string | Buffer): void;
  writeNew(relativePath: string, bytes: string | Buffer): boolean;
}

export function openResearchPersistence(
  root: string,
  options?: { requireAnchored?: boolean; beforeLeafOpen?: () => void },
): ResearchPersistence;
```

- [ ] **Step 1: Write security regressions before moving call sites**

Test canonical relative paths, `..`, absolute paths, leaf symlinks, intermediate symlinks, wrong-owner/world-writable directories where the platform permits them, and a destination swapped in `beforeLeafOpen`. On macOS, assert `requireAnchored: true` fails with a message naming Linux and `/proc/self/fd`.

```ts
test("required anchored storage fails closed when unavailable", () => {
  if (process.platform === "linux") return;
  assert.throws(
    () => openResearchPersistence(tempRoot(), { requireAnchored: true }),
    /Linux.*\/proc\/self\/fd/,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-persistence.test.ts`

Expected: FAIL because the bound persistence API does not exist.

- [ ] **Step 3: Implement the two explicit backends with Node built-ins**

Production Linux opens the root and each intermediate directory using `O_DIRECTORY | O_NOFOLLOW`, verifies directory type, current UID, and no group/world write, then traverses through `/proc/self/fd/${directoryFd}/${segment}` while holding the directory descriptor. Open final files with `O_NOFOLLOW`; atomic writes create a unique sibling and rename within the held parent. Reject empty segments, `.`, `..`, NUL, separators inside identifiers, and non-canonical relative paths.

The compatibility backend keeps the current repeated realpath/lstat containment checks and is selectable only when `requireAnchored !== true`. Do not emulate a descriptor path on macOS and do not add a native dependency.

- [ ] **Step 4: Move existing persistence helpers behind the bound root**

Replace every full-path reopen in the research modules with relative paths on one `ResearchPersistence` instance, including candle facts/shards, returns, candidate/validation artifacts, promotion, journals, reports, backup traversal, and CLI reads. Reuse the existing canonical JSON, hash, gzip, fsync, and atomic-file logic; change only how the parent/file is reached.

Keep filename validation at the existing typed boundaries. Do not turn the API into a general virtual filesystem.

- [ ] **Step 5: Run the persistence and store suites**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-persistence.test.ts test/research-store.test.ts test/research-candles.test.ts test/research-returns.test.ts test/research-calibration.test.ts test/research-replay.test.ts test/research-artifacts.test.ts test/research-journal.test.ts test/research-report.test.ts test/research-backup.test.ts`

Expected: exit 0, including compatibility-backend swap regressions on macOS.

- [ ] **Step 6: Commit the containment fix**

```bash
git add writer/src/research/persistence.ts writer/src/research/store.ts writer/src/research/candles.ts writer/src/research/returns.ts writer/src/research/calibration.ts writer/src/research/replay.ts writer/src/research/artifacts.ts writer/src/research/journal.ts writer/src/research/daily.ts writer/src/research/backup.ts writer/src/research/report.ts writer/src/research/cli.ts writer/test/research-persistence.test.ts
git commit -m "fix(research): anchor persistence to root"
```

---

### Task 3: Collect Only Closed Testnet Candle Pages

**Files:**
- Modify: `writer/src/research/candles.ts`
- Modify: `writer/src/research/cli.ts`
- Modify: `writer/src/research/types.ts`
- Modify: `writer/test/research-candles.test.ts`

**Boundary helpers:**

```ts
export function lastClosedHour(nowMs: number): { lastOpenTimeMs: number; endTimeMs: number };
export function selectClosedPage(
  rows: unknown[],
  request: { coin: string; startTimeMs: number; endTimeMs: number; retrievedAtMs: number },
): { candles: CandleRecord[]; ignoredBefore: number; ignoredAfter: number };
```

- [ ] **Step 1: Add observed-boundary and paging regressions**

Generate the observed 5,001-row response from the existing valid candle fixture: one adjacent row before the request and exactly 5,000 valid closed rows. Add a smaller generated case with a currently open final row. Assert boundary extras are counted, the retained page alone is capped, and the checkpoint advances only to the last candle sealed in a verified shard.

Also cover resume, retry idempotency, conflicting retained duplicates, malformed retained OHLC, missing hours, and a source with `measurementEnabled: false`.

```ts
assert.deepEqual(lastClosedHour(Date.UTC(2026, 7, 29, 12, 37)), {
  lastOpenTimeMs: Date.UTC(2026, 7, 29, 11),
  endTimeMs: Date.UTC(2026, 7, 29, 11, 59, 59, 999),
});
```

- [ ] **Step 2: Run the collector suite and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-candles.test.ts`

Expected: FAIL because the current parser caps and validates the raw provider response before boundary selection.

- [ ] **Step 3: Align initial and resume requests to closed pages**

Build every request from expected candle opens, at most 5,000 per page. Filter adjacent provider rows to the issued closed interval first; then validate the retained rows for coin, interval, timestamp safety, one-hour width, unique/increasing opens, finite values, OHLC ordering, and `closeTime <= endTime < retrievedAt`.

Skip collection for `measurementEnabled: false`. Take the API URL only from `LoadedResearchNetworkProfile`; remove the research CLI's independent URL default/override. Bump every changed candle/request/data-manifest wire shape, then persist network, profile hash, request bounds, and ignored-before/after counts in the request journal and raw manifest.

- [ ] **Step 4: Run the collector and CLI suites**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-candles.test.ts`

Run: `cd writer && npm run typecheck`

Expected: both commands exit 0; no test performs a live network call.

- [ ] **Step 5: Commit closed testnet collection**

```bash
git add writer/src/research/candles.ts writer/src/research/cli.ts writer/src/research/types.ts writer/test/research-candles.test.ts
git commit -m "fix(research): collect closed testnet candles"
```

---

### Task 4: Close Returns-v2 Over Observations and Exclusions

**Files:**
- Modify: `writer/src/research/returns.ts`
- Modify: `writer/src/research/types.ts`
- Modify: `writer/src/research/store.ts`
- Modify: `writer/src/research/calibration.ts`
- Modify: `writer/src/research/replay.ts`
- Modify: `writer/src/research/report.ts`
- Modify: `writer/test/research-returns.test.ts`
- Modify: `writer/test/research-calibration.test.ts`
- Modify: `writer/test/research-replay.test.ts`

**Shared policy:**

```ts
export type ReturnMode = "hourly" | "daily";

export function returnModeFor(left: SourceEntry, right: SourceEntry): ReturnMode {
  return left.calendar === "continuous" &&
    right.calendar === "continuous" &&
    left.cluster === right.cluster
    ? "hourly"
    : "daily";
}

export interface ReturnRecord {
  schemaVersion: 2;
  network: ResearchNetwork;
  underlying: string;
  interval: ReturnMode;
  timestampMs: number;
  observationCloseTimeMs: number;
  value: number;
}
```

- [ ] **Step 1: Write failing causality, policy, and closure tests**

Cover same-cluster continuous crypto selecting hourly at exactly 1,000 observations and 80% coverage; any session-backed pair selecting daily at exactly 90 and 80%; one below each boundary; missing `observationCloseTimeMs`; `returns-v1`; wrong network; and a derived manifest missing the exclusion partition/hash.

```ts
test("a same-cluster pair containing a session source uses daily returns", () => {
  assert.equal(returnModeFor(continuousCrypto, nySessionCrypto), "daily");
});

test("v2 rejects open-time fallback", () => {
  const row = { ...validReturn, observationCloseTimeMs: undefined };
  assert.throws(() => parseReturnRecord(row), /observationCloseTimeMs/);
});
```

- [ ] **Step 2: Run focused suites and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-returns.test.ts test/research-calibration.test.ts test/research-replay.test.ts`

Expected: FAIL because returns-v1 and the optional close-time fallback are still accepted.

- [ ] **Step 3: Version returns and derived manifests once**

Set `TRANSFORMATION_VERSION = "returns-v2"`. Make close time and network required in the parser and wire type. Write immutable return and exclusion partitions beneath v2 paths. Bump the derived manifest schema and require both entries:

```ts
interface DerivedManifestV2 {
  schemaVersion: 2;
  network: ResearchNetwork;
  transformationVersion: "returns-v2";
  returns: { path: string; sha256: string; rows: number };
  exclusions: { path: string; sha256: string; rows: number };
}
```

Verify both hashes before calibration, replay, or report parsing. Delete `row.observationCloseTimeMs ?? row.timestampMs`; there is no fallback.

- [ ] **Step 4: Use one return-mode policy in calibration and replay**

Replace both same-cluster-only checks with `returnModeFor`. Keep the existing daily settlement alignment code. Apply 1,000/80% only to hourly and 90/80% to daily. Freshness uses the required observation close time.

Render verified exclusion counts/reasons for missing, stale, non-positive, unsynchronized, and quarantined evidence. Escape rendered labels with the existing report escaping helper.

- [ ] **Step 5: Run return consumers and confirm GREEN**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-returns.test.ts test/research-calibration.test.ts test/research-replay.test.ts test/research-report.test.ts`

Expected: exit 0 with returns-only and v1 inputs rejected.

- [ ] **Step 6: Commit v2 causal closure**

```bash
git add writer/src/research/returns.ts writer/src/research/types.ts writer/src/research/store.ts writer/src/research/calibration.ts writer/src/research/replay.ts writer/src/research/report.ts writer/test/research-returns.test.ts writer/test/research-calibration.test.ts writer/test/research-replay.test.ts
git commit -m "fix(research): version causal return closure"
```

---

### Task 5: Admit Direct or Exact Static Testnet Correlations

**Files:**
- Modify: `writer/src/research/calibration.ts`
- Modify: `writer/src/research/artifacts.ts`
- Modify: `writer/src/research/types.ts`
- Modify: `writer/src/correlation.ts`
- Modify: `writer/test/research-calibration.test.ts`
- Modify: `writer/test/research-artifacts.test.ts`
- Modify: `writer/test/fixtures/research/expected-candidate.json`

**Pair decision:**

```ts
type PairAdmission =
  | { kind: "direct"; correlation: number; reason: "testnet-quality-passed" }
  | { kind: "fallback"; correlation: number; reason: "operator-reviewed-testnet-bootstrap" }
  | { kind: "quarantined"; reason: string };
```

- [ ] **Step 1: Write failing admission tests**

Cover: quality-passing direct estimate; delisted-but-fallback-eligible ZEC; short-history AAPL; stale TSLA; baseline value `0`; a pair missing from the static table; fallback-disabled source; wrong baseline hash/network; and direct evidence from the wrong network.

```ts
test("delisted mapped source uses its exact approved testnet baseline", () => {
  assert.deepEqual(admitPair(zec, btc, noDirectEstimate, baseline), {
    kind: "fallback",
    correlation: pairCorrelation(baseline, "ZEC", "BTC"),
    reason: "operator-reviewed-testnet-bootstrap",
  });
});
```

- [ ] **Step 2: Run focused suites and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-calibration.test.ts test/research-artifacts.test.ts`

Expected: FAIL because source-quality rejection currently happens before fallback and fallback uses the structured shrink target.

- [ ] **Step 3: Put exact baseline lookup after direct quality and before quarantine**

Reuse `parseCorrelations` and `pairCorrelation`. Direct is allowed only when both sources are measurement-enabled and the exact pair passes mode-specific quality. Otherwise, if both sources are fallback-eligible and the exact static entry exists, use that exact value and reason. Do not use the shrink target, another pair, or a truthiness check that drops zero.

- [ ] **Step 4: Bump and bind the candidate artifact**

Add required network closure to the artifact's next schema version:

```ts
interface CorrelationArtifactV2 {
  schemaVersion: 2;
  network: ResearchNetwork;
  profileSha256: string;
  sourceRegistrySha256: string;
  marketRegistrySha256: string;
  deploymentRegistrySha256: string;
  baselineCorrelationSha256: string;
  directPairs: PairRecord[];
  fallbackPairs: PairRecord[];
  quarantinedPairs: QuarantinedPairRecord[];
}
```

Keep the existing model matrices, diagnostics, provenance, `dataAsOf`, validation, and atomic artifact behavior. The profile loader supplies hashes; artifact parsing and promotion compare all of them exactly.

- [ ] **Step 5: Run calibration/artifact suites and confirm GREEN**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-calibration.test.ts test/research-artifacts.test.ts test/correlation.test.ts`

Expected: exit 0 and fixtures explicitly distinguish direct, fallback, and quarantined pairs.

- [ ] **Step 6: Commit testnet bootstrap admission**

```bash
git add writer/src/research/calibration.ts writer/src/research/artifacts.ts writer/src/research/types.ts writer/src/correlation.ts writer/test/research-calibration.test.ts writer/test/research-artifacts.test.ts writer/test/fixtures/research/expected-candidate.json
git commit -m "feat(research): admit static testnet fallback"
```

---

### Task 6: Close Replay, Promotion, Writer, and Journals Over the Profile

**Files:**
- Modify: `writer/src/config.ts`
- Modify: `writer/src/index.ts`
- Modify: `writer/src/research/cli.ts`
- Modify: `writer/src/research/replay.ts`
- Modify: `writer/src/research/artifacts.ts`
- Modify: `writer/src/research/journal.ts`
- Modify: `writer/src/research/types.ts`
- Modify: `writer/test/config.test.ts`
- Modify: `writer/test/research-replay.test.ts`
- Modify: `writer/test/research-artifacts.test.ts`
- Modify: `writer/test/research-journal.test.ts`

- [ ] **Step 1: Add mismatch tests at every live boundary**

Cover profile versus actual RPC chain, configured vault address/deploy block versus deployment registry, candidate/validation/champion hashes, quote-decision network, joined-event network, and promotion of a testnet candidate into a root containing another network marker.

```ts
test("writer refuses a chain that differs from the selected profile", () => {
  assert.throws(() => assertProfileChain(testnetProfile, 999), /expected chain 998/);
});
```

- [ ] **Step 2: Run focused suites and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/config.test.ts test/research-replay.test.ts test/research-artifacts.test.ts test/research-journal.test.ts`

Expected: FAIL because configuration and persisted records are not yet closed over the profile.

- [ ] **Step 3: Load the profile once in CLI and writer startup**

Require `RESEARCH_NETWORK_PROFILE_FILE` when research or multi-underlying quoting is enabled. Resolve all public files and the Info API URL from the loaded profile. Keep secrets, RPC URLs, keys, and operational paths in environment variables.

At writer startup, read the actual EVM chain ID before enabling multi-underlying quotes and compare chain, vault address, deploy block, champion network, and all champion hashes. A mismatch disables multi-underlying quoting with a precise health reason; it never falls back to an unverified artifact. Same-underlying quotes remain unchanged.

- [ ] **Step 4: Version replay and journal records**

Bump validation, quote-decision, and joined-event schemas when adding required `network`, profile/deployment identity, and artifact identity. Replay reads only verified v2 returns plus exclusions and uses required close time. Promotion requires a Supported validation sidecar with the same network and hashes, plus existing freshness checks.

Journal the exact champion/fallback decision used for each quote without adding private keys, raw signatures, IPs, emails, or invite codes.

- [ ] **Step 5: Run writer boundary suites and typecheck**

Run: `cd writer && ./node_modules/.bin/tsx --test test/config.test.ts test/research-replay.test.ts test/research-artifacts.test.ts test/research-journal.test.ts test/server.test.ts`

Run: `cd writer && npm run typecheck`

Expected: both commands exit 0.

- [ ] **Step 6: Commit live network closure**

```bash
git add writer/src/config.ts writer/src/index.ts writer/src/research/cli.ts writer/src/research/replay.ts writer/src/research/artifacts.ts writer/src/research/journal.ts writer/src/research/types.ts writer/test/config.test.ts writer/test/research-replay.test.ts writer/test/research-artifacts.test.ts writer/test/research-journal.test.ts
git commit -m "fix(research): bind replay and writer network"
```

---

### Task 7: Preserve Immutable Operational Failures

**Files:**
- Create: `writer/src/research/operations.ts`
- Modify: `writer/test/research-operations.test.ts`
- Modify: `writer/src/research/cli.ts`
- Modify: `writer/src/research/daily.ts`
- Modify: `writer/src/research/report.ts`
- Modify: `writer/src/research/types.ts`
- Modify: `writer/test/research-report.test.ts`

**Record shape:**

```ts
interface OperationRunRecord {
  schemaVersion: 1;
  network: ResearchNetwork;
  runId: string;
  operation: "collect" | "calibrate" | "replay" | "join" | "report" | "promote" | "backup" | "daily";
  phase: "start" | "terminal";
  startedAt: string;
  endedAt?: string;
  status?: "success" | "failure";
  stage?: string;
  detail?: Record<string, string | number | boolean | null>;
  error?: string;
}
```

- [ ] **Step 1: Add failure-retention tests**

Use deterministic run IDs/timestamps. Write one failed terminal record followed by one success; assert the report still includes both the latest success and the failure within 30 days. Assert a start record alone is not treated as terminal evidence and that detail/error sanitization rejects secrets and control characters.

- [ ] **Step 2: Run focused suites and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-operations.test.ts test/research-report.test.ts`

Expected: FAIL because reports currently read mutable operation state.

- [ ] **Step 3: Write immutable start and terminal files**

Use the bound persistence `writeNew` operation under:

```text
journal/operations/YYYY/MM/DD/RUN_ID.start.json
journal/operations/YYYY/MM/DD/RUN_ID.terminal.json
```

Generate `RUN_ID` from UTC time plus `randomUUID()`. The CLI wraps collect, calibrate, replay, join, report, promote, backup, and daily. Daily remains a coordinator; a derive failure is recorded as its terminal `stage`. Sanitized details contain only bounded public artifact IDs/counts/stages; errors contain bounded messages without environment dumps or stacks.

- [ ] **Step 4: Make reports read immutable terminal history**

Scan retained terminal records, verify their schema/network, select the latest terminal result per operation, and render all failures whose end time is within the preceding 30 days. Do not use mutable `state/*.json` as evidence. Old immutable records remain on disk when omitted from HTML.

- [ ] **Step 5: Run operation, daily, and report suites**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-operations.test.ts test/research-report.test.ts test/research-integration.test.ts`

Expected: exit 0, and the failure remains visible after the later success.

- [ ] **Step 6: Commit durable history**

```bash
git add writer/src/research/operations.ts writer/src/research/cli.ts writer/src/research/daily.ts writer/src/research/report.ts writer/src/research/types.ts writer/test/research-operations.test.ts writer/test/research-report.test.ts
git commit -m "feat(research): retain operation history"
```

---

### Task 8: Wire Testnet Operations and Prove the Local Pipeline

**Files:**
- Modify: `writer/.env.example`
- Modify: `ops/systemd/hype-research-collector.service`
- Modify: `ops/systemd/hype-research-daily.service`
- Modify: `ops/systemd/hype-research-backup.service`
- Modify: `DEPLOY.md`
- Modify: `docs/research/testnet-correlation-verification.md`
- Modify: `writer/test/research-end-to-end.test.ts`
- Modify: `writer/test/research-operations.test.ts`

- [ ] **Step 1: Extend the deterministic end-to-end fixture test**

Drive the existing local fixture through profile load, collect, derive v2, calibrate, replay, promotion, writer startup validation, quote journal, event join, report, restart, and backup-plan generation. Include one direct, one static fallback, and one quarantined pair; a failed operation followed by success; and a rotation that preserves the testnet marker.

Assert no output contains `api.hyperliquid.xyz`, `"network":"mainnet"`, or a returns-v1 path.

- [ ] **Step 2: Run the end-to-end fixture and confirm RED**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-end-to-end.test.ts`

Expected: FAIL until the operational configuration is closed over the profile and anchored-storage requirement.

- [ ] **Step 3: Update shipped configuration and runbooks**

Replace `RESEARCH_INFO_API_URL` and independent public registry settings with:

```dotenv
RESEARCH_NETWORK_PROFILE_FILE=../registry/research-network.testnet.json
RESEARCH_ROOT=/opt/hype/research/testnet
```

Set `Environment=RESEARCH_REQUIRE_ANCHORED_FS=1` in every shipped research systemd service. Keep the writer/keeper separation, persistent-root preservation, rotation behavior, and backup instructions. Document that macOS local fixtures use the compatibility backend and cannot satisfy Linux operational containment acceptance.

In `DEPLOY.md`, make the future mainnet checklist explicit but non-executable: add reviewed mainnet profile/registries, enable mainnet in code, use a fresh root, deploy contracts, collect fresh evidence, validate, and promote. Do not add mainnet values or commands now.

- [ ] **Step 4: Run the end-to-end fixture and all repository gates**

Run: `cd writer && ./node_modules/.bin/tsx --test test/research-end-to-end.test.ts`

Run: `forge build`

Run: `forge test`

Run: `cd writer && npm run check`

Run: `cd writer && npm run research:check`

Run: `cd keeper && npm run check`

Run: `node --test tools/rotate-lib.test.mjs`

Run: `./scripts/verify.sh`

Run: `git diff --check`

Expected: every command exits 0. Preserve and report raw failing output if any command is red; do not claim local completion.

- [ ] **Step 5: Audit shipped files for forbidden mainnet research inputs**

Run:

```bash
rg -n 'api\.hyperliquid\.xyz|sourceNetwork.*mainnet|RESEARCH_INFO_API_URL|returns-v1' registry writer/src writer/.env.example ops DEPLOY.md
```

Expected: no enabled testnet configuration, runtime default, persisted fixture, or service references a mainnet research input. Allowed hits are limited to fail-closed hostname validation, explicit v1 rejection tests, and the future-mainnet explanatory checklist; inspect each hit.

- [ ] **Step 6: Commit local corrective-wave proof**

```bash
git add writer/.env.example ops/systemd/hype-research-collector.service ops/systemd/hype-research-daily.service ops/systemd/hype-research-backup.service DEPLOY.md docs/research/testnet-correlation-verification.md writer/test/research-end-to-end.test.ts writer/test/research-operations.test.ts
git commit -m "test(research): verify testnet-only pipeline"
```

---

### Task 9: Run Separately Approved Ubuntu Testnet Acceptance

**Precondition:** Stop and obtain explicit approval immediately before this task because it writes shared testnet state, may promote a champion, restarts the testnet writer, and sends/mints a testnet quote. It never touches mainnet.

**Files:**
- Modify after evidence exists: `docs/research/testnet-correlation-verification.md`

- [ ] **Step 1: Verify the target before mutation**

On the Ubuntu testnet host, record the checked-out commit, selected profile hash, chain ID 998, public vault address, deploy block, clean/fresh `/opt/hype/research/testnet` root, and `RESEARCH_REQUIRE_ANCHORED_FS=1`. Abort on any mismatch.

- [ ] **Step 2: Prove the real Linux containment regression**

Run the persistence suite on Ubuntu with anchored storage required, including intermediate-directory and destination-swap cases. Confirm it uses `/proc/self/fd`, rejects symlink substitution, and exits 0. A macOS compatibility pass is not sufficient evidence.

- [ ] **Step 3: Run the bounded testnet research flow**

Run collect, derive, calibrate, replay, and report using only `registry/research-network.testnet.json`. Record command output, manifests/hashes, ignored boundary counts, direct/fallback/quarantined pairs, exclusion counts, validation verdict, and immutable operation records. Inspect before promotion.

- [ ] **Step 4: Promote and exercise only the testnet writer**

After inspecting a Supported candidate, manually promote it, restart only the writer, verify health/profile/champion identities, request and mint a testnet quote, then join it to a testnet resolution or void. Do not restart or stop the keeper and do not access a mainnet endpoint.

- [ ] **Step 5: Prove durability and record evidence**

Verify writer restart, nightly market rotation, and backup preserve the testnet research root and champion. Confirm the report shows direct/fallback/quarantined evidence plus any preceding 30-day failures. Add exact commands, exit codes, public IDs, hashes, and redacted output to `testnet-correlation-verification.md`.

- [ ] **Step 6: Re-run local gates and commit only recorded evidence**

Run the full Task 8 gate list again at the tested commit plus documentation change. If green:

```bash
git add docs/research/testnet-correlation-verification.md
git commit -m "docs(research): record testnet acceptance"
```

---

## Completion Boundary

Tasks 1-8 establish locally verified implementation readiness. They do **not** prove that the system is operating on testnet. Task 9 is the separately approved operational acceptance that proves collect-to-report, promotion, quote, join, and durability on testnet. Neither state is mainnet readiness or production profitability evidence.
