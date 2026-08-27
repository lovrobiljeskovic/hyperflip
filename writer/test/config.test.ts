import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseMarkets,
  parseInviteCodes,
  parseCorsOrigins,
  defaultPerCodeReservedCap,
  syncedPerCodeReservedCap,
  loadConfig,
} from "../src/config.js";
import { parseCorrelations } from "../src/correlation.js";

const VAULT = "0x1111111111111111111111111111111111111111";

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
  const keys = [
    "MARKETS_FILE",
    "MAX_STAKE",
    "PER_MARKET_CAP",
    "PER_CLUSTER_CAP",
    "INVITE_CODES",
    "PARLAY_VAULT_ADDRESS",
    "WRITER_ADDRESS",
    "QUOTE_SIGNER_PRIVATE_KEY",
    "POKER_PRIVATE_KEY",
    "TESTNET_RPC",
    "SPOT_PX_STALE_MS",
  ];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.MARKETS_FILE = "registry/markets.json";
    process.env.MAX_STAKE = "1000000";
    process.env.PER_MARKET_CAP = "1000000";
    process.env.PER_CLUSTER_CAP = "1000000";
    process.env.INVITE_CODES = "test";
    process.env.PARLAY_VAULT_ADDRESS = "0x1111111111111111111111111111111111111111";
    process.env.WRITER_ADDRESS = "0x2222222222222222222222222222222222222222";
    process.env.QUOTE_SIGNER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    process.env.POKER_PRIVATE_KEY = `0x${"22".repeat(32)}`;
    process.env.TESTNET_RPC = "http://localhost:1";
    process.env.SPOT_PX_STALE_MS = "not-a-number";
    assert.throws(() => loadConfig(), /SPOT_PX_STALE_MS/);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
