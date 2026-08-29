import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { admitPair, calibrate, calibrationPairSample, fitHierarchical, type CalibrationInput } from "../src/research/calibration.js";
import type { LoadedResearchNetworkProfile } from "../src/research/network.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import type { CandleRecord, DataManifest, SourceEntry, SourceRegistry } from "../src/research/types.js";
import type { ReturnRecord } from "../src/research/returns.js";

const source = (underlying: string, cluster: SourceEntry["cluster"]): SourceEntry => ({
  schemaVersion: 1, underlying, sourceNetwork: "testnet", sourceCoin: underlying, cluster,
  calendar: "continuous", measurementEnabled: true, fallbackEligible: false,
});

function baseline(sources: SourceEntry[], clusters: Record<string, Record<string, { global: number; cluster: number; underlying: number }>>): LoadedResearchNetworkProfile {
  const registry: SourceRegistry = { schemaVersion: 2, network: "testnet", sources };
  const profile = { schemaVersion: 1, network: "testnet", infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "correlations.json" } as const;
  const marketRegistryRaw = canonicalJson({ schemaVersion: 1, network: "testnet", markets: [] });
  const deployment = { schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: "0x1111111111111111111111111111111111111111", parlayDeployBlock: "1" } as const;
  const baselineCorrelationRaw = canonicalJson({ network: "testnet", fallbackReason: "operator-reviewed-testnet-bootstrap", clusters });
  return {
    profile, profileSha256: sha256(canonicalJson(profile)), sources: registry, sourceRegistrySha256: sha256(canonicalJson(registry)),
    marketRegistryRaw, marketRegistrySha256: sha256(marketRegistryRaw), deployment, deploymentRegistrySha256: sha256(canonicalJson(deployment)),
    baselineCorrelationRaw, baselineCorrelationSha256: sha256(baselineCorrelationRaw),
  };
}

const admissionSources = [
  { ...source("BTC", "crypto"), fallbackEligible: true },
  { ...source("ZEC", "crypto"), measurementEnabled: false, fallbackEligible: true },
  { ...source("AAPL", "equity"), fallbackEligible: true },
  { ...source("TSLA", "equity"), fallbackEligible: true },
];
const admissionBaseline = baseline(admissionSources, {
  crypto: { BTC: { global: 0.3, cluster: 0.9, underlying: 0.1 }, ZEC: { global: 0.3, cluster: 0.8, underlying: 0.2 } },
  equity: { AAPL: { global: 0, cluster: 0, underlying: 0 }, TSLA: { global: 0.3, cluster: 0.7, underlying: 0.2 } },
});

test("pair admission orders direct quality before exact static fallback and quarantine", () => {
  const [btc, zec, aapl, tsla] = admissionSources;
  assert.deepEqual(admitPair(btc, tsla, { network: "testnet", eligible: true, correlation: 0.42, reason: null }, admissionBaseline), { kind: "direct", correlation: 0.42, reason: "testnet-quality-passed" });
  assert.deepEqual(admitPair(zec, btc, null, admissionBaseline), { kind: "fallback", correlation: 0.81, reason: "operator-reviewed-testnet-bootstrap" });
  assert.deepEqual(admitPair(aapl, tsla, { network: "testnet", eligible: false, correlation: null, reason: "insufficient-pair-quality" }, admissionBaseline), { kind: "fallback", correlation: 0, reason: "operator-reviewed-testnet-bootstrap" });
  assert.deepEqual(admitPair(tsla, aapl, { network: "testnet", eligible: false, correlation: null, reason: "trailing-source-stale" }, admissionBaseline), { kind: "fallback", correlation: 0, reason: "operator-reviewed-testnet-bootstrap" });

  const absent = { ...source("ABSENT", "crypto"), fallbackEligible: true };
  assert.deepEqual(admitPair(absent, btc, null, admissionBaseline), { kind: "quarantined", reason: "insufficient-pair-quality" });
  assert.deepEqual(admitPair({ ...zec, fallbackEligible: false }, btc, null, admissionBaseline), { kind: "quarantined", reason: "ineligible-source" });
});

