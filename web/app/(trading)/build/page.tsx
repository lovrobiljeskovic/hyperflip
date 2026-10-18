"use client";

import { useRef } from "react";
import { groupMarkets } from "@/lib/writer";
import { OddsFormatToggle } from "@/app/odds-format-toggle";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsDesktop } from "@/lib/media";
import { Ticket } from "./ticket";
import { useTicket } from "./use-ticket";
import { SlipSheet } from "./slip-sheet";
import { MintedSlipDialog } from "./minted-slip";
import { BoardRow, GroupRow, LoadingSkeleton } from "./board-cards";
import { useBoard } from "./use-board";
import { useSlipLegs } from "./use-slip-legs";
import { useStickyFit } from "./use-sticky-fit";

export default function BuildPage() {
  const { legs, onBoard, addLeg, removeLeg, clearLegs } = useSlipLegs();
  const ticket = useTicket(legs);
  const isDesktop = useIsDesktop();
  const slipRef = useRef<HTMLElement>(null);
  useStickyFit(slipRef, isDesktop);
  const { markets, error, load, mids, live, tabs, board, tab, setTab, soonestFirst, setSoonestFirst } = useBoard(onBoard);

  return (
    <div className="min-h-screen text-[13px] text-fg">

      <main className="mx-auto grid max-w-[1280px] gap-8 px-4 py-8 pb-28 sm:px-6 sm:pt-10 lg:grid-cols-[1fr_400px] lg:gap-0 lg:pb-10">
        <section className="lg:border-r lg:border-line lg:pr-8">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">Build a slip</h1>
            <Button variant="ghost" size="sm" onClick={() => setSoonestFirst((v) => !v)} aria-label={`Sort by kickoff, ${soonestFirst ? "soonest" : "latest"} first`}
              className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Kickoff {soonestFirst ? "↑" : "↓"}</Button>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            {tabs.length > 2 ? (
              <ToggleGroup type="single" size="sm" variant="outline" value={tab} onValueChange={(v) => { if (v) setTab(v); }} aria-label="Sport" className="flex-wrap">
                {tabs.map((t) => (
                  <ToggleGroupItem key={t} value={t} className="mono h-7 border-line px-3 text-[10px] uppercase tracking-[0.16em] text-dim data-[state=on]:border-accent data-[state=on]:bg-accent/10 data-[state=on]:text-fg">
                    {t}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : <span />}
            <OddsFormatToggle className="hidden lg:inline-flex" />
          </div>

          <div className="mt-4">
            {error ? (
              <div className="flex flex-col items-start gap-3 rounded-card border border-line bg-panel p-6">
                <p className="text-no">Writer unreachable.</p>
                <Button variant="outline" onClick={() => void load()} className="border-line">Retry</Button>
              </div>
            ) : markets === null ? (
              <LoadingSkeleton />
            ) : live.length === 0 ? (
              <p className="rounded-card border border-line bg-panel p-6 text-dim">No quotable markets right now.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {groupMarkets(board).map((entry) =>
                  entry.kind === "market"
                    ? <BoardRow key={entry.market.vault} market={entry.market} mids={mids} legs={legs} onPick={addLeg} />
                    : <GroupRow key={entry.group} title={entry.title} members={entry.members} mids={mids} legs={legs} onPick={addLeg} />,
                )}
              </div>
            )}
          </div>
        </section>

        {isDesktop ? (
          <aside ref={slipRef} id="slip" className="scroll-mt-20 lg:sticky lg:top-24 lg:self-start lg:pl-8">
            <Ticket legs={legs} onRemove={removeLeg} ticket={ticket} />
          </aside>
        ) : (
          <SlipSheet legs={legs} ticket={ticket} onClear={clearLegs}>
            <Ticket legs={legs} onRemove={removeLeg} ticket={ticket} compact />
          </SlipSheet>
        )}
      </main>

      <MintedSlipDialog slip={ticket.minted} onClose={() => { ticket.dismissMinted(); clearLegs(); }} />
    </div>
  );
}
