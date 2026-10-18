"use client";

import Link from "next/link";
import { appHref } from "@/lib/site";
import { compareKickoff, marketMid } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { pct1 } from "@/lib/format";
import { useMarkets, type BoardSnapshot } from "@/lib/market-board";
import { marketContext } from "./market-board";

/** The duplicate set is aria-hidden and exists only to make the CSS loop seamless. */
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

  const markets = [...state.markets].sort((a, b) => compareKickoff(a, b)).slice(0, 6);
  const items = markets.map((market) => ({
    vault: market.vault,
    title: market.title,
    context: marketContext(market),
    yes: marketMid(mids, market, market.coinYes),
    no: marketMid(mids, market, market.coinNo),
  }));

  const set = (hidden: boolean) => (
    <div className="flex shrink-0" aria-hidden={hidden || undefined}>
      {items.map((item) => (
        <Link
          key={item.vault}
          href={`${appHref()}?leg=${item.vault}`}
          prefetch={false}
          tabIndex={hidden ? -1 : undefined}
          className="flex min-w-[310px] items-center justify-between gap-8 border-r border-line px-5 py-3 transition-colors hover:bg-raised"
        >
          <span className="min-w-0 max-w-[190px]">
            <span className="block truncate text-xs">{item.title}</span>
            <span className="mono block truncate text-[9px] uppercase tracking-[0.12em] text-dim">{item.context}</span>
          </span>
          <span className="mono shrink-0 text-[11px]">
            <span className="text-yes">Y {item.yes === null ? "-" : pct1(item.yes)}</span>
            <span className="mx-2 text-line">/</span>
            <span className="text-no">N {item.no === null ? "-" : pct1(item.no)}</span>
          </span>
        </Link>
      ))}
    </div>
  );

  return (
    <div className="market-rail overflow-hidden border-y border-line bg-panel" aria-label="Live market prices">
      <div className="market-rail-track flex">{set(false)}{set(true)}</div>
    </div>
  );
}
