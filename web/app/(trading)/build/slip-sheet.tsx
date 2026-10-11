"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { barSummary } from "@/lib/slip-summary";
import type { BuilderLeg } from "@/lib/ticket";
import type { useTicket } from "./use-ticket";

const DRAG_PX = 40;

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
        <div className="flex justify-center py-2 touch-none" {...drag}>
          <span className="h-1 w-10 rounded-full bg-line" aria-hidden />
        </div>
        {/* Stays mounted while collapsed so BridgeStep state survives. */}
        <div hidden={!open} className="min-h-0 overflow-y-auto px-4 pb-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Your slip <span key={pulse} className="badge-pulse ml-1 inline-grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] text-on-accent">{legs.length}</span></span>
              <span className="flex items-center gap-3">
                <button type="button" onClick={onClear} className="mono text-[11px] text-dim hover:text-fg">Clear</button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Collapse slip" className="text-dim">⌄</button>
              </span>
            </div>
            {children}
        </div>
        {/* touch-none: a swipe on the bar must reach pointerup here, not become a page scroll. */}
        {!open && (
          <button type="button" aria-expanded={false} {...drag} onClick={() => { if (!swiped.current) setOpen(true); }} className="flex w-full items-center justify-between gap-3 px-4 pb-4 pt-1 text-left touch-none">
            <span className="flex flex-col">
              <span className="mono text-[14px] text-fg">{summary.primary} <span key={pulse} className="badge-pulse ml-1 inline-grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] text-on-accent">{legs.length}</span></span>
              <span className="text-[11px] text-dim">{summary.secondary}</span>
            </span>
            <span className="mono text-[15px] font-semibold text-accent">{summary.right ?? "⌃"}</span>
          </button>
        )}
      </section>
    </>
  );
}
