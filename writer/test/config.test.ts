import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMarkets,
  parseInviteCodes,
  parseCorsOrigins,
  defaultPerCodeReservedCap,
  syncedPerCodeReservedCap,
  loadConfig,
} from "../src/config.js";
import { parseCorrelations } from "../src/correlation.js";
import { canonicalJson, sha256 } from "../src/research/store.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const CONFIG_NOW = Date.parse("2026-08-28T18:00:00.000Z");

function writeLiveConfigFixture(root: string): { artifactFile: string; sourcesFile: string; marketsFile: string; artifact: Record<string, any> } {
  const sources = {
    schemaVersion: 1,
    sources: ["BTC", "ETH"].map((underlying) => ({ schemaVersion: 1, underlying, sourceNetwork: "mainnet", sourceCoin: underlying, cluster: "crypto", calendar: "continuous", eligible: true, fallbackEligible: false })),
  };
  const artifact = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8")) as Record<string, any>;
  artifact.sourceRegistrySha256 = sha256(canonicalJson(sources));
  const markets = [{ vault: VAULT, coinYes: "+1", coinNo: "+2", underlying: "BTC", cluster: "crypto", direction: "up", title: "BTC", category: "crypto" }];
  const artifactFile = join(root, "champion.json");
  const sourcesFile = join(root, "sources.json");
  const marketsFile = join(root, "markets.json");
  writeFileSync(artifactFile, JSON.stringify(artifact));
  writeFileSync(sourcesFile, canonicalJson(sources));
  writeFileSync(marketsFile, JSON.stringify(markets));
  return { artifactFile, sourcesFile, marketsFile, artifact };
}

test("parseMarkets parses JSON array and keys by lowercase vault", () => {
  const raw = JSON.stringify([
    { vault: VAULT.toUpperCase().replace("0X", "0x"), coinYes: "+123850", coinNo: "+123851", expiryMs: 1755500000000, underlying: "BTC", cluster: "crypto", direction: "up", title: "Will BTC close above X?", category: "crypto" },
  ]);
  const m = parseMarkets(raw);
  const info = m.get(VAULT.toLowerCase());
  assert.ok(info);
  assert.equal(info.coinYes, "+123850");
  assert.equal(info.coinNo, "+123851");
  assert.equal(info.expiryMs, 1755500000000);
  assert.equal(info.underlying, "BTC");
  assert.equal(info.cluster, "crypto");
  assert.equal(info.direction, "up");
  assert.equal(info.title, "Will BTC close above X?");
  assert.equal(info.category, "crypto");
});

test("parseMarkets rejects bad address", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: "0xnope", coinYes: "a", coinNo: "b", underlying: "BTC", cluster: "crypto" }])));
});

test("parseMarkets rejects missing coin fields", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT }])));
});

test("parseMarkets rejects missing underlying/cluster", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b" }])));
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "BTC" }])));
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "", cluster: "crypto" }])));
});

test("parseMarkets rejects missing or bad direction", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "BTC", cluster: "crypto", title: "t", category: "c" }])), /direction/);
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "BTC", cluster: "crypto", direction: "sideways", title: "t", category: "c" }])), /direction/);
});

test("parseMarkets accepts registry object shape and requires title/category", () => {
  const raw = JSON.stringify({
    markets: [{
      vault: "0x2695562df7D7056E7262CC5D2CD7b5916ce463aF",
      title: "Will MU close above X?", category: "crypto",
      coinYes: "#130690", coinNo: "#130691", underlying: "MU", cluster: "crypto", direction: "up",
    }],
  });
  const m = parseMarkets(raw);
  const info = m.get("0x2695562df7d7056e7262cc5d2cd7b5916ce463af")!;
  assert.equal(info.title, "Will MU close above X?");
  assert.equal(info.category, "crypto");
});

test("parseMarkets rejects entry missing title/category", () => {
  const raw = JSON.stringify({
    markets: [{
      vault: "0x2695562df7D7056E7262CC5D2CD7b5916ce463aF",
      coinYes: "#130690", coinNo: "#130691", underlying: "MU", cluster: "crypto", direction: "up",
    }],
  });
  assert.throws(() => parseMarkets(raw), /missing title\/category/);
});

test("parseInviteCodes trims and drops empties", () => {
  assert.deepEqual([...parseInviteCodes(" a, b,,c ")], ["a", "b", "c"]);
});

