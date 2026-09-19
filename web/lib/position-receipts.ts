import { parseAbi, parseEventLogs, TransactionReceiptNotFoundError, type Address, type PublicClient, type TransactionReceipt } from "viem";
import { PARLAY_VAULT, parlayMintedEvent } from "./contracts";
import { hyperEvmTestnet } from "./chain";
import { loadRow, type Row } from "./positions";
import type { PositionSnapshot } from "./positions-api";
import { pool } from "./pool";

const events = [...parseAbi(["event ParlayResolved(uint256 indexed id, uint8 status)", "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]), parlayMintedEvent];
export type PositionReceipt = { hash: `0x${string}`; block: string; blockHash: `0x${string}`; mintBlock: string; id: string | null; kind: "mint" | "claim" | "resolve" };
const memory = new Map<string, PositionReceipt[]>();
const storageUnavailable = new Set<string>();
const key = (wallet: string) => `positions:${hyperEvmTestnet.id}:${PARLAY_VAULT.toLowerCase()}:${wallet.toLowerCase()}`;

export function savedPositions(wallet: string): PositionReceipt[] {
  try {
    if (storageUnavailable.has(key(wallet))) return memory.get(key(wallet)) ?? [];
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key(wallet));
    const value: unknown = raw === null ? memory.get(key(wallet)) ?? [] : JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(v => v && /^0x[\da-f]{64}$/i.test(v.hash) && /^0x[\da-f]{64}$/i.test(v.blockHash) &&
      /^[1-9]\d{0,77}$/.test(v.block) && /^[1-9]\d{0,77}$/.test(v.mintBlock) && (v.id === null || /^[1-9]\d{0,77}$/.test(v.id)) && ["mint", "claim", "resolve"].includes(v.kind)).slice(-20);
  } catch { return memory.get(key(wallet)) ?? []; }
}

function save(wallet: string, receipts: PositionReceipt[]) {
  memory.set(key(wallet), receipts.slice(-20));
  try { localStorage.setItem(key(wallet), JSON.stringify(receipts.slice(-20))); storageUnavailable.delete(key(wallet)); }
  catch { storageUnavailable.add(key(wallet)); }
}

export function rememberPosition(wallet: string, receipt: TransactionReceipt, kind: PositionReceipt["kind"], id: bigint | null, mintBlock = receipt.blockNumber): PositionReceipt {
  const entry = { hash: receipt.transactionHash, block: String(receipt.blockNumber), blockHash: receipt.blockHash, mintBlock: String(mintBlock), kind, id: id === null ? null : String(id) };
  save(wallet, [...savedPositions(wallet).filter(p => p.hash !== entry.hash), entry]);
  return entry;
}

/** Verify persisted hints against canonical receipts; local storage never authorizes an action. */
export async function receiptPositions(client: PublicClient, wallet: Address, indexed?: PositionSnapshot): Promise<{ rows: Row[]; pending: boolean; failed: boolean }> {
  const receipts = savedPositions(wallet);
  const discard = new Set<string>();
  let pending = false;
  let failed = false;
  const rows = await pool(receipts, 4, async hint => {
    try {
      const receipt = await client.getTransactionReceipt({ hash: hint.hash });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.status !== "success" || receipt.blockHash !== block.hash || receipt.blockHash !== hint.blockHash || String(receipt.blockNumber) !== hint.block) {
        discard.add(hint.hash); return null;
      }
      const logs = parseEventLogs({ abi: events, logs: receipt.logs.filter(l => l.address.toLowerCase() === PARLAY_VAULT.toLowerCase()), strict: true });
      const minted = logs.filter(l => l.eventName === "ParlayMinted").find(l => l.args.taker.toLowerCase() === wallet.toLowerCase());
      const id = hint.kind === "mint" ? minted?.args.id : hint.id === null ? undefined : BigInt(hint.id);
      const validAction = logs.some(l => l.eventName === "Transfer" && l.args.tokenId === id && l.args.from.toLowerCase() === wallet.toLowerCase() && /^0x0{40}$/.test(l.args.to));
      if (id === undefined || (hint.kind !== "mint" && !validAction)) { discard.add(hint.hash); return null; }
      if (indexed && BigInt(indexed.number) >= receipt.blockNumber) { discard.add(hint.hash); return null; }
      pending = true;
      const mintBlock = minted ? receipt.blockNumber : BigInt(hint.mintBlock);
      const row = confirmedPositionRow(await loadRow(client, { id, block: mintBlock }), receipt);
      return { ...row, taker: minted?.args.taker, burnHolder: row.burned && validAction ? wallet : undefined };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        try {
          const canonical = await client.getBlock({ blockNumber: BigInt(hint.block) });
          if (canonical.hash && canonical.hash !== hint.blockHash) { discard.add(hint.hash); return null; }
        } catch { /* A temporarily unavailable receipt/block is not proof of a reorg. */ }
      }
      pending = true;
      failed = true;
      return null;
    }
  });
  // Preserve hints added while RPC work was in flight (e.g. a second confirmed action).
  save(wallet, savedPositions(wallet).filter(p => !discard.has(p.hash)));
  return { rows: rows.filter((row): row is NonNullable<typeof row> => row !== null), pending, failed };
}

export function mergePositionRows(rows: Row[], updates: Row[]): Row[] {
  const merged = new Map(rows.map(row => [String(row.id), row]));
  for (const row of updates) {
    const old = merged.get(String(row.id));
    merged.set(String(row.id), { ...old, ...row, taker: row.taker ?? old?.taker,
      burnHolder: row.burnHolder ?? old?.burnHolder, block: old?.block ?? row.block, mintedAtMs: old?.mintedAtMs ?? row.mintedAtMs });
  }
  return [...merged.values()].sort((a, b) => a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
}

export function confirmedPositionRow(row: Row, receipt: TransactionReceipt): Row {
  let next = { ...row };
  for (const log of parseEventLogs({ abi: events, logs: receipt.logs.filter(l => l.address.toLowerCase() === PARLAY_VAULT.toLowerCase()) })) {
    if (log.eventName === "ParlayResolved" && log.args.id === row.id) next = { ...next, parlay: { ...next.parlay, status: log.args.status } };
    if (log.eventName === "Transfer" && log.args.tokenId === row.id && /^0x0{40}$/.test(log.args.to)) next = { ...next, burned: true, owner: null, burnHolder: log.args.from };
  }
  return next;
}
