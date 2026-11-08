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
  expect(entries[0]).toMatchObject({ rank: 1, wallet: a, wins: 2, losses: 2, winRate: 0.5, open: 3 });
  expect(settled).toBe(4);
  expect(unknown).toBe(1);
  expect(paidOut).toBe(6_000_000n);
});

test("ranks by win rate alone, then wins; wallets with nothing settled trail, most open slips first", () => {
  const c = `0x${"c".repeat(40)}` as const, d = `0x${"d".repeat(40)}` as const, e = `0x${"e".repeat(40)}` as const, f = `0x${"f".repeat(40)}` as const;
  const rows = [
    row(a, STATUS.Won, ["hit"]), row(a, STATUS.Dead, ["lost"]),          // a: 1-1 → 50%
    row(b, STATUS.Won, ["hit"]), row(b, STATUS.Won, ["hit"]), row(b, STATUS.Dead, ["lost"], 9_000_000n, 90_000_000n), // b: 2-1 → 67%
    row(f, STATUS.Won, ["hit"]),                                         // f: 1-0 → 100%, one slip is enough
    ...Array.from({ length: 5 }, () => row(c, STATUS.Won, ["hit"])), ...Array.from({ length: 24 }, () => row(c, STATUS.Dead, ["lost"])), // c: 5-24 → 17%, most wins, last
    row(e, STATUS.Open, ["pending"]),                                    // e: one open slip
    row(d, STATUS.Open, ["pending"]), row(d, STATUS.Void, ["fractional"]), // d: two undecided → ahead of e
  ];
  const { entries } = aggregate(rows, new Set());
  expect(entries.map(x => [x.rank, x.wallet])).toEqual([[1, f], [2, b], [3, a], [4, c], [5, d], [6, e]]);
  expect(entries[4]).toMatchObject({ wins: 0, losses: 0, winRate: 0, open: 2 });
  expect(entries[0]).not.toHaveProperty("profit");
});

test("equal win rates rank by more wins", () => {
  const rows = [row(a, STATUS.Won, ["hit"]), row(a, STATUS.Dead, ["lost"]), row(b, STATUS.Won, ["hit"]), row(b, STATUS.Won, ["hit"]), row(b, STATUS.Dead, ["lost"]), row(b, STATUS.Dead, ["lost"])];
  expect(aggregate(rows, new Set()).entries.map(x => x.wallet)).toEqual([b, a]);
});

test("house wallets are excluded by default and the share text carries record and rank", () => {
  const house = [...HOUSE_WALLETS][0] as `0x${string}`;
  const { entries } = aggregate([row(house, STATUS.Won, ["hit"]), row(a, STATUS.Won, ["hit"])]);
  expect(entries.map(e => e.wallet)).toEqual([a]);
  expect(recordShareText(entries[0], "HyperEVM Testnet")).toBe("1-0 on @hyperflip_xyz, #1 on HyperEVM Testnet");
});
