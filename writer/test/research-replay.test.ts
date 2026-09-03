import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fittedArtifact } from "./fixtures/research/fitted.js";
import {
  brier,
  blockBootstrap,
  filteredHistoricalSimulation,
  fitReplayDependence,
  forecastAt,
  logLoss,
  replayOrigins,
  runReplay,
  loadReplaySourceRegistry,
  scoreForecasts,
  selectDegreesOfFreedom,
  signedTCopula,
  studentTCdf,
  studentTInv,
  syntheticEvents,
  ticketStress,
  assertReplayProfileIdentity,
  type ReplaySeries,
} from "../src/research/replay.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import { pairCorrelation } from "../src/correlation.js";
import type { CorrelationArtifact, DerivedManifestV2, SourceEntry } from "../src/research/types.js";
import { researchRootIdentity, type LoadedResearchNetworkProfile } from "../src/research/network.js";

const DAY = 86_400_000;
const ORIGIN = Date.parse("2026-08-01T00:00:00.000Z");

const source = (underlying: string, cluster: SourceEntry["cluster"], calendar: SourceEntry["calendar"] = "continuous"): SourceEntry => ({
  schemaVersion: 1,
  underlying,
  sourceNetwork: "testnet",
  sourceCoin: underlying,
  cluster,
  calendar,
  ...(calendar === "session" ? { session: { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], openLocal: "09:00", closeLocal: "17:00", closedDates: [] } } : {}),
  measurementEnabled: true,
  fallbackEligible: false,
});

function dailySeries(days = 130): ReplaySeries {
  const sources = [source("A", "crypto"), source("B", "crypto"), source("C", "equity", "session"), source("D", "equity", "session")];
  const rows = sources.flatMap((entry, asset) => Array.from({ length: days }, (_, index) => {
    const timestampMs = ORIGIN - (days - index) * DAY;
    return {
      schemaVersion: 2 as const,
      transformationVersion: "returns-v2" as const,
      network: "testnet" as const,
      underlying: entry.underlying,
      interval: "daily" as const,
      timestampMs,
      observationCloseTimeMs: timestampMs + DAY - 1,
      sessionDate: new Date(timestampMs).toISOString().slice(0, 10),
      value: 0.002 * (asset + 1) + Math.sin(index / (3 + asset)) * 0.03,
      sourceKeys: [`fixture:${entry.underlying}:${timestampMs}`],
    };
  }));
  return { network: "testnet", rows, exclusions: [], sources, manifestHash: "a".repeat(64) };
}

function candidateFor(series: ReplaySeries, modelVersion = "fixture", signedPsdTarget?: number[][]): CorrelationArtifact {
  const matrixOrder = series.sources.filter((entry) => entry.measurementEnabled).map((entry) => entry.underlying);
  const clusters: CorrelationArtifact["clusters"] = {};
  for (const entry of series.sources) (clusters[entry.cluster] ??= {})[entry.underlying] = { global: 0.1, cluster: 0.2, underlying: 0.3, underlyingBasis: "structural-underlying" };
  const directPairs = matrixOrder.flatMap((left, index) => matrixOrder.slice(index + 1).map((right) => ({ pair: [left, right] as [string, string], correlation: 0, reason: "testnet-quality-passed" as const })));
  return {
    schemaVersion: 2, network: "testnet", profileSha256: "b".repeat(64), marketRegistrySha256: "c".repeat(64), deploymentRegistrySha256: "e".repeat(64), baselineCorrelationSha256: "f".repeat(64),
    modelVersion, modelFamily: "hierarchical-gaussian-factor", createdAt: "2026-08-01T00:00:00.000Z", dataAsOf: "2026-07-31T00:00:00.000Z",
    dataManifestSha256: series.manifestHash, sourceRegistrySha256: "d".repeat(64), directPairs, fallbackPairs: [], quarantinedPairs: [],
    policy: { lookbackDays: 180, halfLifeDays: 45, diagnosticWindowsDays: [30, 90, 180], minHourly: 1000, minDaily: 90, minCoverage: 0.8, maxProjectionError: 0.10 },
    quality: { matrixOrder, eligibleUnderlyings: matrixOrder, quarantinedUnderlyings: series.sources.filter((entry) => !entry.measurementEnabled).map((entry) => ({ underlying: entry.underlying, reason: "fixture-ineligible" })), pairEligibility: matrixOrder.flatMap((left, index) => matrixOrder.slice(index + 1).map((right) => ({ pair: [left, right] as [string, string], status: "direct" as const, reason: "fixture" }))), lastUsableObservationMs: Object.fromEntries(matrixOrder.map((underlying) => [underlying, ORIGIN - DAY])), pairDiagnostics: [], maxProjectionError: 0, highamProjectionDelta: 0, clippedNegativePairs: [], signedPsdTarget: signedPsdTarget ?? matrixOrder.map((_, row) => matrixOrder.map((__, column) => row === column ? 1 : 0)), diagnosticMatrices: { "30": [], "90": [], "180": [] } },
    validation: { status: "pending" },
    clusters,
  };
}

