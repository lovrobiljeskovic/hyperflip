"use client";

import { useSyncExternalStore } from "react";

export type OddsFormat = "x" | "decimal" | "american" | "probability";
export const ODDS_FORMATS: readonly OddsFormat[] = ["x", "decimal", "american", "probability"];
export const ODDS_FORMAT_LABEL: Record<OddsFormat, string> = { x: "1.5x", decimal: "1.50", american: "+150", probability: "%" };
const KEY = "hf:odds-format";
const DEFAULT: OddsFormat = "x";

export function formatOdds(mid: number | null, format: OddsFormat): string {
  if (mid === null || !(mid > 0 && mid < 1)) return "—";
  switch (format) {
    case "x": return `${(1 / mid).toFixed(2)}x`;
    case "decimal": return (1 / mid).toFixed(2);
    case "probability": return `${Math.round(mid * 100)}%`;
    case "american": {
      // Underdog (p < .5): profit per 100 staked. Favourite: stake per 100 profit. 0.5 is +100 by convention.
      return mid <= 0.5 ? `+${Math.round((1 / mid - 1) * 100)}` : `-${Math.round((mid / (1 - mid)) * 100)}`;
    }
  }
}

const isFormat = (v: unknown): v is OddsFormat => ODDS_FORMATS.includes(v as OddsFormat);

// Module-level mirror so a blocked localStorage still keeps the choice for the session.
let current: OddsFormat | null = null;
const listeners = new Set<() => void>();

export function readOddsFormat(): OddsFormat {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    // Storage is the source of truth when readable; an unknown value is the default, not the last choice.
    if (raw !== null) return isFormat(raw) ? (current = raw) : DEFAULT;
    return current ?? DEFAULT;
  } catch { return current ?? DEFAULT; }
}

export function setOddsFormat(f: OddsFormat): void {
  current = f;
  try { localStorage.setItem(KEY, f); } catch { /* storage blocked; the in-memory value still applies */ }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** The viewer's odds format; `x` on the server and before hydration. */
export function useOddsFormat(): OddsFormat {
  return useSyncExternalStore(subscribe, readOddsFormat, () => DEFAULT);
}
