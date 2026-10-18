"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { appHref } from "@/lib/site";
import { compareKickoff, liveMarkets, marketMid, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { pct1 } from "@/lib/format";
import { formatOdds, useOddsFormat } from "@/lib/odds-format";
import { distinctByQuestion, useMarkets, type BoardSnapshot } from "@/lib/market-board";
import { Kickoff } from "./live";

/* Odds cell that nudges on a mid change while the semantic YES/NO text color
   carries direction. */
function OddsCell({ side, mid }: { side: "YES" | "NO"; mid: number | null }) {
  const format = useOddsFormat();
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
        {formatOdds(mid, format)}
      </span>
      <span className="ml-2 text-[10px] text-dim">
        {mid === null ? "-" : pct1(mid)}
      </span>
    </div>
  );
}

export function marketContext(m: Market): string {
  return m.groupTitle && m.groupTitle !== m.title
    ? m.groupTitle
    : [m.sport ?? m.category, m.cluster].filter(Boolean).join(" · ");
}

function BoardRow({ market, mids }: { market: Market; mids: Record<string, string> }) {
  const yes = marketMid(mids, market, market.coinYes);
  const no = marketMid(mids, market, market.coinNo);
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
      className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-5 py-[15px] sm:grid-cols-[1fr_110px_110px_150px] ${lead}`}
    >
      <div className="col-span-2 sm:col-span-1">
        <p className="text-[12px] leading-snug">{market.title}</p>
        <p className="mono mt-1 text-[10px] uppercase tracking-[0.14em] text-dim">{marketContext(market)}</p>
      </div>
      <OddsCell side="YES" mid={yes} />
      <OddsCell side="NO" mid={no} />
      <div className="col-span-2 flex justify-end sm:col-span-1">
        <Kickoff market={market} />
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

const BOARD_ROWS = 5;

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

  const pricedAll = liveMarkets(state.markets, mids)
    .sort((a, b) => compareKickoff(a, b));
  // One row per question first (five different games beats five sides of one
  // futures market), then fill from the rest if the registry is narrow.
  const distinct = distinctByQuestion(pricedAll);
  const priced = [...distinct, ...pricedAll.filter((m) => !distinct.includes(m))].slice(0, BOARD_ROWS);

  if (priced.length === 0) {
    return (
      <Slab>
        <p className="mono px-5 py-10 text-center text-xs uppercase tracking-wide text-dim">
          {state.markets.length === 0 ? "No markets listed yet" : "No priced markets yet"}
        </p>
      </Slab>
    );
  }

  return (
    <Slab>
      <div className="mono hidden grid-cols-[1fr_110px_110px_150px] gap-x-4 border-b border-line px-5 py-3 text-[9px] uppercase tracking-[0.14em] text-dim sm:grid">
        <span>Market</span>
        <span className="text-right">Yes</span>
        <span className="text-right">No</span>
        <span className="text-right">Kickoff</span>
      </div>
      <div className="flex flex-col divide-y divide-line">
        {priced.map((m) => (
          <BoardRow key={m.vault} market={m} mids={mids} />
        ))}
      </div>
      {pricedAll.length > priced.length && (
        <Link
          href={appHref()}
          prefetch={false}
          className="mono block border-t border-line px-5 py-3 text-center text-[10px] uppercase tracking-[0.14em] text-dim transition-colors hover:bg-raised hover:text-fg"
        >
          See all {pricedAll.length} markets
        </Link>
      )}
    </Slab>
  );
}
