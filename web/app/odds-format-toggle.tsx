"use client";

import { ODDS_FORMAT_LABEL, ODDS_FORMATS, setOddsFormat, useOddsFormat } from "@/lib/odds-format";

/** Segmented control. Lives in the hamburger on the phone and at the right of the market filters on desktop. */
export function OddsFormatToggle({ className = "" }: { className?: string }) {
  const format = useOddsFormat();
  return (
    <div role="group" aria-label="Odds format" className={`mono inline-flex overflow-hidden rounded-[6px] border border-line text-[11px] ${className}`}>
      {ODDS_FORMATS.map((f) => (
        <button
          key={f}
          type="button"
          aria-pressed={format === f}
          onClick={() => setOddsFormat(f)}
          className={`px-2.5 py-1 transition-colors ${format === f ? "bg-raised text-fg" : "text-dim hover:text-fg"}`}
        >
          {ODDS_FORMAT_LABEL[f]}
        </button>
      ))}
    </div>
  );
}
