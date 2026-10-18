"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { compareKickoff, fetchMarketBoard, liveMarkets, sportLabel, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";

/** Loads the market board and holds its sport tab and kickoff sort. `onBoard` must be stable. */
export function useBoard(onBoard: (board: Market[]) => void) {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState("all");
  const [soonestFirst, setSoonestFirst] = useState(true);
  const mids = useMids();

  const load = useCallback(async () => {
    setError(false);
    setMarkets(null);
    try {
      const board = await fetchMarketBoard();
      setMarkets(board);
      onBoard(board);
    } catch {
      setError(true);
    }
  }, [onBoard]);

  const live = useMemo(
    () => liveMarkets(markets ?? [], mids),
    [markets, mids],
  );
  const tabs = useMemo(() => ["all", ...new Set(live.map(sportLabel))], [live]);
  const board = useMemo(() => {
    // Games past kickoff stay: the writer quotes in-play until expiry.
    return live.filter((m) => tab === "all" || sportLabel(m) === tab).sort((a, b) => compareKickoff(a, b, soonestFirst));
  }, [live, tab, soonestFirst]);

  useEffect(() => {
    void load();
  }, [load]);

  return { markets, error, load, mids, live, tabs, board, tab, setTab, soonestFirst, setSoonestFirst };
}
