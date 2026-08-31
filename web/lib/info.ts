/* The HyperCore info endpoint. Kept clear of React so both the server render
   and the client poll in lib/mids.ts can call it — a module that reaches
   useSyncExternalStore cannot be imported by a Server Component at all. */
export const INFO_API =
  process.env.NEXT_PUBLIC_INFO_API ?? "https://api.hyperliquid-testnet.xyz/info";

export const NO_MIDS: Record<string, string> = {};
export const NO_VOLUMES: Record<string, number> = {};

/** HIP-4 side coin -> rolling 24h USDC notional from spotMetaAndAssetCtxs. */
export function parseMarketVolumes(value: unknown): Record<string, number> {
  const contexts = Array.isArray(value) && Array.isArray(value[1]) ? value[1] : [];
  const volumes: Record<string, number> = {};
  for (const row of contexts) {
    const coin = row?.coin;
    const volume = Number(row?.dayNtlVlm);
    if (typeof coin === "string" && coin.startsWith("#") && Number.isFinite(volume) && volume >= 0) {
      volumes[coin] = volume;
    }
  }
  return volumes;
}

/** Rolling 24h notional for every HIP-4 side. Never throws: volume is
 * supplemental, so a failed context request must not take the board down. */
export async function fetchMarketVolumes(revalidate = 60): Promise<Record<string, number>> {
  try {
    const r = await fetch(INFO_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
      next: { revalidate },
    });
    return r.ok ? parseMarketVolumes(await r.json()) : NO_VOLUMES;
  } catch {
    return NO_VOLUMES;
  }
}

/** Mids for every coin on the venue, keyed by coin string ("#130690" →
 * "0.56667"). Never throws: an unreachable book just means the caller keeps
 * whatever it had. `revalidate` is inert in the browser. */
export async function fetchMids(revalidate?: number): Promise<Record<string, string>> {
  try {
    const r = await fetch(INFO_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      ...(revalidate === undefined ? {} : { next: { revalidate } }),
    });
    return r.ok ? await r.json() : NO_MIDS;
  } catch {
    return NO_MIDS;
  }
}
