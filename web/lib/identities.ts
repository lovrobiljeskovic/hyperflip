import "server-only";

export type Identity = { username: string; name: string | null; avatar: string | null };
export type Identities = Record<string, Identity>;

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const AVATAR = /^https:\/\/pbs\.twimg\.com\//;

/** Keep only well-formed entries: a handle X would accept, an avatar on X's image host or none. */
export function parseIdentities(body: unknown): Identities {
  const out: Identities = {};
  if (!body || typeof body !== "object") return out;
  for (const [wallet, v] of Object.entries(body as Record<string, unknown>)) {
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || !v || typeof v !== "object") continue;
    const { username, name, avatar } = v as Record<string, unknown>;
    if (typeof username !== "string" || !HANDLE.test(username)) continue;
    out[wallet] = {
      username,
      name: typeof name === "string" && name.length <= 50 ? name : null,
      avatar: typeof avatar === "string" && AVATAR.test(avatar) ? avatar : null,
    };
  }
  return out;
}

/** Wallet → linked X account, from the lane's writer. `{}` on any failure: the board renders
 * addresses rather than breaking on the writer. Cached with the page's ISR window. */
export async function loadIdentities(): Promise<Identities> {
  const base = process.env.NEXT_PUBLIC_WRITER_URL;
  if (!base) return {};
  try {
    const r = await fetch(`${base}/identities`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return {};
    return parseIdentities(await r.json());
  } catch { return {}; }
}
