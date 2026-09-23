"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { HyperflipLogo } from "@/app/brand";
import { explorerTx } from "@/lib/chain";
import { formatUsdc, multiplier } from "@/lib/format";
import { slipShareText, xIntentUrl } from "@/lib/share";
import type { MintedSlip } from "./use-ticket";

const SITE = "https://hyperflip.xyz";
const xIcon = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

/** The confirmed slip, printed once the mint lands. A native dialog: focus
 * trap, Escape and backdrop come free, so the only state is open or not. */
export function MintedSlipDialog({ slip, onClose }: { slip: MintedSlip | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (slip && !el.open) el.showModal();
    if (!slip && el.open) el.close();
  }, [slip]);

  if (!slip) return null;
  const { legs, premium, maxPayout, hash, id } = slip;
  const tx = explorerTx(hash);
  const share = xIntentUrl(slipShareText(legs, premium, maxPayout), SITE);
  const stamped = new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-labelledby="minted-title"
      className="minted-dialog m-auto w-[min(100%-2rem,400px)] bg-transparent p-0 text-fg backdrop:bg-ink/85 backdrop:backdrop-blur-sm"
    >
      <div className="minted-slip text-[13px]">
        <div className="relative px-6 pt-6">
          <div className="flex items-center gap-2">
            <HyperflipLogo className="size-6" />
            <span className="display text-[16px] tracking-[-0.045em]">hyperflip</span>
          </div>
          <h2 id="minted-title" className="display mt-6 text-[34px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">
            Slip minted
          </h2>
          <p className="mt-1 text-dim">{legs.length} legs, all must hit.</p>
          <span aria-hidden className="minted-stamp mono">Minted</span>
        </div>

        <ul className="mt-5 flex flex-col gap-px bg-line">
          {legs.map((leg) => (
            <li key={leg.vault} className="flex items-center gap-3 bg-ink px-6 py-3">
              <span className={`mono max-w-32 shrink-0 truncate text-[11px] ${leg.group ? "" : "uppercase"} ${leg.isYes ? "text-yes" : "text-no"}`}>
                {leg.label ?? (leg.isYes ? "YES" : "NO")}
              </span>
              <span className="min-w-0 flex-1 truncate">{leg.title}</span>
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

        <p className="mono mt-5 flex justify-between px-6 text-[10px] text-dim">
          <span>{id === null ? "Position pending" : `Position #${id}`} · {stamped}</span>
          {tx ? (
            <a href={tx} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-4 hover:decoration-dim">
              tx {hash.slice(0, 6)}…{hash.slice(-4)}
            </a>
          ) : (
            <span>tx {hash.slice(0, 6)}…{hash.slice(-4)}</span>
          )}
        </p>

        <div className="minted-tear" />
        <div className="px-6 pb-6">
          <div className="grid grid-cols-2 gap-2">
            <a
              href={share}
              target="_blank"
              rel="noreferrer"
              className="mono flex items-center justify-center gap-2 rounded-[8px] bg-accent py-[13px] text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform active:scale-[0.98] hover:opacity-90 motion-reduce:transition-none"
            >
              <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden="true"><path d={xIcon} /></svg>
              Share on X
            </a>
            <Link
              href="/positions"
              className="mono flex items-center justify-center rounded-[8px] border border-line py-[13px] text-[12px] uppercase tracking-[0.1em] text-fg transition-colors hover:border-dim"
            >
              View positions
            </Link>
          </div>
          <button type="button" onClick={onClose} className="mono mt-3 w-full py-1 text-[11px] text-dim transition-colors hover:text-fg">
            Back to the board
          </button>
        </div>
      </div>
    </dialog>
  );
}