test("pair admission rejects mixed baseline identity and never admits wrong-network direct evidence", () => {
  const [btc, zec] = admissionSources;
  assert.throws(() => admitPair(zec, btc, null, { ...admissionBaseline, baselineCorrelationSha256: "0".repeat(64) }), /baseline correlation hash/);
  assert.throws(() => admitPair(zec, btc, null, { ...admissionBaseline, profile: { ...admissionBaseline.profile, network: "mainnet" } }), /testnet/);
  assert.deepEqual(admitPair(zec, btc, { network: "mainnet", eligible: true, correlation: 0.99, reason: null }, admissionBaseline), { kind: "fallback", correlation: 0.81, reason: "operator-reviewed-testnet-bootstrap" });
});

test("hierarchical fit is non-negative and preserves the explained-variance ceiling", () => {
  const fit = fitHierarchical([
    [1, 0.5, -0.2],
    [0.5, 1, 0.2],
    [-0.2, 0.2, 1],
  ], [source("B", "crypto"), source("A", "crypto"), source("C", "equity")]);
  assert.deepEqual(Object.keys(fit.loadings.crypto), ["A", "B"]);
  for (const cluster of Object.values(fit.loadings)) {
    for (const loading of Object.values(cluster)) {
      assert.ok(loading.global >= 0 && loading.cluster >= 0 && loading.underlying >= 0);
      assert.ok(loading.global ** 2 + loading.cluster ** 2 + loading.underlying ** 2 <= 0.99 + 1e-12);
      assert.equal(loading.underlyingBasis, "structural-underlying");
    }
  }
  assert.ok(fit.implied.flat().every((value) => value >= 0));
});

test("hierarchical fit jointly caps global and cluster explained variance", () => {
  const fit = fitHierarchical([
    [1, 1, 0.5],
    [1, 1, 0.5],
    [0.5, 0.5, 1],
  ], [source("A", "crypto"), source("B", "crypto"), source("C", "equity")]);
  for (const loading of Object.values(fit.loadings.crypto)) assert.ok(loading.global ** 2 + loading.cluster ** 2 <= 0.99 + 1e-12);
});

const AS_OF_MS = Date.parse("2026-08-28T12:00:00.000Z");
const HOUR = 3_600_000;
const fixtureReturns = readFileSync(new URL("./fixtures/research/returns-small.jsonl", import.meta.url), "utf8");

