import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  alignPair,
  buildDailyReturns,
  buildHourlyReturns,
  classifyCandle,
  deriveReturns,
  quality,
  parseReturnRecord,
  returnModeFor,
  sessionDates,
  trailingFresh,
} from "../src/research/returns.js";
import { buildDailyManifest, canonicalJson, readDerivedDataset, sha256 } from "../src/research/store.js";
import type { CandleRecord, SourceEntry } from "../src/research/types.js";

const HOUR = 3_600_000;
const continuousSource: SourceEntry = {
  schemaVersion: 1, underlying: "BTC", sourceNetwork: "testnet", sourceCoin: "BTC", cluster: "crypto", calendar: "continuous", measurementEnabled: true, fallbackEligible: false,
};
const sessionSource: SourceEntry = {
  schemaVersion: 1, underlying: "NVDA", sourceNetwork: "testnet", sourceCoin: "xyz:NVDA", cluster: "equity", calendar: "session", measurementEnabled: true, fallbackEligible: false,
  session: { timeZone: "America/New_York", weekdays: [1, 2, 3, 4, 5], openLocal: "09:30", closeLocal: "16:00", closedDates: ["2026-09-07"] },
};
const at = (date: string): number => Date.parse(date);
const window = (fromMs: number, asOfMs: number) => ({ asOfMs, lookbackMs: asOfMs - fromMs });
const candle = (openTimeMs: number, close: string, volume = "1", tradeCount = 1, underlying = "BTC", sourceCoin = "BTC"): CandleRecord => ({
  schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "testnet", underlying, sourceCoin, interval: "1h", openTimeMs, closeTimeMs: openTimeMs + HOUR - 1,
  open: close, high: close, low: close, close, volume, tradeCount, retrievedAtMs: openTimeMs + HOUR,
});
const fixture = (name: string): CandleRecord[] => readFileSync(new URL(`./fixtures/research/${name}`, import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line) as CandleRecord);

test("return mode uses hourly only for a same-cluster continuous pair", () => {
  assert.equal(returnModeFor(continuousSource, { ...continuousSource, underlying: "ETH", sourceCoin: "ETH" }), "hourly");
  assert.equal(returnModeFor(continuousSource, { ...sessionSource, cluster: "crypto" }), "daily");
});

test("continuous equity and commodity pairs use daily returns", () => {
  for (const cluster of ["equity", "commodity"] as const) {
    const left = { ...continuousSource, underlying: `${cluster}-A`, sourceCoin: `${cluster}-A`, cluster };
    const right = { ...continuousSource, underlying: `${cluster}-B`, sourceCoin: `${cluster}-B`, cluster };
    assert.equal(returnModeFor(left, right), "daily");
  }
});

test("return quality accepts exact hourly and daily boundaries and rejects one below", () => {
  assert.equal(quality(1_000, 1_250, "hourly").eligible, true);
  assert.equal(quality(999, 1_248, "hourly").eligible, false);
  assert.equal(quality(90, 112, "daily").eligible, true);
  assert.equal(quality(89, 111, "daily").eligible, false);
  assert.equal(quality(100, 125, "daily").eligible, true);
  assert.equal(quality(99, 125, "daily").eligible, false);
});

test("returns-v2 parser requires close-time causality and network identity", () => {
  const valid = {
    schemaVersion: 2, transformationVersion: "returns-v2", network: "testnet", underlying: "BTC", interval: "hourly",
    timestampMs: HOUR, observationCloseTimeMs: 2 * HOUR - 1, sessionDate: "1970-01-01", value: 0.1, sourceKeys: [],
  };
  assert.doesNotThrow(() => parseReturnRecord(valid, "testnet"));
  assert.throws(() => parseReturnRecord({ ...valid, observationCloseTimeMs: undefined }, "testnet"), /observationCloseTimeMs/);
  assert.throws(() => parseReturnRecord({ ...valid, schemaVersion: 1, transformationVersion: "returns-v1" }, "testnet"), /returns-v2|schemaVersion/);
  assert.throws(() => parseReturnRecord({ ...valid, network: "mainnet" }, "testnet"), /network/);
  assert.throws(() => parseReturnRecord({ ...valid, network: "mainnet" }), /mainnet.*not enabled/);
});

test("missing intervals stay missing and are never forward-filled", () => {
  const returns = buildHourlyReturns([candle(0, "100"), candle(2 * HOUR, "121")], continuousSource, window(0, 2 * HOUR));
  assert.deepEqual(returns, []);
});

