import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  brier,
  blockBootstrap,
  filteredHistoricalSimulation,
  forecastAt,
  logLoss,
  runReplay,
  scoreForecasts,
  selectDegreesOfFreedom,
  signedTCopula,
  studentTCdf,
  studentTInv,
  syntheticEvents,
  type ReplaySeries,
} from "../src/research/replay.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import type { CorrelationArtifact, SourceEntry } from "../src/research/types.js";

const DAY = 86_400_000;
const ORIGIN = Date.parse("2026-08-01T00:00:00.000Z");

const source = (underlying: string, cluster: SourceEntry["cluster"], calendar: SourceEntry["calendar"] = "continuous"): SourceEntry => ({
  schemaVersion: 1,
  underlying,
  sourceNetwork: "mainnet",
  sourceCoin: underlying,
  cluster,
  calendar,
  ...(calendar === "session" ? { session: { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], openLocal: "09:00", closeLocal: "17:00", closedDates: [] } } : {}),
  eligible: true,
  fallbackEligible: false,
});

function dailySeries(days = 130): ReplaySeries {
  const sources = [source("A", "crypto"), source("B", "crypto"), source("C", "equity", "session"), source("D", "equity", "session")];
  const rows = sources.flatMap((entry, asset) => Array.from({ length: days }, (_, index) => {
    const timestampMs = ORIGIN - (days - index) * DAY;
    return {
      schemaVersion: 1 as const,
      transformationVersion: "returns-v1" as const,
      underlying: entry.underlying,
      interval: "1d" as const,
      timestampMs,
      sessionDate: new Date(timestampMs).toISOString().slice(0, 10),
      value: 0.002 * (asset + 1) + Math.sin(index / (3 + asset)) * 0.03,
      sourceKeys: [`fixture:${entry.underlying}:${timestampMs}`],
    };
  }));
  return { rows, sources, manifestHash: "a".repeat(64) };
}

function candidateFor(series: ReplaySeries, modelVersion = "fixture"): CorrelationArtifact {
  const matrixOrder = series.sources.map((entry) => entry.underlying);
  const clusters: CorrelationArtifact["clusters"] = {};
  for (const entry of series.sources) (clusters[entry.cluster] ??= {})[entry.underlying] = { global: 0.1, cluster: 0.2, underlying: 0.3, underlyingBasis: "structural-underlying" };
  return {
    schemaVersion: 1, modelVersion, modelFamily: "hierarchical-gaussian-factor", createdAt: "2026-08-01T00:00:00.000Z", dataAsOf: "2026-07-31T00:00:00.000Z",
    dataManifestSha256: series.manifestHash, sourceRegistrySha256: "d".repeat(64),
    policy: { lookbackDays: 180, halfLifeDays: 45, diagnosticWindowsDays: [30, 90, 180], minHourly: 1000, minDaily: 90, minCoverage: 0.8, maxProjectionError: 0.10 },
    quality: { matrixOrder, eligibleUnderlyings: matrixOrder, quarantinedUnderlyings: [], pairEligibility: [], lastUsableObservationMs: {}, pairDiagnostics: [], maxProjectionError: 0, highamProjectionDelta: 0, clippedNegativePairs: [], signedPsdTarget: matrixOrder.map((_, row) => matrixOrder.map((__, column) => row === column ? 1 : 0)), diagnosticMatrices: { "30": [], "90": [], "180": [] } },
    validation: { status: "pending" },
    clusters,
  };
}

function baselineFor(series: ReplaySeries): { clusters: Record<string, Record<string, { global: number; cluster: number; underlying: number }>> } {
  const baseline = { clusters: Object.fromEntries(series.sources.map((entry) => [entry.cluster, {}])) } as { clusters: Record<string, Record<string, { global: number; cluster: number; underlying: number }>> };
  for (const entry of series.sources) baseline.clusters[entry.cluster][entry.underlying] = { global: 0.1, cluster: 0.2, underlying: 0.3 };
  return baseline;
}

test("future mutation cannot change an earlier forecast", () => {
  const series = dailySeries();
  const before = forecastAt(ORIGIN, series);
  const changed = forecastAt(ORIGIN, {
    ...series,
    rows: series.rows.map((row) => row.timestampMs > ORIGIN ? { ...row, value: row.value + 100 } : row),
  });
  assert.deepEqual(changed, before);
  const future = series.sources.flatMap((entry, asset) => [1, 2, 3, 4].map((days) => ({
    schemaVersion: 1 as const, transformationVersion: "returns-v1" as const, underlying: entry.underlying, interval: "1d" as const,
    timestampMs: ORIGIN + days * DAY, sessionDate: new Date(ORIGIN + days * DAY).toISOString().slice(0, 10), value: 0.01 * (asset + days), sourceKeys: [],
  })));
  const selected = syntheticEvents(ORIGIN, series, future).map(({ outcome: _, ...ticket }) => ticket);
  const mutated = syntheticEvents(ORIGIN, series, future.map((row) => ({ ...row, value: row.value + 100 }))).map(({ outcome: _, ...ticket }) => ticket);
  assert.deepEqual(mutated, selected);
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
    schemaVersion: 1 as const,
    transformationVersion: "returns-v1" as const,
    underlying: entry.underlying,
    interval: "1d" as const,
    timestampMs: ORIGIN + days * DAY,
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
    "same-underlying:2": 10,
    "same-underlying:3": 2,
  });
});

