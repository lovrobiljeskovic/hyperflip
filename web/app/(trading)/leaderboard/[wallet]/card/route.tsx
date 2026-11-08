import { shareCard } from "@/lib/og";
import { loadRecordCard, parseWallet } from "@/lib/record-card";

export const runtime = "nodejs";

/** The wallet's record card at a stable URL (see t/[id]/card for why not opengraph-image.tsx). */
export async function GET(_request: Request, { params }: { params: Promise<{ wallet: string }> }) {
  const wallet = parseWallet((await params).wallet);
  const found = wallet && await loadRecordCard(wallet);
  if (!found) return new Response("Not found", { status: 404 });
  const image = await shareCard(found.card);
  return new Response(image.body, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60, s-maxage=60" } });
}