test("returns persist the close time at which the return becomes observable", () => {
  const rows = buildHourlyReturns([candle(0, "100"), candle(HOUR, "110")], continuousSource, window(0, HOUR));
  assert.equal(rows[0].timestampMs, HOUR);
  assert.equal(rows[0].observationCloseTimeMs, 2 * HOUR - 1);
});

test("zero-volume repeated session close is stale", () => {
  assert.equal(classifyCandle(candle(HOUR, "100", "0", 0, "NVDA", "xyz:NVDA"), sessionSource, candle(0, "100", "1", 1, "NVDA", "xyz:NVDA")), "stale");
});

test("quality gates enforce 1000 hourly, 90 daily, and 80 percent coverage", () => {
  assert.equal(quality(999, 1_000, "hourly").eligible, false);
  assert.equal(quality(90, 100, "daily").eligible, true);
  assert.equal(quality(90, 120, "daily").eligible, false);
});

test("daily session returns bridge weekends and declared holidays, not missing sessions", () => {
  const start = at("2026-09-04T00:00:00.000Z");
  const end = at("2026-09-08T23:59:59.999Z");
  assert.deepEqual(sessionDates(window(start, end), sessionSource), ["2026-09-04", "2026-09-08"]);
  assert.equal(buildDailyReturns(fixture("candles-session.jsonl"), sessionSource, window(start, end)).length, 1);
});

test("trailing freshness follows expected sessions instead of global dataAsOf", () => {
  const fridayClose = at("2026-09-04T19:30:00.000Z");
  const saturdayNoon = at("2026-09-05T16:00:00.000Z");
  assert.equal(trailingFresh(sessionSource, [fridayClose], saturdayNoon), true);
  assert.equal(trailingFresh(continuousSource, [fridayClose], saturdayNoon), false);
});

test("a leading-window gap reduces the fixed pair coverage denominator", () => {
  const rows = fixture("candles-continuous.jsonl");
  const peer = rows.map((row) => ({ ...row, underlying: "ETH", sourceCoin: "ETH" }));
  const result = alignPair(rows, peer, continuousSource, { ...continuousSource, underlying: "ETH", sourceCoin: "ETH" }, window(0, 5 * HOUR), "hourly");
  assert.equal(result.quality.expected, 5);
  assert.equal(result.quality.observations, 0);
  assert.equal(result.quality.coverage, 0);
  assert.equal(result.quality.eligible, false);
  assert.ok(result.quality.exclusions.some((row) => row.reason === "missing-interval"));
});

test("daily returns reject a bridge over a missing scheduled session", () => {
  const monday = at("2026-09-14T19:30:00.000Z");
  const tuesday = at("2026-09-15T19:30:00.000Z");
  const friday = at("2026-09-11T19:30:00.000Z");
  const result = alignPair(
    [candle(friday, "100", "1", 1, "NVDA", "xyz:NVDA"), candle(tuesday, "121", "1", 1, "NVDA", "xyz:NVDA")],
    [candle(friday, "200", "1", 1, "SP500", "xyz:SP500"), candle(tuesday, "242", "1", 1, "SP500", "xyz:SP500")],
    { ...sessionSource, session: { ...sessionSource.session!, closedDates: [] } },
    { ...sessionSource, underlying: "SP500", sourceCoin: "xyz:SP500" },
    window(at("2026-09-11T00:00:00.000Z"), at("2026-09-15T23:59:59.999Z")),
    "daily",
  );
  assert.equal(monday < tuesday, true);
  assert.equal(result.quality.observations, 0);
  assert.ok(result.quality.exclusions.some((row) => row.reason === "missing-interval"));
});

