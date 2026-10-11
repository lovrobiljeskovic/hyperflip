import { appChain } from "./chain";
import { PARLAY_VAULT } from "./contracts";
import type { BuilderLeg } from "./ticket";
import type { Market } from "./writer";

export type SavedLeg = { vault: `0x${string}`; isYes: boolean };

export const slipKey = (): string => `hf:slip:${appChain.id}:${PARLAY_VAULT.toLowerCase()}`;

const isSaved = (v: unknown): v is SavedLeg =>
  !!v && typeof v === "object" && /^0x[0-9a-f]{40}$/i.test(String((v as SavedLeg).vault)) && typeof (v as SavedLeg).isYes === "boolean";

export function loadSlip(): SavedLeg[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(slipKey());
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSaved).map((l) => ({ vault: l.vault, isYes: l.isYes })) : [];
  } catch { return []; }
}

export function saveSlip(legs: BuilderLeg[]): void {
  try {
    if (legs.length === 0) localStorage.removeItem(slipKey());
    else localStorage.setItem(slipKey(), JSON.stringify(legs.map((l) => ({ vault: l.vault, isYes: l.isYes }))));
  } catch { /* storage blocked: the slip lives for this page only */ }
}

/** Rebuild legs from a saved list against the board that just loaded. Unknown vaults are dropped. */
export function restoreLegs(saved: SavedLeg[], board: Market[], legFor: (m: Market, isYes: boolean) => BuilderLeg): BuilderLeg[] {
  const byVault = new Map(board.map((m) => [m.vault.toLowerCase(), m]));
  return saved.flatMap((s) => { const m = byVault.get(s.vault.toLowerCase()); return m ? [legFor(m, s.isYes)] : []; });
}

/** Markets a saved leg may restore onto: unexpired. Mids may not be loaded yet, so price is not checked here. */
export function restorableBoard<M extends { expiryMs?: number }>(markets: M[], now = Date.now()): M[] {
  return markets.filter((m) => (m.expiryMs ?? Infinity) >= now);
}