function baselineFor(series: ReplaySeries): { clusters: Record<string, Record<string, { global: number; cluster: number; underlying: number }>> } {
  const baseline = { clusters: Object.fromEntries(series.sources.map((entry) => [entry.cluster, {}])) } as { clusters: Record<string, Record<string, { global: number; cluster: number; underlying: number }>> };
  for (const entry of series.sources) baseline.clusters[entry.cluster][entry.underlying] = { global: 0.1, cluster: 0.2, underlying: 0.3 };
  return baseline;
}

function replayProfile(series: ReplaySeries): LoadedResearchNetworkProfile {
  const sources = { schemaVersion: 2 as const, network: "testnet" as const, sources: series.sources };
  const profileValue = { schemaVersion: 1 as const, network: "testnet" as const, infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "correlations.json" };
  const marketRegistryRaw = canonicalJson({ schemaVersion: 1, network: "testnet", markets: [] });
  const deployment = { schemaVersion: 1 as const, network: "testnet" as const, evmChainId: 998, parlayVault: "0x1111111111111111111111111111111111111111" as const, parlayDeployBlock: "1" };
  const baselineCorrelationRaw = canonicalJson({ network: "testnet", fallbackReason: "operator-reviewed-testnet-bootstrap", ...baselineFor(series) });
  return {
    profile: profileValue, profileSha256: sha256(canonicalJson(profileValue)), sources, sourceRegistrySha256: sha256(canonicalJson(sources)),
    marketRegistryRaw, marketRegistrySha256: sha256(marketRegistryRaw), deployment, deploymentRegistrySha256: sha256(canonicalJson(deployment)),
    baselineCorrelationRaw, baselineCorrelationSha256: sha256(baselineCorrelationRaw),
  };
}

function replayInput(root: string, candidate: CorrelationArtifact, series: ReplaySeries, seed: string, extra: Record<string, unknown> = {}) {
  const profile = replayProfile(series);
  const marker = join(root, "network-profile.json");
  if (!existsSync(marker)) writeFileSync(marker, `${canonicalJson(researchRootIdentity(profile))}\n`);
  mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
  writeFileSync(join(root, "facts", "source-registries", `${profile.sourceRegistrySha256}.json`), canonicalJson(profile.sources));
  const returnsPath = "derived/returns-v2/returns/fixture.jsonl.gz";
  const exclusionsPath = "derived/returns-v2/exclusions/fixture.jsonl.gz";
  const returnsBytes = gzipSync(series.rows.map((row) => canonicalJson(row)).join("\n") + (series.rows.length ? "\n" : ""));
  const exclusionBytes = gzipSync(series.exclusions.map((row) => canonicalJson(row)).join("\n") + (series.exclusions.length ? "\n" : ""));
  mkdirSync(join(root, "derived", "returns-v2", "returns"), { recursive: true });
  mkdirSync(join(root, "derived", "returns-v2", "exclusions"), { recursive: true });
  writeFileSync(join(root, returnsPath), returnsBytes);
  writeFileSync(join(root, exclusionsPath), exclusionBytes);
  const derivedManifest: DerivedManifestV2 = {
    schemaVersion: 2, network: series.network, transformationVersion: "returns-v2",
    dataManifestSha256: series.manifestHash, sourceRegistrySha256: profile.sourceRegistrySha256,
    window: { asOfMs: ORIGIN, lookbackMs: 180 * DAY },
    returns: { path: returnsPath, sha256: sha256(returnsBytes), rows: series.rows.length },
    exclusions: { path: exclusionsPath, sha256: sha256(exclusionBytes), rows: series.exclusions.length },
  };
  const derivedManifestPath = "derived/returns-v2/fixture.manifest.json";
  writeFileSync(join(root, derivedManifestPath), canonicalJson(derivedManifest));
  return {
    root,
    candidate: { ...candidate, network: profile.profile.network, profileSha256: profile.profileSha256, sourceRegistrySha256: profile.sourceRegistrySha256, marketRegistrySha256: profile.marketRegistrySha256, deploymentRegistrySha256: profile.deploymentRegistrySha256, baselineCorrelationSha256: profile.baselineCorrelationSha256 },
    inputManifestSha256: series.manifestHash,
    derivedManifestPath,
    profile,
    series,
    seed,
    ...extra,
  };
}

test("replay rejects candidate and return identities outside the selected profile", () => {
  const series = dailySeries();
  const candidate = candidateFor(series);
  const profile = {
    profile: { network: "testnet" },
    profileSha256: candidate.profileSha256,
    sourceRegistrySha256: candidate.sourceRegistrySha256,
    marketRegistrySha256: candidate.marketRegistrySha256,
    deploymentRegistrySha256: candidate.deploymentRegistrySha256,
    baselineCorrelationSha256: candidate.baselineCorrelationSha256,
  } as LoadedResearchNetworkProfile;
  assert.doesNotThrow(() => assertReplayProfileIdentity(profile, candidate, "testnet"));
  assert.throws(() => assertReplayProfileIdentity(profile, { ...candidate, profileSha256: "0".repeat(64) }, "testnet"), /profile hash mismatch/);
  assert.throws(() => assertReplayProfileIdentity(profile, candidate, "mainnet"), /return network mismatch/);
});

