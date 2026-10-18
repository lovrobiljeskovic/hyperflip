import { fetchMarketVolumes } from "./info";

export interface Market {
  vault: `0x${string}`;
  title: string;
  category: string;
  coinYes: string;
  coinNo: string;

  underlying?: string;
  expiryMs?: number;

  startMs?: number;

  sideYes?: string;
  sideNo?: string;

  group?: string;
  groupTitle?: string;
  question?: number;
  sport?: string;

  cluster?: string;

  deployer?: string;
  /** House prior P(YES) written by tools/house-markets.mjs for markets we deployed. */
  priorYes?: number;
  volume24h?: number;
}

export function marketMid(mids: Record<string, string>, market: Partial<Pick<Market, "volume24h" | "priorYes" | "coinYes">>, coin: string): number | null {
  const prior = market.priorYes === undefined ? null : coin === market.coinYes ? market.priorYes : 1 - market.priorYes;
  const raw = mids[coin];
  if (raw === undefined) return prior;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return prior;
  // ponytail: hides a traded 0.5 book with no volume today; use book depth if needed.
  if (n === 0.5 && !market.volume24h) return prior;
  return n;
}

/** Both sides quotable: a book price, a traded 0.5, or a house prior. */
export function isPriced(mids: Record<string, string>, market: Market): boolean {
  return marketMid(mids, market, market.coinYes) !== null && marketMid(mids, market, market.coinNo) !== null;
}

/** Tab label. Core deployers spell the same sport several ways ("Soccer", "Association Football",
 * "American football"); fold them so one sport gets one tab. */
export function sportLabel(market: Pick<Market, "sport" | "category">): string {
  const raw = (market.sport ?? market.category).trim().toLowerCase();
  if (raw === "american football") return "Football";
  if (raw === "association football" || raw === "soccer") return "Soccer";
  return raw.length <= 3 ? raw.toUpperCase() : raw[0].toUpperCase() + raw.slice(1);
}

export function onlySports(markets: Market[]): Market[] {
  return markets.filter((m) => m.category === "sports");
}

export function sideLabel(market: Pick<Market, "sideYes" | "sideNo"> | undefined, isYes: boolean): string {
  return (isYes ? market?.sideYes : market?.sideNo) ?? (isYes ? "YES" : "NO");
}

type BoardEntry = { kind: "market"; market: Market } | { kind: "group"; group: string; title: string; members: Market[] };

export function groupMarkets(markets: Market[]): BoardEntry[] {
  const entries: BoardEntry[] = [];
  const groups = new Map<string, Extract<BoardEntry, { kind: "group" }>>();
  for (const market of markets) {
    if (!market.group) {
      entries.push({ kind: "market", market });
      continue;
    }
    let entry = groups.get(market.group);
    if (!entry) {
      entry = { kind: "group", group: market.group, title: market.groupTitle ?? market.group, members: [] };
      groups.set(market.group, entry);
      entries.push(entry);
    }
    entry.members.push(market);
  }
  return entries;
}

export interface WriterQuote {
  taker: `0x${string}`;
  legs: { vault: `0x${string}`; isYes: boolean }[];
  premium: string;
  maxPayout: string;
  deadline: string;
  quoteId: `0x${string}`;
}

// Display inputs are not covered by the quote signature.
interface QuoteBreakdown {
  legPricesWad: string[];

  jointProbWad?: string;
  edgeBps: string;
  legBps?: string;
}

export type QuoteResult =
  | { ok: true; quote: WriterQuote; sig: `0x${string}`; breakdown?: QuoteBreakdown }
  | { ok: false; status: number; error: string; maxStake?: string; vault?: string };

const BASE = process.env.NEXT_PUBLIC_WRITER_URL ?? "";

export interface ParlayRef {
  id: bigint;
  block: bigint; // mint block
}

