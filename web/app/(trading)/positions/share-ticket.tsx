"use client";

import type { Row } from "@/lib/positions";
import { shareableTicket, ticketState } from "@/lib/share-card";
import { ticketShareText, ticketUrl, X_ICON_PATH, xIntentUrl } from "@/lib/share";

/** Opens the X composer with the ticket's page link; that page's preview is the card. Rows render
 * client-side only (they come from wallet reads), so `location` is available. */
export function ShareTicket({ row, view, className = "" }: { row: Row; view: { statusLabel: string }; className?: string }) {
  if (!shareableTicket(view)) return null;
  const state = ticketState(view);
  const { premium, maxPayout, legs } = row.parlay;
  const href = xIntentUrl(ticketShareText(state, legs.length, maxPayout - premium), ticketUrl(location.origin, row.id, state));
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Share slip #${row.id} on X`}
      className={`mono inline-flex items-center justify-center gap-1.5 rounded-[4px] border border-line text-[11px] uppercase tracking-[0.1em] text-dim transition-colors hover:border-dim hover:text-fg ${className}`}>
      <svg viewBox="0 0 24 24" className="size-3 fill-current" aria-hidden><path d={X_ICON_PATH} /></svg>
      Share
    </a>
  );
}
