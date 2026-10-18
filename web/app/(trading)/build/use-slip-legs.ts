"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BuilderLeg } from "@/lib/ticket";
import type { Market } from "@/lib/writer";
import { legFor, loadSlip, restorableBoard, restoreLegs, saveSlip } from "@/lib/slip-storage";

/** The slip's legs, persisted per chain. `onBoard` must run on every board load: the first one
 * restores the saved slip, and each one applies a `?leg=` hand-off. */
export function useSlipLegs() {
  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const restored = useRef(false);
  useEffect(() => { if (restored.current) saveSlip(legs); }, [legs]);

  const onBoard = useCallback((board: Market[]) => {
    if (!restored.current) {
      restored.current = true;
      const saved = restoreLegs(loadSlip(), restorableBoard(board));
      if (saved.length) setLegs((prev) => (prev.length ? prev : saved));
    }
    // Landing-page rail hands off a market as ?leg=<vault>; pick its YES side.
    const picked = new URLSearchParams(window.location.search).get("leg")?.toLowerCase();
    const market = picked && board.find((m) => m.vault.toLowerCase() === picked);
    // Not addLeg: that toggles, and StrictMode runs this effect twice in dev.
    if (market) setLegs((prev) => (prev.some((l) => l.vault === market.vault) ? prev : [...prev, legFor(market, true)]));
  }, []);

  function addLeg(market: Market, isYes: boolean) {
    setLegs((prev) => {
      // One leg per question: the writer refuses two (`same-game`), so a second
      // outcome from the same group replaces the first instead of stacking.
      const rest = prev.filter((l) => l.vault !== market.vault && !(market.group && l.group === market.group));
      if (prev.some((l) => l.vault === market.vault && l.isYes === isYes)) return rest;
      return [...rest, legFor(market, isYes)];
    });
  }

  function removeLeg(vault: `0x${string}`) {
    setLegs((prev) => prev.filter((l) => l.vault !== vault));
  }

  const clearLegs = () => setLegs([]);

  return { legs, onBoard, addLeg, removeLeg, clearLegs };
}
