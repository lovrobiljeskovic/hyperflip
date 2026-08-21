"use client";

import { useEffect, useRef, useState } from "react";
import { fetchMarkets, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { impliedPct } from "@/lib/format";

/* One registry fetch shared by the hero slip, the stat line, and the board.
   ponytail: module-level promise cache, cleared on failure so a client-side
   revisit retries. */
let marketsCache: Promise<Market[]> | null = null;
function loadMarkets(): Promise<Market[]> {
  marketsCache ??= fetchMarkets().catch((e) => {
    marketsCache = null;
    throw e;
  });
  return marketsCache;
}

type MarketsState =
  | { status: "loading" }
  | { status: "offline" }
  | { status: "live"; markets: Market[] };

function useMarkets(): MarketsState {
  const [state, setState] = useState<MarketsState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    loadMarkets()
      .then((markets) => alive && setState({ status: "live", markets }))
      .catch(() => alive && setState({ status: "offline" }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/* --- mid helpers: never fake a number, dash on missing --- */

function midNumber(mids: Record<string, string>, coin: string): number | null {
  const raw = mids[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function oddsLabel(mid: number | null): string {
  return mid === null ? "—" : `${(1 / mid).toFixed(2)}x`;
}

/** The book's overround: both sides' implied probabilities sum past 100% by
 * exactly the margin the market makes. Null unless both sides are priced. */
function overround(yes: number | null, no: number | null): number | null {
  return yes === null || no === null ? null : yes + no - 1;
}

/* Odds cell that flashes on mid change: up = ink green, down = stamp red,
   400ms decay (globals.css keyframes, re-tinted by the .slip palette). */
function OddsCell({ side, mid }: { side: "YES" | "NO"; mid: number | null }) {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<{ dir: "up" | "down"; seq: number } | null>(null);

  useEffect(() => {
    const p = prev.current;
    prev.current = mid;
    if (p !== null && mid !== null && mid !== p) {
      const dir = mid > p ? "up" : "down";
      setFlash((f) => ({ dir, seq: (f?.seq ?? 0) + 1 }));
    }
  }, [mid]);

  return (
    <div
      key={flash?.seq ?? 0}
      className={`mono px-2 py-1 text-right ${
        flash ? (flash.dir === "up" ? "flash-up" : "flash-down") : ""
      }`}
    >
      <span className={`text-[15px] ${side === "YES" ? "text-yes" : "text-no"}`}>
        {oddsLabel(mid)}
      </span>
      <span className="ml-2 text-[10px] text-dim">
        {mid === null ? "—" : impliedPct(mid)}
      </span>
    </div>
  );
}

function expiryLabel(expiryMs?: number): string | null {
  if (!expiryMs) return null;
  return new Date(expiryMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function BoardRow({ market, mids }: { market: Market; mids: Record<string, string> }) {
  const yes = midNumber(mids, market.coinYes);
  const no = midNumber(mids, market.coinNo);
  const book = overround(yes, no);
  const expiry = expiryLabel(market.expiryMs);
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-5 py-4 sm:grid-cols-[1fr_110px_110px_86px]">
      <div className="col-span-2 sm:col-span-1">
        <p className="text-[15px] leading-snug">{market.title}</p>
        <p className="mono mt-1 text-[10px] uppercase tracking-wide text-dim">
          {market.category}
          {expiry ? ` · settles ${expiry}` : ""}
        </p>
      </div>
      <OddsCell side="YES" mid={yes} />
      <OddsCell side="NO" mid={no} />
      <div className="mono col-span-2 text-right text-[11px] text-dim sm:col-span-1">
        {book === null ? "—" : `${book >= 0 ? "+" : ""}${(book * 100).toFixed(1)}%`}
      </div>
    </div>
  );
}

function Slab({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-8 rounded-[3px] bg-[var(--paper)] shadow-[6px_8px_0_rgba(36,21,18,0.14)]">
      {children}
    </div>
  );
}

/** The board for the #board section: every listed market with both sides and
 * the margin the book is charging on each. */
export function LiveMarketBoard() {
  const state = useMarkets();
  const mids = useMids();

  if (state.status === "loading") {
    return (
      <Slab>
        <div className="flex flex-col divide-y divide-line" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-5 py-5">
              <div className="h-3 w-2/5 rounded-[2px] bg-raised" />
              <div className="mt-2 h-2 w-24 rounded-[2px] bg-raised" />
            </div>
          ))}
        </div>
      </Slab>
    );
  }

  if (state.status === "offline") {
    return (
      <Slab>
        <div className="px-5 py-10 text-center">
          <p className="mono text-xs uppercase tracking-wide text-no">Board down</p>
          <p className="mt-2 text-sm text-dim">
            The registry is unreachable. Prices come back when the writer does.
          </p>
        </div>
      </Slab>
    );
  }

  if (state.markets.length === 0) {
    return (
      <Slab>
        <p className="mono px-5 py-10 text-center text-xs uppercase tracking-wide text-dim">
          No markets listed yet
        </p>
      </Slab>
    );
  }

  return (
    <Slab>
      <div className="mono hidden grid-cols-[1fr_110px_110px_86px] gap-x-4 border-b border-line px-5 py-3 text-[10px] uppercase tracking-wide text-dim sm:grid">
        <span>Market</span>
        <span className="text-right">Yes</span>
        <span className="text-right">No</span>
        <span className="text-right">Book</span>
      </div>
      <div className="flex flex-col divide-y divide-line">
        {state.markets.map((m) => (
          <BoardRow key={m.vault} market={m} mids={mids} />
        ))}
      </div>
    </Slab>
  );
}

/** One line of true numbers under the headline. */
export function HeroStats() {
  const state = useMarkets();
  return (
    <p className="mono text-[11px] uppercase tracking-wide text-dim">
      {state.status === "live"
        ? `${state.markets.length} market${state.markets.length === 1 ? "" : "s"} on the board · HyperEVM testnet`
        : "HyperEVM testnet"}
    </p>
  );
}

/* --- the hero slip --- */

type SlipLeg = { side: "YES" | "NO"; title: string; prob: number };

const EXAMPLE_LEGS: SlipLeg[] = [
  { side: "YES", title: "BTC above 64,000 on Aug 21?", prob: 0.85 },
  { side: "NO", title: "HYPE above 60 by Friday?", prob: 0.57 },
  { side: "YES", title: "ETH below 1,850 on Aug 21?", prob: 0.62 },
];

function Line({ i, children }: { i: number; children: React.ReactNode }) {
  return (
    <div className="print-line" style={{ animationDelay: `${240 + i * 110}ms` }}>
      {children}
    </div>
  );
}

/** The signature: a slip printing itself, line by line, on live odds when the
 * board is up and on the worked example when it isn't. Every number shown is
 * labelled for which of the two it is. */
export function HeroSlip() {
  const state = useMarkets();
  const mids = useMids();

  /* Live legs only when every side has a mid — a half-priced slip would
     print a combined implied that isn't real. */
  let legs = EXAMPLE_LEGS;
  let live = false;
  if (state.status === "live" && state.markets.length >= 2) {
    const priced = state.markets.slice(0, 3).map((m) => ({
      side: "YES" as const,
      title: m.title,
      prob: midNumber(mids, m.coinYes),
    }));
    if (priced.every((l) => l.prob !== null)) {
      legs = priced as SlipLeg[];
      live = true;
    }
  }

  const combined = legs.reduce((acc, l) => acc * (l.prob as number), 1);
  const stake = 100;
  /* Fair returns, not a quote: the house spread is applied by the writer at
     quote time, so the slip says which number this is. */
  const fair = stake / combined;
  return (
    <div className="relative">
      <div className="torn bg-[var(--paper)] px-6 py-7 shadow-[10px_14px_0_rgba(36,21,18,0.16)]">
        <Line i={0}>
          <div className="mono flex items-baseline justify-between text-[10px] uppercase tracking-wide text-dim">
            <span>Parlay slip</span>
            <span>{live ? "live board" : "example"}</span>
          </div>
        </Line>

        <Line i={1}>
          <div className="perf my-4" />
        </Line>

        <ul className="flex flex-col gap-3">
          {legs.map((leg, i) => (
            <li key={leg.title}>
              <Line i={2 + i}>
                <div className="flex items-start gap-3">
                  <span
                    className={`mono mt-[2px] shrink-0 px-1.5 py-0.5 text-[10px] leading-none ${
                      leg.side === "YES"
                        ? "bg-[var(--hit)] text-[var(--paper)]"
                        : "bg-[var(--stamp)] text-[var(--paper)]"
                    }`}
                  >
                    {leg.side}
                  </span>
                  <span className="flex-1 text-[13px] leading-snug">{leg.title}</span>
                  <span className="mono text-[13px]">{oddsLabel(leg.prob)}</span>
                </div>
              </Line>
            </li>
          ))}
        </ul>

        <Line i={2 + legs.length}>
          <div className="perf my-4" />
        </Line>

        <div className="mono flex flex-col gap-2 text-[12px]">
          <Line i={3 + legs.length}>
            <div className="flex justify-between">
              <span className="text-dim">Stake</span>
              <span>{stake.toFixed(2)} USDC</span>
            </div>
          </Line>
          <Line i={4 + legs.length}>
            <div className="flex justify-between">
              <span className="text-dim">Combined implied</span>
              <span>{(combined * 100).toFixed(1)}%</span>
            </div>
          </Line>
          <Line i={5 + legs.length}>
            <div className="flex items-baseline justify-between">
              <span className="text-dim">Fair returns</span>
              <span className="text-[20px]">{fair.toFixed(2)}</span>
            </div>
          </Line>
        </div>

        <Line i={6 + legs.length}>
          <p className="mono mt-5 text-[9px] uppercase tracking-wide text-dim">
            {live
              ? "Odds from the live Core book, before the house spread. Your quote is signed at mint."
              : "Worked example. Live odds print here when the board is up."}
          </p>
        </Line>
      </div>

      <span
        aria-hidden
        className="stamp-in mono pointer-events-none absolute -bottom-3 -left-3 border-[3px] border-[var(--stamp)] bg-[color-mix(in_srgb,var(--paper)_75%,transparent)] px-3 py-1 text-[12px] uppercase tracking-widest text-[var(--stamp)] [animation-delay:1.1s]"
      >
        Testnet
      </span>
    </div>
  );
}
