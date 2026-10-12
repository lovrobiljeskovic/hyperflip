import type { PublicClient } from "viem";
import type { WriterConfig } from "./config.js";
import { fetchBestAskWad } from "./infoApi.js";
import { defaultFetchJson, LivePrior } from "./livePrior.js";
import type { QuoteLeg } from "./quotes.js";
import { makeLegPriceFetcher, readSpotPxWad } from "./spotPx.js";

/** Live prior + leg-price fetcher wired from config; source order lives in the livePrior.ts header. */
export function priceFeed(cfg: WriterConfig, publicClient: Pick<PublicClient, "call">) {
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
  const legPrices = makeLegPriceFetcher({
    fetchBook: (coin) => fetchBestAskWad(cfg.infoApiUrl, coin, cfg.minBookDepthWad),
    readSpotPx: (coin) => readSpotPxWad(publicClient, BigInt(coin.slice(1))),
    prior: (coin) => livePrior.prior(coin),
    staleMs: cfg.spotPxStaleMs,
    now: () => Date.now(),
    onBookError: (coin, err) =>
      console.warn(JSON.stringify({ event: "book-fetch-failed", coin, error: (err as Error).message.slice(0, 200) })),
  });
  return {
    livePrior,
    legPrices,
    fetchLegPrice: async (leg: QuoteLeg) => {
      const market = cfg.markets.get(leg.vault.toLowerCase())!; // validated upstream
      return legPrices.fetch(leg.isYes ? market.coinYes : market.coinNo);
    },
    livePriorYes: (vault: string) => livePrior.priorYes(vault),
  };
}
