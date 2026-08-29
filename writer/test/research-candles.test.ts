import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { collectSources, lastClosedHour, nextCandleRequest, parseCandleSnapshot, selectClosedPage } from "../src/research/candles.js";
import { buildDailyManifest, readCandlePartition, sha256, canonicalJson } from "../src/research/store.js";
import type { SourceEntry } from "../src/research/types.js";
import type { LoadedResearchNetworkProfile } from "../src/research/network.js";

const source: SourceEntry = {
  schemaVersion: 1,
  underlying: "BTC",
  sourceNetwork: "testnet",
  sourceCoin: "BTC",
  cluster: "crypto",
  calendar: "continuous",
  measurementEnabled: true,
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
  return visit(raw).filter((file) => file.endsWith(".jsonl.gz"));
}

function loadedProfile(registry: { schemaVersion: 2; network: "testnet"; sources: SourceEntry[] }): LoadedResearchNetworkProfile {
  const profile = { schemaVersion: 1 as const, network: "testnet" as const, infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "correlations.json" };
  return {
    profile,
    profileSha256: sha256(canonicalJson(profile)),
    sources: registry,
    sourceRegistrySha256: sha256(canonicalJson(registry)),
    marketRegistryRaw: "{}",
    marketRegistrySha256: sha256("{}"),
    deployment: { schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: "0x0000000000000000000000000000000000000000", parlayDeployBlock: "0" },
    deploymentRegistrySha256: sha256("{}"),
    baselineCorrelationRaw: "{}",
    baselineCorrelationSha256: sha256("{}"),
  };
}

test("candle snapshot maps exact Hyperliquid fields", () => {
  assert.deepEqual(parseCandleSnapshot(source, fixture("candle-snapshot.json"), 12_000_000)[0], {
    schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "testnet", underlying: "BTC", sourceCoin: "BTC", interval: "1h",
    openTimeMs: 3_600_000, closeTimeMs: 7_199_999, open: "100", high: "110", low: "90", close: "105", volume: "12.5", tradeCount: 8, retrievedAtMs: 12_000_000,
  });
});

test("candle snapshot rejects invalid OHLC, non-finite values, and reverse time", () => {
  const row = JSON.parse(fixture("candle-snapshot.json"))[0];
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([{ ...row, h: "99" }]), 12_000_000), /OHLC/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([{ ...row, v: "Infinity" }]), 12_000_000), /finite/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([{ ...row, T: row.t }]), 12_000_000), /time/);
});

test("candle snapshot rejects oversized, unordered, duplicate, non-hourly, out-of-range, and unclosed batches", () => {
  const row = JSON.parse(fixture("candle-snapshot.json"))[0];
  const later = { ...row, t: row.t + hour, T: row.T + hour };
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify(Array.from({ length: 5_001 }, (_, index) => ({ ...row, t: index * hour, T: (index + 1) * hour - 1 }))), 20_000_000_000), /5,000/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([later, row]), 20_000_000), /strictly increasing/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([row, row]), 20_000_000), /duplicate/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([{ ...row, T: row.T - 1 }]), 20_000_000), /one hour/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([row]), 20_000_000, { startTime: row.t + (2 * hour), endTime: row.T + (2 * hour) }), /non-adjacent/);
  assert.throws(() => parseCandleSnapshot(source, JSON.stringify([row]), row.T, { startTime: row.t, endTime: row.T }), /closed/);
});

test("closed candle pages retain a capped closed interval after adjacent provider extras", () => {
  const row = JSON.parse(fixture("candle-snapshot.json"))[0];
  const startTimeMs = hour;
  const endTimeMs = startTimeMs + (5_000 * hour) - 1;
  const rows = [
    { ...row, t: startTimeMs - hour, T: startTimeMs - 1 },
    ...Array.from({ length: 5_000 }, (_, index) => ({ ...row, t: startTimeMs + (index * hour), T: startTimeMs + ((index + 1) * hour) - 1 })),
  ];
  const page = selectClosedPage(rows, { coin: "BTC", startTimeMs, endTimeMs, retrievedAtMs: endTimeMs + hour });
  assert.equal(page.ignoredBefore, 1);
  assert.equal(page.ignoredAfter, 0);
  assert.equal(page.candles.length, 5_000);
  assert.equal(page.candles[0].openTimeMs, startTimeMs);
  assert.equal(page.candles.at(-1)?.closeTimeMs, endTimeMs);
  assert.equal(parseCandleSnapshot(source, JSON.stringify(rows), endTimeMs + hour, { startTime: startTimeMs, endTime: endTimeMs }).length, 5_000);
});

