import { formatUnits } from "viem";
import { summarizePositions, type Row } from "@/lib/positions";
import { USDC_DECIMALS, usdc2 } from "@/lib/format";
import { CountUp } from "@/app/live";

export function SummaryStrip({ rows, wallet }: { rows: Row[]; wallet: string }) {
  const { staked, open, claimable, won } = summarizePositions(rows, wallet);
  const usdc = (v: bigint) => Number(formatUnits(v, USDC_DECIMALS));
  const usdcLabel = (x: number) => `${usdc2(x)} USDC`;
  const whole = (x: number) => String(Math.round(x));
  const cells = [
    { label: "Tickets", value: rows.length, format: whole, className: "" },
    { label: "Total staked", value: usdc(staked), format: usdcLabel, className: "" },
    { label: "Open", value: open, format: whole, className: "" },
    { label: "Claimable", value: usdc(claimable), format: usdcLabel, className: claimable > 0n ? "text-accent" : "" },
    { label: "Claimed", value: usdc(won), format: usdcLabel, className: won > 0n ? "text-yes" : "" },
  ];
  return (
    <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((c) => (
        <div key={c.label} className="bg-panel px-[18px] py-[14px]">
          <p className="mono text-[10px] uppercase tracking-[0.16em] text-dim">{c.label}</p>
          <p className={`mono mt-1 text-[16px] ${c.className}`}>
            <CountUp value={c.value} format={c.format} />
          </p>
        </div>
      ))}
    </div>
  );
}
