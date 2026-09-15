import { isAddress, type Address } from "viem";

export interface MarketInfo {
  vault: Address;
  coinYes: string;
  coinNo: string;
  // Event identity used to refuse two legs from the same game.
  underlying: string;
  cluster: string;

  expiryMs?: number;

  startMs?: number;

  question?: number;

  sideYes?: string;
  sideNo?: string;

  group?: string;
  groupTitle?: string;
  /** House prior P(YES) for markets we deployed; used when the Core book is empty. */
  priorYes?: number;
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

export function parseMarkets(raw: string): Map<string, MarketInfo> {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.markets;
  if (!Array.isArray(list)) throw new Error("MARKETS must be a JSON array or { markets: [...] }");
  const map = new Map<string, MarketInfo>();
  for (const market of list) {
    if (!isAddress(market.vault)) throw new Error(`invalid market vault: ${market.vault}`);
    if (typeof market.coinYes !== "string" || typeof market.coinNo !== "string") throw new Error(`market ${market.vault} missing coinYes/coinNo`);
    if (typeof market.underlying !== "string" || market.underlying === "" || typeof market.cluster !== "string" || market.cluster === "") throw new Error(`market ${market.vault} missing underlying/cluster`);
    if (typeof market.title !== "string" || market.title === "" || typeof market.category !== "string" || market.category === "") throw new Error(`market ${market.vault} missing title/category`);
    if (market.category !== "sports") throw new Error(`market ${market.vault} must be sports`);
    const priorYes = optionalNumber(market, "priorYes");
    if (priorYes !== undefined && !(priorYes > 0 && priorYes < 1)) throw new Error(`market ${market.vault} priorYes must be in (0,1)`);
    map.set(market.vault.toLowerCase(), {
      vault: market.vault as Address,
      coinYes: market.coinYes,
      coinNo: market.coinNo,
      underlying: market.underlying,
      cluster: market.cluster,
      title: market.title,
      category: market.category,
      expiryMs: optionalNumber(market, "expiryMs"),
      startMs: optionalNumber(market, "startMs"),
      question: optionalNumber(market, "question"),
      sideYes: optionalString(market, "sideYes"),
      sideNo: optionalString(market, "sideNo"),
      group: optionalString(market, "group"),
      groupTitle: optionalString(market, "groupTitle"),
      ...(priorYes !== undefined ? { priorYes } : {}),
    });
  }
  return map;
}