test("parseCorsOrigins trims and drops empties", () => {
  assert.deepEqual(parseCorsOrigins(" https://overround.xyz, https://overround-wine.vercel.app,, "), [
    "https://overround.xyz",
    "https://overround-wine.vercel.app",
  ]);
});

// mainnet-hardening P0-4: the default PER_CODE_RESERVED_CAP must track
// minPremiumBps, not a hardcoded multiple, or it silently stops matching its
// own justification (floorCap in pricing.ts) whenever MIN_PREMIUM_BPS changes.
test("defaultPerCodeReservedCap tracks minPremiumBps, not a fixed multiple of maxStake", () => {
  // default 100bps -> floorCap multiple = 10000/100 - 1 = 99x, *3 = 297x
  assert.equal(defaultPerCodeReservedCap(1_000_000n, 100n), 1_000_000n * 297n);
  // a stricter 200bps halves the floorCap multiple -> 10000/200 - 1 = 49x, *3 = 147x
  assert.equal(defaultPerCodeReservedCap(1_000_000n, 200n), 1_000_000n * 147n);
  // a looser 50bps doubles it -> 10000/50 - 1 = 199x, *3 = 597x
  assert.equal(defaultPerCodeReservedCap(1_000_000n, 50n), 1_000_000n * 597n);
});

// mainnet-hardening final review: index.ts overwrites cfg.minPremiumBps with
// the chain value after loadConfig runs, so a PER_CODE_RESERVED_CAP left to
// default must be recomputed off that chain value too, or it silently keeps
// pricing against the stale env minPremiumBps.
test("syncedPerCodeReservedCap recomputes the default off the chain value, but never touches an explicit override", () => {
  assert.equal(
    syncedPerCodeReservedCap(false, 1_000_000n * 297n, 1_000_000n, 200n),
    defaultPerCodeReservedCap(1_000_000n, 200n),
  );
  const explicit = 42n;
  assert.equal(syncedPerCodeReservedCap(true, explicit, 1_000_000n, 200n), explicit);
});

