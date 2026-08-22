/* The HyperCore info endpoint. Kept clear of React so both the server render
   and the client poll in lib/mids.ts can call it — a module that reaches
   useSyncExternalStore cannot be imported by a Server Component at all. */
export const INFO_API =
  process.env.NEXT_PUBLIC_INFO_API ?? "https://api.hyperliquid-testnet.xyz/info";

export const NO_MIDS: Record<string, string> = {};

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
