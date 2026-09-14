import type { PublicClient } from "viem";
import { DEPLOY_BLOCK, PARLAY_VAULT, parlayMintedEvent } from "./contracts";
import { hyperEvmTestnet } from "./chain";
import { pool } from "./pool";

export const scanCacheKey = (taker: string) =>
  `parlayScan3:${hyperEvmTestnet.id}:${PARLAY_VAULT.toLowerCase()}:${DEPLOY_BLOCK}:${taker.toLowerCase()}`;

export interface ParlayRef {
  id: bigint;
  block: bigint;
}

// RPC log ranges are capped at 1000 blocks; keep requests bounded.
const CONCURRENCY = 12;

export async function scanParlayIds(client: PublicClient, taker: `0x${string}`): Promise<ParlayRef[]> {
  const key = scanCacheKey(taker);
  const head = await client.getBlockNumber();
  let cached: { last: string; refs: [string, string][] } | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    const decimal = (v: unknown): v is string => typeof v === "string" && /^[0-9]+$/.test(v);
    if (value && decimal(value.last) && BigInt(value.last) >= DEPLOY_BLOCK - 1n && BigInt(value.last) <= head &&
        Array.isArray(value.refs) && value.refs.every((ref: unknown) => Array.isArray(ref) && ref.length === 2 &&
          decimal(ref[0]) && decimal(ref[1]) && BigInt(ref[1]) >= DEPLOY_BLOCK && BigInt(ref[1]) <= BigInt(value.last))) cached = value;
  } catch { /* Storage can be unavailable; scanning still works. */ }
  const refs = new Map<string, string>(cached?.refs ?? []);
  let from = cached ? BigInt(cached.last) + 1n : DEPLOY_BLOCK;
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

  try { localStorage.setItem(key, JSON.stringify({ last: head.toString(), refs: [...refs] })); }
  catch { /* A full or blocked cache must not hide loaded positions. */ }
  return [...refs].map(([id, block]) => ({ id: BigInt(id), block: BigInt(block) }));
}
