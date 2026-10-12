import { verifyDeploymentRpc } from "../../registry/deployment.mjs";
import crypto from "node:crypto";
import { QuoteJournal } from "./journal.js";
import { createPublicClient, createWalletClient, erc20Abi, fallback, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parlayVaultAbi } from "./abi.js";
import { defaultPerCodeReservedCap, loadConfig, type WriterConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { fetchBestAskWad } from "./infoApi.js";
import { buildPriceFreshness, makeLegPriceFetcher, readSpotPxWad } from "./spotPx.js";
import { defaultFetchJson, LivePrior } from "./livePrior.js";
import { Poker, chainFetchers, isStalled, stallThresholdMs } from "./poker.js";
import { bankrollRoom, lowBankrollAlerter } from "./bankroll.js";
import { signQuote, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import { newMetrics, startServer, type QuoteDeps } from "./server.js";
import { readLegStates } from "./settlement.js";
import { RateLimiter, sendInviteEmail, Waitlist } from "./waitlist.js";
import { GoogleSheetsWaitlist } from "./googleSheets.js";
import { privyAuthenticator } from "./auth.js";

const RECEIPT_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const loaded = loadConfig();
  const journal = new QuoteJournal(loaded.quoteJournalFile);
  const rpcUrls = loaded.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const transport = fallback(rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ transport });
  await verifyDeploymentRpc(publicClient, loaded);
  const chainId = loaded.chainId;
  const usdcAddress = (await publicClient.readContract({
    address: loaded.parlayVault,
    abi: parlayVaultAbi,
    functionName: "usdc",
  })) as `0x${string}`;
  const lowBankroll = parseUnits(process.env.LOW_BANKROLL ?? "100", 6);
  const shouldAlertLowBankroll = lowBankrollAlerter(lowBankroll);
  let lastBankroll: bigint | null = null;

  const chainMinPremiumBps = BigInt(
    (await publicClient.readContract({
      address: loaded.parlayVault,
      abi: parlayVaultAbi,
      functionName: "minPremiumBps",
    })) as number,
  );
  if (chainMinPremiumBps !== loaded.minPremiumBps) {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        event: "minpremiumbps-env-mismatch",
        env: loaded.minPremiumBps.toString(),
        chain: chainMinPremiumBps.toString(),
      }),
    );
  }
  const cfg: WriterConfig = {
    ...loaded,
    perCodeReservedCap: loaded.perCodeReservedCap ?? defaultPerCodeReservedCap(loaded.maxStake, chainMinPremiumBps),
    minPremiumBps: chainMinPremiumBps,
  };

  const pokerAccount = privateKeyToAccount(cfg.pokerKey);
  const walletClient = createWalletClient({ account: pokerAccount, transport });

  // Hold expired reservations for two polls so a late mint remains counted.
  const exposure = new ExposureBook((v) => cfg.markets.get(v)?.cluster, cfg.pokerIntervalMs * 2);
  const metrics = newMetrics();
  let lastQuoteJournalAppendMs: number | null = null;
  // Live feed first (Polymarket mid, then mainnet book mid, then ESPN win probability); the registry prior is
  // the pre-kickoff fallback only, since in play it is stale by construction.
  const livePrior = new LivePrior({
    markets: cfg.markets.values(),
    fetchJson: defaultFetchJson,
    now: () => Date.now(),
    staleMs: cfg.livePriorStaleMs,
    jumpWad: cfg.livePriorJumpWad,
    suspendMs: cfg.livePriorSuspendMs,
    mainnetInfoUrl: cfg.mainnetInfoUrl,
    log: (msg) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg })),
  });
  const legPriceFetcher = makeLegPriceFetcher({
    fetchBook: (coin) => fetchBestAskWad(cfg.infoApiUrl, coin, cfg.minBookDepthWad),
    readSpotPx: (coin) => readSpotPxWad(publicClient, BigInt(coin.slice(1))),
    prior: (coin) => livePrior.prior(coin),
    staleMs: cfg.spotPxStaleMs,
    now: () => Date.now(),
    onBookError: (coin, err) =>
      console.warn(JSON.stringify({ event: "book-fetch-failed", coin, error: (err as Error).message.slice(0, 200) })),
  });

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
      journal.append(decision);
      lastQuoteJournalAppendMs = Date.now();
    },
    readAllowance: async () => {
      const [allowance, balance] = await Promise.all([
        publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "allowance", args: [cfg.writerAddress, cfg.parlayVault] }),
        publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [cfg.writerAddress] }),
      ]);
      lastBankroll = bankrollRoom(allowance, balance);
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
      ? (email) => sendInviteEmail(cfg.resendApiKey!, email)
      : undefined,
    signupLimiter: new RateLimiter(5, 60 * 60 * 1000),
    badInviteLimiter: new RateLimiter(20, 60 * 60 * 1000),
    authenticate: cfg.privyAppId && cfg.privyAppSecret ? privyAuthenticator(cfg.privyAppId, cfg.privyAppSecret) : undefined,
    quoteLimiter: new RateLimiter(300, 60 * 60 * 1000),
    parlaysOf: (taker) => poker.parlaysOf(taker),
    livePriorYes: (vault) => livePrior.priorYes(vault),
  };
  if (!cfg.resendApiKey) {
    console.warn(JSON.stringify({ event: "admission-email-disabled", reason: "RESEND_API_KEY unset" }));
  }

  const pokerLog = (msg: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg }));
  const poker = new Poker({
    ...chainFetchers(publicClient, cfg.parlayVault, pokerLog),
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
    log: pokerLog,
  });
  startServer(deps, cfg.port, () => {
    const now = Date.now();
    // Per-market exposure is deliberately not published: /health is public, and the
    // book is a cap map an attacker would otherwise get for free. Read it from the
    // quote-rejected log lines instead.
    const priceFreshnessMs = buildPriceFreshness(cfg.markets.values(), (coin) => legPriceFetcher.ageMs(coin));
    return {
      ok: true,
      quoteJournalLastAppendMs: lastQuoteJournalAppendMs,
      seeded,
      openParlays: poker.openCount(),
      priceFreshnessMs,
      livePrior: livePrior.status(),
      perMarketCap: cfg.perMarketCap.toString(),
      reservedGlobal: exposure.reservedGlobal(now).toString(),
      bankroll: lastBankroll?.toString() ?? null,
    };
  });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "writer-listening", port: cfg.port }));

  if (cfg.googleSheets) {
    const sheets = new GoogleSheetsWaitlist(cfg.googleSheets, deps.waitlist);
    deps.syncWaitlist = () => sheets.sync();
    const sync = async () => {
      try {
        await sheets.sync();
      } catch (error) {
        console.error(JSON.stringify({ event: "google-sheets-sync-failed", reason: (error as Error).message }));
      } finally {
        // Only retry unsent signups; idle ticks make no Google requests.
        setTimeout(sync, 60_000).unref();
      }
    };
    void sync();
  }

  // Quotes stay disabled until existing on-chain exposure is loaded.
  await poker.seed();
  seeded = true;
  // Prime /limits.bankroll so the app shows it before the first quote.
  await deps.readAllowance().catch((err) => console.error(new Date().toISOString(), "boot readAllowance failed", err));

  if (cfg.livePriorPollMs > 0) {
    const liveTick = async () => {
      try {
        await livePrior.tick();
      } catch (err) {
        console.error(new Date().toISOString(), "live prior tick failed", err);
      } finally {
        setTimeout(liveTick, cfg.livePriorPollMs);
      }
    };
    void liveTick();
  }

  // ponytail: disabling polling weakens exposure caps; keep it enabled for a funded writer.
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

  console.log(JSON.stringify({ at: new Date().toISOString(), event: "writer-started", port: cfg.port, chainId }));
}

main().catch((err) => {
  console.error(new Date().toISOString(), "FATAL", err);
  process.exit(1);
});