test("future mutation cannot change an earlier forecast", () => {
  const series = dailySeries();
  const before = forecastAt(ORIGIN, series);
  const changed = forecastAt(ORIGIN, {
    ...series,
    rows: series.rows.map((row) => row.timestampMs > ORIGIN ? { ...row, value: row.value + 100 } : row),
  });
  assert.deepEqual(changed, before);
  const future = series.sources.flatMap((entry, asset) => [1, 2, 3, 4].map((days) => ({
    schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const,
    timestampMs: ORIGIN + days * DAY, observationCloseTimeMs: ORIGIN + days * DAY + DAY - 1, sessionDate: new Date(ORIGIN + days * DAY).toISOString().slice(0, 10), value: 0.01 * (asset + days), sourceKeys: [],
  })));
  const selected = syntheticEvents(ORIGIN, series, future).map(({ outcome: _, ...ticket }) => ticket);
  const mutated = syntheticEvents(ORIGIN, series, future.map((row) => ({ ...row, value: row.value + 100 }))).map(({ outcome: _, ...ticket }) => ticket);
  assert.deepEqual(mutated, selected);

  const notYetObserved = series.sources.map((entry, asset) => ({
    schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const,
    timestampMs: ORIGIN, observationCloseTimeMs: ORIGIN + DAY, sessionDate: new Date(ORIGIN).toISOString().slice(0, 10), value: 100 + asset, sourceKeys: [],
  }));
  assert.deepEqual(forecastAt(ORIGIN, { ...series, rows: [...series.rows, ...notYetObserved] }), before);
});

test("replay loads the immutable canonical source-registry fact instead of mutable pretty bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-source-fact-"));
  try {
    const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source("A", "crypto"), source("B", "crypto")] };
    const canonical = canonicalJson(registry);
    const sourceHash = sha256(canonical);
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    writeFileSync(join(root, "facts", "source-registries", `${sourceHash}.json`), canonical);
    const pretty = JSON.stringify(registry, null, 2);
    assert.notEqual(sha256(pretty), sourceHash);
    assert.deepEqual(loadReplaySourceRegistry(root, sourceHash), registry.sources);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historical dependence enforces candidate quarantine, pair quality, and explicit fallback policy", () => {
  const complete = dailySeries(130);
  const quarantined = candidateFor(complete, "policy");
  quarantined.quality.eligibleUnderlyings = quarantined.quality.eligibleUnderlyings.filter((underlying) => underlying !== "C");
  quarantined.quality.quarantinedUnderlyings.push({ underlying: "C", reason: "fixture-quarantine" });
  const fit = fitReplayDependence(complete.rows, complete.sources, quarantined, ORIGIN - DAY);
  assert.equal(fit.sources.some((entry) => entry.underlying === "C"), false);

  const sources = [source("A", "crypto"), source("B", "equity")];
  const sparse = { ...dailySeries(89), sources, rows: dailySeries(89).rows.filter((row) => row.underlying === "A" || row.underlying === "B") };
  const direct = candidateFor(sparse, "direct");
  assert.equal(fitReplayDependence(sparse.rows, sources, direct, ORIGIN - DAY).admittedPairs.has("A:B"), false);
  const fallbackSources = sources.map((entry) => ({ ...entry, fallbackEligible: true }));
  const fallbackSeries = { ...sparse, sources: fallbackSources };
  const fallback = candidateFor(fallbackSeries, "fallback");
  fallback.quality.pairEligibility = [{ pair: ["A", "B"], status: "fallback", reason: "operator-reviewed" }];
  fallback.directPairs = [];
  fallback.fallbackPairs = [{ pair: ["A", "B"], correlation: 0.25, reason: "operator-reviewed-testnet-bootstrap" }];
  const fallbackFit = fitReplayDependence(sparse.rows, fallbackSources, fallback, ORIGIN - DAY);
  assert.equal(fallbackFit.admittedPairs.has("A:B"), true);
  assert.ok(Math.abs(fallbackFit.matrix[0][1] - 0.25) <= 1e-9, String(fallbackFit.matrix[0][1]));
});

test("replay dependence fits the calibrator's signed factor model and keeps negative cross-cluster loadings", () => {
  const sources = [source("A", "crypto"), source("B", "equity")];
  const rows = sources.flatMap((entry, asset) => Array.from({ length: 170 }, (_, index) => {
    const timestampMs = ORIGIN - (170 - index) * DAY;
    const common = Math.sin(index / 4.3) + Math.cos(index / 9.7);
    return {
      schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const,
      timestampMs, observationCloseTimeMs: timestampMs + DAY - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10),
      value: (asset === 0 ? common : -common) * 0.02 + 0.002 * Math.sin(index / (1.3 + asset)), sourceKeys: [],
    };
  }));
  const series = { network: "testnet" as const, rows, exclusions: [], sources, manifestHash: "a".repeat(64) };
  const fit = fitReplayDependence(series.rows, series.sources, candidateFor(series, "signed"), ORIGIN - DAY);
  assert.ok(fit.matrix[0][1] < -0.9, String(fit.matrix[0][1]));
  const loadings = fit.sources.map((entry) => fit.loadings[entry.cluster][entry.underlying]);
  assert.ok(Math.abs(pairCorrelation(loadings[0], loadings[1], false, false) - fit.matrix[0][1]) <= 1e-12);
  assert.ok(loadings.every((loading) => loading.underlyingBasis === "structural-underlying"));
});