function calibrationRoot(options: { staleParticipatingUnderlying?: string; constantUnderlying?: string } = {}): { root: string; input: CalibrationInput; profileFile: string } {
  const root = mkdtempSync(join(tmpdir(), "hype-research-calibration-"));
  const sources: SourceRegistry = {
    schemaVersion: 2,
    network: "testnet",
    sources: [source("A", "crypto"), source("B", "equity"), source("C", "commodity")].map((entry) => ({ ...entry, fallbackEligible: true })),
  };
  const profile = baseline(sources.sources, {
    crypto: { A: { global: 0.3, cluster: 0.8, underlying: 0.2 } },
    equity: { B: { global: 0.3, cluster: 0.7, underlying: 0.3 } },
    commodity: { C: { global: 0.3, cluster: 0.6, underlying: 0.4 } },
  });
  const registryBytes = canonicalJson(sources);
  const registryHash = sha256(registryBytes);
  const latest = AS_OF_MS - 6 * HOUR;
  const candleTimes = options.staleParticipatingUnderlying ? [latest - 2 * HOUR, latest - HOUR, latest] : [latest - HOUR, latest];
  const candles: CandleRecord[] = sources.sources.flatMap((entry) => candleTimes.map((openTimeMs, index) => ({
    schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "testnet", underlying: entry.underlying,
    sourceCoin: entry.sourceCoin, interval: "1h", openTimeMs, closeTimeMs: openTimeMs + HOUR - 1,
    open: String(100 + index), high: String(100 + index), low: String(100 + index),
    close: String(100 + index), volume: "1", tradeCount: 1, retrievedAtMs: AS_OF_MS,
  })));
  const rawBytes = gzipSync(`${candles.map(canonicalJson).join("\n")}\n`);
  const rawPath = "raw/candles/2026/08/28/fixture.jsonl.gz";
  mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
  mkdirSync(join(root, "raw", "candles", "2026", "08", "28"), { recursive: true });
  mkdirSync(join(root, "derived", "returns-v2", "returns", "2026", "08", "28"), { recursive: true });
  mkdirSync(join(root, "derived", "returns-v2", "exclusions", "2026", "08", "28"), { recursive: true });
  writeFileSync(join(root, "facts", "source-registries", `${registryHash}.json`), registryBytes);
  writeFileSync(join(root, rawPath), rawBytes);
  const manifest: DataManifest = {
    schemaVersion: 1,
    createdAt: "2026-08-28T12:00:00.000Z",
    sourceRegistrySha256: registryHash,
    sourceRange: { fromMs: candleTimes[0], toMs: latest + HOUR - 1 },
    underlyings: Object.fromEntries(sources.sources.map((entry) => [entry.underlying, {
      rows: candleTimes.length, firstUsableObservationMs: candleTimes[0], lastUsableObservationMs: latest, missingIntervals: [],
    }])),
    files: [
      { path: `facts/source-registries/${registryHash}.json`, bytes: Buffer.byteLength(registryBytes), sha256: registryHash, rows: 1, schemaVersion: 1 },
      { path: rawPath, bytes: rawBytes.length, sha256: sha256(rawBytes), rows: candles.length, schemaVersion: 1 },
    ],
  };
  const derivedText = options.staleParticipatingUnderlying || options.constantUnderlying
    ? `${fixtureReturns.trim().split("\n").map((line) => {
      const row = JSON.parse(line) as unknown as Record<string, unknown> & { underlying: string; interval: string; sourceKeys: string[]; value: number; observationCloseTimeMs: number };
      if (row.underlying === options.staleParticipatingUnderlying) {
        row.sourceKeys = [`testnet:${row.underlying}:1h:${latest - 2 * HOUR}`];
        row.observationCloseTimeMs = latest - HOUR - 1;
      }
      if (row.underlying === options.constantUnderlying) row.value = 0;
      return canonicalJson(row);
    }).join("\n")}\n`
    : fixtureReturns;
  const derivedBytes = gzipSync(derivedText);
  const derivedPath = "derived/returns-v2/returns/2026/08/28/fixture.jsonl.gz";
  const exclusionPath = "derived/returns-v2/exclusions/2026/08/28/fixture.jsonl.gz";
  const exclusionBytes = gzipSync("");
  writeFileSync(join(root, derivedPath), derivedBytes);
  writeFileSync(join(root, exclusionPath), exclusionBytes);
  const derivedManifest = {
    schemaVersion: 2, network: "testnet", transformationVersion: "returns-v2",
    dataManifestSha256: sha256(canonicalJson(manifest)), sourceRegistrySha256: registryHash,
    window: { asOfMs: AS_OF_MS, lookbackMs: 180 * 86_400_000 },
    returns: { path: derivedPath, sha256: sha256(derivedBytes), rows: 450 },
    exclusions: { path: exclusionPath, sha256: sha256(exclusionBytes), rows: 0 },
  };
  const derivedManifestPath = join(root, `${derivedPath}.manifest.json`);
  writeFileSync(derivedManifestPath, canonicalJson(derivedManifest));
  writeFileSync(join(root, "manifest.json"), canonicalJson(manifest));
  const profileFile = join(root, "profile.json");
  writeFileSync(profileFile, canonicalJson(profile.profile));
  writeFileSync(join(root, "sources.json"), canonicalJson(profile.sources));
  writeFileSync(join(root, "markets.json"), profile.marketRegistryRaw);
  writeFileSync(join(root, "deployment.json"), canonicalJson(profile.deployment));
  writeFileSync(join(root, "correlations.json"), profile.baselineCorrelationRaw);
  return { root, input: { root, manifest, derivedManifestPath, profile }, profileFile };
}

