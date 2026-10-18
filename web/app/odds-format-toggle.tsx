"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ODDS_FORMAT_LABEL, ODDS_FORMATS, setOddsFormat, useOddsFormat, type OddsFormat } from "@/lib/odds-format";

export function OddsFormatToggle({ className = "" }: { className?: string }) {
  const format = useOddsFormat();
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      spacing={0}
      value={format}
      onValueChange={(v) => { if (v) setOddsFormat(v as OddsFormat); }}
      aria-label="Odds format"
      className={className}
    >
      {ODDS_FORMATS.map((f) => (
        <ToggleGroupItem key={f} value={f} className="mono h-7 px-2.5 text-[11px] text-dim data-[state=on]:bg-raised data-[state=on]:text-fg">
          {ODDS_FORMAT_LABEL[f]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
