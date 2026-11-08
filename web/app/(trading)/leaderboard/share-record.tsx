"use client";

import Link from "next/link";
import { appChain } from "@/lib/chain";
import { formatUsdc } from "@/lib/format";
import { recordShareText, type Entry } from "@/lib/leaderboard";
import { xIntentUrl } from "@/lib/share";
import { appCanonical, appHref } from "@/lib/site";
import { useWalletState } from "@/lib/wallet";

export type WireEntry = Omit<Entry, "profit" | "staked"> & { profit: string; staked: string };
const xIcon = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

/** The connected wallet's own line: rank, record and a post-to-X link back to this board. */
export function ShareRecord({ entries }: { entries: WireEntry[] }) {
  const { ready, isConnected, address } = useWalletState();
  if (!ready || !isConnected || !address) return null;
  const mine = entries.find(e => e.wallet === address.toLowerCase());
  const shell = "mono mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-accent/40 bg-accent/[0.06] px-4 py-3 text-[12px]";
  if (!mine) {
    return <p className={shell}>You&apos;re not ranked yet. <Link href={appHref()} className="text-accent underline underline-offset-4">Settle a slip</Link> to get on the board.</p>;
  }
  const profit = BigInt(mine.profit);
  const entry: Entry = { ...mine, profit, staked: BigInt(mine.staked) };
  const href = xIntentUrl(recordShareText(entry, appChain.name), appCanonical("/leaderboard"));
  return (
    <p className={shell}>
      <span>You&apos;re <span className="text-accent">#{mine.rank}</span> · {mine.wins}-{mine.losses} · <span className={profit >= 0n ? "text-yes" : "text-no"}>{profit < 0n ? "−" : "+"}{formatUsdc(profit < 0n ? -profit : profit)} USDC</span></span>
      <a href={href} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-2 uppercase tracking-[0.1em] text-fg transition-colors hover:text-accent">
        <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden><path d={xIcon} /></svg>
        Share record
      </a>
    </p>
  );
}