function rewriteReturns(fixture: ReturnType<typeof calibrationRoot>, change: (row: Record<string, unknown>) => void): void {
  const manifest = JSON.parse(readFileSync(fixture.input.derivedManifestPath, "utf8")) as { returns: { path: string; sha256: string; rows: number } };
  const path = join(fixture.root, manifest.returns.path);
  const rows = gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  change(rows[0]);
  const bytes = gzipSync(`${rows.map(canonicalJson).join("\n")}\n`);
  writeFileSync(path, bytes);
  manifest.returns.sha256 = sha256(bytes);
  writeFileSync(fixture.input.derivedManifestPath, canonicalJson(manifest));
}

function rewriteAllReturns(fixture: ReturnType<typeof calibrationRoot>, change: (row: Record<string, unknown>) => void): void {
  const manifest = JSON.parse(readFileSync(fixture.input.derivedManifestPath, "utf8")) as { returns: { path: string; sha256: string; rows: number } };
  const path = join(fixture.root, manifest.returns.path);
  const rows = gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  rows.forEach(change);
  const bytes = gzipSync(`${rows.map(canonicalJson).join("\n")}\n`);
  writeFileSync(path, bytes);
  manifest.returns.sha256 = sha256(bytes);
  writeFileSync(fixture.input.derivedManifestPath, canonicalJson(manifest));
}

test("calibration uses daily settlement mode when either same-cluster source has a session", () => {
  const session = { ...source("B", "crypto"), calendar: "session" as const, session: { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], openLocal: "09:00", closeLocal: "17:00", closedDates: [] } };
  const sample = calibrationPairSample([], source("A", "crypto"), session, { asOfMs: AS_OF_MS, lookbackMs: 180 * 86_400_000 });
  assert.equal(sample.mode, "daily");
});

