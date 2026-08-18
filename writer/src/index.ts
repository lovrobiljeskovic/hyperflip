import crypto from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parlayVaultAbi } from "./abi.js";
import { loadConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { fetchBestAskWad } from "./infoApi.js";
import { Poker } from "./poker.js";
import { signQuote, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import { newMetrics, startServer, type QuoteDeps } from "./server.js";
import { readLegStates } from "./settlement.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
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
  const walletClient = createWalletClient({ account: pokerAccount, transport: http(cfg.rpcUrl) });

  const exposure = new ExposureBook();
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
  };

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

  startServer(deps, cfg.port, () => ({
    ok: true,
    openParlays: poker.openCount(),
    lastBookFetchAgeMs: lastBookFetchMs ? Date.now() - lastBookFetchMs : null,
  }));
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "writer-started", port: cfg.port, chainId }));
}

main().catch((err) => {
  console.error(new Date().toISOString(), "FATAL", err);
  process.exit(1);
});
