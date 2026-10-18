"use client";

import type { ReactNode } from "react";
import { marketMid, sideLabel, sportLabel, type Market } from "@/lib/writer";
import { tradeUrl } from "@/lib/chain";
import { formatOdds, useOddsFormat } from "@/lib/odds-format";
import type { BuilderLeg } from "@/lib/ticket";
import { Kickoff } from "@/app/live";

function PriceCell({ mid, side, tone, selected, label, onPick }: { mid: number | null; side: string; tone: "yes" | "no"; selected: boolean; label: string; onPick: () => void }) {
  const format = useOddsFormat();
  return (
    <button type="button" onClick={onPick} disabled={mid === null} aria-pressed={selected} aria-label={label}
      className={`flex min-w-0 flex-col items-center gap-0.5 rounded-[8px] border px-2 py-2 transition-[transform,background-color,border-color] active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${
        selected ? "border-accent bg-accent" : "border-line bg-panel hover:border-dim"}`}>
      <span title={side} className={`w-full truncate text-center text-[11px] ${selected ? "text-on-accent/70" : "text-dim"}`}>{side}</span>
      <span className={`mono text-[14px] font-medium ${selected ? "text-on-accent" : tone === "yes" ? "text-yes" : "text-no"}`}>{formatOdds(mid, format)}</span>
    </button>
  );
}

/** American football: Tabler's `ball-american-football` (MIT), inlined; the lucide set has none. */
function SportBadge({ market }: { market: Pick<Market, "sport" | "category"> }) {
  if (sportLabel(market) === "Football") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-dim">
        <path d="M15 9l-6 6M10 12l2 2M12 10l2 2M8 21a5 5 0 0 0-5-5M16 3c-7.18 0-13 5.82-13 13a5 5 0 0 0 5 5c7.18 0 13-5.82 13-13a5 5 0 0 0-5-5M16 3a5 5 0 0 0 5 5" />
      </svg>
    );
  }
  return (
    <span aria-hidden="true" className="mono flex h-5 w-5 items-center justify-center rounded-full border border-line text-[8px] uppercase text-dim">
      {(market.sport ?? "?").slice(0, 2)}
    </span>
  );
}

export function BoardRow({
  market,
  mids,
  legs,
  onPick,
}: {
  market: Market;
  mids: Record<string, string>;
  legs: BuilderLeg[];
  onPick: (market: Market, isYes: boolean) => void;
}) {
  const current = legs.find((l) => l.vault === market.vault);
  // aria-label overrides the button's text, so the price has to be spoken here
  // or a screen reader never hears it - the price IS the control.
  const yes = marketMid(mids, market, market.coinYes);
  const no = marketMid(mids, market, market.coinNo);
  const cells = (
    <>
      <PriceCell
        mid={yes}
        side={sideLabel(market, true)}
        tone="yes"
        selected={current?.isYes === true}
        label={`Take ${sideLabel(market, true)} on ${market.title} at ${yes === null ? "no price" : formatOdds(yes, "probability")}`}
        onPick={() => onPick(market, true)}
      />
      <PriceCell
        mid={no}
        side={sideLabel(market, false)}
        tone="no"
        selected={current?.isYes === false}
        label={`Take ${sideLabel(market, false)} on ${market.title} at ${no === null ? "no price" : formatOdds(no, "probability")}`}
        onPick={() => onPick(market, false)}
      />
    </>
  );
  return (
    <div className={`flex flex-col rounded-[12px] border border-line p-4 ${current ? "bg-accent/[0.07]" : "bg-panel/30"}`}>
      {/* Kickoff on its own line: beside the title it ate half the card. */}
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0">
          <SportBadge market={market} />
        </span>
        <p className="min-w-0 truncate text-[13px]">
          <MarketLink coin={market.coinYes}>{market.title}</MarketLink>
        </p>
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <p className="mono min-w-0 truncate text-[10px] uppercase tracking-[0.14em] text-dim">{market.cluster}</p>
        <span className="shrink-0"><Kickoff market={market} /></span>
      </div>
      <div className="mt-auto grid grid-cols-2 gap-2 pt-3">{cells}</div>
    </div>
  );
}

function MarketLink({ coin, children }: { coin: string; children: ReactNode }) {
  return (
    <a
      href={tradeUrl(coin)}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-line underline-offset-4 transition-colors hover:decoration-dim"
    >
      {children}
    </a>
  );
}

/** One HIP-4 question: one card, a button per outcome, YES side only (a grouped NO is the sum of the
 * others). The writer refuses two legs from one question (`same-game`), so a second pick swaps the first. */
export function GroupRow({
  title,
  members,
  mids,
  legs,
  onPick,
}: {
  title: string;
  members: Market[];
  mids: Record<string, string>;
  legs: BuilderLeg[];
  onPick: (market: Market, isYes: boolean) => void;
}) {
  const current = legs.find((l) => members.some((m) => m.vault === l.vault));
  const head = members[0];
  const priced = members
    .map((m) => ({ m, mid: marketMid(mids, m, m.coinYes) }))
    .sort((a, b) => (b.mid ?? -1) - (a.mid ?? -1));
  return (
    <div className={`flex flex-col rounded-[12px] border border-line p-4 ${current ? "bg-accent/[0.07]" : "bg-panel/30"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0">
            <SportBadge market={head} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px]">
              <MarketLink coin={head.coinYes}>{title}</MarketLink>
            </p>
            <p className="mono mt-0.5 truncate text-[10px] uppercase tracking-[0.14em] text-dim">{head.cluster}</p>
          </div>
        </div>
        <span className="shrink-0">
          <Kickoff market={head} />
        </span>
      </div>
      <div className={`mt-auto grid gap-2 pt-3 ${priced.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {priced.map(({ m, mid }) => (
          <PriceCell
            key={m.vault}
            mid={mid}
            side={m.title}
            tone="yes"
            selected={current?.vault === m.vault}
            label={`Take ${m.title} in ${title} at ${mid === null ? "no price" : formatOdds(mid, "probability")}`}
            onPick={() => onPick(m, true)}
          />
        ))}
      </div>
    </div>
  );
}

export function LoadingSkeleton() {
  return (
    <div className="border border-line">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-11 animate-pulse motion-reduce:animate-none border-t border-line bg-panel first:border-t-0" />
      ))}
    </div>
  );
}
