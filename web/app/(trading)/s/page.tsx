import type { Metadata } from "next";
import { appChain } from "@/lib/chain";
import { appCanonical, appPageMetadata } from "@/lib/site";
import { BuildPage } from "../build/build-page";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** Where a shared slip link lands. The browser URL stays /build?leg=… (or /?leg=… on the app host):
 * next.config rewrites those here when `leg` is present, so /build itself stays a static page and
 * only shared links pay for a server render. The card is drawn by /build/card from the same query. */
export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const legs = [(await searchParams).leg ?? []].flat();
  if (legs.length === 0) return {};
  const params = new URLSearchParams();
  for (const leg of legs) params.append("leg", leg);
  const query = `?${params}`;
  const base = appPageMetadata(`A slip on ${appChain.name}`, "Open it in the builder and mint your own.", `/build${query}`);
  // Absolute on purpose: a metadataBase with a path (local /build) would otherwise prefix it.
  const image = { url: appCanonical(`/build/card${query}`), width: 1200, height: 630, alt: `A slip on ${appChain.name}` };
  return { ...base, openGraph: { ...base.openGraph, images: [image] }, twitter: { ...base.twitter, images: [image] } };
}

export default function Page() {
  return <BuildPage />;
}
