import { HyperflipLogo } from "@/app/brand";
import { explorerTx } from "@/lib/chain";
import { formatUsdc, multiplier } from "@/lib/format";
import type { SlipLeg } from "@/lib/slip";

/** The printed ticket. Pure markup, so the mint dialog and the public
 * /slip/[id] page print the same thing. */
export function SlipCard({ legs, premium, maxPayout, id, hash, stamp, footer }: {
  legs: SlipLeg[];
  premium: bigint;
  maxPayout: bigint;
  id: string | null;
  /** Mint tx when the viewer just sent it; the public page has only the id. */
  hash?: `0x${string}`;
  /** Stamp text: "Minted" fresh off the printer, or the parlay's status later. */
  stamp: string;
  footer?: React.ReactNode;
}) {
  const tx = hash ? explorerTx(hash) : null;
  return (
    <div className="minted-slip text-[13px] text-fg">
      <div className="relative px-6 pt-6">
        <div className="flex items-center gap-2">
          <HyperflipLogo className="size-6" />
          <span className="display text-[16px] tracking-[-0.045em]">hyperflip</span>
        </div>
        <h2 id="slip-title" className="display mt-6 text-[34px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">
          {id === null ? "Slip" : `Slip #${id}`}
        </h2>
        <p className="mt-1 text-dim">{legs.length} legs, all must hit.</p>
        <span aria-hidden className="minted-stamp mono">{stamp}</span>
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

      {hash && (
        <p className="mono mt-5 flex justify-end px-6 text-[10px] text-dim">
          {tx ? (
            <a href={tx} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-4 hover:decoration-dim">
              tx {hash.slice(0, 6)}…{hash.slice(-4)}
            </a>
          ) : (
            <span>tx {hash.slice(0, 6)}…{hash.slice(-4)}</span>
          )}
        </p>
      )}

      <div className="minted-tear" />
      <div className="px-6 pb-6">{footer}</div>
    </div>
  );
}
