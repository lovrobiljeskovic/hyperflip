import { shareCard } from "@/lib/og";
import { loadTicketCard, parseTicketId } from "@/lib/ticket-card";

export const runtime = "nodejs";

/** The ticket's share card at a stable URL: the page's og:image and its own <img>. A route handler
 * rather than opengraph-image.tsx because Next hashes that file's URL, which the page cannot know. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseTicketId((await params).id);
  const card = id === null ? null : await loadTicketCard(id);
  if (!card) return new Response("Not found", { status: 404 });
  const image = await shareCard(card);
  return new Response(image.body, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60, s-maxage=60" } });
}
