import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { appChain } from "@/lib/chain";
import { appCanonical, appHref, appPageMetadata } from "@/lib/site";
import { parseTicketId } from "@/lib/ticket-card";

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const base = appPageMetadata(`Slip #${id}`, `A slip on ${appChain.name}.`, `/t/${id}`);
  // Absolute on purpose: a metadataBase with a path (local /build) would otherwise prefix it.
  const image = { url: appCanonical(`/t/${id}/card`), width: 1200, height: 630, alt: `Slip #${id}` };
  return { ...base, openGraph: { ...base.openGraph, images: [image] }, twitter: { ...base.twitter, images: [image] } };
}

/** The link exists for its preview card (card/route.tsx beside this file). The page itself must
 * answer 200 with HTML, not redirect: crawlers follow redirects and would read the target's tags
 * instead. So it shows the same card and points at the app. */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (parseTicketId(id) === null) notFound();
  return (
    <main className="mx-auto flex min-h-screen max-w-[640px] flex-col items-center gap-6 px-4 py-10 text-[13px] text-fg">
      <img src={`/t/${id}/card`} alt={`Slip #${id}`} width={1200} height={630} className="w-full rounded-card border border-line" />
      <div className="mono flex gap-4 text-[11px] uppercase tracking-[0.1em]">
        <Link href={appHref()} className="text-accent underline underline-offset-4">Build your own</Link>
        <Link href="/positions" className="text-dim underline underline-offset-4 hover:text-fg">Your positions</Link>
      </div>
    </main>
  );
}
