import { formatUsdc } from "./format";
import type { TicketState } from "./share-card";

const HYPERFLIP_X = "@hyperflip_xyz";

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

/** The ticket's page; `v` makes X refetch the preview when the state changes. */
export const ticketUrl = (origin: string, id: bigint, state: TicketState): string => `${origin}/t/${id}?v=${state}`;
