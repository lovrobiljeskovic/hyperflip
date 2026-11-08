import { expect, test } from "vitest";
import { loadRecordCard, parseWallet } from "./record-card";
import { STATUS } from "./contracts";
import type { Row } from "./positions";

const a = `0x${"a".repeat(40)}` as const;
const vault = `0x${"1".repeat(40)}` as const;
const row = (taker: `0x${string}`, status: number, legVerdicts: Row["legVerdicts"]): Row =>
  ({ id: 1n, block: 1n, mintedAtMs: 0, taker, burned: false, owner: taker, legVerdicts,
    parlay: { legs: [{ vault, isYes: true }], writer: vault, premium: 1_000_000n, maxPayout: 3_000_000n, status } });

test("parseWallet lowercases a valid address and rejects the rest", () => {
  expect(parseWallet(`0x${"A".repeat(40)}`)).toBe(a);
  expect(parseWallet("0x123")).toBeNull();
  expect(parseWallet("vitalik")).toBeNull();
});

test("loadRecordCard finds the wallet's entry; off-board wallets and failed loads give null", async () => {
  const rows = async () => ({ rows: [row(a, STATUS.Won, ["hit"]), row(a, STATUS.Dead, ["lost"])] });
  const found = await loadRecordCard(a, { rows });
  expect(found?.entry).toMatchObject({ rank: 1, wins: 1, losses: 1 });
  expect(found?.card.headline).toBe("1-1");
  expect(await loadRecordCard(`0x${"b".repeat(40)}`, { rows })).toBeNull();
  expect(await loadRecordCard(a, { rows: async () => { throw new Error("subgraph down"); } })).toBeNull();
});
