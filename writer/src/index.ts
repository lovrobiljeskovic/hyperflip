import { verifyDeploymentRpc } from "../../registry/deployment.mjs";
import crypto from "node:crypto";
import { QuoteJournal } from "./journal.js";
import { createPublicClient, createWalletClient, erc20Abi, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parlayVaultAbi } from "./abi.js";
import { loadConfig, syncedPerCodeReservedCap } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { fetchBestAskWad } from "./infoApi.js";
import { buildPriceFreshness, makeLegPriceFetcher, readSpotPxWad } from "./spotPx.js";
import { Poker } from "./poker.js";
import { bankrollRoom, isStalled, lowBankrollAlerter, parseDecimalToUnits, stallThresholdMs, WAD } from "./pure.js";
import { signQuote, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import { newMetrics, startMaker, type QuoteDeps } from "./maker.js";
import { readLegStates } from "./settlement.js";

const RECEIPT_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const journal = new QuoteJournal(cfg.quoteJournalFile);
  const rpcUrls = cfg.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const transport = fallback(rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ transport });
  await verifyDeploymentRpc(publicClient, cfg);
  const chainId = cfg.chainId;
  const usdcAddress = (await publicClient.readContract({
    address: cfg.parlayVault,
    abi: parlayVaultAbi,
    functionName: "usdc",
  })) as `0x${string}`;
  const lowBankroll = parseDecimalToUnits(process.env.LOW_BANKROLL ?? "100", 6);
  const shouldAlertLowBankroll = lowBankrollAlerter(lowBankroll);
  let lastBankroll: bigint | null = null;

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
  cfg.perCodeReservedCap = syncedPerCodeReservedCap(
    !!process.env.PER_CODE_RESERVED_CAP,
    cfg.perCodeReservedCap,
    cfg.maxStake,
    chainMinPremiumBps,
  );
  cfg.minPremiumBps = chainMinPremiumBps;

  const pokerAccount = privateKeyToAccount(cfg.pokerKey);
  const walletClient = createWalletClient({ account: pokerAccount, transport });

  // Hold expired reservations for two polls so a late mint remains counted.
  const exposure = new ExposureBook((v) => cfg.markets.get(v)?.cluster, cfg.pokerIntervalMs * 2);
  const metrics = newMetrics();
  let lastQuoteJournalAppendMs: number | null = null;
  // House priors: pre-kickoff only. In play the prior is stale by construction, so the
  // leg falls through to the book / spotPx path and its existing refusals.
  const priorByCoin = new Map<string, { wad: bigint; startMs?: number }>();
  for (const m of cfg.markets.values()) {
    if (m.priorYes === undefined) continue;
    const yesWad = BigInt(Math.round(m.priorYes * 1e6)) * 10n ** 12n;
    priorByCoin.set(m.coinYes, { wad: yesWad, startMs: m.startMs });
    priorByCoin.set(m.coinNo, { wad: WAD - yesWad, startMs: m.startMs });
  }
  const legPriceFetcher = makeLegPriceFetcher({
    fetchBook: (coin) => fetchBestAskWad(cfg.infoApiUrl, coin, cfg.minBookDepthWad),
    readSpotPx: (coin) => readSpotPxWad(publicClient, BigInt(coin.slice(1))),
    prior: (coin) => {
      const p = priorByCoin.get(coin);
      return p && (p.startMs === undefined || Date.now() < p.startMs) ? p.wad : undefined;
    },
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
    parlaysOf: (taker) => poker.parlaysOf(taker),
  };

  const poker = new Poker({
    publicClient,
    parlayVault: cfg.parlayVault,
    maker: cfg.writerAddress,
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
    log: (msg) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg })),
  });
  startMaker(deps, cfg.port, () => {
    const now = Date.now();
    const perMarket: Record<string, string> = {};
    for (const v of cfg.markets.keys()) perMarket[v] = exposure.perMarket(v, now).toString();
    const priceFreshnessMs = buildPriceFreshness(cfg.markets.values(), (coin) => legPriceFetcher.ageMs(coin));
    return {
      ok: true,
      quoteJournalLastAppendMs: lastQuoteJournalAppendMs,
      seeded,
      openParlays: poker.openCount(),
      priceFreshnessMs,
      perMarketCap: cfg.perMarketCap.toString(),
      reservedGlobal: exposure.reservedGlobal(now).toString(),
      bankroll: lastBankroll?.toString() ?? null,
      perMarket,
    };
  });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "maker-listening", port: cfg.port }));

  // Quotes stay disabled until existing on-chain exposure is loaded.
  await poker.seed();
  seeded = true;

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