test("replay dependence uses daily returns for a same-cluster session pair", () => {
  const complete = dailySeries(200);
  const sources = complete.sources.filter((entry) => entry.underlying === "C" || entry.underlying === "D");
  const series = { ...complete, sources, rows: complete.rows.filter((row) => sources.some((source) => source.underlying === row.underlying)) };
  assert.equal(fitReplayDependence(series.rows, series.sources, candidateFor(series, "session-mode"), ORIGIN - DAY).admittedPairs.has("C:D"), true);
});

test("replay never substitutes daily rows for policy-selected sparse hourly evidence", () => {
  const complete = dailySeries();
  const sources = complete.sources.filter((entry) => entry.underlying === "A" || entry.underlying === "B");
  const daily = complete.rows.filter((row) => sources.some((entry) => entry.underlying === row.underlying));
  const sparseHourly = Array.from({ length: 10 }, (_, index) => {
    const timestampMs = ORIGIN - (10 - index) * 3_600_000;
    return {
      schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: "A", interval: "hourly" as const,
      timestampMs, observationCloseTimeMs: timestampMs + 3_600_000 - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: 0.001 * index, sourceKeys: [],
    };
  });
  const series = { network: "testnet" as const, rows: [...daily, ...sparseHourly], exclusions: [], sources, manifestHash: complete.manifestHash };
  assert.equal(syntheticEvents(ORIGIN, series, []).some((ticket) => ticket.stratum === "same-cluster"), false);
});

test("daily replay origins stay on an exact 24-hour UTC cadence", () => {
  const complete = dailySeries();
  const missingTimestamp = ORIGIN - 20 * DAY;
  const series = { ...complete, rows: complete.rows.filter((row) => row.timestampMs !== missingTimestamp) };
  const origins = replayOrigins(series);
  assert.ok(origins.length > 2);
  assert.ok(origins.every((originMs, index) => index === 0 || originMs - origins[index - 1] === DAY));
});

test("future outcomes require exact horizon-close alignment across every asset", () => {
  const series = dailySeries();
  const future = series.sources.flatMap((entry, asset) => [1, 2, 3, 4].map((days) => {
    const timestampMs = ORIGIN + days * DAY + (asset === 0 ? 0 : 3_600_000);
    return { schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const, timestampMs, observationCloseTimeMs: timestampMs + DAY - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: 0.01, sourceKeys: [] };
  }));
  const crossAsset = syntheticEvents(ORIGIN, series, future).filter((ticket) => ticket.stratum !== "same-underlying");
  assert.ok(crossAsset.length > 0);
  assert.ok(crossAsset.every((ticket) => ticket.outcome === null));
});

test("log loss and Brier score match hand calculations", () => {
  const rows = [{ p: 0.8, y: 1 as const }, { p: 0.25, y: 0 as const }];
  assert.ok(Math.abs(logLoss(rows) - 0.2554128) < 1e-6);
  assert.ok(Math.abs(brier(rows) - 0.05125) < 1e-8);
});

test("student t inverse round trips tail and interior probabilities", () => {
  for (const df of [4, 8, 30]) for (const probability of [1e-6, 0.01, 0.25, 0.5, 0.9, 1 - 1e-6]) {
    assert.ok(Math.abs(studentTCdf(studentTInv(probability, df), df) - probability) <= 1e-8);
  }
});

test("signed t challenger preserves marginals and negative correlation changes opposite-direction probability", () => {
  const positive = signedTCopula([[1, 0.8], [0.8, 1]], [0.25, 0.25], ["up", "down"], 8, 100_000, "fixture");
  const negative = signedTCopula([[1, -0.8], [-0.8, 1]], [0.25, 0.25], ["up", "down"], 8, 100_000, "fixture");
  for (const marginal of negative.marginals) assert.ok(Math.abs(marginal - 0.25) < 0.01);
  assert.ok(negative.probability > positive.probability + 0.08);
});

test("zero-hit challenger batches remain finite after add-one smoothing", () => {
  const result = signedTCopula([[1, 0], [0, 1]], [1e-9, 1e-9], ["up", "up"], 4, 100, "zero");
  assert.equal(result.hits, 0);
  assert.equal(result.probability, 1 / 102);
  assert.ok(Number.isFinite(logLoss([{ p: result.probability, y: 0 }])));
});

