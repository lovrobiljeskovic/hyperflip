export interface Market {
  vault: `0x${string}`;
  title: string;
  category: string;
  coinYes: string;
  coinNo: string;
  /** Perp symbol, e.g. BTC or NVDA. In the registry since the first rotation;
   * optional here for tickets naming markets from before it existed. */
  underlying?: string;
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
  /** P(all legs win) from the writer's copula, WAD. Absent on writers
   * predating correlation pricing — treat as the product of the leg prices. */
  jointProbWad?: string;
  edgeBps: string;
  legBps?: string; // absent on writers predating leg-count-scaled edge
}

export type QuoteResult =
  | { ok: true; quote: WriterQuote; sig: `0x${string}`; breakdown?: QuoteBreakdown }
  | { ok: false; status: number; error: string; maxStake?: string; vault?: string };

const BASE = process.env.NEXT_PUBLIC_WRITER_URL ?? "";

/* Revalidated rather than request-time so the landing page stays prerendered.
   The option is inert in the browser, where this same function still backs the
   client-side fallback fetch. */
export async function fetchMarkets(includeArchived = false): Promise<Market[]> {
  const r = await fetch(`${BASE}/markets`, { next: { revalidate: 60 } });
  if (!r.ok) throw new Error(`markets ${r.status}`);
  const j = (await r.json()) as Market[] | { markets: Market[]; archived?: Market[] };
  if (Array.isArray(j)) return j;
  // archived = rotated-out (expired) markets — only wanted where old tickets
  // need naming; the build board must not offer them.
  return includeArchived ? [...j.markets, ...(j.archived ?? [])] : j.markets;
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

export type WaitlistResult = { ok: true } | { ok: false; error: string };

/** Writer waitlist error → user-facing copy, shared by every signup form. */
export const WAITLIST_ERRORS: Record<string, string> = {
  "bad-email": "Enter a valid email address.",
  "rate-limited": "Too many signups from your connection — try again later.",
  "email-failed": "Couldn't send the email — try again in a minute.",
  "waitlist-unavailable": "Signups are paused right now — try again later.",
  unreachable: "Writer unreachable — try again shortly.",
};

/** Beta waitlist signup — the writer emails back a generated invite code. */
export async function joinWaitlist(email: string): Promise<WaitlistResult> {
  try {
    const r = await fetch(`${BASE}/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error ?? `waitlist ${r.status}` };
  } catch {
    return { ok: false, error: "unreachable" };
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
    // A hung writer would otherwise leave the CTA reading "Quoting…" forever —
    // bound the wait and surface it as the same status-0 shape as a network
    // failure, so the existing retry UI renders.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      r = await fetch(`${BASE}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
