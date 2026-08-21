import type { PublicClient } from "viem";
import { DEPLOY_BLOCK, PARLAY_VAULT, parlayMintedEvent } from "./contracts";
import { pool } from "./pool";

// v2: the checkpoint now stores the mint block per id (for the "minted" column),
// so the v1 `ids: string[]` shape is incompatible. New key = old checkpoints are
// ignored rather than misread; the rescan from DEPLOY_BLOCK costs one page load.
const KEY_PREFIX = "parlayScan2:";

export interface ParlayRef {
  id: bigint;
  block: bigint;
}

// The testnet RPC caps eth_getLogs at 1000 blocks per request ("query exceeds max
// block range 1000"), so a first load is one request per 1000 blocks since deploy —
// 239 of them today, growing ~80/day with the chain. Sequentially that was ~4
// minutes; a pool of 12 covers the same range in ~5s.
// ponytail: fixed-size pool + localStorage checkpoint. Upgrade path if beta history
// outgrows it: seed from nextId + ownerOf (instant for unburned positions) and scan
// logs only for the claimed ones, or index takers writer-side.
const CONCURRENCY = 12;

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
  const ranges: [bigint, bigint][] = [];
  for (; from <= head; from += 1000n) ranges.push([from, from + 999n < head ? from + 999n : head]);

  // pool rejects on the first failure, so the checkpoint below is only ever
  // written for a range that was covered end to end — a failed chunk must not
  // leave a hole the next load skips over.
  const pages = await pool(ranges, CONCURRENCY, ([fromBlock, toBlock]) =>
    client.getLogs({ address: PARLAY_VAULT, event: parlayMintedEvent, args: { taker }, fromBlock, toBlock }),
  );
  for (const logs of pages) {
    for (const l of logs) refs.set(l.args.id!.toString(), l.blockNumber.toString());
  }

  localStorage.setItem(key, JSON.stringify({ last: head.toString(), refs: [...refs] }));
  return [...refs].map(([id, block]) => ({ id: BigInt(id), block: BigInt(block) }));
}
