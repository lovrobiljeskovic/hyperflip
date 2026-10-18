"use client";

import { formatUnits } from "viem";
import type { useTicket } from "./use-ticket";
import { formatUsdc, mult, USDC_DECIMALS, usdc2 } from "@/lib/format";
import { STAKE_CHIPS, chipState } from "@/lib/slip-summary";
import { CountUp } from "@/app/live";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type T = ReturnType<typeof useTicket>;

/** `ticketMult` is the quoted multiplier, null while there is no live quote. */
export function StakeInput({
  stake,
  setStake,
  toWin,
  lastWin,
  maxStake,
  usdcBalance,
  ticketMult,
  legCount,
  ttlLeft,
}: Pick<T, "stake" | "setStake" | "toWin" | "maxStake" | "usdcBalance" | "ttlLeft"> & {
  lastWin: bigint | null;
  ticketMult: number | null;
  legCount: number;
}) {
  const maxAllowed =
    usdcBalance === undefined
      ? maxStake
      : maxStake === null
        ? usdcBalance
        : usdcBalance < maxStake
          ? usdcBalance
          : maxStake;
  return (
    <div className="mt-4">
      <div className="grid grid-cols-2 items-end gap-3">
        <div>
          <label htmlFor="stake" className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Stake</label>
          <div className="mt-1 flex items-center gap-1 rounded-card border border-line bg-ink px-3 py-2 focus-within:border-accent">
            <span className="mono text-[16px] leading-none text-dim">$</span>
            <input id="stake" inputMode="decimal" autoComplete="off" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="0.00"
              className="mono w-full bg-transparent text-[20px] leading-none text-fg outline-none placeholder:text-dim" />
          </div>
        </div>
        <div className="text-right">
          <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">To win</span>
          <div className={`mono mt-1 text-[22px] leading-none ${toWin === null ? "text-dim" : "text-accent"}`}>
            {toWin === null ? (lastWin === null ? "—" : `$${formatUsdc(lastWin)}`) : <CountUp value={Number(formatUnits(toWin, USDC_DECIMALS))} format={(x) => `$${usdc2(x)}`} />}
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <ToggleGroup type="single" size="sm" variant="outline" value={STAKE_CHIPS.some((v) => String(v) === stake) ? stake : ""} onValueChange={(v) => { if (v) setStake(v); }} aria-label="Stake presets" className="flex-1 gap-1.5 [&>*]:flex-1">
          {STAKE_CHIPS.map((v) => {
            const c = chipState(v, maxStake, usdcBalance);
            return (
              <ToggleGroupItem key={v} value={String(v)} disabled={!c.enabled} title={c.title} className="mono h-8 border-line px-0 text-[11px] text-dim data-[state=on]:border-accent data-[state=on]:bg-transparent data-[state=on]:text-accent">
                ${v}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <Button variant="outline" size="sm" disabled={maxAllowed === null || maxAllowed === 0n} title={maxAllowed === null ? "House limit unknown" : maxAllowed === 0n ? "No USDC in this wallet" : undefined}
          onClick={() => maxAllowed !== null && setStake(formatUnits(maxAllowed, USDC_DECIMALS))} className="mono h-8 flex-1 border-line text-[11px] text-dim">
          Max
        </Button>
      </div>
      <div className="mono mt-2 flex items-center justify-between text-[11px] text-dim">
        <span>{ticketMult !== null ? `Ticket ${mult(ticketMult)} · ${legCount} legs` : `Balance $${usdcBalance === undefined ? "–" : formatUsdc(usdcBalance)}`}</span>
        {ticketMult !== null && <span>Quote locked {ttlLeft}s</span>}
      </div>
    </div>
  );
}
