import type { PublicClient } from "viem";
import { DEPLOY_BLOCK, PARLAY_VAULT, parlayMintedEvent } from "./contracts";

// v2: the checkpoint now stores the mint block per id (for the "minted" column),
// so the v1 `ids: string[]` shape is incompatible. New key = old checkpoints are
// ignored rather than misread; the rescan from DEPLOY_BLOCK costs one page load.
const KEY_PREFIX = "parlayScan2:";

export interface ParlayRef {
  id: bigint;
  block: bigint;
}

/** ponytail: sequential 1000-block scan + localStorage checkpoint; move to an
 * indexer if beta history ever makes first-load scans slow. */
export async function scanParlayIds(client: PublicClient, taker: `0x${string}`): Promise<ParlayRef[]> {
  const key = `${KEY_PREFIX}${taker.toLowerCase()}`;
  let cached: { last: string; refs: [string, string][] } | null = null;
  try {
    cached = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    localStorage.removeItem(key); // corrupt/incompatible checkpoint — scan from DEPLOY_BLOCK instead of bricking every load
  }
  const refs = new Map<string, string>(Array.isArray(cached?.refs) ? cached.refs : []);
  let from = cached ? BigInt(cached.last) + 1n : DEPLOY_BLOCK;
  const head = await client.getBlockNumber();
  for (; from <= head; from += 1000n) {
    const to = from + 999n < head ? from + 999n : head;
    const logs = await client.getLogs({
      address: PARLAY_VAULT,
      event: parlayMintedEvent,
      args: { taker },
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs) refs.set(l.args.id!.toString(), l.blockNumber.toString());
  }
  localStorage.setItem(key, JSON.stringify({ last: head.toString(), refs: [...refs] }));
  return [...refs].map(([id, block]) => ({ id: BigInt(id), block: BigInt(block) }));
}
