"use client";

import { marketMid, sideLabel } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { usePrinting } from "@/lib/print";
import { pct1 } from "@/lib/format";
import { distinctByQuestion, useMarkets, type BoardSnapshot } from "@/lib/market-board";
import { CountUp } from "./live";
import { marketContext } from "./market-board";

type SlipLeg = { side: "YES" | "NO"; label: string; title: string; context: string; prob: number | null };

/* Worked example printed whenever the live feed cannot fully price a slip
   (registry down, fewer than two markets, or a leg without a mid). The hero
   must always show a complete combination; the header labels it as an
   example so it never reads as a live quote. */
const EXAMPLE_LEGS: SlipLeg[] = [
  { side: "YES", label: "Arsenal", title: "Arsenal", context: "Arsenal vs Chelsea - match winner", prob: 0.58 },
  { side: "YES", label: "Over", title: "Over 215.5 points", context: "Lakers vs Celtics", prob: 0.51 },
  { side: "NO", label: "No", title: "Straight sets", context: "Djokovic vs Alcaraz", prob: 0.62 },
];

function Line({ i, children }: { i: number; children: React.ReactNode }) {
  return (
    <div className="print-line" style={{ animationDelay: `${240 + i * 110}ms` }}>
      {children}
    </div>
  );
}

export function HeroSlip({ board }: { board: BoardSnapshot }) {
  const { state } = useMarkets(board.markets);
  const mids = useMids(board.mids);
  const printing = usePrinting();

  // Only priced markets qualify: a half-priced slip has no honest combined
  // implied, so an unpriced leg is skipped rather than assumed certain. One leg
  // per question: two sides of the same futures market can never both win.
  const liveLegs: SlipLeg[] = distinctByQuestion(state.status === "live" ? state.markets : [])
    .map((m) => ({
      side: "YES" as const,
      label: sideLabel(m, true),
      title: m.title,
      context: marketContext(m),
      prob: marketMid(mids, m, m.coinYes),
    }))
    .filter((l) => l.prob !== null)
    .slice(0, 3);
  const live = liveLegs.length >= 2;
  const legs = live ? liveLegs : EXAMPLE_LEGS;

  const combined = legs.reduce((acc, l) => acc * (l.prob as number), 1);
  const fair = 1 / combined;

  return (
    <div className="[perspective:1200px]">
      <div className={`slip-turn mx-auto w-full max-w-[390px] ${printing}`}>
        <div className="ticket-shell px-6 py-7 sm:px-7 sm:py-8">
          <Line i={0}>
            <div className="mono flex items-baseline justify-between text-[9px] uppercase tracking-[0.14em] text-dim">
              <span>{live ? "Live combo" : "Example combo"}</span>
              <span>{legs.length} legs</span>
            </div>
          </Line>

          <Line i={1}>
            <div className="my-4 h-px bg-line" />
          </Line>

          <ul className="flex flex-col gap-3">
            {legs.map((leg, i) => (
              <li key={i}>
                <Line i={2 + i}>
                  <div className="flex items-baseline justify-between gap-3 text-[12px]">
                    {/* The side label already names the outcome, so a leg whose
                        title is that same name shows its question instead. */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate leading-snug">{leg.title === leg.label ? leg.context : leg.title}</span>
                      {leg.title !== leg.label && (
                        <span className="mono block truncate text-[9px] uppercase tracking-[0.12em] text-dim">{leg.context}</span>
                      )}
                    </span>
                    <span className={`mono shrink-0 uppercase ${leg.side === "YES" ? "text-yes" : "text-no"}`}>
                      {leg.label} {leg.prob === null ? "-" : pct1(leg.prob)}
                    </span>
                  </div>
                </Line>
              </li>
            ))}
          </ul>

          <Line i={2 + legs.length}>
            <div className="my-4 h-px bg-line" />
          </Line>

          <Line i={3 + legs.length}>
            <div className="mt-3 flex items-end justify-between">
              <span className="mono text-[9px] uppercase tracking-[0.14em] text-dim">Multiplier</span>
              <CountUp value={fair} format={(x) => `${x.toFixed(2)}×`} className="mono text-[28px] leading-none text-accent" />
            </div>
          </Line>

          <Line i={4 + legs.length}>
            <p className="mono mt-5 border-t border-line pt-4 text-[9px] leading-relaxed text-dim">
              {live ? "Fair value" : "Illustrative fair value"} before fees. Open the app to request a signed quote.
            </p>
          </Line>
        </div>
      </div>
    </div>
  );
}
