import crypto from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parlayVaultAbi } from "./abi.js";
import { applyWriterProfileIdentity, loadConfig, syncedPerCodeReservedCap } from "./config.js";
import { CorrelationWorker } from "./correlationWorker.js";
import { ExposureBook } from "./exposure.js";
import { fetchBestAskWad } from "./infoApi.js";
import { appendQuoteDecision } from "./research/journal.js";
import { buildPriceFreshness, makeLegPriceFetcher, readSpotPxWad } from "./spotPx.js";
import { Poker } from "./poker.js";
import { bankrollRoom, isStalled, lowBankrollAlerter, parseDecimalToUnits, stallThresholdMs } from "./pure.js";
import { signQuote, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import { currentModelStatus, newMetrics, startServer, type QuoteDeps } from "./server.js";
import { readLegStates } from "./settlement.js";
import { RateLimiter, sendInviteEmail, Waitlist } from "./waitlist.js";

// Mirrors the keeper's RECEIPT_TIMEOUT_MS (keeper/src/keeper.ts:30). Without it a stuck
// resolveParlay tx hangs waitForTransactionReceipt forever, which hangs poker.tick() forever,
// which stops the poker dead (found in mainnet-hardening P0-2).
const RECEIPT_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const quoteJournal = cfg.researchPersistence;
  // Independent mode never integrates a copula, so no worker thread to hold.
  const correlationWorker = cfg.pricingMode === "correlated" ? new CorrelationWorker() : null;
  // Comma-separated URL list, same convention as the keeper. viem's fallback()
  // forces retryCount 0 on each inner http() and retries the whole chain itself
  // (default 3 tries, 150ms exponential): a 429 on the first URL falls through to
  // the next within ~2s, well under the web's 10s quote abort. Per-URL retry
  // options here are silently ignored, so none are passed.
  const rpcUrls = cfg.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const transport = fallback(rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const profileIdentityFailure = applyWriterProfileIdentity(cfg, chainId);
  if (profileIdentityFailure) console.warn(JSON.stringify({ event: "correlation-profile-mismatch", reason: profileIdentityFailure }));
  const usdcAddress = (await publicClient.readContract({
    address: cfg.parlayVault,
    abi: parlayVaultAbi,
    functionName: "usdc",
  })) as `0x${string}`;
  // Refill runbook lives in DEPLOY.md ("Bankroll"). LOW_BANKROLL is in USDC.
  const lowBankroll = parseDecimalToUnits(process.env.LOW_BANKROLL ?? "100", 6);
  const shouldAlertLowBankroll = lowBankrollAlerter(lowBankroll);
  let lastBankroll: bigint | null = null;

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
  // PER_CODE_RESERVED_CAP's default is derived from minPremiumBps (config.ts);
  // if it was left unset, recompute it off the just-synced chain value so the
  // default keeps tracking priceParlay's floorCap instead of the stale env one.
  cfg.perCodeReservedCap = syncedPerCodeReservedCap(
    !!process.env.PER_CODE_RESERVED_CAP,
    cfg.perCodeReservedCap,
    cfg.maxStake,
    chainMinPremiumBps,
  );
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
  let lastQuoteJournalAppendMs: number | null = null;
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

  // Flipped once poker.seed() has rebuilt the exposure book; /quote refuses with
  // 503 warming-up until then (see startServer ordering below).
  let seeded = false;
  const deps: QuoteDeps = {
    cfg,
    exposure,
    chainId,
    metrics,
    now: () => Date.now(),
    randomId: () => `0x${crypto.randomBytes(32).toString("hex")}` as Hex,
    fetchLegPrice: async (leg: QuoteLeg) => {
      const market = cfg.markets.get(leg.vault.toLowerCase())!; // validated upstream
      const coin = leg.isYes ? market.coinYes : market.coinNo;
      return legPriceFetcher.fetch(coin);
    },
    recordQuote: async (decision) => {
      if (quoteJournal) appendQuoteDecision(quoteJournal, decision);
      else {
        // Independent mode: plain JSONL, one signed quote per line. Same record
        // shape as the research journal minus its storage identity checks.
        mkdirSync(path.dirname(cfg.quoteJournalFile!), { recursive: true });
        appendFileSync(cfg.quoteJournalFile!, `${JSON.stringify(decision)}\n`);
      }
      lastQuoteJournalAppendMs = Date.now();
    },
    bestEstimateJointProbWad: (legs) =>
      correlationWorker ? correlationWorker.bestEstimate(legs, cfg.correlations) : Promise.reject(new Error("no correlation worker in independent mode")),
    readAllowance: async () => {
      const [allowance, balance] = await Promise.all([
        publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "allowance", args: [cfg.writerAddress, cfg.parlayVault] }),
        publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [cfg.writerAddress] }),
      ]);
      lastBankroll = bankrollRoom(allowance, balance);
      // "ALERT" prefix is what ops/alert-relay.sh forwards to Telegram.
      if (shouldAlertLowBankroll(lastBankroll))
        console.error(new Date().toISOString(), "ALERT", JSON.stringify({ event: "low-bankroll", bankroll: lastBankroll.toString(), allowance: allowance.toString(), balance: balance.toString(), threshold: lowBankroll.toString() }));
      return lastBankroll;
    },
    readSettled: async (vaults) => {
      const states = await readLegStates(publicClient, vaults);
      return new Set([...states].filter(([, s]) => s.settled).map(([v]) => v));
    },
    sign: (q: ParlayQuote) => signQuote(cfg.quoteSignerKey, chainId, cfg.parlayVault, q),
    ready: () => seeded,
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
  // Listen BEFORE seeding. Seeding hits the public RPC in bursts and has taken
  // 30s-3min on rate-limited testnet; every hourly rotate.service restart repeated
  // that as a full outage (Caddy 502 with no CORS headers, which the browser reports
  // as status 0 -> "Writer unreachable"). Listening first turns that window into an
  // explicit 503 warming-up the UI can name and retry.
  startServer(deps, cfg.port, () => {
    // Per-market exposure vs cap: without this a "market-cap" rejection is
    // unfalsifiable from outside — you cannot tell a real cap from a leaked
    // reservation. ponytail: unauthenticated, so it does show house posture to
    // anyone who asks; gate it behind an ops token once the bankroll is real.
    const now = Date.now();
    const modelStatus = currentModelStatus(cfg.model, now);
    const perMarket: Record<string, string> = {};
    for (const v of cfg.markets.keys()) perMarket[v] = exposure.perMarket(v, now).toString();
    // Per-coin, not a single global: a fresh BTC book must not hide a dead NVDA book
    // silently riding stale spotPx (mainnet-hardening P0-1). null = never confirmed live.
    const priceFreshnessMs = buildPriceFreshness(cfg.markets.values(), (coin) => legPriceFetcher.ageMs(coin));
    return {
      ok: true,
      pricingMode: cfg.pricingMode,
      quoteJournalLastAppendMs: lastQuoteJournalAppendMs,
      model: { version: cfg.model.version, dataAsOf: cfg.model.dataAsOf, dataManifestSha256: cfg.model.dataManifestSha256, sourceRegistrySha256: cfg.model.sourceRegistrySha256, identityFailureReason: cfg.model.identityFailureReason, ...modelStatus },
      seeded,
      openParlays: poker.openCount(),
      priceFreshnessMs,
      perMarketCap: cfg.perMarketCap.toString(),
      reservedGlobal: exposure.reservedGlobal(now).toString(),
      // min(allowance, balance) as of the last quote; null until the first quote.
      bankroll: lastBankroll?.toString() ?? null,
      perMarket,
    };
  });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "writer-listening", port: cfg.port }));

  // Rebuild `open` from on-chain state before quoting starts (mainnet-hardening P1-6)
  // instead of leaving per-market/cluster caps blind to real exposure until the
  // deployBlock->head scan catches up — this runs on every rotate.service
  // restart, so it has to be both fast and correct every time, not just at genesis.
  await poker.seed();
  seeded = true;

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

  console.log(JSON.stringify({ at: new Date().toISOString(), event: "writer-started", port: cfg.port, chainId, pricingMode: cfg.pricingMode, modelVersion: cfg.model.version, dataAsOf: cfg.model.dataAsOf }));
}

main().catch((err) => {
  console.error(new Date().toISOString(), "FATAL", err);
  process.exit(1);
});