export async function fetchParlays(taker: `0x${string}`): Promise<ParlayRef[]> {
  const r = await fetch(`${BASE}/parlays?taker=${taker}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`parlays ${r.status}`);
  const refs = (await r.json()) as { id: string; block: string }[];
  return refs.map((p) => ({ id: BigInt(p.id), block: BigInt(p.block) }));
}

// Filter here so every route stays sports-only, including historical positions.
export async function fetchMarkets(includeArchived = false): Promise<Market[]> {
  const r = await fetch(`${BASE}/markets`, { next: { revalidate: 60 } });
  if (!r.ok) throw new Error(`markets ${r.status}`);
  const j = (await r.json()) as Market[] | { markets: Market[]; archived?: Market[] };
  if (Array.isArray(j)) return onlySports(j);
  return onlySports(includeArchived ? [...j.markets, ...(j.archived ?? [])] : j.markets);
}

export function withMarketVolumes(markets: Market[], volumes: Record<string, number>): Market[] {
  return markets.map((market) => ({ ...market, volume24h: volumes[market.coinYes] }));
}

export async function fetchMarketBoard(): Promise<Market[]> {
  const [markets, volumes] = await Promise.all([fetchMarkets(), fetchMarketVolumes()]);
  return withMarketVolumes(markets, volumes);
}

/** A grouped question that is one game (3-way soccer: Home / Draw / Away, deadline a few
 * days after kickoff), as opposed to a season-long tournament winner. */
export function isMatchQuestion(m: Pick<Market, "startMs" | "expiryMs" | "group">): boolean {
  return m.group !== undefined && m.startMs !== undefined && m.expiryMs !== undefined && m.expiryMs - m.startMs <= 7 * 86_400_000;
}

/** Soonest kickoff first; markets with neither start nor deadline sink to the bottom. A grouped
 * season ranks on its settlement deadline, a grouped match on its kickoff. */
export function kickoffKey(m: Pick<Market, "startMs" | "expiryMs" | "group">): number | undefined {
  return (m.group === undefined || isMatchQuestion(m) ? m.startMs : undefined) ?? m.expiryMs;
}
export function compareKickoff(left: Market, right: Market, soonestFirst = true): number {
  const ka = kickoffKey(left);
  const kb = kickoffKey(right);
  if (ka === undefined) return kb === undefined ? 0 : 1;
  if (kb === undefined) return -1;
  return (ka - kb) * (soonestFirst ? 1 : -1);
}

export interface WriterLimits {
  maxStake: string;
  edgeBps: string;
  legEdgeBps?: string;
  quoteTtlMs: number;
  /** House risk caps and live bankroll, USDC base units; absent on an older writer. */
  perMarketCap?: string;
  perClusterCap?: string;
  perCodeReservedCap?: string;
  bankroll?: string | null;
  reserved?: string;
}

export function currentPricing(limits: WriterLimits | null): { base: string; perLeg: string } | null {
  const bps = [limits?.edgeBps, limits?.legEdgeBps];
  if (!bps.every((value) => typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) return null;
  return { base: (Number(bps[0]) / 100).toFixed(2), perLeg: (Number(bps[1]) / 100).toFixed(2) };
}

export async function fetchLimits(): Promise<WriterLimits | null> {
  try {
    const r = await fetch(`${BASE}/limits`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    return (await r.json()) as WriterLimits;
  } catch {
    return null;
  }
}

export async function requestQuote(req: {
  taker: `0x${string}`;
  legs: { vault: `0x${string}`; isYes: boolean }[];
  stake: string;
}): Promise<QuoteResult> {
  let r: Response;
  try {
    // Loaded only when trading; the public waitlist keeps wallet SDKs out of its initial bundle.
    const { getAccessToken } = await import("@privy-io/react-auth");
    const token = await getAccessToken();
    if (!token) return { ok: false, status: 401, error: "unauthenticated" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      r = await fetch(`${BASE}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, status: 0, error: "writer-unreachable" };
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const body = j as { error?: string; maxStake?: string; vault?: string };
    return { ok: false, status: r.status, error: body.error ?? "unknown", maxStake: body.maxStake, vault: body.vault };
  }
  const { quote, sig, breakdown } = j as {
    quote: WriterQuote;
    sig: `0x${string}`;
    breakdown?: QuoteBreakdown;
  };
  return { ok: true, quote, sig, breakdown };
}
