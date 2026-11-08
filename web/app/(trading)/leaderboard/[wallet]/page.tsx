import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Board } from "../board";
import { appChain } from "@/lib/chain";
import { CARD_SIZE } from "@/lib/og";
import { loadRecordCard, parseWallet } from "@/lib/record-card";
import { appCanonical, appPageMetadata } from "@/lib/site";

export const revalidate = 60;

/** The board with this wallet highlighted; the link preview is the wallet's record card. */
export async function generateMetadata({ params }: { params: Promise<{ wallet: string }> }): Promise<Metadata> {
  const wallet = parseWallet((await params).wallet);
  const found = wallet && await loadRecordCard(wallet);
  if (!found) return {};
  const { wins, losses, rank } = found.entry;
  const base = appPageMetadata("Leaderboard", `${wins}-${losses}, #${rank} on ${appChain.name}.`, `/leaderboard/${wallet}`);
  // Absolute on purpose: a metadataBase with a path (local /build) would otherwise prefix it.
  // The record rides on the card URL so X refetches the picture when it changes (it keys previews by image URL).
  const image = { url: appCanonical(`/leaderboard/${wallet}/card?v=${wins}-${losses}`), ...CARD_SIZE, alt: `${wins}-${losses} on ${appChain.name}` };
  return { ...base, openGraph: { ...base.openGraph, images: [image] }, twitter: { ...base.twitter, images: [image] } };
}

export default async function WalletPage({ params }: { params: Promise<{ wallet: string }> }) {
  const wallet = parseWallet((await params).wallet);
  if (!wallet) notFound();
  return <Board highlight={wallet} />;
}
