import type { Address, PublicClient } from "viem";
import { outcomeVaultAbi } from "./abi.js";
import { WAD } from "./pure.js";
import type { QuoteLeg } from "./quotes.js";

export interface LegState {
  settled: boolean;
  fractionWad: bigint;
}

/** Precompile-swap boundary (spec §7): settlement state is read from the vaults'
 * keeper-attested on-chain getters today; when settlement read precompiles ship,
 * only this module changes. */
export async function readLegStates(
  client: PublicClient,
  vaults: Address[],
): Promise<Map<string, LegState>> {
  const states = await Promise.all(
    vaults.map(async (v) => {
      const [settled, fractionWad] = await Promise.all([
        client.readContract({ address: v, abi: outcomeVaultAbi, functionName: "settled" }) as Promise<boolean>,
        client.readContract({ address: v, abi: outcomeVaultAbi, functionName: "settleFractionWad" }) as Promise<bigint>,
      ]);
      return [v.toLowerCase(), { settled, fractionWad }] as const;
    }),
  );
  return new Map(states);
}

/** Mirrors ParlayVault.resolveParlay's lost rule: YES lost iff settled fraction == 0,
 * NO lost iff == 1e18. */
export function parlayIsDead(legs: QuoteLeg[], states: Map<string, LegState>): boolean {
  return legs.some((l) => legLost(l, states.get(l.vault.toLowerCase())));
}

/** VOID path: every leg settled, none lost, at least one fractional. resolveParlay
 * then refunds the taker's premium and returns the rest to the writer, so the taker
 * has an incentive to call it — but nothing forces them to, and until someone does
 * the house's contribution stays escrowed and inside the exposure caps. The poker
 * pokes these too; the taker still gets the refund, it just doesn't gate it. */
export function parlayIsVoid(legs: QuoteLeg[], states: Map<string, LegState>): boolean {
  let fractional = false;
  for (const l of legs) {
    const s = states.get(l.vault.toLowerCase());
    if (!s?.settled) return false;
    if (legLost(l, s)) return false;
    const hit = l.isYes ? s.fractionWad === WAD : s.fractionWad === 0n;
    if (!hit) fractional = true;
  }
  return fractional;
}

function legLost(l: QuoteLeg, s: LegState | undefined): boolean {
  if (!s?.settled) return false;
  return l.isYes ? s.fractionWad === 0n : s.fractionWad === WAD;
}