test("synthetic grid caps every stratum, covers two-to-four legs, and excludes four-leg same-underlying", () => {
  const series = dailySeries();
  const future = series.sources.flatMap((entry, asset) => [1, 2, 3, 4].map((days) => ({
    schemaVersion: 2 as const,
    transformationVersion: "returns-v2" as const,
    network: "testnet" as const,
    underlying: entry.underlying,
    interval: "daily" as const,
    timestampMs: ORIGIN + days * DAY,
    observationCloseTimeMs: ORIGIN + days * DAY + DAY - 1,
    sessionDate: new Date(ORIGIN + days * DAY).toISOString().slice(0, 10),
    value: 0.01 * (asset + 1),
    sourceKeys: [`future:${entry.underlying}:${days}`],
  })));
  const tickets = syntheticEvents(ORIGIN, series, future);
  assert.deepEqual(Object.fromEntries(["same-underlying", "same-cluster", "cross-cluster"].map((stratum) => [stratum, tickets.filter((ticket) => ticket.stratum === stratum).length])), {
    "same-underlying": 12,
    "same-cluster": 12,
    "cross-cluster": 12,
  });
  assert.deepEqual([...new Set(tickets.filter((ticket) => ticket.stratum !== "same-underlying").map((ticket) => ticket.legs.length))].sort(), [2, 3, 4]);
  assert.equal(tickets.some((ticket) => ticket.stratum === "same-underlying" && ticket.legs.length === 4), false);
  assert.equal(new Set(tickets.map((ticket) => ticket.key)).size, tickets.length);
  assert.deepEqual(Object.fromEntries([...new Set(tickets.map((ticket) => `${ticket.stratum}:${ticket.legs.length}`))].sort().map((key) => [key, tickets.filter((ticket) => `${ticket.stratum}:${ticket.legs.length}` === key).length])), {
    "cross-cluster:2": 4,
    "cross-cluster:3": 6,
    "cross-cluster:4": 2,
    "same-cluster:2": 12,
    "same-underlying:2": 11,
    "same-underlying:3": 1,
  });
});

test("same-underlying mixed-direction tickets are visible as bands", () => {
  const series = { ...dailySeries(), manifestHash: "0".repeat(64) };
  const future = series.sources.flatMap((entry) => [1, 2, 3, 4].map((days) => {
    const timestampMs = ORIGIN + days * DAY;
    return { schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const, timestampMs, observationCloseTimeMs: timestampMs + DAY - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: 0.01, sourceKeys: [] };
  }));
  const mixed = syntheticEvents(ORIGIN, series, future).filter((ticket) => ticket.stratum === "same-underlying" && new Set(ticket.legs.map((leg) => leg.direction)).size > 1);
  assert.ok(mixed.length > 0);
  for (const ticket of mixed) assert.equal(ticket.direction, "band");
});

test("filtered historical simulation is causal under a volatility shift and keeps non-zero mean", () => {
  const sources = [source("A", "equity", "session"), source("B", "commodity", "session")];
  const rows = sources.flatMap((entry, asset) => Array.from({ length: 140 }, (_, index) => {
    const timestampMs = ORIGIN - (140 - index) * DAY;
    return {
      schemaVersion: 2 as const,
      transformationVersion: "returns-v2" as const,
      network: "testnet" as const,
      underlying: entry.underlying,
      interval: "daily" as const,
      timestampMs,
      observationCloseTimeMs: timestampMs + DAY - 1,
      sessionDate: new Date(timestampMs).toISOString().slice(0, 10),
      value: 0.01 + Math.sin(index) * (index < 100 ? 0.01 : 0.08) * (asset ? -1 : 1),
      sourceKeys: [],
    };
  }));
  const ticket = {
    key: "fhs", originMs: ORIGIN, horizonHours: 24, stratum: "cross-cluster" as const, direction: "all-up" as const,
    legs: sources.map((entry) => ({ underlying: entry.underlying, cluster: entry.cluster, direction: "up" as const, quantile: 0.5, threshold: 0.005, marginalProbability: 0.5 })),
    outcome: 1 as const,
  };
  const before = filteredHistoricalSimulation(ticket, { network: "testnet", rows, exclusions: [], sources, manifestHash: "b".repeat(64) });
  const mutated = filteredHistoricalSimulation(ticket, { network: "testnet", rows: rows.map((row) => row.timestampMs > ORIGIN ? { ...row, value: 100 } : row), exclusions: [], sources, manifestHash: "b".repeat(64) });
  assert.deepEqual(mutated, before);
  assert.equal(before.available, true);
  assert.ok(before.originMean.every((mean) => mean > 0.005));
  assert.ok(before.originSigma.every((sigma) => sigma > 0.02));
});

