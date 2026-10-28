import { verifyDeploymentRpc } from "../../registry/deployment.mjs";
import { rpcUrls } from "../../services/env.mjs";
import crypto from "node:crypto";
import { QuoteJournal } from "./journal.js";
import { createPublicClient, createWalletClient, fallback, http, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parlayVaultAbi } from "./abi.js";
import { bankrollReader } from "./bankroll.js";
import { defaultPerCodeReservedCap, loadConfig, type LoadedConfig, type WriterConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { buildPriceFreshness } from "./spotPx.js";
import { LivePrior } from "./livePrior.js";
import { logJson } from "../../services/log.mjs";
import { every, watchdog } from "../../services/loop.mjs";
import { Poker, chainFetchers, stallThresholdMs } from "./poker.js";
import { priceFeed } from "./priceFeed.js";
import { quoteSigner } from "./quotes.js";
import { newMetrics, startServer, type Metrics, type QuoteDeps } from "./server.js";
import { readLegStates } from "./settlement.js";
import { RateLimiter, sendInviteEmail, Waitlist } from "./waitlist.js";
import { GoogleSheetsWaitlist } from "./googleSheets.js";
import { privyAuthenticator } from "./auth.js";

const RECEIPT_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const loaded = loadConfig();
  const journal = new QuoteJournal(loaded.quoteJournalFile);
  const transport = fallback(rpcUrls(loaded.rpcUrl).map((u) => http(u)));
  const publicClient = createPublicClient({ transport });
  await verifyDeploymentRpc(createPublicClient({ transport: fallback(rpcUrls(loaded.archiveRpcUrl).map((u) => http(u))) }), loaded);
  const chainId = loaded.chainId;
  const bankroll = await bankrollReader(publicClient, loaded);
  const cfg = await withChainMinPremium(publicClient, loaded);

  // Hold expired reservations for two polls so a late mint remains counted.
  const exposure = new ExposureBook((v) => cfg.markets.get(v)?.cluster, cfg.pokerIntervalMs * 2);
  const metrics = newMetrics();
  let lastQuoteJournalAppendMs: number | null = null;
  const feed = priceFeed(cfg, publicClient);

  let seeded = false;
  const deps: QuoteDeps = {
    cfg,
    exposure,
    chainId,
    metrics,
    now: () => Date.now(),
    randomId: () => `0x${crypto.randomBytes(32).toString("hex")}` as Hex,
    fetchLegPrice: feed.fetchLegPrice,
    recordQuote: async (decision) => {
      journal.append(decision);
      lastQuoteJournalAppendMs = Date.now();
    },
    readAllowance: bankroll.readAllowance,
    readSettled: async (vaults) => {
      const states = await readLegStates(publicClient, vaults);
      return new Set([...states].filter(([, s]) => s.settled).map(([v]) => v));
    },
    sign: quoteSigner(cfg.quoteSignerKey, chainId, cfg.parlayVault),
    ready: () => seeded,
    waitlist: new Waitlist(cfg.waitlistFile),
    sendInvite: cfg.resendApiKey
      ? (email) => sendInviteEmail(cfg.resendApiKey!, email)
      : undefined,
    signupLimiter: new RateLimiter(5, 60 * 60 * 1000),
    badInviteLimiter: new RateLimiter(20, 60 * 60 * 1000),
    authenticate: cfg.privyAppId && cfg.privyAppSecret ? privyAuthenticator(cfg.privyAppId, cfg.privyAppSecret) : undefined,
    quoteLimiter: new RateLimiter(300, 60 * 60 * 1000),
    parlaysOf: (taker) => poker.parlaysOf(taker),
    livePriorYes: feed.livePriorYes,
  };
  if (!cfg.resendApiKey) {
    console.warn(JSON.stringify({ event: "admission-email-disabled", reason: "RESEND_API_KEY unset" }));
  }

  const poker = makePoker(cfg, publicClient, transport, exposure, metrics);
  startServer(deps, cfg.port, () => {
    const now = Date.now();
    // Per-market exposure is deliberately not published: /health is public, and the
    // book is a cap map an attacker would otherwise get for free. Read it from the
    // quote-rejected log lines instead.
    const priceFreshnessMs = buildPriceFreshness(cfg.markets.values(), (coin) => feed.legPrices.ageMs(coin));
    return {
      ok: true,
      quoteJournalLastAppendMs: lastQuoteJournalAppendMs,
      seeded,
      openParlays: poker.openCount(),
      priceFreshnessMs,
      livePrior: feed.livePrior.status(),
      perMarketCap: cfg.perMarketCap.toString(),
      reservedGlobal: exposure.reservedGlobal(now).toString(),
      bankroll: bankroll.bankroll()?.toString() ?? null,
    };
  });
  logJson({ event: "writer-listening", port: cfg.port });

  if (cfg.googleSheets) startSheetsSync(cfg.googleSheets, deps);

  // Quotes stay disabled until existing on-chain exposure is loaded.
  await poker.seed();
  seeded = true;
  // Prime /limits.bankroll so the app shows it before the first quote.
  await deps.readAllowance().catch((err) => console.error(new Date().toISOString(), "boot readAllowance failed", err));

  if (cfg.livePriorPollMs > 0) startLivePriorLoop(feed.livePrior, cfg.livePriorPollMs);
  // ponytail: disabling polling weakens exposure caps; keep it enabled for a funded writer.
  if (cfg.pokerIntervalMs > 0) startPokerLoop(poker, cfg.pokerIntervalMs);
  else logJson({ event: "poker-disabled" });

  logJson({ event: "writer-started", port: cfg.port, chainId });
}