test("filtered historical simulation is causal under a volatility shift and keeps non-zero mean", () => {
  const sources = [source("A", "equity", "session"), source("B", "commodity", "session")];
  const rows = sources.flatMap((entry, asset) => Array.from({ length: 140 }, (_, index) => {
    const timestampMs = ORIGIN - (140 - index) * DAY;
    return {
      schemaVersion: 1 as const,
      transformationVersion: "returns-v1" as const,
      underlying: entry.underlying,
      interval: "1d" as const,
      timestampMs,
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
  const before = filteredHistoricalSimulation(ticket, { rows, sources, manifestHash: "b".repeat(64) });
  const mutated = filteredHistoricalSimulation(ticket, { rows: rows.map((row) => row.timestampMs > ORIGIN ? { ...row, value: 100 } : row), sources, manifestHash: "b".repeat(64) });
  assert.deepEqual(mutated, before);
  assert.equal(before.available, true);
  assert.ok(before.originMean.every((mean) => mean > 0.005));
  assert.ok(before.originSigma.every((sigma) => sigma > 0.02));
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
  const changedFuture = selectDegreesOfFreedom([...training, ...training.slice(0, 20).map((row) => ({ ...row, timestampMs: ORIGIN + DAY, value: 100 }))], series.sources, "df", ORIGIN);
  assert.equal(changedFuture, selected);
  assert.ok([4, 6, 8, 12, 20, 30].includes(selected));
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
    const input = { root, candidate, inputManifestSha256: series.manifestHash, baselineFile, series, seed: "fixture", draws: 200 };
    const first = runReplay(input);
    const bytes = readFileSync(join(root, "artifacts", "candidates", "fixture.validation.json"), "utf8");
    writeFileSync(baselineFile, JSON.stringify({ clusters: {} }));
    assert.deepEqual(runReplay(input), first);
    assert.equal(readFileSync(join(root, "artifacts", "candidates", "fixture.validation.json"), "utf8"), bytes);
    const snapshot = readFileSync(join(root, first.baselineSnapshotPath));
    assert.equal(sha256(snapshot), first.baselineSha256);
    assert.equal(bytes, `${canonicalJson(first)}\n`);
    assert.ok(Object.values(first.modelElapsedMs).every((elapsedMs) => elapsedMs > 0));
    assert.ok(first.peakRssBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed dependence fit yields a serializable Rejected report", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-replay-rejected-"));
  try {
    const complete = dailySeries(95);
    const series = { ...complete, rows: complete.rows.filter((row) => row.underlying === "A") };
    const baselineFile = join(root, "correlations.json");
    writeFileSync(baselineFile, JSON.stringify(baselineFor(series)));
    const report = runReplay({ root, candidate: candidateFor(series, "failed-fit"), inputManifestSha256: series.manifestHash, baselineFile, series, seed: "failed-fit", draws: 20 });
    assert.equal(report.decision, "Rejected");
    assert.ok(report.exclusions.some((entry) => entry.reason === "non-finite-probability"));
    assert.doesNotThrow(() => canonicalJson(report));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay CLI requires explicit immutable inputs", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "replay"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {},
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /RESEARCH_ROOT, RESEARCH_CANDIDATE_FILE, RESEARCH_DERIVED_MANIFEST_FILE, CORRELATION_SOURCES_FILE, CORRELATIONS_FILE, and RESEARCH_REPLAY_SEED are required/);
});

test("representative 20-underlying replay fixture is deterministic within local resource bounds", () => {
  const specs = readFileSync(new URL("./fixtures/research/replay-series.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { underlying: string; cluster: SourceEntry["cluster"]; calendar: SourceEntry["calendar"]; phase: number });
  const sources = specs.map((entry) => source(entry.underlying, entry.cluster, entry.calendar));
  const rows = specs.flatMap((entry) => Array.from({ length: 100 }, (_, index) => {
    const timestampMs = ORIGIN - (100 - index) * DAY;
    return { schemaVersion: 1 as const, transformationVersion: "returns-v1" as const, underlying: entry.underlying, interval: "1d" as const, timestampMs, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: entry.phase / 10_000 + Math.sin((index + entry.phase) / 7) * 0.02, sourceKeys: [] };
  }));
  const future = specs.flatMap((entry) => [1, 2, 3, 4].map((days) => {
    const timestampMs = ORIGIN + days * DAY;
    return { schemaVersion: 1 as const, transformationVersion: "returns-v1" as const, underlying: entry.underlying, interval: "1d" as const, timestampMs, sessionDate: new Date(timestampMs).toISOString().slice(0, 10), value: entry.phase / 10_000 + 0.001 * days, sourceKeys: [] };
  }));
  const series = { rows, sources, manifestHash: "e".repeat(64) };
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const tickets = syntheticEvents(ORIGIN, series, future);
  const elapsedMs = performance.now() - started;
  const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);
  const summary = `${canonicalJson({ counts: Object.fromEntries(["same-underlying", "same-cluster", "cross-cluster"].map((stratum) => [stratum, tickets.filter((ticket) => ticket.stratum === stratum).length])), keys: tickets.map((ticket) => ticket.key) })}\n`;
  const rerun = syntheticEvents(ORIGIN, series, future);
  assert.equal(`${canonicalJson({ counts: Object.fromEntries(["same-underlying", "same-cluster", "cross-cluster"].map((stratum) => [stratum, rerun.filter((ticket) => ticket.stratum === stratum).length])), keys: rerun.map((ticket) => ticket.key) })}\n`, summary);
  assert.equal(summary, readFileSync(new URL("./fixtures/research/replay-expected.json", import.meta.url), "utf8"));
  assert.ok(elapsedMs < 30_000, `fixture took ${elapsedMs}ms`);
  assert.ok(rssGrowth < 512 * 1024 * 1024, `fixture grew RSS by ${rssGrowth} bytes`);
});