// mainnet-hardening final review: isSpotPxStale is `now - lastFreshMs > staleMs`;
// a NaN staleMs makes every comparison false, silently disabling the P0-1
// freshness gate. loadConfig must refuse to boot instead.
test("loadConfig throws on a non-numeric SPOT_PX_STALE_MS", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-config-spot-"));
  const fixture = writeLiveConfigFixture(root);
  try {
    withConfigEnv(fixture.artifactFile, () => {
      process.env.SPOT_PX_STALE_MS = "not-a-number";
      assert.throws(() => loadConfig(CONFIG_NOW), /SPOT_PX_STALE_MS/);
      process.env.SPOT_PX_STALE_MS = "0";
      assert.equal(loadConfig(CONFIG_NOW).spotPxStaleMs, Infinity);
    }, { MARKETS_FILE: fixture.marketsFile, CORRELATION_SOURCES_FILE: fixture.sourcesFile });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function withConfigEnv(artifactFile: string, run: () => void, overrides: Record<string, string> = {}): void {
  const values: Record<string, string> = {
    MARKETS_FILE: "writer/test/fixtures/markets.json", MAX_STAKE: "1000000", PER_MARKET_CAP: "1000000", PER_CLUSTER_CAP: "1000000", INVITE_CODES: "test",
    PARLAY_VAULT_ADDRESS: "0x1111111111111111111111111111111111111111", WRITER_ADDRESS: "0x2222222222222222222222222222222222222222",
    QUOTE_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`, POKER_PRIVATE_KEY: `0x${"22".repeat(32)}`, TESTNET_RPC: "http://localhost:1",
    CORRELATION_ARTIFACT_FILE: artifactFile, CORRELATION_SOURCES_FILE: "registry/correlation-sources.json", RESEARCH_ROOT: "research-data",
    ...overrides,
  };
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); run(); }
  finally { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

test("loadConfig refuses a malformed champion artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-config-artifact-"));
  try {
    const artifact = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8"));
    artifact.schemaVersion = 2;
    const file = join(root, "champion.json");
    writeFileSync(file, JSON.stringify(artifact));
    withConfigEnv(file, () => assert.throws(() => loadConfig(Date.parse("2026-08-28T18:00:00.000Z")), /schemaVersion/));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a champion age at seven days disables only multi-asset correlation", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-config-stale-"));
  try {
    const fixture = writeLiveConfigFixture(root);
    fixture.artifact.dataAsOf = new Date(CONFIG_NOW - 7 * 86_400_000).toISOString();
    writeFileSync(fixture.artifactFile, JSON.stringify(fixture.artifact));
    withConfigEnv(fixture.artifactFile, () => {
      const config = loadConfig(CONFIG_NOW);
      assert.equal(config.model.ageMs, 7 * 86_400_000);
      assert.equal(config.model.multiAssetEnabled, false);
      assert.ok(config.correlations.underlyings.BTC);
    }, { MARKETS_FILE: fixture.marketsFile, CORRELATION_SOURCES_FILE: fixture.sourcesFile });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loadConfig rejects a champion from a different current source registry", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-config-source-hash-"));
  try {
    const fixture = writeLiveConfigFixture(root);
    fixture.artifact.sourceRegistrySha256 = "c".repeat(64);
    writeFileSync(fixture.artifactFile, JSON.stringify(fixture.artifact));
    withConfigEnv(fixture.artifactFile, () => assert.throws(() => loadConfig(CONFIG_NOW), /source registry hash mismatch/), {
      MARKETS_FILE: fixture.marketsFile, CORRELATION_SOURCES_FILE: fixture.sourcesFile,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loadConfig rejects source, market, and artifact cluster disagreement", () => {
  for (const kind of ["market", "artifact"] as const) {
    const root = mkdtempSync(join(tmpdir(), `hype-config-${kind}-cluster-`));
    try {
      const fixture = writeLiveConfigFixture(root);
      if (kind === "market") {
        writeFileSync(fixture.marketsFile, JSON.stringify([{ vault: VAULT, coinYes: "+1", coinNo: "+2", underlying: "BTC", cluster: "equity", direction: "up", title: "BTC", category: "crypto" }]));
      } else {
        fixture.artifact.clusters.equity = { BTC: fixture.artifact.clusters.crypto.BTC };
        delete fixture.artifact.clusters.crypto.BTC;
        writeFileSync(fixture.artifactFile, JSON.stringify(fixture.artifact));
      }
      withConfigEnv(fixture.artifactFile, () => assert.throws(() => loadConfig(CONFIG_NOW), /cluster disagreement/), {
        MARKETS_FILE: fixture.marketsFile, CORRELATION_SOURCES_FILE: fixture.sourcesFile,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("loadConfig rejects a future-dated champion", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-config-future-"));
  try {
    const fixture = writeLiveConfigFixture(root);
    fixture.artifact.dataAsOf = new Date(CONFIG_NOW + 3_600_000).toISOString();
    fixture.artifact.createdAt = fixture.artifact.dataAsOf;
    writeFileSync(fixture.artifactFile, JSON.stringify(fixture.artifact));
    withConfigEnv(fixture.artifactFile, () => assert.throws(() => loadConfig(CONFIG_NOW), /future/), {
      MARKETS_FILE: fixture.marketsFile, CORRELATION_SOURCES_FILE: fixture.sourcesFile,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the shipped correlations file parses and covers a registry's clusters and underlyings", () => {
  // Deliberately a committed fixture, not registry/markets.json: the live file
  // is owned and rewritten by tools/rotate-markets.mjs, so asserting against it
  // is non-deterministic by construction. The live file's coverage is checked
  // at boot by loadConfig, which warns on an unknown cluster instead.
  const raw = readFileSync(new URL("../../registry/correlations.json", import.meta.url), "utf8");
  const table = parseCorrelations(raw);
  const markets = parseMarkets(readFileSync(new URL("./fixtures/markets.json", import.meta.url), "utf8"));
  for (const m of markets.values()) {
    // The cluster must be known on its own. An underlying-only match is not
    // enough: a market labelled with a cluster the table has never heard of
    // prices against the blunt whole-table fallback, not against its peers,
    // even when its underlying is tabulated.
    assert.ok(table.fallback[m.cluster] !== undefined, `unknown cluster ${m.cluster} for ${m.underlying}`);
    assert.ok(
      table.underlyings[m.underlying] !== undefined || table.fallback[m.cluster] !== undefined,
      `no loadings and no cluster fallback for ${m.underlying} (${m.cluster})`,
    );
  }
});

test("the coverage assertion fails a market whose cluster the table does not know", () => {
  // Guards the assertion itself: the `||` form this replaced passed on the
  // underlying alone, so a BTC market mislabelled into cluster "btc" slipped by.
  const table = parseCorrelations(readFileSync(new URL("../../registry/correlations.json", import.meta.url), "utf8"));
  assert.ok(table.underlyings.BTC !== undefined);
  assert.equal(table.fallback.btc, undefined);
});
