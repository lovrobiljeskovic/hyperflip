import { beforeEach, expect, test, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type TransactionReceipt } from "viem";
import { confirmedPositionRow, mergePositionRows, receiptPositions, rememberPosition, savedPositions } from "./position-receipts";
import { PARLAY_VAULT, parlayMintedEvent } from "./contracts";
import { loadRow, type Row } from "./positions";

vi.mock("./positions", () => ({ loadRow: vi.fn() }));
const wallet = `0x${"1".repeat(40)}` as const;
const other = `0x${"2".repeat(40)}` as const;
const hash = `0x${"a".repeat(64)}` as const;
const blockHash = `0x${"b".repeat(64)}` as const;
const zero = `0x${"0".repeat(40)}` as const;
const row: Row = { id: 1n, block: 10n, mintedAtMs: 1000, burned: false, owner: wallet, taker: wallet,
  parlay: { legs: [{ vault: other, isYes: true }], writer: other, premium: 1n, maxPayout: 2n, status: 0 }, legVerdicts: ["pending"] };

function minted(): TransactionReceipt {
  return { status: "success", transactionHash: hash, blockHash, blockNumber: 10n,
    logs: [{ address: PARLAY_VAULT, topics: encodeEventTopics({ abi: [parlayMintedEvent], args: { id: 1n, taker: wallet } }),
      data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint96" }, { type: "uint96" }], [hash, 1n, 2n]) }] } as unknown as TransactionReceipt;
}
beforeEach(() => {
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.mocked(loadRow).mockResolvedValue(row);
});

test("confirmed mint survives index lag and reload, stays wallet-scoped, then reconciles", async () => {
  const receipt = minted();
  rememberPosition(wallet, receipt, "mint", 1n);
  expect(savedPositions(other)).toEqual([]);
  const client = { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: blockHash }) };
  expect((await receiptPositions(client as never, wallet, { number: "9", hash: blockHash })).rows[0].id).toBe(1n);
  expect(savedPositions(wallet)).toHaveLength(1);
  expect((await receiptPositions(client as never, wallet, { number: "10", hash: blockHash })).rows).toEqual([]);
  expect(savedPositions(wallet)).toEqual([]);
});

test("reorged receipts disappear, RPC outages preserve their hints for retry", async () => {
  const receipt = minted();
  rememberPosition(wallet, receipt, "mint", 1n);
  const outage = { getTransactionReceipt: async () => { throw new Error("RPC unavailable"); } };
  expect(await receiptPositions(outage as never, wallet)).toMatchObject({ pending: true, failed: true });
  expect(savedPositions(wallet)).toHaveLength(1);
  const reorg = { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash }) };
  expect((await receiptPositions(reorg as never, wallet)).rows).toEqual([]);
  expect(savedPositions(wallet)).toEqual([]);
});

test("confirmed claim/refund updates cannot be undone by stale indexed or RPC state", async () => {
  const abi = parseAbi(["event ParlayResolved(uint256 indexed id, uint8 status)", "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
  for (const status of [1, 3]) {
    const receipt = { ...minted(), logs: [
      { address: PARLAY_VAULT, topics: encodeEventTopics({ abi, eventName: "ParlayResolved", args: { id: 1n } }), data: encodeAbiParameters([{ type: "uint8" }], [status]) },
      { address: PARLAY_VAULT, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: wallet, to: zero, tokenId: 1n } }), data: "0x" },
    ] } as unknown as TransactionReceipt;
    const confirmed = confirmedPositionRow(row, receipt);
    expect(confirmed).toMatchObject({ burned: true, owner: null, burnHolder: wallet, parlay: { status } });
    expect(mergePositionRows([row], [confirmed])[0]).toMatchObject({ burned: true, block: 10n, mintedAtMs: 1000 });
    rememberPosition(wallet, receipt, status === 1 ? "claim" : "resolve", row.id, row.block);
    const client = { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: blockHash }) };
    expect((await receiptPositions(client as never, wallet)).rows[0]).toMatchObject({ burned: true, parlay: { status } });
  }
});
