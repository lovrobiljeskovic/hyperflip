"use client";

import Link from "next/link";
import { appChain } from "@/lib/chain";
import { formatUsdc } from "@/lib/format";
import { recordShareText, type Entry } from "@/lib/leaderboard";
import { xIntentUrl } from "@/lib/share";
import { appCanonical, appHref } from "@/lib/site";
import { renderRecordPng } from "@/lib/slip-image";
import { useImageShare } from "@/lib/use-image-share";
import { useLinkX, useWalletState } from "@/lib/wallet";

export type WireEntry = Omit<Entry, "profit" | "staked"> & { profit: string; staked: string };
export const xIcon = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";
const action = "inline-flex items-center gap-2 uppercase tracking-[0.1em] text-fg transition-colors hover:text-accent";
const XGlyph = () => <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden><path d={xIcon} /></svg>;

/** The connected wallet's own line: rank, record, a post-to-X link and the record card as an
 * image. A signed-in wallet without X sees the link prompt: handles are what make the board worth
 * sharing, and the writer picks the link up within minutes. */
export function ShareRecord({ entries }: { entries: WireEntry[] }) {
  const { ready, isConnected, address } = useWalletState();
  const { handle, canLink, link } = useLinkX();
  const mine = address ? entries.find(e => e.wallet === address.toLowerCase()) : undefined;
  const entry: Entry | undefined = mine && { ...mine, profit: BigInt(mine.profit), staked: BigInt(mine.staked) };
  const text = entry ? recordShareText(entry, appChain.name) : "";
  const share = useImageShare(
    () => renderRecordPng({ ...entry!, wallet: address!, handle, chainName: appChain.name }), text, appCanonical("/leaderboard"), "hyperflip-record.png");
  if (!ready || !isConnected || !address) return null;
  const shell = "mono mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-accent/40 bg-accent/[0.06] px-4 py-3 text-[12px]";
  const linkX = canLink && !handle && (
    <button type="button" onClick={link} className={`${action} text-accent`}><XGlyph />Link X to show your handle here</button>
  );
  if (!entry) {
    return (
      <p className={shell}>
        <span>You&apos;re not on the board yet. <Link href={appHref()} className="text-accent underline underline-offset-4">Mint a slip</Link> to get listed.</span>
        <span className="ml-auto">{linkX}</span>
      </p>
    );
  }
  const { profit } = entry;
  return (
    <div className={shell}>
      <span>
        {handle ? <span className="text-fg">@{handle} · </span> : null}
        You&apos;re <span className="text-accent">#{entry.rank}</span> · {entry.wins}-{entry.losses} · <span className={profit >= 0n ? "text-yes" : "text-no"}>{profit < 0n ? "−" : "+"}{formatUsdc(profit < 0n ? -profit : profit)} USDC</span>
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
        {linkX}
        {share.canShareFiles ? (
          <button type="button" onClick={() => void share.shareNative()} className={action}><XGlyph />Share record</button>
        ) : (
          <>
            <a href={xIntentUrl(text, appCanonical("/leaderboard"))} target="_blank" rel="noreferrer" className={action}><XGlyph />Share record</a>
            <button type="button" onClick={() => void share.copyImage()} className={action}>{share.copied ? "Copied" : share.imageError ? "Image failed" : "Copy image"}</button>
          </>
        )}
      </span>
    </div>
  );
}
