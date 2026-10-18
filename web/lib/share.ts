const HYPERFLIP_X = "@hyperflip_xyz";

export function slipShareText(legCount: number): string {
  return `Just minted a ${legCount}-leg slip on ${HYPERFLIP_X}`;
}

export function xIntentUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params}`;
}