test("calibration rejects returns-v1 and missing or mismatched causal identity", () => {
  for (const mutate of [
    (row: Record<string, unknown>) => Object.assign(row, { schemaVersion: 1, transformationVersion: "returns-v1", interval: "1d" }),
    (row: Record<string, unknown>) => { delete row.observationCloseTimeMs; },
    (row: Record<string, unknown>) => { row.network = "mainnet"; },
  ]) {
    const fixture = calibrationRoot();
    try {
      rewriteReturns(fixture, mutate);
      assert.throws(() => calibrate(fixture.input), /returns-v2|observationCloseTimeMs|network/);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("calibration rejects a derived manifest without the exclusion partition or hash", () => {
  for (const remove of ["partition", "hash"] as const) {
    const fixture = calibrationRoot();
    try {
      const manifest = JSON.parse(readFileSync(fixture.input.derivedManifestPath, "utf8")) as { exclusions?: { sha256?: string } };
      if (remove === "partition") delete manifest.exclusions;
      else delete manifest.exclusions!.sha256;
      writeFileSync(fixture.input.derivedManifestPath, canonicalJson(manifest));
      assert.throws(() => calibrate(fixture.input), /exclusions/);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("calibration preserves signed negatives and writes a byte-identical immutable candidate", () => {
  const first = calibrationRoot();
  const second = calibrationRoot();
  try {
    const artifact = calibrate(first.input);
    const rerun = calibrate(first.input);
    const other = calibrate(second.input);
    const firstBytes = readFileSync(join(first.root, "artifacts", "candidates", `${artifact.modelVersion}.json`));
    const secondBytes = readFileSync(join(second.root, "artifacts", "candidates", `${other.modelVersion}.json`));
    assert.deepEqual(rerun, artifact);
    assert.equal(firstBytes.equals(secondBytes), true);
    assert.equal(firstBytes.toString("utf8"), readFileSync(new URL("./fixtures/research/expected-candidate.json", import.meta.url), "utf8"));
    assert.ok(artifact.quality.clippedNegativePairs.length > 0);
    assert.ok(artifact.quality.signedPsdTarget.flat().some((value) => value < 0));
    assert.ok(artifact.quality.pairEligibility.every((pair) => pair.status === "direct"));
    assert.deepEqual(Object.keys(artifact.quality.diagnosticMatrices), ["30", "90", "180"]);
    assert.equal(JSON.parse(readFileSync(join(first.root, "state", "calibrator.json"), "utf8")).status, "succeeded");
    writeFileSync(join(first.root, "artifacts", "candidates", `${artifact.modelVersion}.json`), "different");
    assert.throws(() => calibrate(first.input), /different bytes/);
    assert.equal(JSON.parse(readFileSync(join(first.root, "state", "calibrator.json"), "utf8")).status, "failed");
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("an admitted direct pair is unchanged when unrelated pair evidence changes", () => {
  const first = calibrationRoot();
  const second = calibrationRoot();
  try {
    rewriteAllReturns(second, (row) => {
      if (row.underlying === "C") row.value = -(row.value as number);
    });
    const original = calibrate(first.input).directPairs.find((entry) => entry.pair[0] === "A" && entry.pair[1] === "B");
    const changed = calibrate(second.input).directPairs.find((entry) => entry.pair[0] === "A" && entry.pair[1] === "B");
    assert.equal(changed?.correlation, original?.correlation);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("calibration rejects a derived return whose immutable manifest closure changed", () => {
  const fixture = calibrationRoot();
  try {
    const derived = JSON.parse(readFileSync(fixture.input.derivedManifestPath, "utf8")) as { returns: { path: string } };
    writeFileSync(join(fixture.root, derived.returns.path), "changed");
    assert.throws(() => calibrate(fixture.input), /derived manifest returns hash mismatch/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("freshness ignores a late raw candle absent from participating return source keys", () => {
  const fixture = calibrationRoot({ staleParticipatingUnderlying: "A" });
  try {
    const artifact = calibrate(fixture.input);
    assert.equal(artifact.quality.quarantinedUnderlyings.some((entry) => entry.underlying === "A"), false);
    assert.ok(artifact.quality.pairEligibility.filter((entry) => entry.pair.includes("A")).every((entry) => entry.status === "fallback" && entry.reason === "operator-reviewed-testnet-bootstrap"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a constant synchronized pair takes the pair-local fallback instead of aborting calibration", () => {
  const fixture = calibrationRoot({ constantUnderlying: "B" });
  try {
    const artifact = calibrate(fixture.input);
    assert.deepEqual(artifact.quality.pairEligibility, [
      { pair: ["A", "B"], status: "fallback", reason: "operator-reviewed-testnet-bootstrap" },
      { pair: ["A", "C"], status: "direct", reason: "testnet-quality-passed" },
      { pair: ["B", "C"], status: "fallback", reason: "operator-reviewed-testnet-bootstrap" },
    ]);
    assert.deepEqual(artifact.fallbackPairs, [
      { pair: ["A", "B"], correlation: 0.09, reason: "operator-reviewed-testnet-bootstrap" },
      { pair: ["B", "C"], correlation: 0.09, reason: "operator-reviewed-testnet-bootstrap" },
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("calibrate CLI writes the deterministic candidate from explicit immutable inputs", () => {
  const fixture = calibrationRoot();
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "calibrate"], {
      cwd: resolve(import.meta.dirname, ".."), encoding: "utf8",
      env: { ...process.env, RESEARCH_ROOT: fixture.root, RESEARCH_NETWORK_PROFILE: fixture.profileFile, RESEARCH_MANIFEST_FILE: join(fixture.root, "manifest.json"), RESEARCH_DERIVED_MANIFEST_FILE: fixture.input.derivedManifestPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2026-08-28\.398fc2b3/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
