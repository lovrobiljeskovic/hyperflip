"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronUpIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { barSummary } from "@/lib/slip-summary";
import type { BuilderLeg } from "@/lib/ticket";
import type { useTicket } from "./use-ticket";

const SWIPE_PX = 40;

export function SlipSheet({ legs, ticket, onClear, children }: { legs: BuilderLeg[]; ticket: ReturnType<typeof useTicket>; onClear: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const summary = barSummary({ legs: legs.length, multiplier: ticket.multiplier, stakeUsdc: ticket.stakeBase, maxPayout: ticket.toWin });

  useEffect(() => { if (ticket.mintState === "done") setOpen(false); }, [ticket.mintState]);

  const swipeStart = useRef<number | null>(null);
  const swiped = useRef(false);
  const swipe = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => { swipeStart.current = e.clientY; swiped.current = false; e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerCancel: () => { swipeStart.current = null; },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (swipeStart.current === null) return;
      const dy = e.clientY - swipeStart.current;
      swipeStart.current = null;
      if (dy > -SWIPE_PX) return;
      swiped.current = true;
      setOpen(true);
    },
  };

  const [pulse, setPulse] = useState(0);
  const prevCount = useRef(legs.length);
  useEffect(() => { if (legs.length !== prevCount.current) { prevCount.current = legs.length; setPulse((n) => n + 1); } }, [legs.length]);
  const badge = <span key={pulse} className="badge-pulse inline-flex h-4 w-fit min-w-4 shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent bg-primary px-1 py-0.5 font-sans text-[10px] font-semibold whitespace-nowrap text-primary-foreground transition-all">{legs.length}</span>;

  return (
    <>
      {legs.length > 0 && !open && (
        <div className="sheet fixed inset-x-0 bottom-0 z-40 rounded-t-[18px] border border-b-0 border-line bg-raised shadow-[0_-20px_60px_rgba(4,10,12,0.6)] lg:hidden">
          <div className="flex justify-center py-2.5" aria-hidden><span className="h-1 w-10 rounded-full bg-line" /></div>
          <button
            type="button"
            aria-expanded={false}
            {...swipe}
            onClick={() => { if (!swiped.current) setOpen(true); }}
            className="flex min-h-14 w-full touch-none items-center justify-between gap-3 px-4 pb-4 pt-0.5 text-left"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="mono inline-flex items-center gap-2 text-[14px] leading-none text-fg">{summary.primary} {badge}</span>
              <span className="text-[11px] leading-none text-dim">{summary.secondary}</span>
            </span>
            {summary.right
              ? <span className="mono shrink-0 text-[15px] font-semibold text-accent">{summary.right}</span>
              : <ChevronUpIcon className="size-5 shrink-0 text-dim" aria-hidden />}
          </button>
        </div>
      )}
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="max-h-[88svh] border-line bg-raised pb-[env(safe-area-inset-bottom)] lg:hidden">
          <div className="flex h-10 items-center justify-between px-4">
            <DrawerTitle className="mono inline-flex items-center gap-2 text-[10px] font-normal uppercase tracking-[0.16em] text-dim">Your slip {badge}</DrawerTitle>
            <DrawerDescription className="sr-only">Your picked legs, stake and the mint button.</DrawerDescription>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={onClear} className="mono text-[11px] text-dim">Clear</Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Collapse slip" className="text-dim"><XIcon /></Button>
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto px-4 pb-4">{children}</div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
