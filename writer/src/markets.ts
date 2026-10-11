import { isAddress, type Address } from "viem";

export interface MarketInfo {
  /** Address the ParlayVault reads: the OutcomeVault on HyperEVM, or the OutcomeLeg on Elysium. */
  vault: Address;
  /** HyperEVM OutcomeVault an Elysium leg mirrors (the Core account); absent on HyperEVM rows. */
  sourceVault?: Address;
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
  sport?: string;
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

/**
 * Registry rows are written Elysium-first: `vault` is the OutcomeLeg the Elysium ParlayVault reads,
 * `sourceVault` the 998 OutcomeVault behind it. A writer on the Core chain reads the 998 vault instead,
 * so both lanes share one registry file. A row without `sourceVault` is a 998-only address (pre-cutover
 * or foreign venue); the bridged lane drops it, because the same deployer nonce on both chains makes
 * such an address collide with a live leg and the app labels legs by address.
 */
export function laneRows<T extends { vault: string; sourceVault?: string | null }>(rows: T[], chainId: number, coreChainId: number): T[] {
  if (chainId !== coreChainId) return rows.filter((row) => row.sourceVault);
  return rows.map(({ sourceVault, ...row }) => (sourceVault ? { ...row, vault: sourceVault } : row) as T);
}

export function parseMarkets(raw: string): Map<string, MarketInfo> {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.markets;
  if (!Array.isArray(list)) throw new Error("MARKETS must be a JSON array or { markets: [...] }");
  const map = new Map<string, MarketInfo>();
  for (const market of list) {
    if (!isAddress(market.vault)) throw new Error(`invalid market vault: ${market.vault}`);
    if (market.sourceVault !== undefined && market.sourceVault !== null && !isAddress(market.sourceVault)) throw new Error(`market ${market.vault} invalid sourceVault`);
    if (typeof market.coinYes !== "string" || typeof market.coinNo !== "string") throw new Error(`market ${market.vault} missing coinYes/coinNo`);
    if (typeof market.underlying !== "string" || market.underlying === "" || typeof market.cluster !== "string" || market.cluster === "") throw new Error(`market ${market.vault} missing underlying/cluster`);
    if (typeof market.title !== "string" || market.title === "" || typeof market.category !== "string" || market.category === "") throw new Error(`market ${market.vault} missing title/category`);
    if (market.category !== "sports") throw new Error(`market ${market.vault} must be sports`);
    const priorYes = optionalNumber(market, "priorYes");
    if (priorYes !== undefined && !(priorYes > 0 && priorYes < 1)) throw new Error(`market ${market.vault} priorYes must be in (0,1)`);
    map.set(market.vault.toLowerCase(), {
      vault: market.vault as Address,
      ...(market.sourceVault ? { sourceVault: market.sourceVault as Address } : {}),
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
      ...(market.sport !== undefined && market.sport !== null ? { sport: optionalString(market, "sport") } : {}),
      ...(priorYes !== undefined ? { priorYes } : {}),
    });
  }
  return map;
}