test("closed candle pages ignore only the adjacent currently open final row", () => {
  const row = JSON.parse(fixture("candle-snapshot.json"))[0];
  const startTimeMs = hour;
  const endTimeMs = startTimeMs + hour - 1;
  const page = selectClosedPage([
    { ...row, t: startTimeMs, T: endTimeMs },
    { ...row, t: endTimeMs + 1, T: endTimeMs + hour },
  ], { coin: "BTC", startTimeMs, endTimeMs, retrievedAtMs: endTimeMs + 2 });
  assert.equal(page.ignoredBefore, 0);
  assert.equal(page.ignoredAfter, 1);
  assert.equal(page.candles.length, 1);
});

test("closed-hour requests never include the current interval", () => {
  assert.deepEqual(lastClosedHour(Date.UTC(2026, 7, 29, 12, 37)), {
    lastOpenTimeMs: Date.UTC(2026, 7, 29, 11),
    endTimeMs: Date.UTC(2026, 7, 29, 11, 59, 59, 999),
  });
});

test("collector seals only the closed profile-bound page and journals boundary extras", async () => {
  const root = scratch();
  const nowMs = Date.UTC(2026, 7, 29, 12, 37);
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source] };
  const profile = loadedProfile(registry);
  const { lastOpenTimeMs, endTimeMs } = lastClosedHour(nowMs);
  const startTimeMs = lastOpenTimeMs - (4_999 * hour);
  const row = JSON.parse(fixture("candle-snapshot.json"))[0];
  const rows = [
    { ...row, t: startTimeMs - hour, T: startTimeMs - 1 },
    ...Array.from({ length: 5_000 }, (_, index) => ({ ...row, t: startTimeMs + (index * hour), T: startTimeMs + ((index + 1) * hour) - 1 })),
  ];
  const requests: { url: string; request: { startTime: number; endTime: number } }[] = [];
  try {
    const summary = await collectSources({ root, profile, nowMs, sleep: async () => {}, fetch: async (url, init) => {
      requests.push({ url: String(url), request: JSON.parse(String(init?.body)).req });
      return new Response(JSON.stringify(rows));
    } });
    assert.equal(summary.accepted, 5_000);
    assert.deepEqual(requests, [{ url: profile.profile.infoApiUrl, request: { coin: "BTC", interval: "1h", startTime: startTimeMs, endTime: endTimeMs } }]);
    assert.equal(readCandlePartition(shardFiles(root)[0]).length, 5_000);
    assert.equal(JSON.parse(readFileSync(join(root, "state", "collector.json"), "utf8")).sources["testnet:BTC"], lastOpenTimeMs);
    const journal = JSON.parse(readFileSync(join(root, "journal", "requests", "2026", "08", "29.jsonl"), "utf8"));
    assert.deepEqual({ network: journal.network, profileSha256: journal.profileSha256, startTimeMs: journal.startTimeMs, endTimeMs: journal.endTimeMs, ignoredBefore: journal.ignoredBefore, ignoredAfter: journal.ignoredAfter }, { network: "testnet", profileSha256: profile.profileSha256, startTimeMs, endTimeMs, ignoredBefore: 1, ignoredAfter: 0 });
    const provenance = JSON.parse(readFileSync(`${shardFiles(root)[0]}.provenance.json`, "utf8"));
    assert.deepEqual({ network: provenance.network, profileSha256: provenance.profileSha256, startTimeMs: provenance.startTimeMs, endTimeMs: provenance.endTimeMs, ignoredBefore: provenance.ignoredBefore, ignoredAfter: provenance.ignoredAfter }, { network: "testnet", profileSha256: profile.profileSha256, startTimeMs, endTimeMs, ignoredBefore: 1, ignoredAfter: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector skips sources excluded from measurement", async () => {
  const root = scratch();
  let calls = 0;
  try {
    await collectSources({ root, registry: { schemaVersion: 2, network: "testnet", sources: [{ ...source, measurementEnabled: false }] }, nowMs: 12_000_000, sleep: async () => {}, fetch: async () => {
      calls++;
      return new Response("[]");
    } });
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candle request uses a 5,000-hour initial range and resumes after the durable bar", () => {
  assert.deepEqual(nextCandleRequest(source, null, 20_000_000_000), { source, startTimeMs: 1_998_000_000, endTimeMs: 19_997_999_999 });
  assert.deepEqual(nextCandleRequest(source, 7_200_000, 20_000_000_000), { source, startTimeMs: 10_800_000, endTimeMs: 18_010_799_999 });
});

test("candle request recovers from a stale state file using sealed candles", async () => {
  const root = scratch();
  const nowMs = 15_000_000;
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source] };
  const requests: { startTime: number }[] = [];
  try {
    await collectSources({ root, registry, nowMs, fetch: async () => new Response(fixture("candle-snapshot.json")) });
    writeFileSync(join(root, "state", "collector.json"), JSON.stringify({ schemaVersion: 1, sourceRegistrySha256: sha256(canonicalJson(registry)), sources: { "testnet:BTC": 3_600_000 } }));
    await collectSources({ root, registry, nowMs, fetch: async (_url, init) => {
      requests.push(JSON.parse(init?.body as string).req);
      return new Response("[]");
    } });
    assert.equal(requests[0].startTime, 10_800_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daily manifest retains the registry fact that produced its sealed shard", async () => {
  const root = scratch();
  const nowMs = 12_000_000;
  const registryA = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source] };
  const registryB = { schemaVersion: 2 as const, network: "testnet" as const, sources: [{ ...source, underlying: "BTC-RENAMED" }] };
  try {
    await collectSources({ root, registry: registryA, nowMs, fetch: async () => new Response(fixture("candle-snapshot.json")) });
    await collectSources({ root, registry: registryB, nowMs: nowMs + 86_400_000, fetch: async () => new Response("[]") });
    assert.equal(buildDailyManifest(root, "1970-01-01").sourceRegistrySha256, sha256(canonicalJson(registryA)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector publishes a content-addressed rolling manifest and current mapping-epoch pointer", async () => {
  const root = scratch();
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source] };
  try {
    const summary = await collectSources({ root, registry, nowMs: 12_000_000, fetch: async () => new Response(fixture("candle-snapshot.json")) });
    assert.ok(summary.manifestPath);
    const pointer = JSON.parse(readFileSync(join(root, "manifests", "current.json"), "utf8"));
    assert.equal(pointer.sourceRegistrySha256, sha256(canonicalJson(registry)));
    assert.equal(pointer.lookbackMs, 180 * 86_400_000);
    assert.equal(pointer.path, summary.manifestPath.slice(root.length + 1));
    assert.equal(sha256(canonicalJson(JSON.parse(readFileSync(summary.manifestPath, "utf8")))), pointer.manifestSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session calendars report missing expected open hours", async () => {
  const root = scratch();
  const sessionSource: SourceEntry = { ...source, underlying: "NYSE", sourceCoin: "NYSE", calendar: "session", session: { timeZone: "UTC", weekdays: [1], openLocal: "09:00", closeLocal: "12:00", closedDates: [] } };
  const nowMs = Date.UTC(1970, 0, 5, 13);
  const snapshot = JSON.stringify([
    { t: Date.UTC(1970, 0, 5, 9), T: Date.UTC(1970, 0, 5, 10) - 1, s: "NYSE", i: "1h", o: "1", h: "1", l: "1", c: "1", v: "1", n: 1 },
    { t: Date.UTC(1970, 0, 5, 11), T: Date.UTC(1970, 0, 5, 12) - 1, s: "NYSE", i: "1h", o: "1", h: "1", l: "1", c: "1", v: "1", n: 1 },
  ]);
  try {
    await collectSources({ root, registry: { schemaVersion: 2, network: "testnet", sources: [sessionSource] }, nowMs, fetch: async () => new Response(snapshot) });
    assert.deepEqual(buildDailyManifest(root, "1970-01-05").underlyings.NYSE.missingIntervals, [Date.UTC(1970, 0, 5, 10)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector uses every bounded retry delay and journals HTTP failures with their status", async () => {
  const root = scratch();
  const delays: number[] = [];
  let attempts = 0;
  try {
    const summary = await collectSources({ root, registry: { schemaVersion: 2, network: "testnet", sources: [source] }, nowMs: 12_000_000, sleep: async (delay) => { delays.push(delay); }, fetch: async () => {
      attempts++;
      return new Response("unavailable", { status: 503 });
    } });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [250, 1_000, 4_000]);
    assert.deepEqual(summary.failures.map((failure) => failure.underlying), ["BTC", "manifest"]);
    const journal = readFileSync(join(root, "journal", "requests", "1970", "01", "01.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(journal.map((entry) => entry.httpStatus), [503, 503, 503]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a source failure preserves a sibling source's sealed shard", async () => {
  const root = scratch();
  const eth = { ...source, underlying: "ETH", sourceCoin: "ETH" };
  try {
    const summary = await collectSources({ root, registry: { schemaVersion: 2, network: "testnet", sources: [source, eth] }, nowMs: 12_000_000, sleep: async () => {}, fetch: async (_url, init) => JSON.parse(init?.body as string).req.coin === "BTC" ? new Response(fixture("candle-snapshot.json")) : new Response("bad", { status: 500 }) });
    assert.equal(summary.accepted, 2);
    assert.deepEqual(summary.failures.map((failure) => failure.underlying), ["ETH"]);
    assert.equal(shardFiles(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical fixture collections in independent roots produce identical sealed shards", async () => {
  const firstRoot = scratch();
  const secondRoot = scratch();
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source] };
  try {
    await collectSources({ root: firstRoot, registry, nowMs: 12_000_000, fetch: async () => new Response(fixture("candle-snapshot.json")) });
    await collectSources({ root: secondRoot, registry, nowMs: 12_000_000, fetch: async () => new Response(fixture("candle-snapshot.json")) });
    assert.equal(sha256(readFileSync(shardFiles(firstRoot)[0])), sha256(readFileSync(shardFiles(secondRoot)[0])));
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("collector CLI requires a loaded network profile before fetching", () => {
  const root = scratch();
  const sources = join(root, "sources.json");
  try {
    writeFileSync(sources, JSON.stringify({ schemaVersion: 2, network: "testnet", sources: [source] }));
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "collect"], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, RESEARCH_ROOT: root, CORRELATION_SOURCES_FILE: sources, RESEARCH_INFO_API_URL: "http://127.0.0.1:1" }, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /RESEARCH_NETWORK_PROFILE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candle snapshot collection is idempotent without replacing the accepted candle", async () => {
  const root = scratch();
  const nowMs = 12_000_000;
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source] };
  const response = (body: string) => async () => new Response(body, { status: 200 });
  try {
    await collectSources({ root, registry, nowMs, fetch: response(fixture("candle-snapshot.json")) });
    const first = shardFiles(root);
    assert.equal(first.length, 1);
    const accepted = readCandlePartition(first[0]);
    const firstHash = sha256(canonicalJson(buildDailyManifest(root, "1970-01-01")));

    await collectSources({ root, registry, nowMs, fetch: response("[]") });
    assert.equal(shardFiles(root).length, 1);
    assert.equal(sha256(canonicalJson(buildDailyManifest(root, "1970-01-01"))), firstHash);
    assert.deepEqual(readCandlePartition(first[0]), accepted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-response conflicting duplicates are quarantined before any shard or checkpoint is sealed", async () => {
  const root = scratch();
  const registry = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source] };
  const row = JSON.parse(fixture("candle-snapshot.json"))[0];
  try {
    const summary = await collectSources({ root, registry, nowMs: 12_000_000, sleep: async () => {}, fetch: async () => new Response(JSON.stringify([row, { ...row, h: "111" }])) });
    assert.equal(summary.accepted, 0);
    assert.equal(summary.conflicts, 1);
    assert.deepEqual(summary.failures.map((failure) => failure.underlying), ["BTC", "manifest"]);
    assert.equal(existsSync(join(root, "raw", "candles")), false);
    assert.match(readFileSync(join(root, "quarantine", "candles", "1970", "01", "01.jsonl"), "utf8"), /"high":"111"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
