"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchMarketBoard, type Market } from "./writer";

/* One registry fetch shared by the hero slip, the stat line, and the board.
   ponytail: module-level promise cache, cleared on failure so a client-side
   revisit retries. */
let marketsCache: Promise<Market[]> | null = null;
function loadMarkets(): Promise<Market[]> {
  marketsCache ??= fetchMarketBoard().catch((e) => {
    marketsCache = null;
    throw e;
  });
  return marketsCache;
}

type MarketsState =
  | { status: "loading" }
  | { status: "offline" }
  | { status: "live"; markets: Market[] };

/* `initial` is the server-rendered board. A client-only fetch lands after the hero's print cascade
   ends, so the slip would print placeholder legs and then swap; seeding avoids that. The fetch below
   is the fallback for a writer unreachable at render time. */
export function useMarkets(initial: Market[] | null): { state: MarketsState; retry: () => void } {
  const [state, setState] = useState<MarketsState>(
    initial ? { status: "live", markets: initial } : { status: "loading" },
  );
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

export interface BoardSnapshot {
  markets: Market[] | null;
  mids: Record<string, string>;
}

/** First market per question (`groupTitle`, else its own vault), in input order. */
export function distinctByQuestion(markets: Market[]): Market[] {
  const seen = new Set<string>();
  return markets.filter((m) => {
    const g = m.groupTitle ?? m.vault;
    if (seen.has(g)) return false;
    seen.add(g);
    return true;
  });
}
