"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { compareMarketVolume, fetchMarketBoard, onlySports, sideLabel, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { usePrinting } from "@/lib/print";
import { formatVolume, oddsLabel, pct1, until } from "@/lib/format";

/* One registry fetch shared by the hero slip, the stat line, and the board.
   ponytail: module-level promise cache, cleared on failure so a client-side
   revisit retries. */
let marketsCache: Promise<Market[]> | null = null;
function loadMarkets(): Promise<Market[]> {
  marketsCache ??= fetchMarketBoard().then(onlySports).catch((e) => {
    marketsCache = null;
    throw e;
  });
  return marketsCache;
}

type MarketsState =
  | { status: "loading" }
  | { status: "offline" }
  | { status: "live"; markets: Market[] };

/* `initial` is the board as the server rendered it. Measured cold on Chrome:
   hydration starts the client fetch at ~1.45s and /markets answers at ~2.28s,
   while the hero's print cascade runs 240-1510ms - so a client-only fetch
   guaranteed the slip printed placeholder legs and then swapped to the real
   ones after the animation was already over. Seeding from the server means
   there is one market set and one print. The fetch below is the fallback for
   when the writer was unreachable at render time. */
function useMarkets(initial: Market[] | null): { state: MarketsState; retry: () => void } {
  const [state, setState] = useState<MarketsState>(
    initial ? { status: "live", markets: initial } : { status: "loading" },
  );
  // Manual retry for the offline state - loadMarkets() already clears
  // marketsCache on failure, so this just re-runs the same fetch.
  const retry = useCallback(() => {
    setState({ status: "loading" });
    loadMarkets()
      .then((markets) => setState({ status: "live", markets }))
      .catch(() => setState({ status: "offline" }));
  }, []);
  useEffect(() => {
    if (initial) return;
    let alive = true;
    loadMarkets()
      .then((markets) => alive && setState({ status: "live", markets }))
      .catch(() => alive && setState({ status: "offline" }));
    return () => {
      alive = false;
    };
  }, [initial]);
  return { state, retry };
}

/** What the server hands every live component on the landing page. */
export interface BoardSnapshot {
  markets: Market[] | null;
  mids: Record<string, string>;
}

/* --- mid helpers: never fake a number, dash on missing --- */

/** A coin's mid as a probability. allMids carries every coin on the venue, so
 * a mid is only meaningful here when it lands strictly inside (0, 1) - the
 * same domain priceBreakdown() enforces on a signed quote's leg prices.
 * Anything else is not a probability and must not reach the board or the
 * hero, where it would print as a nonsense percentage or payout. */
function midNumber(mids: Record<string, string>, coin: string): number | null {
  const raw = mids[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

/* Odds cell that nudges on a mid change while the semantic YES/NO text color
   carries direction. */
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
        {mid === null ? "-" : pct1(mid)}
      </span>
    </div>
  );
}