/** The chain's minPremiumBps wins over env; the per-code reserved cap defaults off it. */
async function withChainMinPremium(publicClient: Pick<PublicClient, "readContract">, loaded: LoadedConfig): Promise<WriterConfig> {
  const chainMinPremiumBps = BigInt(
    (await publicClient.readContract({
      address: loaded.parlayVault,
      abi: parlayVaultAbi,
      functionName: "minPremiumBps",
    })) as number,
  );
  if (chainMinPremiumBps !== loaded.minPremiumBps) {
    logJson({ event: "minpremiumbps-env-mismatch", env: loaded.minPremiumBps.toString(), chain: chainMinPremiumBps.toString() });
  }
  return {
    ...loaded,
    perCodeReservedCap: loaded.perCodeReservedCap ?? defaultPerCodeReservedCap(loaded.maxStake, chainMinPremiumBps),
    minPremiumBps: chainMinPremiumBps,
  };
}

function makePoker(cfg: WriterConfig, publicClient: PublicClient, transport: Transport, exposure: ExposureBook, metrics: Metrics): Poker {
  const walletClient = createWalletClient({ account: privateKeyToAccount(cfg.pokerKey), transport });
  return new Poker({
    ...chainFetchers(publicClient, cfg.parlayVault, logJson),
    exposure,
    metrics,
    fromBlock: cfg.deployBlock,
    indexFile: cfg.parlayIndexFile,
    indexFromBlock: cfg.parlayIndexFromBlock,
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
    log: logJson,
  });
}

function startSheetsSync(sheetsCfg: NonNullable<WriterConfig["googleSheets"]>, deps: QuoteDeps): void {
  const sheets = new GoogleSheetsWaitlist(sheetsCfg, deps.waitlist);
  deps.syncWaitlist = () => sheets.sync();
  // Only retry unsent signups; idle ticks make no Google requests.
  every(60_000, () => sheets.sync(), (error) => {
    console.error(JSON.stringify({ event: "google-sheets-sync-failed", reason: (error as Error).message }));
  }, true);
}

function startLivePriorLoop(livePrior: LivePrior, pollMs: number): void {
  every(pollMs, () => livePrior.tick(), (err) => console.error(new Date().toISOString(), "live prior tick failed", err));
}

function startPokerLoop(poker: Poker, intervalMs: number): void {
  const stamps = { poker: Date.now() };
  every(
    intervalMs,
    () => poker.tick().finally(() => { stamps.poker = Date.now(); }),
    (err) => console.error(new Date().toISOString(), "poker tick failed", err),
  );
  watchdog(
    stamps,
    () => stallThresholdMs(poker.openCount(), RECEIPT_TIMEOUT_MS, intervalMs),
    (_, staleMs, thresholdMs) =>
      console.error(JSON.stringify({ at: new Date().toISOString(), event: "poker-watchdog-stalled", staleMs, thresholdMs })),
  );
}

main().catch((err) => {
  console.error(new Date().toISOString(), "FATAL", err);
  process.exit(1);
});
