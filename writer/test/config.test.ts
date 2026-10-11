import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkets, laneRows, parseCorsOrigins, defaultPerCodeReservedCap, syncedPerCodeReservedCap, loadConfig } from "../src/config.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const MARKET = { vault: VAULT, coinYes: "#1", coinNo: "#2", underlying: "q844", cluster: "WC2026", title: "Draw", category: "sports", question: 844, startMs: 1, expiryMs: 2, sideYes: "Draw", sideNo: "No draw", group: "q844", groupTitle: "Saudi Arabia vs Uruguay" };

test("parseCorsOrigins trims and drops empties", () => {
  assert.deepEqual(parseCorsOrigins(" https://overround.xyz, https://overround-wine.vercel.app,, "), [
    "https://overround.xyz",
    "https://overround-wine.vercel.app",
  ]);
});

test("defaultPerCodeReservedCap tracks minPremiumBps, not a fixed multiple of maxStake", () => {
  assert.equal(defaultPerCodeReservedCap(1_000_000n, 100n), 1_000_000n * 297n);
  assert.equal(defaultPerCodeReservedCap(1_000_000n, 200n), 1_000_000n * 147n);
  assert.equal(defaultPerCodeReservedCap(1_000_000n, 50n), 1_000_000n * 597n);
});

test("syncedPerCodeReservedCap recomputes the default off the chain value, but never touches an explicit override", () => {
  assert.equal(
    syncedPerCodeReservedCap(false, 1_000_000n * 297n, 1_000_000n, 200n),
    defaultPerCodeReservedCap(1_000_000n, 200n),
  );
  const explicit = 42n;
  assert.equal(syncedPerCodeReservedCap(true, explicit, 1_000_000n, 200n), explicit);
});


test("parseMarkets accepts sports metadata and rejects malformed active markets", () => {
  for (const raw of [[MARKET], { markets: [MARKET] }]) {
    assert.deepEqual(parseMarkets(JSON.stringify(raw)).get(VAULT), MARKET);
  }
  // Elysium rows: `vault` is the leg the ParlayVault reads, `sourceVault` the 998 vault behind it.
  const sourceVault = "0x69288D331911984fAeC8Af82688B7f718e2bB541";
  assert.equal(parseMarkets(JSON.stringify([{ ...MARKET, sourceVault }])).get(VAULT)?.sourceVault, sourceVault);
  assert.throws(() => parseMarkets(JSON.stringify([{ ...MARKET, sourceVault: "0x12" }])), /invalid sourceVault/);
  for (const [change, reason] of [
    [{ vault: "invalid" }, /invalid market vault/],
    [{ coinYes: undefined }, /coinYes/],
    [{ underlying: "" }, /underlying/],
    [{ cluster: "" }, /cluster/],
    [{ title: "" }, /title/],
    [{ category: "" }, /category/],
    [{ category: "other" }, /must be sports/],
    [{ question: "844" }, /question must be a number/],
    [{ startMs: "1" }, /startMs must be a number/],
    [{ sideYes: "" }, /sideYes/],
  ] as const) {
    assert.throws(() => parseMarkets(JSON.stringify([{ ...MARKET, ...change }])), reason);
  }
  assert.throws(() => parseMarkets("{}"), /JSON array/);
});

test("laneRows: a writer on the Core chain reads the 998 vault behind an Elysium row", () => {
  const leg = "0x7d3f116e525ceaf7bfae310c091b8fcf82ac1612";
  const rows = [{ ...MARKET, vault: leg, sourceVault: VAULT }, MARKET];
  // Elysium writer: rows as written (vault = leg).
  assert.deepEqual(laneRows(rows, 99801, 998), rows);
  // 998 writer: vault = sourceVault, no sourceVault left; rows without one pass through.
  assert.deepEqual(laneRows(rows, 998, 998), [MARKET, MARKET]);
});

test("writer boots with only sports configuration and filters historical public metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-config-sports-"));
  const marketsFile = join(root, "markets.json");
  const legacy = { ...MARKET, category: "other", title: "Legacy market" };
  const values = {
    DEPLOYMENT_FILE: join(root, "deployment.json"), EVM_CHAIN_ID: "998", POKER_INTERVAL_MS: "15000",
    PRICING_MODE: "", MARKETS_FILE: marketsFile, PARLAY_VAULT_ADDRESS: VAULT, PARLAY_DEPLOY_BLOCK: "1",
    MAX_STAKE: "1000000", PER_MARKET_CAP: "1000000", PER_CLUSTER_CAP: "1000000", INVITE_CODES: "test",
    WRITER_ADDRESS: "0x2222222222222222222222222222222222222222",
    QUOTE_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`, POKER_PRIVATE_KEY: `0x${"22".repeat(32)}`, TESTNET_RPC: "http://localhost:1",
    WRITER_RPC: "", SPOT_PX_STALE_MS: "60000", QUOTE_JOURNAL_FILE: join(root, "quotes.jsonl"),
  };
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    writeFileSync(marketsFile, JSON.stringify({ network: "testnet", markets: [MARKET], archived: [MARKET, legacy] }));
    writeFileSync(values.DEPLOYMENT_FILE, JSON.stringify({ schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: VAULT, parlayDeployBlock: "1" }));
    Object.assign(process.env, values);
    const config = loadConfig();
    assert.equal(config.parlayVault, VAULT);
    assert.equal("inviteCodes" in config, false);
    assert.equal(config.rpcUrl, values.TESTNET_RPC);
    assert.equal(config.deployBlock, 1n);
    assert.equal(config.markets.get(VAULT)?.question, 844);
    assert.equal(config.quoteJournalFile, values.QUOTE_JOURNAL_FILE);
    assert.deepEqual(JSON.parse(config.registryJson).archived, [MARKET]);
    // Shared registry, Elysium-shaped row: the 998 writer keys and serves it by the 998 vault.
    const leg = "0x7d3f116e525ceaf7bfae310c091b8fcf82ac1612";
    writeFileSync(marketsFile, JSON.stringify({ network: "testnet", markets: [{ ...MARKET, vault: leg, sourceVault: VAULT }], archived: [] }));
    const lane998 = loadConfig();
    assert.equal(lane998.markets.get(VAULT)?.title, "Draw");
    assert.equal(lane998.markets.has(leg), false);
    assert.deepEqual(JSON.parse(lane998.registryJson).markets, [MARKET]);
    writeFileSync(marketsFile, JSON.stringify({ network: "testnet", markets: [MARKET], archived: [MARKET, legacy] }));
    process.env.PRICING_MODE = "independent";
    assert.equal(loadConfig().markets.size, 1);
    process.env.PRICING_MODE = "unsupported";
    assert.throws(() => loadConfig(), /PRICING_MODE/);
    process.env.PRICING_MODE = "";
    process.env.SPOT_PX_STALE_MS = "not-a-number";
    assert.throws(() => loadConfig(), /SPOT_PX_STALE_MS/);
    process.env.SPOT_PX_STALE_MS = "0";
    assert.equal(loadConfig().spotPxStaleMs, Infinity);
    process.env.POKER_INTERVAL_MS = "0";
    assert.throws(() => loadConfig(), /POKER_INTERVAL_MS/);
    process.env.POKER_INTERVAL_MS = "15000";
    process.env.QUOTE_SIGNER_PRIVATE_KEY = "invalid";
    assert.throws(() => loadConfig(), /QUOTE_SIGNER_PRIVATE_KEY must be/);
  } finally {
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
