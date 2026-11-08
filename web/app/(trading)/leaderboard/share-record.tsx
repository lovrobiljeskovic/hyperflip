"use client";

import Link from "next/link";
import { appChain } from "@/lib/chain";
import { pct1, shortAddress } from "@/lib/format";
import { recordShareText, type Entry } from "@/lib/leaderboard";
import { X_ICON_PATH, xIntentUrl } from "@/lib/share";
import { appCanonical, appHref } from "@/lib/site";
import { useLinkX, useWalletState } from "@/lib/wallet";
import { Button } from "@/components/ui/button";

const XGlyph = () => <svg viewBox="0 0 24 24" className="size-3 fill-current" aria-hidden><path d={X_ICON_PATH} /></svg>;

/** The connected wallet's own card: who you are on the board, where you stand, one way to share
 * it. Linking X is the identity's own secondary line, not a competing action. Share opens the X
 * composer with the wallet's record page; that page's link preview is the record card, so the
 * image reaches the post without a clipboard step. */
export function ShareRecord({ entries }: { entries: Entry[] }) {
  const { ready, isConnected, address } = useWalletState();
  const { handle, avatar, canLink, link } = useLinkX();
  const entry = address ? entries.find(e => e.wallet === address.toLowerCase()) : undefined;
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

  const stats: [string, string, string][] = [
    ["Rank", `#${entry.rank}`, "text-accent"],
    ["Record", `${entry.wins}-${entry.losses}`, ""],
    ["Win %", pct1(entry.winRate), ""],
  ];
  const text = recordShareText(entry, appChain.name);
  const recordUrl = appCanonical(`/leaderboard/${address.toLowerCase()}?v=${entry.wins}-${entry.losses}`);
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
        <div className="ml-auto flex w-full sm:w-auto">
          <Button asChild className={`${shareClass} w-full sm:w-auto`}>
            <a href={xIntentUrl(text, recordUrl)} target="_blank" rel="noreferrer"><XGlyph />Share record</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
