import type { LegVerdict, Row } from "@/lib/positions";
import { pct1 } from "@/lib/format";
import { Kickoff } from "@/app/live";
import { explorerAddress, tradeUrl } from "@/lib/chain";
import { type Market, marketMid, sideLabel } from "@/lib/writer";

const VERDICT_STYLE: Record<LegVerdict, { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-dim" },
  unknown: { label: "Unavailable", className: "text-dim" },
  hit: { label: "Hit", className: "text-yes" },
  lost: { label: "Lost", className: "text-no" },
  fractional: { label: "Partial", className: "text-fg" },
};

const DOT_CLASS: Record<LegVerdict, string> = {
  hit: "bg-yes",
  lost: "bg-no",
  pending: "bg-line",
  unknown: "border border-dim",
  fractional: "bg-[linear-gradient(90deg,var(--color-yes)_50%,var(--color-line)_50%)]",
};

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LegDots({ verdicts }: { verdicts: LegVerdict[] }) {
  return (
    <span
      role="img"
      aria-label={verdicts.map((v) => VERDICT_STYLE[v].label).join(", ")}
      className="inline-flex items-center gap-[3px]"
    >
      {verdicts.map((v, i) => (
        <span
          key={i}
          title={VERDICT_STYLE[v].label}
          className={`inline-block size-1.5 rounded-full ${DOT_CLASS[v]}`}
        />
      ))}
    </span>
  );
}

export function DotLegend() {
  const order: LegVerdict[] = ["hit", "fractional", "lost", "pending"];
  return (
    <div className="mono mt-4 flex flex-wrap items-center gap-5 text-[10px] uppercase tracking-[0.16em] text-dim">
      {order.map((v) => (
        <span key={v} className="flex items-center gap-2">
          <span className={`inline-block size-1.5 rounded-full ${DOT_CLASS[v]}`} aria-hidden />
          {v === "fractional" ? "partial" : v}
        </span>
      ))}
    </div>
  );
}

export function LegTable({
  row,
  markets,
  mids,
}: {
  row: Row;
  markets: Map<string, Market>;
  mids: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-2 border-l-2 border-line bg-raised/30 px-4 py-4 sm:px-5">
      <div className="hidden gap-4 mono text-[9px] uppercase tracking-[0.16em] text-dim sm:flex">
        <span className="w-10 sm:w-16">Side</span>
        <span className="flex-1">Market</span>
        <span className="w-16 text-right">Live</span>
        <span className="w-32 text-right">Kickoff</span>
        <span className="w-20 text-right">Outcome</span>
      </div>
      {row.parlay.legs.map((leg, i) => {
        const m = markets.get(leg.vault.toLowerCase());
        const coin = m ? (leg.isYes ? m.coinYes : m.coinNo) : undefined;
        // Same rule as the board: allMids prints 0.5 for every untraded book,
        // which is a placeholder, not a price.
        const live = m && coin !== undefined ? marketMid(mids, m, coin) : null;
        const verdict = VERDICT_STYLE[row.legVerdicts[i]];
        return (
          // flex-wrap: on mobile the meta line's basis-full pushes it to a
          // second row; live/kickoff columns only exist at sm+.
          <div key={leg.vault} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 mono text-xs">
            <span className={`w-10 shrink-0 truncate sm:w-16 ${m?.group ? "" : "uppercase"} ${leg.isYes ? "text-yes" : "text-no"}`}>{sideLabel(m, leg.isYes)}</span>
            {/* The leg is a HyperCore market - link its live order book, not the
                EVM explorer. Explorer stays the fallback for archived legs whose
                market (and coin) the registry no longer carries. */}
            <a
              href={
                coin === undefined
                  ? explorerAddress(leg.vault) ?? undefined
                  : tradeUrl(coin)
              }
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-fg underline decoration-line underline-offset-4 transition-colors hover:decoration-dim"
            >
              {m?.title ?? leg.vault}
            </a>
            <span className="hidden w-16 text-right text-dim sm:block">
              {live === null ? "-" : pct1(live)}
            </span>
            <span className="hidden w-32 justify-end sm:flex">{m ? <Kickoff market={m} /> : <span className="text-dim">-</span>}</span>
            <span className={`text-right sm:w-20 ${verdict.className}`}>{verdict.label}</span>
            <span className="flex basis-full items-center gap-2 pl-14 text-[10px] text-dim sm:hidden">
              {live === null ? "-" : pct1(live)} live · {m ? <Kickoff market={m} align="left" /> : "-"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
