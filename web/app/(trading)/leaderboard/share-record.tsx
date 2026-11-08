"use client";

import Link from "next/link";
import { appChain } from "@/lib/chain";
import { formatUsdc, shortAddress } from "@/lib/format";
import { recordShareText, type Entry } from "@/lib/leaderboard";
import { xIntentUrl } from "@/lib/share";
import { appCanonical, appHref } from "@/lib/site";
import { renderRecordPng } from "@/lib/slip-image";
import { useImageShare } from "@/lib/use-image-share";
import { useLinkX, useWalletState } from "@/lib/wallet";
import { Button } from "@/components/ui/button";

export type WireEntry = Omit<Entry, "profit" | "staked"> & { profit: string; staked: string };
const xIcon = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";
const XGlyph = () => <svg viewBox="0 0 24 24" className="size-3 fill-current" aria-hidden><path d={xIcon} /></svg>;

/** The connected wallet's own card: who you are on the board, where you stand, one way to share
 * it. Linking X is the identity's own secondary line, not a competing action. Desktop share copies
 * the record card to the clipboard and opens the X composer in the same click (the web intent cannot
 * attach an image); phones get the share sheet with the image attached. */
export function ShareRecord({ entries }: { entries: WireEntry[] }) {
  const { ready, isConnected, address } = useWalletState();
  const { handle, avatar, canLink, link } = useLinkX();
  const mine = address ? entries.find(e => e.wallet === address.toLowerCase()) : undefined;
  const entry: Entry | undefined = mine && { ...mine, profit: BigInt(mine.profit), staked: BigInt(mine.staked) };
  const text = entry ? recordShareText(entry, appChain.name) : "";
  const boardUrl = appCanonical("/leaderboard");
  const share = useImageShare(
    () => renderRecordPng({ ...entry!, wallet: address!, handle, chainName: appChain.name }), text, boardUrl, "hyperflip-record.png");
  if (!ready || !isConnected || !address) return null;

  const identity = (
    <div className="flex min-w-0 items-center gap-3">
      {avatar
        ? <img src={avatar} alt="" width={32} height={32} referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-full bg-line" />
        : <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-dim" aria-hidden><span className="size-1.5 rounded-full bg-yes" /></span>}
      <div className="min-w-0 leading-tight">
        <p className="mono truncate text-[13px] text-fg">{handle ? `@${handle}` : shortAddress(address)}</p>
        {handle
          ? <p className="mono truncate text-[11px] text-dim">{shortAddress(address)}</p>
          : canLink && <button type="button" onClick={link} className="inline-flex items-center gap-1.5 text-[11px] text-dim transition-colors hover:text-accent"><XGlyph />Link your X handle</button>}
      </div>
    </div>
  );

  if (!entry) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-panel px-4 py-3">
        {identity}
        <p className="text-[12px] text-dim">Not on the board yet. <Link href={appHref()} className="text-accent underline underline-offset-4">Mint a slip</Link> to get listed.</p>
      </div>
    );
  }

  const { profit } = entry;
  const stats: [string, string, string][] = [
    ["Rank", `#${entry.rank}`, "text-accent"],
    ["Record", `${entry.wins}-${entry.losses}`, ""],
    ["Net", `${profit < 0n ? "−" : "+"}${formatUsdc(profit < 0n ? -profit : profit)}`, profit > 0n ? "text-yes" : profit < 0n ? "text-no" : ""],
  ];
  const caption = share.imageError ? "Couldn't copy the card; the post opens without it."
    : share.copied ? "Card copied. Paste it into your post." : null;
  const shareClass = "mono h-9 px-4 text-[11px] uppercase tracking-[0.1em]";

  return (
    <div className="mt-4 rounded-card border border-accent/30 bg-accent/[0.05] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {identity}
        <dl className="mono flex gap-6 sm:ml-2">
          {stats.map(([label, value, cls]) => (
            <div key={label}>
              <dt className="text-[9px] uppercase tracking-[0.16em] text-dim">{label}</dt>
              <dd className={`mt-0.5 text-[13px] ${cls}`}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="ml-auto flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
          {share.canShareFiles ? (
            <Button onClick={() => void share.shareNative()} className={shareClass}><XGlyph />Share record</Button>
          ) : (
            <Button asChild className={shareClass}>
              <a href={xIntentUrl(text, boardUrl)} target="_blank" rel="noreferrer" onClick={() => void share.copyImage()}><XGlyph />Share record</a>
            </Button>
          )}
          {caption && <p className="text-[11px] text-dim sm:text-right" aria-live="polite">{caption}</p>}
        </div>
      </div>
    </div>
  );
}
