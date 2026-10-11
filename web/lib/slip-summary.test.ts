import { expect, test } from "vitest";
import { barSummary, chipState, STAKE_CHIPS } from "./slip-summary";

test("chips above the house max or the balance are disabled with the reason in the title", () => {
  expect(STAKE_CHIPS).toEqual([5, 10, 25, 50, 100]);
  expect(chipState(5, 8_000_000n, 1_000_000_000n)).toEqual({ enabled: true });
  expect(chipState(10, 8_000_000n, 1_000_000_000n)).toEqual({ enabled: false, title: "House limit 8.00 USDC per ticket" });
  expect(chipState(25, 100_000_000n, 20_000_000n)).toEqual({ enabled: false, title: "Balance 20.00 USDC" });
  expect(chipState(100, null, undefined)).toEqual({ enabled: true });
});

test("bar summary reads legs, multiplier, stake and to-win", () => {
  expect(barSummary({ legs: 1, multiplier: null, stakeUsdc: null, maxPayout: null }))
    .toEqual({ primary: "1 leg · —", secondary: "add 1 more leg", right: null });
  expect(barSummary({ legs: 3, multiplier: 4.123, stakeUsdc: 25_000_000n, maxPayout: 103_000_000n }))
    .toEqual({ primary: "3 legs · 4.12x", secondary: "$25.00 stake", right: "→ $103.00" });
  expect(barSummary({ legs: 2, multiplier: 2.5, stakeUsdc: null, maxPayout: null }))
    .toEqual({ primary: "2 legs · 2.50x", secondary: "enter a stake", right: null });
});
