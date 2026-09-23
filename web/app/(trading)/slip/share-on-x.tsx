import { slipShareText, xIntentUrl } from "@/lib/share";
import type { SlipLeg } from "@/lib/slip";

const xIcon = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

export function ShareOnX({ legs, premium, maxPayout, url }: { legs: SlipLeg[]; premium: bigint; maxPayout: bigint; url: string }) {
  return (
    <a
      href={xIntentUrl(slipShareText(legs, premium, maxPayout), url)}
      target="_blank"
      rel="noreferrer"
      className="mono flex items-center justify-center gap-2 rounded-[8px] bg-accent py-[13px] text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform active:scale-[0.98] hover:opacity-90 motion-reduce:transition-none"
    >
      <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden="true"><path d={xIcon} /></svg>
      Share on X
    </a>
  );
}
