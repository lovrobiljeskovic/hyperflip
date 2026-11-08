import { appChain } from "@/lib/chain";
import { ogCard, shareCard } from "@/lib/og";
import { appHost } from "@/lib/site";
import { loadSlipCard } from "@/lib/slip-card";

export const runtime = "nodejs";

/** The slip card for a `/build?leg=…` link; with no resolvable leg, the static build card. */
export async function GET(request: Request) {
  const card = await loadSlipCard(new URL(request.url).search);
  const image = card ? await shareCard(card) : await ogCard(`Build a slip on ${appChain.name}.`, `Combos on HIP-4 markets · ${appHost}`);
  return new Response(image.body, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300, s-maxage=300" } });
}
