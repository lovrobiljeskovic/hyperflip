import type { PrivyClient } from "@privy-io/node";
import { isAddress } from "viem";

export type Identity = { username: string; name: string | null; avatar: string | null };
/** Lowercase wallet address → the X account its Privy user linked. */
export type IdentityMap = Record<string, Identity>;

type Client = Pick<PrivyClient, "users">;

/** Wallet → X handle for every Privy user who linked X, read from Privy's user list and cached in
 * memory. Serves the last good map while Privy is down (or `{}` before the first load).
 * ponytail: full-list scan every `ttlMs`; a few hundred users is two pages. Switch to
 * getByWalletAddress per board wallet if the list ever gets slow. */
export function identityDirectory(client: Client, ttlMs = 5 * 60_000, now: () => number = Date.now) {
  let cache: { at: number; map: IdentityMap } | undefined;
  let inflight: Promise<IdentityMap> | undefined;

  async function refresh(): Promise<IdentityMap> {
    const map: IdentityMap = {};
    for await (const user of client.users().list()) {
      const x = user.linked_accounts.find(a => a.type === "twitter_oauth");
      if (!x || !x.username) continue;
      const identity: Identity = { username: x.username, name: x.name ?? null, avatar: x.profile_picture_url ?? null };
      for (const a of user.linked_accounts) {
        if (a.type === "wallet" && a.chain_type === "ethereum" && a.verified_at > 0 && isAddress(a.address)) map[a.address.toLowerCase()] = identity;
      }
    }
    return map;
  }

  return async function identities(): Promise<IdentityMap> {
    if (cache && now() - cache.at < ttlMs) return cache.map;
    inflight ??= refresh()
      .then(map => { cache = { at: now(), map }; return map; })
      .catch(err => {
        console.warn(JSON.stringify({ event: "identities-refresh-failed", reason: (err as Error)?.message ?? String(err), stale: !!cache }));
        // Back off for one TTL on a failure too, so a dead Privy is not hit on every page build.
        cache = { at: now(), map: cache?.map ?? {} };
        return cache.map;
      })
      .finally(() => { inflight = undefined; });
    return inflight;
  };
}
