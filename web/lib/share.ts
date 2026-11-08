import { formatUsdc } from "./format";
import type { TicketState } from "./share-card";

const HYPERFLIP_X = "@hyperflip_xyz";
/** The X logo as a 24×24 path, shared by every share button. */
export const X_ICON_PATH = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

export function slipShareText(legCount: number): string {
  return `Just minted a ${legCount}-leg slip on ${HYPERFLIP_X}`;
}

export function xIntentUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params}`;
}

/** A link that rebuilds this slip in the builder: one `leg` param per leg, `:n` marks the NO
 * side. Only the vault and side travel; the board on the other end supplies titles and prices,
 * and legs whose market has rotated off are dropped silently. */
export function slipUrl(origin: string, legs: { vault: string; isYes: boolean }[]): string {
  const params = new URLSearchParams();
  for (const l of legs) params.append("leg", l.isYes ? l.vault : `${l.vault}:n`);
  return `${origin}/build?${params}`;
}

export function ticketShareText(state: TicketState, legCount: number, wonAmount?: bigint): string {
  const slip = `${legCount}-leg slip`;
  if (state === "won") return `Hit a ${slip} for +${formatUsdc(wonAmount ?? 0n)} USDC on ${HYPERFLIP_X}`;
  if (state === "lost") return `Lost a ${slip} on ${HYPERFLIP_X}`;
  if (state === "void") return `${slip} voided on ${HYPERFLIP_X}`;
  return `Riding a ${slip} on ${HYPERFLIP_X}`;
}

/** A short per-share token. X caches its verdict on a page URL for days, so a link that failed
 * its first crawl (cold card) stays blank; a fresh token per share makes every post a fresh crawl.
 * Seconds in base 36: unique per click in practice, opaque, short. */
export const shareToken = (nowMs = Date.now()): string => Math.floor(nowMs / 1000).toString(36);

/** The ticket's page; `v` keys the card (and its cache) by state, `s` keeps X's crawl fresh. */
export const ticketUrl = (origin: string, id: bigint, state: TicketState, token?: string): string =>
  `${origin}/t/${id}?v=${state}${token ? `&s=${token}` : ""}`;

/** The ticket card as the page advertises it (og:image), so a warm-up fetch and X hit one cache key. */
export const ticketCardUrl = (origin: string, id: bigint, state: TicketState): string => `${origin}/t/${id}/card?v=${state}`;

/** Fire-and-forget fetch of a card before the composer opens: the first render is a cold start
 * (~3 s) that X's crawler may not wait for; warming it leaves the PNG in the CDN cache. */
export function warmCard(url: string): void {
  try { void fetch(url, { mode: "no-cors" }).catch(() => {}); } catch { /* no fetch (SSR) */ }
}
