"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { barSummary } from "@/lib/slip-summary";
import type { BuilderLeg } from "@/lib/ticket";
import type { useTicket } from "./use-ticket";

const DRAG_PX = 40;

function Badge({ n, pulse }: { n: number; pulse: number }) {
  return <span key={pulse} className="badge-pulse inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-sans text-[10px] font-semibold leading-none text-on-accent">{n}</span>;
}
function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`h-4 w-4 ${up ? "rotate-180" : ""}`} aria-hidden="true">
      <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Phone-only bottom sheet around the Ticket. Collapsed: one bar with legs, multiplier, stake and
 * to-win. Expanded: the whole ticket, scrolling inside the sheet. Collapses on backdrop tap,
 * Escape, a downward swipe on the handle, and after a successful mint. Expands on a tap or an
 * upward swipe on the collapsed bar. */
export function SlipSheet({ legs, ticket, onClear, children }: { legs: BuilderLeg[]; ticket: ReturnType<typeof useTicket>; onClear: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const dragStart = useRef<number | null>(null);
  // Set when a pointerup ended a real swipe, so the bar's click (which fires right after) is ignored.
  const swiped = useRef(false);
  const drag = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => { dragStart.current = e.clientY; swiped.current = false; e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerCancel: () => { dragStart.current = null; },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (dragStart.current === null) return;
      const dy = e.clientY - dragStart.current;
      dragStart.current = null;
      if (Math.abs(dy) < DRAG_PX) return;
      swiped.current = true;
      setOpen(dy < 0);
    },
  };
  const summary = barSummary({ legs: legs.length, multiplier: ticket.multiplier, stakeUsdc: ticket.stakeBase, maxPayout: ticket.toWin });

  useEffect(() => { if (ticket.mintState === "done") setOpen(false); }, [ticket.mintState]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Badge pulse on every leg count change.
  const [pulse, setPulse] = useState(0);
  const prevCount = useRef(legs.length);
  useEffect(() => { if (legs.length !== prevCount.current) { prevCount.current = legs.length; setPulse((n) => n + 1); } }, [legs.length]);

  if (legs.length === 0 && !open) return null;

  return (
    <>
      {open && <button type="button" aria-label="Collapse slip" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-ink/60 lg:hidden" />}
      <section aria-label="Your slip" className="sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[85svh] flex-col rounded-t-[18px] border border-b-0 border-line bg-raised shadow-[0_-20px_60px_rgba(4,10,12,0.6)] lg:hidden">
        <div className="flex justify-center py-2.5 touch-none" {...drag}>
          <span className="h-1 w-10 rounded-full bg-line" aria-hidden />
        </div>
        {/* Stays mounted while collapsed so BridgeStep state survives. */}
        <div hidden={!open} className="min-h-0 overflow-y-auto px-4 pb-4">
            <div className="mb-3 flex h-8 items-center justify-between">
              <span className="mono inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-dim">Your slip <Badge n={legs.length} pulse={pulse} /></span>
              <span className="flex items-center gap-1">
                <button type="button" onClick={onClear} className="mono h-8 rounded-[6px] px-2 text-[11px] text-dim transition-colors hover:bg-panel hover:text-fg">Clear</button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Collapse slip" className="grid h-8 w-8 place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel hover:text-fg"><Chevron /></button>
              </span>
            </div>
            {children}
        </div>
        {/* touch-none: a swipe on the bar must reach pointerup here, not become a page scroll. */}
        {!open && (
          <button type="button" aria-expanded={false} {...drag} onClick={() => { if (!swiped.current) setOpen(true); }} className="flex min-h-14 w-full items-center justify-between gap-3 px-4 pb-4 pt-0.5 text-left touch-none">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="mono inline-flex items-center gap-2 text-[14px] leading-none text-fg">{summary.primary} <Badge n={legs.length} pulse={pulse} /></span>
              <span className="text-[11px] leading-none text-dim">{summary.secondary}</span>
            </span>
            {summary.right
              ? <span className="mono shrink-0 text-[15px] font-semibold text-accent">{summary.right}</span>
              : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-dim"><Chevron up /></span>}
          </button>
        )}
      </section>
    </>
  );
}
