import { expect, test } from "vitest";
import { aggregate, HOUSE_WALLETS, recordShareText } from "./leaderboard";
import { STATUS } from "./contracts";
import type { Row } from "./positions";

const a = `0x${"a".repeat(40)}` as const;
const b = `0x${"b".repeat(40)}` as const;
const vault = `0x${"1".repeat(40)}` as const;
let nextId = 1n;
function row(taker: `0x${string}`, status: number, legVerdicts: Row["legVerdicts"], premium = 1_000_000n, maxPayout = 3_000_000n): Row {
  return { id: nextId++, block: 1n, mintedAtMs: 0, taker, burned: false, owner: taker, legVerdicts,
    parlay: { legs: legVerdicts.map(() => ({ vault, isYes: true })), writer: vault, premium, maxPayout, status } };
}

test("classifies slips like the Positions page: claimed, claimable and dead count; void, open and unknown do not", () => {
  const rows = [
    row(a, STATUS.Won, ["hit"]),                 // claimed/claimable → win
    row(a, STATUS.Open, ["hit", "hit"]),         // all legs hit, unclaimed → win
    row(a, STATUS.Dead, ["lost"]),               // dead → loss
    row(a, STATUS.Open, ["hit", "lost"]),        // lost leg, not yet poked → loss
    row(a, STATUS.Void, ["fractional"]),         // void → ignored
    row(a, STATUS.Open, ["pending", "hit"]),     // open → ignored
    row(a, STATUS.Open, ["unknown"]),            // data error → counted as unknown
  ];
  const { entries, settled, unknown, paidOut } = aggregate(rows, new Set());
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ rank: 1, wallet: a, wins: 2, losses: 2, winRate: 0.5, staked: 4_000_000n });
  // profit = 2 × (3 − 1) − 2 × 1 = 2 USDC
  expect(entries[0].profit).toBe(2_000_000n);
  expect(settled).toBe(4);
  expect(unknown).toBe(1);
  expect(paidOut).toBe(6_000_000n);
});

test("ranks by wins, then win rate, then profit; wallets without a settled slip are absent", () => {
  const c = `0x${"c".repeat(40)}` as const;
  const rows = [
    row(a, STATUS.Won, ["hit"]), row(a, STATUS.Dead, ["lost"]),          // a: 1-1
    row(b, STATUS.Won, ["hit"]),                                         // b: 1-0 → beats a on win rate
    row(c, STATUS.Won, ["hit"]), row(c, STATUS.Won, ["hit"]), row(c, STATUS.Dead, ["lost"]), // c: 2-1 → most wins
    row(`0x${"d".repeat(40)}`, STATUS.Open, ["pending"]),                // d: nothing settled
  ];
  const { entries } = aggregate(rows, new Set());
  expect(entries.map(e => [e.rank, e.wallet])).toEqual([[1, c], [2, b], [3, a]]);
});

test("house wallets are excluded by default and the share text carries record and rank", () => {
  const house = [...HOUSE_WALLETS][0] as `0x${string}`;
  const { entries } = aggregate([row(house, STATUS.Won, ["hit"]), row(a, STATUS.Won, ["hit"])]);
  expect(entries.map(e => e.wallet)).toEqual([a]);
  expect(recordShareText(entries[0], "HyperEVM Testnet")).toBe("1-0 on @hyperflip_xyz (#1 on HyperEVM Testnet)");
});
