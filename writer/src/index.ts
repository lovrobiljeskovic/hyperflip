import crypto from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parlayVaultAbi } from "./abi.js";
import { loadConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { fetchBestAskWad } from "./infoApi.js";
import { Poker } from "./poker.js";
import { signQuote, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import { newMetrics, startServer, type QuoteDeps } from "./server.js";
import { readLegStates } from "./settlement.js";
import { RateLimiter, sendInviteEmail, Waitlist } from "./waitlist.js";

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

  const exposure = new ExposureBook((v) => cfg.markets.get(v)?.cluster);
  const metrics = newMetrics();
  let lastBookFetchMs = 0;

  const deps: QuoteDeps = {
    cfg,
    exposure,
    chainId,
    metrics,
    now: () => Date.now(),
    randomId: () => `0x${crypto.randomBytes(32).toString("hex")}` as Hex,
    fetchLegPriceWad: async (leg: QuoteLeg) => {
      const market = cfg.markets.get(leg.vault.toLowerCase())!; // validated upstream
      const wad = await fetchBestAskWad(cfg.infoApiUrl, leg.isYes ? market.coinYes : market.coinNo);
      lastBookFetchMs = Date.now();
      return wad;
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
      await publicClient.waitForTransactionReceipt({ hash });
    },
    log: (msg) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg })),
  });

  // POKER_INTERVAL_MS=0 turns the poker off. Quoting and minting are unaffected —
  // the poker only recycles house escrow off DEAD tickets and keeps the exposure
  // book's per-market breakdown warm. Solvency does not depend on it: the hard cap
  // is the on-chain writer allowance, which the book anchors to either way. Takers
  // are unaffected too, since claim() auto-resolves and resolveParlay is
  // permissionless from the UI. Off means PER_MARKET_CAP / PER_CLUSTER_CAP see only
  // live reservations, so they bind looser than configured — acceptable while the
  // allowance is small, not something to leave off once the bankroll grows.
  if (cfg.pokerIntervalMs > 0) {
    const tick = async () => {
      try {
        await poker.tick();
      } catch (err) {
        console.error(new Date().toISOString(), "poker tick failed", err);
      } finally {
        setTimeout(tick, cfg.pokerIntervalMs);
      }
    };
    void tick();
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
    return {
      ok: true,
      openParlays: poker.openCount(),
      lastBookFetchAgeMs: lastBookFetchMs ? Date.now() - lastBookFetchMs : null,
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
