import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkets, parseInviteCodes, parseCorsOrigins, defaultPerCodeReservedCap, syncedPerCodeReservedCap, loadConfig } from "../src/config.js";

const VAULT = "0x1111111111111111111111111111111111111111";
const MARKET = { vault: VAULT, coinYes: "#1", coinNo: "#2", underlying: "q844", cluster: "WC2026", title: "Draw", category: "sports", question: 844, startMs: 1, expiryMs: 2, sideYes: "Draw", sideNo: "No draw", group: "q844", groupTitle: "Saudi Arabia vs Uruguay" };

test("parseInviteCodes trims and drops empties", () => {
  assert.deepEqual([...parseInviteCodes(" a, b,,c ")], ["a", "b", "c"]);
});

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

test("writer boots with only sports configuration and filters historical public metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-config-sports-"));
  const marketsFile = join(root, "markets.json");
  const legacy = { ...MARKET, category: "other", title: "Legacy market" };
  const values = {
    PRICING_MODE: "", MARKETS_FILE: marketsFile, PARLAY_VAULT_ADDRESS: VAULT, PARLAY_DEPLOY_BLOCK: "1",
    MAX_STAKE: "1000000", PER_MARKET_CAP: "1000000", PER_CLUSTER_CAP: "1000000", INVITE_CODES: "test",
    WRITER_ADDRESS: "0x2222222222222222222222222222222222222222",
    QUOTE_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`, POKER_PRIVATE_KEY: `0x${"22".repeat(32)}`, TESTNET_RPC: "http://localhost:1",
    WRITER_RPC: "", SPOT_PX_STALE_MS: "60000", QUOTE_JOURNAL_FILE: join(root, "quotes.jsonl"),
  };
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    writeFileSync(marketsFile, JSON.stringify({ network: "testnet", markets: [MARKET], archived: [MARKET, legacy] }));
    Object.assign(process.env, values);
    const config = loadConfig();
    assert.equal(config.parlayVault, VAULT);
    assert.equal(config.rpcUrl, values.TESTNET_RPC);
    assert.equal(config.deployBlock, 1n);
    assert.equal(config.markets.get(VAULT)?.question, 844);
    assert.equal(config.quoteJournalFile, values.QUOTE_JOURNAL_FILE);
    assert.deepEqual(JSON.parse(config.registryJson).archived, [MARKET]);
    process.env.PRICING_MODE = "independent";
    assert.equal(loadConfig().markets.size, 1);
    process.env.PRICING_MODE = "unsupported";
    assert.throws(() => loadConfig(), /PRICING_MODE/);
    process.env.PRICING_MODE = "";
    process.env.SPOT_PX_STALE_MS = "not-a-number";
    assert.throws(() => loadConfig(), /SPOT_PX_STALE_MS/);
    process.env.SPOT_PX_STALE_MS = "0";
    assert.equal(loadConfig().spotPxStaleMs, Infinity);
    process.env.QUOTE_SIGNER_PRIVATE_KEY = "invalid";
    assert.throws(() => loadConfig(), /QUOTE_SIGNER_PRIVATE_KEY must be/);
  } finally {
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
