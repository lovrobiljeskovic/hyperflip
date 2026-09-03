import { isAddress, type Address } from "viem";

export interface MarketInfo {
  vault: Address;
  coinYes: string;
  coinNo: string;
  underlying: string;
  cluster: string;
  direction: "up" | "down" | "band";
  /** Resolution deadline. */
  expiryMs?: number;
  /** Event start (kickoff). When set, quoting locks out from here, not from
   * expiryMs: a game's result is known long before its resolution deadline. */
  startMs?: number;
  /** HIP-4 question id when this outcome is one leg of a mutually exclusive
   * group (A / Draw / B, tournament winner). Absent for standalone binaries. */
  question?: number;
  /** Display labels for the two sides ("Twins"/"Orioles", "Over"/"Under").
   * Absent means Yes/No. */
  sideYes?: string;
  sideNo?: string;
  /** Vaults sharing a group render as one card in the UI. */
  group?: string;
  groupTitle?: string;
  title: string;
  category: string;
}

function optionalNumber(market: Record<string, unknown>, key: string): number | undefined {
  const v = market[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`market ${market.vault} ${key} must be a number`);
  return v;
}

function optionalString(market: Record<string, unknown>, key: string): string | undefined {
  const v = market[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v === "") throw new Error(`market ${market.vault} ${key} must be a non-empty string`);
  return v;
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
      expiryMs: optionalNumber(market, "expiryMs"),
      startMs: optionalNumber(market, "startMs"),
      question: optionalNumber(market, "question"),
      sideYes: optionalString(market, "sideYes"),
      sideNo: optionalString(market, "sideNo"),
      group: optionalString(market, "group"),
      groupTitle: optionalString(market, "groupTitle"),
    });
  }
  return map;
}
