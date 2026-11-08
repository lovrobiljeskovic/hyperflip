import "server-only";
import { isAddress } from "viem";
import { appChain } from "./chain";
import { aggregate, type Entry } from "./leaderboard";
import { loadLeaderboardRows } from "./leaderboard-source";
import type { Row } from "./positions";
import { recordCardState, type CardState } from "./share-card";

export function parseWallet(raw: string): `0x${string}` | null {
  return isAddress(raw, { strict: false }) ? (raw.toLowerCase() as `0x${string}`) : null;
}

/** The wallet's board entry and record card; null off the board or when the board cannot load. */
export async function loadRecordCard(wallet: `0x${string}`, deps: { rows?: () => Promise<{ rows: Row[] }> } = {}): Promise<{ card: CardState; entry: Entry } | null> {
  try {
    const { rows } = await (deps.rows ?? loadLeaderboardRows)();
    const entry = aggregate(rows).entries.find((e) => e.wallet === wallet);
    return entry ? { card: recordCardState(entry, appChain.name), entry } : null;
  } catch { return null; }
}
