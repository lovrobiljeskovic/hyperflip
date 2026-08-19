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

export type QuoteResult =
  | { ok: true; quote: WriterQuote; sig: `0x${string}` }
  | { ok: false; status: number; error: string };

const BASE = process.env.NEXT_PUBLIC_WRITER_URL ?? "";

export async function fetchMarkets(): Promise<Market[]> {
  const r = await fetch(`${BASE}/markets`);
  if (!r.ok) throw new Error(`markets ${r.status}`);
  return (await r.json()).markets as Market[];
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
  if (!r.ok) return { ok: false, status: r.status, error: (j as { error?: string }).error ?? "unknown" };
  const { quote, sig } = j as { quote: WriterQuote; sig: `0x${string}` };
  return { ok: true, quote, sig };
}