function BoardRow({ market, mids }: { market: Market; mids: Record<string, string> }) {
  const yes = midNumber(mids, market.coinYes);
  const no = midNumber(mids, market.coinNo);
  // The leading side tints the row so direction reads before the numbers.
  const lead =
    yes === null || no === null
      ? ""
      : yes > no
        ? "bg-yes/[0.045]"
        : no > yes
          ? "bg-no/[0.04]"
          : "";
  return (
    <div
      className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-5 py-[15px] sm:grid-cols-[1fr_110px_110px_100px_120px] ${lead}`}
    >
      <div className="col-span-2 sm:col-span-1">
        <p className="text-[12px] leading-snug">{market.title}</p>
        <p className="mono mt-1 text-[10px] uppercase tracking-[0.14em] text-dim">
          {market.groupTitle && market.groupTitle !== market.title
            ? market.groupTitle
            : [market.sport ?? market.category, market.cluster].filter(Boolean).join(" · ")}
          <span className="sm:hidden">
            {" · "}
            {formatVolume(market.volume24h)}
          </span>
        </p>
      </div>
      <OddsCell side="YES" mid={yes} />
      <OddsCell side="NO" mid={no} />
      <div className="mono hidden text-right text-[11px] text-dim sm:block">
        {formatVolume(market.volume24h)}
      </div>
      <div className="mono col-span-2 text-right text-[11px] text-dim sm:col-span-1">
        {market.expiryMs ? until(market.expiryMs) : "-"}
      </div>
    </div>
  );
}

function Slab({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-8 overflow-hidden rounded-[12px] border border-line bg-panel">
      {children}
    </div>
  );
}

/** The board for the #board section: every listed market with both sides
 * priced live. */
export function LiveMarketBoard({ board }: { board: BoardSnapshot }) {
  const { state, retry } = useMarkets(board.markets);
  const mids = useMids(board.mids);

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
          <button
            type="button"
            onClick={retry}
            className="mono mt-4 rounded-[4px] border border-line px-4 py-2 text-xs uppercase tracking-wide text-dim transition-colors hover:border-dim hover:text-fg"
          >
            Retry
          </button>
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
        <span className="text-right">24h vol</span>
        <span className="text-right">Expires</span>
      </div>
      <div className="flex flex-col divide-y divide-line">
        {[...state.markets].sort((a, b) => compareMarketVolume(a, b, false)).map((m) => (
          <BoardRow key={m.vault} market={m} mids={mids} />
        ))}
      </div>
    </Slab>
  );
}

/** One line of true numbers above the headline. */
export function HeroStats({ board }: { board: BoardSnapshot }) {
  const { state } = useMarkets(board.markets);
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

/** One continuous line of actual markets. The duplicate set is hidden from
 * assistive tech and exists only to make the native CSS loop seamless. */
export function LiveMarketRail({ board }: { board: BoardSnapshot }) {
  const { state } = useMarkets(board.markets);
  const mids = useMids(board.mids);

  if (state.status !== "live" || state.markets.length === 0) {
    return (
      <div className="border-y border-line bg-panel px-4 py-3 text-center mono text-[10px] uppercase tracking-[.12em] text-dim">
        Live market feed reconnecting
      </div>
    );
  }

  const markets = [...state.markets].sort((a, b) => compareMarketVolume(a, b, false)).slice(0, 6);
  const items = markets.map((market) => ({
    title: market.title,
    yes: midNumber(mids, market.coinYes),
    no: midNumber(mids, market.coinNo),
  }));

  const set = (hidden: boolean) => (
    <div className="flex shrink-0" aria-hidden={hidden || undefined}>
      {items.map((item) => (
        <div key={item.title} className="flex min-w-[310px] items-center justify-between gap-8 border-r border-line px-5 py-3">
          <span className="max-w-[190px] truncate text-xs">{item.title}</span>
          <span className="mono shrink-0 text-[11px]">
            <span className="text-yes">Y {item.yes === null ? "-" : pct1(item.yes)}</span>
            <span className="mx-2 text-line">/</span>
            <span className="text-no">N {item.no === null ? "-" : pct1(item.no)}</span>
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="market-rail overflow-hidden border-y border-line bg-panel" aria-label="Live market prices">
      <div className="market-rail-track flex">{set(false)}{set(true)}</div>
    </div>
  );
}

/* --- the hero slip --- */

type SlipLeg = { side: "YES" | "NO"; label: string; title: string; prob: number | null };

function Line({ i, children }: { i: number; children: React.ReactNode }) {
  return (
    <div className="print-line" style={{ animationDelay: `${240 + i * 110}ms` }}>
      {children}
    </div>
  );
}

/** The signature: a slip printing itself, line by line, on live odds when the
 * board is up and on the worked example when it isn't. It turns to face the
 * reader as they scroll. Every number shown is labelled for which it is -
 * this is fair value off the book, not a signed quote. */
export function HeroSlip({ board }: { board: BoardSnapshot }) {
  const { state } = useMarkets(board.markets);
  const mids = useMids(board.mids);
  const printing = usePrinting();

  const listed = state.status === "live" ? state.markets.slice(0, 3) : [];
  const live = listed.length >= 2;
  const legs: SlipLeg[] = live
    ? listed.map((m) => ({
        side: "YES" as const,
        label: sideLabel(m, true),
        title: m.title,
        prob: midNumber(mids, m.coinYes),
      }))
    : [];

  // A half-priced slip has no honest combined implied, so the payout goes
  // unavailable rather than multiplying by an assumed certainty.
  const combined = live && legs.every((l) => l.prob !== null)
    ? legs.reduce((acc, l) => acc * (l.prob as number), 1)
    : null;
  const fair = combined !== null && combined > 0 ? 1 / combined : null;

  return (
    <div className="[perspective:1200px]">
      <div className={`slip-turn mx-auto w-full max-w-[390px] ${printing}`}>
        <div className="ticket-shell px-6 py-7 sm:px-7 sm:py-8">
          <Line i={0}>
            <div className="mono flex items-baseline justify-between text-[9px] uppercase tracking-[0.14em] text-dim">
              <span>Live combination</span>
              <span>
                {live ? `${legs.length} legs` : "feed unavailable"}
              </span>
            </div>
          </Line>

          <Line i={1}>
            <div className="my-4 h-px bg-line" />
          </Line>

          {live ? <ul className="flex flex-col gap-3">
            {legs.map((leg, i) => (
              <li key={i}>
                <Line i={2 + i}>
                  <div className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="flex-1 truncate leading-snug">{leg.title}</span>
                    <span className={`mono shrink-0 uppercase ${leg.side === "YES" ? "text-yes" : "text-no"}`}>
                      {leg.label} {leg.prob === null ? "-" : pct1(leg.prob)}
                    </span>
                  </div>
                </Line>
              </li>
            ))}
          </ul> : (
            <Line i={2}><p className="py-10 text-center text-sm text-dim">Live markets will print here when the feed reconnects.</p></Line>
          )}

          <Line i={2 + legs.length}>
            <div className="my-4 h-px bg-line" />
          </Line>

          <Line i={3 + legs.length}>
            <div className="mt-3 flex items-end justify-between">
              <span className="mono text-[9px] uppercase tracking-[0.14em] text-dim">Combined fair odds</span>
              <span className="mono text-[28px] leading-none text-accent">{fair === null ? "-" : `${fair.toFixed(2)}×`}</span>
            </div>
          </Line>

          <Line i={4 + legs.length}>
            <p className="mono mt-5 border-t border-line pt-4 text-[9px] leading-relaxed text-dim">
              Live Core odds before the house spread. Build a slip to request a signed quote.
            </p>
          </Line>
        </div>
      </div>
    </div>
  );
}
