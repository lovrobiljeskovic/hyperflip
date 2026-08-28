import { isAddress, type Address } from "viem";

export interface MarketInfo {
  vault: Address;
  coinYes: string;
  coinNo: string;
  underlying: string;
  cluster: string;
  direction: "up" | "down" | "band";
  expiryMs?: number;
  title: string;
  category: string;
}

/** Parse the public market registry without initializing live writer config. */
export function parseMarkets(raw: string): Map<string, MarketInfo> {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.markets;
  if (!Array.isArray(list)) throw new Error("MARKETS must be a JSON array or { markets: [...] }");
  const map = new Map<string, MarketInfo>();
  for (const market of list) {
    if (!isAddress(market.vault)) throw new Error(`invalid market vault: ${market.vault}`);
    if (typeof market.coinYes !== "string" || typeof market.coinNo !== "string") throw new Error(`market ${market.vault} missing coinYes/coinNo`);
    if (typeof market.underlying !== "string" || market.underlying === "" || typeof market.cluster !== "string" || market.cluster === "") throw new Error(`market ${market.vault} missing underlying/cluster`);
    if (market.direction !== "up" && market.direction !== "down" && market.direction !== "band") throw new Error(`market ${market.vault} direction must be "up", "down", or "band"`);
    if (typeof market.title !== "string" || market.title === "" || typeof market.category !== "string" || market.category === "") throw new Error(`market ${market.vault} missing title/category`);
    map.set(market.vault.toLowerCase(), {
      vault: market.vault as Address,
      coinYes: market.coinYes,
      coinNo: market.coinNo,
      underlying: market.underlying,
      cluster: market.cluster,
      direction: market.direction,
      title: market.title,
      category: market.category,
      expiryMs: typeof market.expiryMs === "number" ? market.expiryMs : undefined,
    });
  }
  return map;
}
