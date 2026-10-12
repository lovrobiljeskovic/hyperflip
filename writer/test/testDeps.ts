import { after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { newMetrics, type QuoteDeps } from "../src/server.js";
import { ExposureBook } from "../src/exposure.js";
import { RateLimiter, Waitlist } from "../src/waitlist.js";
import { WAD } from "../src/units.js";
import type { WriterConfig } from "../src/config.js";

export const V1 = "0x1111111111111111111111111111111111111111" as Address;
export const V2 = "0x2222222222222222222222222222222222222222" as Address;
export const TAKER = "0x3333333333333333333333333333333333333333" as Address;

export function testCfg(overrides: Partial<WriterConfig> = {}): WriterConfig {
  return {
    chainId: 998, chainName: "HyperEVM Testnet", coreChainId: 998, rpcUrl: "", parlayVault: V1, writerAddress: TAKER,
    quoteSignerKey: `0x${"11".repeat(32)}` as `0x${string}`,
    pokerKey: `0x${"22".repeat(32)}` as `0x${string}`,
    infoApiUrl: "", quoteJournalFile: "/dev/null", port: 0, edgeBps: 0n, minPremiumBps: 100n, minLegs: 2,
    maxStake: 10_000_000n, perMarketCap: 1_000_000_000n, perClusterCap: 1_000_000_000n,
    perCodeReservedCap: 1_000_000_000n,
    openAccess: false,
    legEdgeBps: 0n, quoteTtlMs: 30_000,
    spotPxStaleMs: 60_000,
    minBookDepthWad: 0n,
    lockoutMs: 600_000, inPlayCapBps: 5000n, livePriorPollMs: 0, livePriorStaleMs: 60_000, livePriorJumpWad: WAD / 10n, livePriorSuspendMs: 30_000,
    pokerIntervalMs: 15_000, deployBlock: 0n,
    waitlistFile: "/dev/null", parlayIndexFile: "/dev/null",
    corsOrigins: ["https://overround.xyz"],
    markets: new Map([
      [V1.toLowerCase(), { vault: V1, coinYes: "+10", coinNo: "+11", underlying: "game-1", cluster: "sports", title: "Twins vs Orioles", category: "sports" }],
      [V2.toLowerCase(), { vault: V2, coinYes: "+20", coinNo: "+21", expiryMs: 2_000_000, underlying: "game-2", cluster: "sports", title: "Arsenal vs Chelsea", category: "sports" }],
    ]),
    registryJson: "{}",
    ...overrides,
  };
}

const authDirectory = mkdtempSync(join(tmpdir(), "quote-auth-"));
after(() => rmSync(authDirectory, { recursive: true, force: true }));
let authFixture = 0;
export function testDeps(overrides: Partial<QuoteDeps> = {}): QuoteDeps {
  const c = overrides.cfg ?? testCfg();
  const file = join(authDirectory, `${authFixture++}.json`);
  writeFileSync(file, JSON.stringify([
    { email: "a@b.co", code: "historical-code", ts: 0 },
    { email: "other@b.co", code: "historical-code-2", ts: 0 },
  ]));
  return {
    waitlist: new Waitlist(file),
    authenticate: async token => token === "test-token" || token === "other-token" ? {
      userId: token === "test-token" ? "did:privy:first" : "did:privy:second",
      emails: [token === "test-token" ? "a@b.co" : "other@b.co"], wallets: [TAKER.toLowerCase(), V1.toLowerCase()],
    } : null,
    cfg: c,
    exposure: new ExposureBook((v) => c.markets.get(v)?.cluster),
    chainId: 31337,
    fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "l2Book", observedAtMs: 1_000_000, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }),
    recordQuote: async () => {},
    readAllowance: async () => 1_000_000_000n,
    readSettled: async () => new Set(),
    sign: async () => "0xsig" as Hex,
    now: () => 1_000_000,
    randomId: () => `0x${"ab".repeat(32)}` as Hex,
    metrics: newMetrics(),
    signupLimiter: new RateLimiter(Infinity, 60_000),
    badInviteLimiter: new RateLimiter(Infinity, 60_000),
    quoteLimiter: new RateLimiter(Infinity, 60_000),
    ready: () => true,
    livePriorYes: () => undefined,
    parlaysOf: () => [],
    ...overrides,
  };
}
