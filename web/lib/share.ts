import { formatUsdc, multiplier } from "./format";
import type { SlipLeg } from "./slip";

export const HYPERFLIP_X = "@hyperflip_xyz";

/** Post text for a minted slip: legs, stake, payout. The site link travels in
 * the intent's `url` param so X renders it as a card, not inline. */
export function slipShareText(legs: Pick<SlipLeg, "isYes" | "title" | "label">[], premium: bigint, maxPayout: bigint): string {
  const lines = legs.map((l) => `✅ ${l.label ?? (l.isYes ? "YES" : "NO")} · ${l.title}`);
  return [
    `Just minted a ${legs.length}-leg slip on ${HYPERFLIP_X}`,
    "",
    ...lines,
    "",
    `${formatUsdc(premium)} USDC to win ${formatUsdc(maxPayout)} USDC (${multiplier(premium, maxPayout)})`,
  ].join("\n");
}

export function xIntentUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params}`;
}
