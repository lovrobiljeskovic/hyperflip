import type { PublicClient } from "viem";
import { DEPLOY_BLOCK, PARLAY_VAULT, parlayMintedEvent } from "./contracts";

/** ponytail: sequential 1000-block scan + localStorage checkpoint; move to an
 * indexer if beta history ever makes first-load scans slow. */
export async function scanParlayIds(client: PublicClient, taker: `0x${string}`): Promise<bigint[]> {
  const key = `parlayScan:${taker.toLowerCase()}`;
  let cached: { last: string; ids: string[] } | null = null;
  try {
    cached = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    localStorage.removeItem(key); // corrupt/incompatible checkpoint — scan from DEPLOY_BLOCK instead of bricking every load
  }
  const ids = new Set(cached?.ids ?? []);
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
    for (const l of logs) ids.add(l.args.id!.toString());
  }
  localStorage.setItem(key, JSON.stringify({ last: head.toString(), ids: [...ids] }));
  return [...ids].map(BigInt);
}
