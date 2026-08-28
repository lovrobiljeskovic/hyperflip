import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSources, nextCandleRequest, parseCandleSnapshot } from "../src/research/candles.js";
import { buildDailyManifest, readCandlePartition, sha256, canonicalJson } from "../src/research/store.js";
import type { SourceEntry } from "../src/research/types.js";

const source: SourceEntry = {
  schemaVersion: 1,
  underlying: "BTC",
  sourceNetwork: "mainnet",
  sourceCoin: "BTC",
  cluster: "crypto",
  calendar: "continuous",
  eligible: true,
  fallbackEligible: false,
};
const fixture = (name: string) => readFileSync(new URL(`./fixtures/research/${name}`, import.meta.url), "utf8");
const hour = 3_600_000;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "hype-research-candles-"));
}

function shardFiles(root: string): string[] {
  const raw = join(root, "raw", "candles");
  const visit = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? visit(join(dir, entry.name)) : [join(dir, entry.name)]);
  return visit(raw);
}

test("candle snapshot maps exact Hyperliquid fields", () => {
  assert.deepEqual(parseCandleSnapshot(source, fixture("candle-snapshot.json"), 12_000_000)[0], {
    schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "mainnet", underlying: "BTC", sourceCoin: "BTC", interval: "1h",
    openTimeMs: 3_600_000, closeTimeMs: 7_199_999, open: "100", high: "110", low: "90", close: "105", volume: "12.5", tradeCount: 8, retrievedAtMs: 12_000_000,
  });
});

test("candle snapshot rejects invalid OHLC, non-finite values, and reverse time", () => {
  const row = JSON.parse(fixture("candle-snapshot.json"))[0];
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([{ ...row, h: "99" }]), 1), /OHLC/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([{ ...row, v: "Infinity" }]), 1), /finite/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([{ ...row, T: row.t }]), 1), /time/);
});

test("candle request uses a 5,000-hour initial range and resumes after the durable bar", () => {
  assert.deepEqual(nextCandleRequest(source, null, 20_000_000_000), { source, startTime: 2_000_000_000, endTime: 20_000_000_000 });
  assert.deepEqual(nextCandleRequest(source, 7_200_000, 20_000_000_000), { source, startTime: 10_800_000, endTime: 20_000_000_000 });
});

test("candle request recovers from a stale state file using sealed candles", async () => {
  const root = scratch();
  const nowMs = 20_000_000_000;
  const registry = { schemaVersion: 1 as const, sources: [source] };
  const requests: { startTime: number }[] = [];
  try {
    await collectSources({ root, registry, nowMs, fetch: async () => new Response(fixture("candle-snapshot.json")) });
    writeFileSync(join(root, "state", "collector.json"), JSON.stringify({ schemaVersion: 1, sourceRegistrySha256: sha256(canonicalJson(registry)), sources: { "mainnet:BTC": 3_600_000 } }));
    await collectSources({ root, registry, nowMs, fetch: async (_url, init) => {
      requests.push(JSON.parse(init?.body as string).req);
      return new Response(fixture("candle-snapshot.json"));
    } });
    assert.equal(requests[0].startTime, 10_800_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candle snapshot collection is idempotent and records conflicts without replacing the accepted candle", async () => {
  const root = scratch();
  const nowMs = 20_000_000_000;
  const registry = { schemaVersion: 1 as const, sources: [source] };
  const response = (body: string) => async () => new Response(body, { status: 200 });
  try {
    await collectSources({ root, registry, nowMs, fetch: response(fixture("candle-snapshot.json")) });
    const first = shardFiles(root);
    assert.equal(first.length, 1);
    const accepted = readCandlePartition(first[0]);
    const firstHash = sha256(canonicalJson(buildDailyManifest(root, "1970-08-20")));

    await collectSources({ root, registry, nowMs, fetch: response(fixture("candle-snapshot.json")) });
    assert.equal(shardFiles(root).length, 1);
    assert.equal(sha256(canonicalJson(buildDailyManifest(root, "1970-08-20"))), firstHash);

    await collectSources({ root, registry, nowMs, fetch: response(fixture("candle-conflict.json")) });
    assert.deepEqual(readCandlePartition(first[0]), accepted);
    assert.match(readFileSync(join(root, "quarantine", "candles", "1970", "08", "20.jsonl"), "utf8"), /"high":"111"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
