import crypto from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parlayVaultAbi } from "./abi.js";
import { loadConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { fetchBestAskWad } from "./infoApi.js";
import { buildPriceFreshness, makeLegPriceFetcher, readSpotPxWad } from "./spotPx.js";
import { Poker } from "./poker.js";
import { isStalled, stallThresholdMs } from "./pure.js";
import { signQuote, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import { newMetrics, startServer, type QuoteDeps } from "./server.js";
import { readLegStates } from "./settlement.js";
import { RateLimiter, sendInviteEmail, Waitlist } from "./waitlist.js";

// Mirrors the keeper's RECEIPT_TIMEOUT_MS (keeper/src/keeper.ts:30). Without it a stuck
// resolveParlay tx hangs waitForTransactionReceipt forever, which hangs poker.tick() forever,
// which stops the poker dead (found in mainnet-hardening P0-2).
const RECEIPT_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Testnet RPCs rate-limit bursts (-32005, retryable in viem) and the poker's cold-start
  // rescan is one — deployBlock..head in 1000-block chunks, two getLogs each. Retry hard with a
  // long backoff instead of dying on the limiter, then fall through to the next endpoint.
  // Comma-separated URL list, same convention as the keeper.
  const rpcUrls = cfg.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const transport = fallback(rpcUrls.map((u) => http(u, { retryCount: 6, retryDelay: 2_000 })));
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const usdcAddress = (await publicClient.readContract({
    address: cfg.parlayVault,
    abi: parlayVaultAbi,
    functionName: "usdc",
  })) as `0x${string}`;

  // minPremiumBps is owner-settable on-chain; the env value is only a startup default.
  // The chain value always wins for pricing — override cfg and warn on drift so a stale
  // env doesn't silently under/over-price quotes.
  const chainMinPremiumBps = BigInt(
    (await publicClient.readContract({
      address: cfg.parlayVault,
      abi: parlayVaultAbi,
      functionName: "minPremiumBps",
    })) as number,
  );
  if (chainMinPremiumBps !== cfg.minPremiumBps) {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        event: "minpremiumbps-env-mismatch",
        env: cfg.minPremiumBps.toString(),
        chain: chainMinPremiumBps.toString(),
      }),
    );
  }
  cfg.minPremiumBps = chainMinPremiumBps;

  const pokerAccount = privateKeyToAccount(cfg.pokerKey);
  const walletClient = createWalletClient({ account: pokerAccount, transport });

  // Grace period (mainnet-hardening P1-7): a reservation that expires right before its
  // mint lands stays counted until the poker has had a fair chance to detect the mint
  // and convert it to `open` — otherwise a second quote could land in that gap and
  // push real per-market/cluster exposure past the configured cap. 2x pokerIntervalMs
  // covers "detected on the tick after the one that should have caught it" without
  // holding a truly abandoned reservation much longer than that.
  const exposure = new ExposureBook((v) => cfg.markets.get(v)?.cluster, cfg.pokerIntervalMs * 2);
  const metrics = newMetrics();
  // Best ask first: executable and conservative — the house never sells below the book.
  // Empty book or info-API failure falls back to the 0x808 spotPx precompile, the only
  // mid source that exists for outcome coins (allMids carries none, verified 2026-08-25).
  // spotPx has no on-chain timestamp, so a per-coin freshness gate (spotPx.ts) refuses the
  // leg once that coin hasn't had a real book price in SPOT_PX_STALE_MS — see mainnet-hardening
  // P0-1. exposure caps still bound the damage from a normal (in-window) fallback.
  const legPriceFetcher = makeLegPriceFetcher({
    fetchBook: (coin) => fetchBestAskWad(cfg.infoApiUrl, coin, cfg.minBookDepthWad),
    readSpotPx: (coin) => readSpotPxWad(publicClient, BigInt(coin.slice(1))),
    staleMs: cfg.spotPxStaleMs,
    now: () => Date.now(),
    onBookError: (coin, err) =>
      console.warn(JSON.stringify({ event: "book-fetch-failed", coin, error: (err as Error).message.slice(0, 200) })),
  });

  const deps: QuoteDeps = {
    cfg,
    exposure,
    chainId,
    metrics,
    now: () => Date.now(),
    randomId: () => `0x${crypto.randomBytes(32).toString("hex")}` as Hex,
    fetchLegPriceWad: async (leg: QuoteLeg) => {
      const market = cfg.markets.get(leg.vault.toLowerCase())!; // validated upstream
      const coin = leg.isYes ? market.coinYes : market.coinNo;
      return legPriceFetcher.fetch(coin);
    },
    readAllowance: () =>
      publicClient.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [cfg.writerAddress, cfg.parlayVault],
      }),
    readSettled: async (vaults) => {
      const states = await readLegStates(publicClient, vaults);
      return new Set([...states].filter(([, s]) => s.settled).map(([v]) => v));
    },
    sign: (q: ParlayQuote) => signQuote(cfg.quoteSignerKey, chainId, cfg.parlayVault, q),
    waitlist: new Waitlist(cfg.waitlistFile),
    sendInvite: cfg.resendApiKey
      ? (email, code) => sendInviteEmail(cfg.resendApiKey!, email, code)
      : undefined,
    signupLimiter: new RateLimiter(5, 60 * 60 * 1000),
    badInviteLimiter: new RateLimiter(20, 60 * 60 * 1000),
    quoteLimiter: new RateLimiter(300, 60 * 60 * 1000),
  };
  if (!cfg.resendApiKey) {
    console.warn(JSON.stringify({ event: "waitlist-disabled", reason: "RESEND_API_KEY unset" }));
  }

  const poker = new Poker({
    publicClient,
    parlayVault: cfg.parlayVault,
    exposure,
    metrics,
    fromBlock: cfg.deployBlock,
    resolve: async (id) => {
      const hash = await walletClient.writeContract({
        chain: null,
        address: cfg.parlayVault,
        abi: parlayVaultAbi,
        functionName: "resolveParlay",
        args: [id],
      });
      await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    },
    log: (msg) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg })),
  });
  // Rebuild `open` from on-chain state before quoting starts (mainnet-hardening P1-6)
  // instead of leaving per-market/cluster caps blind to real exposure until the
  // deployBlock->head scan catches up — this runs on every nightly rotate.service
  // restart, so it has to be both fast and correct every night, not just at genesis.
  await poker.seed();

  // POKER_INTERVAL_MS=0 turns the poker off. Quoting and minting are unaffected —
  // the poker only recycles house escrow off DEAD tickets and keeps the exposure
  // book's per-market breakdown warm. Solvency does not depend on it: the hard cap
  // is the on-chain writer allowance, which the book anchors to either way. Takers
  // are unaffected too, since claim() auto-resolves and resolveParlay is
  // permissionless from the UI. Off means PER_MARKET_CAP / PER_CLUSTER_CAP see only
  // live reservations, so they bind looser than configured — acceptable while the
  // allowance is small, not something to leave off once the bankroll grows.
  if (cfg.pokerIntervalMs > 0) {
    let lastTickAt = Date.now();
    const tick = async () => {
      try {
        await poker.tick();
      } catch (err) {
        console.error(new Date().toISOString(), "poker tick failed", err);
      } finally {
        lastTickAt = Date.now();
        setTimeout(tick, cfg.pokerIntervalMs);
      }
    };
    void tick();

    // Watchdog: a hung await (e.g. the old unbounded waitForTransactionReceipt) never throws,
    // so from outside the process looks healthy while the poker has stopped ticking entirely.
    // Every tick is now bounded (each poke's receipt wait capped at RECEIPT_TIMEOUT_MS), so a
    // stamp older than the worst legitimate tick means a true hang: exit and let systemd
    // (Restart=always) bring us back. Mirrors the keeper's watchdog (keeper/src/keeper.ts:462-476).
    setInterval(() => {
      const threshold = stallThresholdMs(poker.openCount(), RECEIPT_TIMEOUT_MS, cfg.pokerIntervalMs);
      if (isStalled(lastTickAt, Date.now(), threshold)) {
        console.error(
          JSON.stringify({
            at: new Date().toISOString(),
            event: "poker-watchdog-stalled",
            staleMs: Date.now() - lastTickAt,
            thresholdMs: threshold,
          }),
        );
        process.exit(1);
      }
    }, 10_000);
  } else {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "poker-disabled" }));
  }

  startServer(deps, cfg.port, () => {
    // Per-market exposure vs cap: without this a "market-cap" rejection is
    // unfalsifiable from outside — you cannot tell a real cap from a leaked
    // reservation. ponytail: unauthenticated, so it does show house posture to
    // anyone who asks; gate it behind an ops token once the bankroll is real.
    const now = Date.now();
    const perMarket: Record<string, string> = {};
    for (const v of cfg.markets.keys()) perMarket[v] = exposure.perMarket(v, now).toString();
    // Per-coin, not a single global: a fresh BTC book must not hide a dead NVDA book
    // silently riding stale spotPx (mainnet-hardening P0-1). null = never confirmed live.
    const priceFreshnessMs = buildPriceFreshness(cfg.markets.values(), (coin) => legPriceFetcher.ageMs(coin));
    return {
      ok: true,
      openParlays: poker.openCount(),
      priceFreshnessMs,
      perMarketCap: cfg.perMarketCap.toString(),
      reservedGlobal: exposure.reservedGlobal(now).toString(),
      perMarket,
    };
  });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "writer-started", port: cfg.port, chainId }));
}

main().catch((err) => {
  console.error(new Date().toISOString(), "FATAL", err);
  process.exit(1);
});
