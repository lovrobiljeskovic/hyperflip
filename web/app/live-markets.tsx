"use client";

import { useEffect, useRef, useState } from "react";
import { fetchMarkets, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { pct1, until } from "@/lib/format";

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

/** A coin's mid as a probability. allMids carries every coin on the venue, so
 * a mid is only meaningful here when it lands strictly inside (0, 1) — the
 * same domain priceBreakdown() enforces on a signed quote's leg prices.
 * Anything else is not a probability and must not reach the board or the
 * hero, where it would print as a nonsense percentage or payout. */
function midNumber(mids: Record<string, string>, coin: string): number | null {
  const raw = mids[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
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
        {mid === null ? "—" : pct1(mid)}
      </span>
    </div>
  );
}

function BoardRow({ market, mids }: { market: Market; mids: Record<string, string> }) {
  const yes = midNumber(mids, market.coinYes);
  const no = midNumber(mids, market.coinNo);
  const book = overround(yes, no);
  // The leading side tints the row — the board reads as a shape before it reads
  // as numbers. Semantic, never rose.
  const lead =
    yes === null || no === null
      ? ""
      : yes > no
        ? "bg-[rgba(31,92,64,0.08)]"
        : no > yes
          ? "bg-[rgba(158,43,26,0.07)]"
          : "";
  return (
    <div
      className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-5 py-[15px] sm:grid-cols-[1fr_110px_110px_100px_120px] ${lead}`}
    >
      <div className="col-span-2 sm:col-span-1">
        <p className="text-[12px] leading-snug">{market.title}</p>
        <p className="mono mt-1 text-[10px] uppercase tracking-[0.14em] text-dim">
          {market.category}
        </p>
      </div>
      <OddsCell side="YES" mid={yes} />
      <OddsCell side="NO" mid={no} />
      <div className="mono col-span-2 text-right text-[11px] text-dim sm:col-span-1">
        {book === null ? "—" : `${book >= 0 ? "+" : ""}${(book * 100).toFixed(1)}%`}
      </div>
      <div className="mono col-span-2 text-right text-[11px] text-dim sm:col-span-1">
        {market.expiryMs ? until(market.expiryMs) : "—"}
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
      <div className="mono hidden grid-cols-[1fr_110px_110px_100px_120px] gap-x-4 border-b border-line px-5 py-3 text-[9px] uppercase tracking-[0.14em] text-dim sm:grid">
        <span>Market</span>
        <span className="text-right">Yes</span>
        <span className="text-right">No</span>
        <span className="text-right">Book</span>
        <span className="text-right">Expires</span>
      </div>
      <div className="flex flex-col divide-y divide-line">
        {state.markets.map((m) => (
          <BoardRow key={m.vault} market={m} mids={mids} />
        ))}
      </div>
    </Slab>
  );
}

/** One line of true numbers above the headline. */
export function HeroStats() {
  const state = useMarkets();
  const count =
    state.status === "live"
      ? `${state.markets.length} market${state.markets.length === 1 ? "" : "s"} live`
      : "HyperEVM testnet";
  return (
    <p className="mono flex flex-wrap gap-x-7 gap-y-1 text-[10px] uppercase tracking-[0.14em] text-dim">
      <span>{count}</span>
      <span>testnet beta</span>
      <span>invite only</span>
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
 * board is up and on the worked example when it isn't. It turns to face the
 * reader as they scroll. Every number shown is labelled for which it is —
 * this is fair value off the book, not a signed quote. */
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
  const fair = combined > 0 ? 1 / combined : 0;

  return (
    <div className="[perspective:1200px]">
      <div className="slip-turn mx-auto w-[280px] shadow-[-34px_30px_60px_rgba(36,21,18,0.35)]">
        <div className="bg-[var(--paper)] px-[22px] py-5">
          <Line i={0}>
            <div className="mono flex items-baseline justify-between text-[9px] uppercase tracking-[0.14em] text-dim">
              <span>Slip #0012</span>
              <span>
                {legs.length} legs · {live ? "live board" : "example"}
              </span>
            </div>
          </Line>

          <Line i={1}>
            <div className="my-3 h-px bg-[var(--hair)]" />
          </Line>

          <ul className="flex flex-col gap-2.5">
            {legs.map((leg, i) => (
              <li key={leg.title}>
                <Line i={2 + i}>
                  <div className="flex items-baseline justify-between gap-3 text-[11px]">
                    <span className="flex-1 truncate leading-snug">{leg.title}</span>
                    <span
                      className={`mono shrink-0 ${
                        leg.side === "YES" ? "text-[var(--hit)]" : "text-[var(--stamp)]"
                      }`}
                    >
                      {leg.side} {leg.prob === null ? "—" : pct1(leg.prob)}
                    </span>
                  </div>
                </Line>
              </li>
            ))}
          </ul>

          <Line i={2 + legs.length}>
            <div className="my-3 h-px bg-[var(--hair)]" />
          </Line>

          <Line i={3 + legs.length}>
            <div className="mono flex items-baseline justify-between text-[11px]">
              <span className="text-dim">Stake</span>
              <span>{stake.toFixed(2)}</span>
            </div>
          </Line>

          <Line i={4 + legs.length}>
            <div className="mt-3 flex items-end justify-between">
              <span className="mono text-[9px] uppercase tracking-[0.14em] text-dim">
                Fair payout {fair.toFixed(2)}×
              </span>
              <span className="mono text-[26px] leading-none">
                {(stake * fair).toFixed(2)}
              </span>
            </div>
          </Line>

          <Line i={5 + legs.length}>
            <div className="mt-4">
              <div className="h-[3px] overflow-hidden bg-[rgba(36,21,18,0.14)]">
                <div className="ttl-bar h-full bg-[var(--stamp)]" />
              </div>
              <p className="mono mt-2 text-[9px] uppercase tracking-[0.14em] text-dim">
                Quote holds 30s
              </p>
            </div>
          </Line>

          <Line i={6 + legs.length}>
            <p className="mono mt-4 text-[9px] leading-relaxed text-dim">
              {live
                ? "Odds from the live Core book, before the house spread. Your quote is signed at mint."
                : "Worked example. Live odds print here when the board is up."}
            </p>
          </Line>
        </div>
        <div className="torn-edge" />
      </div>
    </div>
  );
}