test("stress classification compares future path drawdown with training drawdowns", () => {
  const sources = [source("A", "equity", "session"), source("B", "commodity", "session")];
  const rows = sources.flatMap((entry) => Array.from({ length: 100 }, (_, index) => {
    const timestampMs = ORIGIN - (100 - index) * DAY;
    return { schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const, timestampMs, observationCloseTimeMs: timestampMs + DAY - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: index % 2 === 0 ? 0.01 : -0.01, sourceKeys: [] };
  }));
  const future = sources.flatMap((entry) => [0.2, -0.2].map((value, index) => {
    const timestampMs = ORIGIN + (index + 1) * DAY;
    return { schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const, timestampMs, observationCloseTimeMs: timestampMs + DAY - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value, sourceKeys: [] };
  }));
  const ticket = {
    key: "stress-path", originMs: ORIGIN, horizonHours: 48, stratum: "cross-cluster" as const, direction: "all-up" as const,
    legs: sources.map((entry) => ({ underlying: entry.underlying, cluster: entry.cluster, direction: "up" as const, quantile: 0.5, threshold: 0, marginalProbability: 0.5 })), outcome: 0 as const,
  };
  assert.equal(ticketStress(ticket, { network: "testnet", rows, exclusions: [], sources, manifestHash: "c".repeat(64) }, future).regime, "drawdown-stress");
});

test("block bootstrap is seeded and never splits a forecast origin", () => {
  const origins = Array.from({ length: 12 }, (_, index) => ({
    originMs: ORIGIN + index * DAY,
    baselineLosses: [0.4 + index / 100, 0.5 + index / 100],
    measuredLosses: [0.35 + index / 100, 0.45 + index / 100],
  }));
  const first = blockBootstrap(origins, 96, 200, "seed");
  assert.deepEqual(blockBootstrap(origins, 96, 200, "seed"), first);
  assert.ok(first.groups.every((group) => group.every((originMs) => origins.some((origin) => origin.originMs === originMs))));
  assert.equal(first.groups.flat().length, origins.length);
  assert.equal(new Set(first.groups.flat()).size, origins.length);
});

test("degree-of-freedom selection uses only its nested training slice", () => {
  const series = dailySeries();
  const training = series.rows.filter((row) => row.timestampMs <= ORIGIN);
  const selected = selectDegreesOfFreedom(training, series.sources, "df");
  const changedFuture = selectDegreesOfFreedom([...training, ...training.slice(0, 20).map((row) => ({ ...row, timestampMs: ORIGIN + DAY, observationCloseTimeMs: ORIGIN + 2 * DAY - 1, sessionDate: new Date(ORIGIN + DAY).toISOString().slice(0, 10), value: 100 }))], series.sources, "df", ORIGIN);
  assert.equal(changedFuture, selected);
  assert.ok([4, 6, 8, 12, 20, 30].includes(selected));
});

test("hourly degree selection accepts 1,000 closed observations", () => {
  const values = Array.from({ length: 1_250 }, (_, index) => {
    const a = Math.sin(index / 7) + 0.2 * Math.cos(index / 3);
    const b = index < 1_000 ? 0.85 * a + 0.15 * Math.sin(index / 5) : -0.85 * a + 0.15 * Math.sin(index / 5);
    return [a, b];
  });
  const selection = (): number => {
    const sources = [source("A", "crypto"), source("B", "crypto")];
    const rows = sources.flatMap((entry, asset) => values.map((row, index) => {
      const timestampMs = ORIGIN - (1_250 - index) * 3_600_000;
      return { schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "hourly" as const, timestampMs, observationCloseTimeMs: timestampMs + 3_600_000 - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: row[asset], sourceKeys: [] };
    }));
    return selectDegreesOfFreedom(rows, sources, "nested-hourly", ORIGIN);
  };
  assert.ok([4, 6, 8, 12, 20, 30].includes(selection()));
});

test("band tickets stay visible but are excluded from statistical success", () => {
  const score = scoreForecasts([
    { p: 0.8, y: 1 as const, originMs: ORIGIN, direction: "all-up" },
    { p: 0.9, y: 1 as const, originMs: ORIGIN, direction: "band" },
  ]);
  assert.equal(score.rows, 2);
  assert.equal(score.eligibleRows, 1);
  assert.deepEqual(score.exclusions, [{ reason: "band-market", rows: 1 }]);
});

