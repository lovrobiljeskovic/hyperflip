"use client";

import Link from "next/link";
import { HyperflipLogo } from "@/app/brand";
import { formatUsdc, multiplier } from "@/lib/format";
import { slipShareText, slipUrl, xIntentUrl } from "@/lib/share";
import { renderSlipPng } from "@/lib/slip-image";
import { useImageShare } from "@/lib/use-image-share";
import { legLabel } from "@/lib/ticket";
import type { MintedSlip } from "./use-ticket";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CopySlipLink } from "./copy-slip-link";

const shareClass = "mono flex h-11 items-center justify-center gap-2 rounded-[8px] border border-line text-[12px] uppercase tracking-[0.1em] text-fg transition-colors hover:border-dim";
const xIcon = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

export function MintedSlipDialog({ slip, onClose }: { slip: MintedSlip | null; onClose: () => void }) {
  // The link rebuilds this slip in the reader's builder (while its markets last).
  const text = slip ? slipShareText(slip.legs.length) : "";
  const link = slip ? slipUrl(location.origin, slip.legs) : "";
  const { copied, imageError, canShareFiles, copyImage, shareNative } = useImageShare(
    () => renderSlipPng({ legs: slip!.legs, premium: slip!.premium, maxPayout: slip!.maxPayout }), text, link, "hyperflip-slip.png");

  if (!slip) return null;
  const { legs, premium, maxPayout } = slip;
  const share = xIntentUrl(text, link);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="top-auto bottom-0 w-[min(100%,420px)] max-w-none translate-y-0 rounded-none border-0 bg-transparent p-0 pb-[env(safe-area-inset-bottom)] text-fg shadow-none ring-0 sm:top-1/2 sm:bottom-auto sm:w-[min(100%-2rem,400px)] sm:-translate-y-1/2"
      >
      <div className="minted-slip text-[13px]">
        <div className="relative px-6 pt-6">
          <div className="flex items-center gap-2">
            <HyperflipLogo className="size-6" />
            <span className="display text-[16px] tracking-[-0.045em]">hyperflip</span>
          </div>
          <DialogTitle className="display mt-6 text-[34px] font-normal leading-none [font-variation-settings:'wght'_700] tracking-[-0.03em]">
            {legs.length} leg combo
          </DialogTitle>
          <DialogDescription className="mono mt-2 text-[11px] text-dim">All legs must hit.</DialogDescription>
        </div>

        <ul className="mt-5 flex flex-col gap-px bg-line">
          {legs.map((leg) => (
            <li key={leg.vault} className="flex flex-col gap-0.5 bg-ink px-6 py-3">
              <span className={`mono text-[11px] ${leg.group ? "" : "uppercase"} ${leg.isYes ? "text-yes" : "text-no"}`}>
                {legLabel(leg)}
              </span>
              <span className="text-dim">{leg.title}</span>
            </li>
          ))}
        </ul>

        <div className="px-6 pt-5">
          <dl className="mono flex flex-col gap-2 text-[12px]">
            <div className="flex justify-between"><dt className="text-dim">Stake</dt><dd>{formatUsdc(premium)} USDC</dd></div>
            <div className="flex justify-between"><dt className="text-dim">Multiplier</dt><dd>{multiplier(premium, maxPayout)}</dd></div>
          </dl>
          <div className="mt-4 flex items-end justify-between border-t border-line pt-4">
            <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">To win</span>
            <span className="mono text-[34px] leading-none text-accent">{formatUsdc(maxPayout)}</span>
          </div>
        </div>


        <div className="minted-tear" />
        <div className="px-6 pb-6">
          <div className="grid grid-cols-2 gap-2">
            {canShareFiles ? (
              <button type="button" onClick={() => void shareNative()} className={shareClass}>
                <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden="true"><path d={xIcon} /></svg>
                Share on X
              </button>
            ) : (
              <a href={share} target="_blank" rel="noreferrer" className={shareClass}>
                <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden="true"><path d={xIcon} /></svg>
                Share on X
              </a>
            )}
            <Button asChild className="mono h-11 text-[12px] uppercase tracking-[0.1em]"><Link href="/positions">View positions</Link></Button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => void copyImage()} className="mono h-11 text-[12px] uppercase tracking-[0.1em]">
              {copied ? "Copied" : "Copy image"}
            </Button>
            <CopySlipLink legs={legs} />
          </div>
          {imageError && <p className="mono mt-2 text-center text-[11px] text-no">Could not render the image in this browser.</p>}
        </div>
      </div>
      </DialogContent>
    </Dialog>
  );
}
