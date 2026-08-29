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
  sessionDates,
  trailingFresh,
} from "../src/research/returns.js";
import { buildDailyManifest, canonicalJson, sha256 } from "../src/research/store.js";
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
  assert.equal(quality(999, 1_000, "hourly-within-cluster").eligible, false);
  assert.equal(quality(90, 100, "daily-cross-session").eligible, true);
  assert.equal(quality(90, 120, "daily-cross-session").eligible, false);
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
  const result = alignPair(rows, peer, continuousSource, { ...continuousSource, underlying: "ETH", sourceCoin: "ETH" }, window(0, 5 * HOUR), "hourly-within-cluster");
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
    "daily-cross-session",
  );
  assert.equal(monday < tuesday, true);
  assert.equal(result.quality.observations, 0);
  assert.ok(result.quality.exclusions.some((row) => row.reason === "missing-interval"));
});

test("derived partitions are immutable and deterministic after manifest verification", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-research-returns-"));
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [continuousSource] };
  const registryBytes = canonicalJson(registry);
  const sourceHash = sha256(registryBytes);
  const raw = join(root, "raw", "candles", "1970", "01", "01", "BTC", "fixture.jsonl.gz");
  try {
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "raw", "candles", "1970", "01", "01", "BTC"), { recursive: true });
    writeFileSync(join(root, "facts", "source-registries", `${sourceHash}.json`), registryBytes);
    writeFileSync(join(root, "state", "collector.json"), canonicalJson({ schemaVersion: 1, sourceRegistrySha256: sourceHash, sources: {} }));
    const rows = [candle(0, "100", "1", 1, "BTC", "OTHER"), ...fixture("candles-continuous.jsonl")];
    writeFileSync(raw, gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`));
    writeFileSync(`${raw}.provenance.json`, canonicalJson({ schemaVersion: 2, sourceRegistrySha256: sourceHash, network: "testnet", profileSha256: "a".repeat(64), startTimeMs: 0, endTimeMs: 0, ignoredBefore: 0, ignoredAfter: 0 }));
    const manifest = buildDailyManifest(root, "1970-01-01");
    const first = deriveReturns(root, manifest, window(0, 5 * HOUR));
    const second = deriveReturns(root, manifest, window(0, 5 * HOUR));
    assert.equal(first.rows, 0);
    assert.equal(first.path, second.path);
    assert.equal(readFileSync(first.path).equals(readFileSync(second.path)), true);
    const derivedManifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
    assert.deepEqual(derivedManifest.files.map((file: { kind: string }) => file.kind).sort(), ["exclusions", "returns"]);
    const exclusionFile = derivedManifest.files.find((file: { kind: string }) => file.kind === "exclusions");
    assert.ok(exclusionFile.rows > 0);
    writeFileSync(first.path, "corrupt immutable return bytes");
    assert.throws(() => deriveReturns(root, manifest, window(0, 5 * HOUR)), /different bytes/);
    assert.throws(() => deriveReturns(root, { ...manifest, files: [] }, window(0, 5 * HOUR)), /manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
