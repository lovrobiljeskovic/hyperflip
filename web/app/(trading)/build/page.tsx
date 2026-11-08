import type { Metadata } from "next";
import { appChain } from "@/lib/chain";
import { appCanonical, appPageMetadata } from "@/lib/site";
import { BuildPage } from "./build-page";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** A shared slip link (?leg=…) gets the slip card as its preview; a bare /build keeps the layout's
 * metadata. The card is drawn by ./card/route.tsx from the same query. */
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