test("replay snapshots the baseline and immutable reruns ignore later registry edits", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-"));
  try {
    const series = dailySeries();
    const baselineFile = join(root, "correlations.json");
    writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
    const candidate = candidateFor(series);
    const input = replayInput(root, candidate, series, "fixture");
    const first = runReplay(input);
    const derivedManifestBytes = readFileSync(join(root, input.derivedManifestPath));
    const derivedManifest = JSON.parse(derivedManifestBytes.toString("utf8")) as DerivedManifestV2;
    assert.equal(first.derivedManifestPath, input.derivedManifestPath);
    assert.equal(first.derivedManifestSha256, sha256(derivedManifestBytes));
    assert.equal(first.returnsSha256, derivedManifest.returns.sha256);
    assert.equal(first.exclusionsSha256, derivedManifest.exclusions.sha256);
    assert.deepEqual(first.derivationWindow, derivedManifest.window);
    const bytes = readFileSync(join(root, "artifacts", "candidates", "fixture.validation.json"), "utf8");
    writeFileSync(baselineFile, JSON.stringify({ clusters: {} }));
    assert.deepEqual(runReplay(input), first);
    assert.equal(readFileSync(join(root, "artifacts", "candidates", "fixture.validation.json"), "utf8"), bytes);
    const snapshot = readFileSync(join(root, first.baselineSnapshotPath));
    assert.equal(sha256(snapshot), first.baselineSha256);
    assert.equal(bytes, `${canonicalJson(first)}\n`);
    assert.deepEqual(first.resourcePolicy, { maxWallClockMs: 30_000, maxPeakRssBytes: 512 * 1024 * 1024 });
    for (const score of Object.values(first.modelScores)) {
      assert.deepEqual(Object.keys(score.byStressRegime).sort(), ["drawdown-stress", "high-volatility", "normal"]);
      for (const bucket of Object.values(score.byStressRegime)) if (bucket.rows === 0) {
        assert.equal(bucket.gateEligible, false);
        assert.equal(bucket.exclusionReason, "insufficient-stress-sample");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation sidecar reuse rejects a different requested seed", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-seed-"));
  try {
    const series = dailySeries(95);
    const candidate = candidateFor(series, "seed-closure");
    runReplay(replayInput(root, candidate, series, "first-seed"));
    assert.throws(() => runReplay(replayInput(root, candidate, series, "second-seed")), /different immutable inputs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("validation reuse rejects mutated derived returns, exclusions, and window identities", () => {
  for (const kind of ["returns", "exclusions", "window"] as const) {
    const root = mkdtempSync(join(tmpdir(), `hype-replay-derived-${kind}-`));
    try {
      const series = dailySeries(95);
      const input = replayInput(root, candidateFor(series, `derived-${kind}`), series, `derived-${kind}`);
      runReplay(input);
      const manifestFile = join(root, input.derivedManifestPath);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as DerivedManifestV2;
      if (kind === "window") {
        manifest.window.asOfMs += 1;
        writeFileSync(manifestFile, canonicalJson(manifest));
      } else {
        writeFileSync(join(root, manifest[kind].path), gzipSync(`${canonicalJson({ mutated: true })}\n`));
      }
      assert.throws(() => runReplay(input), /derived manifest|different immutable inputs/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("failed dependence fit yields a serializable Rejected report", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-rejected-"));
  try {
    const complete = dailySeries(95);
    const series = { ...complete, rows: complete.rows.filter((row) => row.underlying === "A") };
    const baselineFile = join(root, "correlations.json");
    writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
    const report = runReplay(replayInput(root, candidateFor(series, "failed-fit"), series, "failed-fit"));
    assert.equal(report.decision, "Rejected");
    assert.ok(report.exclusions.some((entry) => entry.reason === "non-finite-probability"));
    assert.doesNotThrow(() => canonicalJson(report));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReplay signed t probabilities use each origin's fitted matrix, not the terminal candidate PSD", () => {
  const roots = [mkdtempSync(join(tmpdir(), "hype-replay-positive-")), mkdtempSync(join(tmpdir(), "hype-replay-signed-"))];
  try {
    const series = dailySeries(95);
    const signs = [1, -1, 1, -1];
    const positive = signs.map((_, row) => signs.map((__, column) => row === column ? 1 : 0.7));
    const signed = signs.map((left, row) => signs.map((right, column) => row === column ? 1 : 0.7 * left * right));
    const scores = roots.map((root, index) => {
      const baselineFile = join(root, "correlations.json");
      writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
      const candidate = candidateFor(series, `candidate-matrix-${index}`, index === 0 ? positive : signed);
      return runReplay(replayInput(root, candidate, series, "candidate-matrix")).modelScores["signed-t-copula"].overall.logLoss;
    });
    assert.equal(scores[0], scores[1]);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("runReplay rejects unsafe modelVersion paths before writing artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-path-"));
  try {
    const series = dailySeries(95);
    const baselineFile = join(root, "correlations.json");
    writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
    assert.throws(() => runReplay(replayInput(root, candidateFor(series, "../escape"), series, "path")), /safe artifact filename/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runReplay rejects a return without required close-time provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-close-time-"));
  try {
    const series = dailySeries(95);
    delete (series.rows[0] as Partial<typeof series.rows[number]>).observationCloseTimeMs;
    const baselineFile = join(root, "correlations.json");
    writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
    assert.throws(() => runReplay(replayInput(root, candidateFor(series, "missing-close"), series, "missing-close")), /observationCloseTimeMs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh runReplay artifacts are byte-identical and cover full replay determinism", () => {
  const roots = [mkdtempSync(join(tmpdir(), "hype-replay-fresh-a-")), mkdtempSync(join(tmpdir(), "hype-replay-fresh-b-"))];
  try {
    const series = dailySeries(95);
    const candidate = candidateFor(series, "fresh-determinism");
    const bytes = roots.map((root) => {
      const baselineFile = join(root, "correlations.json");
      writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
      const report = runReplay(replayInput(root, candidate, series, "fresh-determinism"));
      assert.equal(report.deterministicRerunMatches, true);
      return readFileSync(join(root, "artifacts", "candidates", "fresh-determinism.validation.json"), "utf8");
    });
    assert.equal(bytes[1], bytes[0]);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("replay CLI requires explicit immutable inputs", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "replay"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {},
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE_FILE, RESEARCH_CANDIDATE_FILE, RESEARCH_DERIVED_MANIFEST_FILE, and RESEARCH_REPLAY_SEED are required/);
});

test("replay fixes challenger simulation at exactly 20,000 draws", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-draws-"));
  try {
    const complete = dailySeries();
    const series = { ...complete, rows: [] };
    const baselineFile = join(root, "correlations.json");
    writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
    assert.throws(() => runReplay(replayInput(root, candidateFor(series, "draw-override"), series, "draw-override", { draws: 200 }) as Parameters<typeof runReplay>[0]), /exactly 20,000 draws/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("representative 20-underlying replay fixture is deterministic within local resource bounds", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-performance-"));
  const branchRoot = mkdtempSync(join(tmpdir(), "hype-replay-performance-branches-"));
  try {
  const specs = readFileSync(new URL("./fixtures/research/replay-series.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { underlying: string; cluster: SourceEntry["cluster"]; calendar: SourceEntry["calendar"]; phase: number });
  const sources = specs.map((entry) => source(entry.underlying, entry.cluster, entry.calendar));
  const rows = specs.flatMap((entry) => Array.from({ length: 94 }, (_, index) => {
    const timestampMs = ORIGIN + (index - 89) * DAY;
    return { schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const, timestampMs, observationCloseTimeMs: timestampMs + DAY - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: entry.phase / 10_000 + Math.sin((index + entry.phase) / 7) * 0.02, sourceKeys: [] };
  }));
  const series = { network: "testnet" as const, rows, exclusions: [], sources, manifestHash: "e".repeat(64) };
  const baselineFile = join(root, "correlations.json");
  writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
  const started = performance.now();
  const report = runReplay(replayInput(root, candidateFor(series, "performance"), series, "performance"));
  const branchSpecs = [specs[0], specs[8], specs[9], specs[15]];
  const branchSources = branchSpecs.map((entry) => source(entry.underlying, entry.cluster, entry.calendar));
  const branchRows = branchSpecs.flatMap((entry) => Array.from({ length: 98 }, (_, index) => {
    const timestampMs = ORIGIN + (index - 89) * DAY;
    return { schemaVersion: 2 as const, transformationVersion: "returns-v2" as const, network: "testnet" as const, underlying: entry.underlying, interval: "daily" as const, timestampMs, observationCloseTimeMs: timestampMs + DAY - 1, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: entry.phase / 10_000 + Math.sin((index + entry.phase) / 7) * 0.02, sourceKeys: [] };
  }));
  const branchSeries = { network: "testnet" as const, rows: branchRows, exclusions: [], sources: branchSources, manifestHash: "f".repeat(64) };
  const branchBaselineFile = join(branchRoot, "branch-correlations.json");
  writeFileSync(branchBaselineFile, JSON.stringify(baselineFor(branchSeries)));
  const branchReport = runReplay(replayInput(branchRoot, candidateFor(branchSeries, "performance-branches"), branchSeries, "performance-branches"));
  const elapsedMs = performance.now() - started;
  const rssBytes = process.memoryUsage().rss;
  const summary = `${canonicalJson({ counts: Object.fromEntries(["same-underlying", "same-cluster", "cross-cluster"].map((stratum) => [stratum, Object.entries(report.ticketCounts).filter(([key]) => key.startsWith(`${stratum}:`)).reduce((sum, [, rows]) => sum + rows, 0)])), keys: report.selectedTicketKeys })}\n`;
  assert.ok(branchReport.modelScores["filtered-historical-simulation"].overall.eligibleRows > 0);
  assert.ok(branchReport.bootstrap.groups.length > 0);
  assert.equal(summary, readFileSync(new URL("./fixtures/research/replay-expected.json", import.meta.url), "utf8"));
  assert.ok(elapsedMs < 30_000, `fixture took ${elapsedMs}ms`);
  assert.ok(rssBytes < 512 * 1024 * 1024, `fixture used ${rssBytes} RSS bytes`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(branchRoot, { recursive: true, force: true });
  }
});

test("replay verifies the candidate-time market registry snapshot for fitted candidates only", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-snapshot-"));
  try {
    const series = dailySeries();
    const legacy = replayInput(root, candidateFor(series, "legacy"), series, "legacy");
    runReplay(legacy);
    const fitted = replayInput(root, fittedArtifact(candidateFor(series, "fitted")), series, "fitted");
    assert.throws(() => runReplay(fitted), /market registry snapshot/);
    const snapshot = join(root, "facts", "market-registries", `${fitted.profile.marketRegistrySha256}.json`);
    mkdirSync(join(root, "facts", "market-registries"), { recursive: true });
    writeFileSync(snapshot, canonicalJson({ schemaVersion: 1, network: "testnet", markets: [], rewritten: true }));
    assert.throws(() => runReplay(fitted), /market registry snapshot/);
    writeFileSync(snapshot, fitted.profile.marketRegistryRaw);
    assert.equal(runReplay(fitted).candidateSha256, sha256(canonicalJson(fitted.candidate)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