test("derived partitions are immutable and deterministic after manifest verification", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-research-returns-"));
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [continuousSource, { ...continuousSource, underlying: "ETH", sourceCoin: "ETH" }] };
  const registryBytes = canonicalJson(registry);
  const sourceHash = sha256(registryBytes);
  const raw = join(root, "raw", "candles", "1970", "01", "01", "BTC", "fixture.jsonl.gz");
  try {
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "raw", "candles", "1970", "01", "01", "BTC"), { recursive: true });
    writeFileSync(join(root, "facts", "source-registries", `${sourceHash}.json`), registryBytes);
    writeFileSync(join(root, "network-profile.json"), canonicalJson({ schemaVersion: 3, network: "testnet", profileSha256: "a".repeat(64), evmChainId: 998, deploymentRegistrySha256: "b".repeat(64) }));
    writeFileSync(join(root, "state", "collector.json"), canonicalJson({ schemaVersion: 2, sourceRegistrySha256: sourceHash, network: "testnet", profileSha256: "a".repeat(64), sources: {} }));
    const rows = fixture("candles-continuous.jsonl");
    writeFileSync(raw, gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`));
    writeFileSync(`${raw}.provenance.json`, canonicalJson({ schemaVersion: 2, sourceRegistrySha256: sourceHash, network: "testnet", profileSha256: "a".repeat(64), startTimeMs: HOUR, endTimeMs: 6 * HOUR - 1, ignoredBefore: 0, ignoredAfter: 0 }));
    const manifest = buildDailyManifest(root, "1970-01-01");
    const first = deriveReturns(root, manifest, window(0, 5 * HOUR));
    const second = deriveReturns(root, manifest, window(0, 5 * HOUR));
    assert.equal(first.rows, 0);
    assert.equal(first.path, second.path);
    assert.equal(readFileSync(first.path).equals(readFileSync(second.path)), true);
    const derivedManifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    assert.equal(derivedManifest.schemaVersion, 2);
    assert.equal(derivedManifest.network, "testnet");
    assert.equal(derivedManifest.transformationVersion, "returns-v2");
    assert.ok(derivedManifest.returns.sha256);
    assert.ok(derivedManifest.exclusions.sha256);
    assert.ok(derivedManifest.exclusions.rows > 0);
    assert.match(derivedManifest.returns.path, /returns-v2/);
    assert.match(derivedManifest.exclusions.path, /returns-v2/);
    const verified = readDerivedDataset(root, first.manifestPath);
    assert.deepEqual(verified.exclusions.filter((row) => row.reason === "no-synchronized-peer"), [{
      schemaVersion: 1, stage: "returns", underlying: "BTC", peerUnderlying: "ETH", timestampMs: null, reason: "no-synchronized-peer", sourceKeys: [],
    }]);
    const wrongNetworkExclusionPath = "derived/returns-v2/exclusions/1970/01/01/wrong-network.jsonl.gz";
    const wrongNetworkExclusionBytes = gzipSync(`${canonicalJson({ ...verified.exclusions[0], sourceKeys: ["mainnet:BTC:1h:0"] })}\n`);
    writeFileSync(join(root, wrongNetworkExclusionPath), wrongNetworkExclusionBytes);
    const wrongNetworkExclusionManifestPath = join(root, "wrong-network-exclusion.manifest.json");
    writeFileSync(wrongNetworkExclusionManifestPath, canonicalJson({
      ...derivedManifest,
      exclusions: { path: wrongNetworkExclusionPath, sha256: sha256(wrongNetworkExclusionBytes), rows: 1 },
    }));
    assert.throws(() => readDerivedDataset(root, wrongNetworkExclusionManifestPath), /exclusion.*network mismatch/);
    const mainnetDerivedManifestPath = join(root, "mainnet-derived.manifest.json");
    writeFileSync(mainnetDerivedManifestPath, canonicalJson({ ...derivedManifest, network: "mainnet" }));
    assert.throws(() => readDerivedDataset(root, mainnetDerivedManifestPath), /mainnet.*not enabled/);

    const mainnetRegistry = { ...registry, network: "mainnet", sources: registry.sources.map((source) => ({ ...source, sourceNetwork: "mainnet" })) };
    const mainnetRegistryBytes = canonicalJson(mainnetRegistry);
    const mainnetSourceHash = sha256(mainnetRegistryBytes);
    const mainnetSourcePath = `facts/source-registries/${mainnetSourceHash}.json`;
    writeFileSync(join(root, mainnetSourcePath), mainnetRegistryBytes);
    const mainnetManifest = {
      ...manifest,
      sourceRegistrySha256: mainnetSourceHash,
      files: manifest.files.map((file) => file.path === `facts/source-registries/${sourceHash}.json`
        ? { ...file, path: mainnetSourcePath, bytes: Buffer.byteLength(mainnetRegistryBytes), sha256: mainnetSourceHash }
        : file),
    };
    assert.throws(() => deriveReturns(root, mainnetManifest, window(0, 5 * HOUR)), /mainnet.*not enabled/);
    writeFileSync(first.path, "corrupt immutable return bytes");
    assert.throws(() => deriveReturns(root, manifest, window(0, 5 * HOUR)), /different bytes/);
    assert.throws(() => deriveReturns(root, { ...manifest, files: [] }, window(0, 5 * HOUR)), /manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
