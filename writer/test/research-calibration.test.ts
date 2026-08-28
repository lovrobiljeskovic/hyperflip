import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { calibrate, fitHierarchical, type CalibrationInput } from "../src/research/calibration.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import type { CandleRecord, DataManifest, SourceEntry, SourceRegistry } from "../src/research/types.js";
import type { ReturnRecord } from "../src/research/returns.js";

const source = (underlying: string, cluster: SourceEntry["cluster"]): SourceEntry => ({
  schemaVersion: 1, underlying, sourceNetwork: "mainnet", sourceCoin: underlying, cluster,
  calendar: "continuous", eligible: true, fallbackEligible: false,
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

function calibrationRoot(options: { staleParticipatingUnderlying?: string; constantUnderlying?: string } = {}): { root: string; input: CalibrationInput } {
  const root = mkdtempSync(join(tmpdir(), "hype-research-calibration-"));
  const sources: SourceRegistry = {
    schemaVersion: 1,
    sources: [source("A", "crypto"), source("B", "equity"), source("C", "commodity")].map((entry) => ({ ...entry, fallbackEligible: true })),
  };
  const registryBytes = canonicalJson(sources);
  const registryHash = sha256(registryBytes);
  const latest = AS_OF_MS - 6 * HOUR;
  const candleTimes = options.staleParticipatingUnderlying ? [latest - 2 * HOUR, latest - HOUR, latest] : [latest - HOUR, latest];
  const candles: CandleRecord[] = sources.sources.flatMap((entry) => candleTimes.map((openTimeMs, index) => ({
    schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "mainnet", underlying: entry.underlying,
    sourceCoin: entry.sourceCoin, interval: "1h", openTimeMs, closeTimeMs: openTimeMs + HOUR - 1,
    open: String(100 + index), high: String(100 + index), low: String(100 + index),
    close: String(100 + index), volume: "1", tradeCount: 1, retrievedAtMs: AS_OF_MS,
  })));
  const rawBytes = gzipSync(`${candles.map(canonicalJson).join("\n")}\n`);
  const rawPath = "raw/candles/2026/08/28/fixture.jsonl.gz";
  mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
  mkdirSync(join(root, "raw", "candles", "2026", "08", "28"), { recursive: true });
  mkdirSync(join(root, "derived", "returns", "2026", "08", "28"), { recursive: true });
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
      const row = JSON.parse(line) as ReturnRecord;
      if (row.underlying === options.staleParticipatingUnderlying) row.sourceKeys = [`mainnet:${row.underlying}:1h:${latest - 2 * HOUR}`];
      if (row.underlying === options.constantUnderlying) row.value = 0;
      return canonicalJson(row);
    }).join("\n")}\n`
    : fixtureReturns;
  const derivedBytes = gzipSync(derivedText);
  const derivedPath = "derived/returns/2026/08/28/fixture.jsonl.gz";
  writeFileSync(join(root, derivedPath), derivedBytes);
  const derivedManifest = {
    schemaVersion: 1, transformationVersion: "returns-v1",
    dataManifestSha256: sha256(canonicalJson(manifest)), sourceRegistrySha256: registryHash,
    window: { asOfMs: AS_OF_MS, lookbackMs: 180 * 86_400_000 },
    files: [{ kind: "returns", path: derivedPath, bytes: derivedBytes.length, sha256: sha256(derivedBytes), rows: 450, schemaVersion: 1 }],
  };
  const derivedManifestPath = join(root, `${derivedPath}.manifest.json`);
  writeFileSync(derivedManifestPath, canonicalJson(derivedManifest));
  writeFileSync(join(root, "manifest.json"), canonicalJson(manifest));
  return { root, input: { root, manifest, derivedManifestPath } };
}

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

test("calibration rejects a derived return whose immutable manifest closure changed", () => {
  const fixture = calibrationRoot();
  try {
    const derived = JSON.parse(readFileSync(fixture.input.derivedManifestPath, "utf8")) as { files: { path: string }[] };
    writeFileSync(join(fixture.root, derived.files[0].path), "changed");
    assert.throws(() => calibrate(fixture.input), /derived manifest file mismatch/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("freshness ignores a late raw candle absent from participating return source keys", () => {
  const fixture = calibrationRoot({ staleParticipatingUnderlying: "A" });
  try {
    const artifact = calibrate(fixture.input);
    assert.deepEqual(artifact.quality.quarantinedUnderlyings.find((entry) => entry.underlying === "A"), { underlying: "A", reason: "trailing-source-stale" });
    assert.ok(artifact.quality.pairEligibility.filter((entry) => entry.pair.includes("A")).every((entry) => entry.status === "quarantined" && entry.reason === "trailing-source-stale"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a constant synchronized pair takes the pair-local fallback instead of aborting calibration", () => {
  const fixture = calibrationRoot({ constantUnderlying: "B" });
  try {
    const artifact = calibrate(fixture.input);
    assert.deepEqual(artifact.quality.pairEligibility, [
      { pair: ["A", "B"], status: "fallback", reason: "operator-reviewed-structured-fallback" },
      { pair: ["A", "C"], status: "direct", reason: "quality-gates-passed" },
      { pair: ["B", "C"], status: "fallback", reason: "operator-reviewed-structured-fallback" },
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
      env: { ...process.env, RESEARCH_ROOT: fixture.root, RESEARCH_MANIFEST_FILE: join(fixture.root, "manifest.json"), RESEARCH_DERIVED_MANIFEST_FILE: fixture.input.derivedManifestPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2026-08-28\.ffdb7ae7/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
