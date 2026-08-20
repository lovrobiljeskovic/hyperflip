export interface Market {
  vault: `0x${string}`;
  title: string;
  category: string;
  coinYes: string;
  coinNo: string;
  expiryMs?: number;
}

export interface WriterQuote {
  taker: `0x${string}`;
  legs: { vault: `0x${string}`; isYes: boolean }[];
  premium: string;
  maxPayout: string;
  deadline: string;
  quoteId: `0x${string}`;
}

/** Informational pricing inputs echoed by the writer alongside the signed
 * quote (not covered by the signature). legPricesWad is in quote.legs order. */
export interface QuoteBreakdown {
  legPricesWad: string[];
  edgeBps: string;
  legBps?: string; // absent on writers predating leg-count-scaled edge
  corrBps: string;
}

export type QuoteResult =
  | { ok: true; quote: WriterQuote; sig: `0x${string}`; breakdown?: QuoteBreakdown }
  | { ok: false; status: number; error: string; maxStake?: string };

const BASE = process.env.NEXT_PUBLIC_WRITER_URL ?? "";

export async function fetchMarkets(): Promise<Market[]> {
  const r = await fetch(`${BASE}/markets`);
  if (!r.ok) throw new Error(`markets ${r.status}`);
  const j = (await r.json()) as Market[] | { markets: Market[] };
  return Array.isArray(j) ? j : j.markets;
}

export interface WriterLimits {
  maxStake: string;
  edgeBps: string;
  quoteTtlMs: number;
}

/** Quote-shaping caps. Returns null when the writer is unreachable or too old
 * to serve /limits — callers fall back to unclamped input. */
export async function fetchLimits(): Promise<WriterLimits | null> {
  try {
    const r = await fetch(`${BASE}/limits`);
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
  inviteCode: string;
}): Promise<QuoteResult> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch {
    return { ok: false, status: 0, error: "writer-unreachable" };
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const body = j as { error?: string; maxStake?: string };
    return { ok: false, status: r.status, error: body.error ?? "unknown", maxStake: body.maxStake };
  }
  const { quote, sig, breakdown } = j as {
    quote: WriterQuote;
    sig: `0x${string}`;
    breakdown?: QuoteBreakdown;
  };
  return { ok: true, quote, sig, breakdown };
}
