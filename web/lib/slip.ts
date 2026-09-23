import { createPublicClient, http } from "viem";
import { appChain } from "./chain";
import { PARLAY_VAULT, parlayVaultAbi } from "./contracts";
import type { ParlayData } from "./positions";
import { fetchMarkets, sideLabel } from "./writer";

export type SlipLeg = { vault: `0x${string}`; isYes: boolean; title: string; label?: string; group?: string };
export type SlipData = { id: string; legs: SlipLeg[]; premium: bigint; maxPayout: bigint; status: number };

const ID = /^[1-9]\d{0,20}$/;

/** A minted slip by token id, straight from the vault plus the registry's
 * titles. Null for a malformed or unminted id. Server only: it opens its own
 * RPC client on the app chain. */
export async function loadSlip(id: string): Promise<SlipData | null> {
  if (!ID.test(id)) return null;
  const client = createPublicClient({ chain: appChain, transport: http(undefined, { timeout: 8_000 }) });
  const [parlay, markets] = await Promise.all([
    client.readContract({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "parlay", args: [BigInt(id)] }) as Promise<ParlayData>,
    fetchMarkets(true).catch(() => []),
  ]);
  if (parlay.legs.length === 0) return null;
  const byVault = new Map(markets.map((m) => [m.vault.toLowerCase(), m]));
  const legs = parlay.legs.map((leg) => {
    const m = byVault.get(leg.vault.toLowerCase());
    return {
      vault: leg.vault,
      isYes: leg.isYes,
      title: m ? (m.group ? (m.groupTitle ?? m.group) : m.title) : `${leg.vault.slice(0, 6)}…${leg.vault.slice(-4)}`,
      label: m?.group ? m.title : sideLabel(m, leg.isYes),
      group: m?.group,
    };
  });
  return { id, legs, premium: parlay.premium, maxPayout: parlay.maxPayout, status: parlay.status };
}
