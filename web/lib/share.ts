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
