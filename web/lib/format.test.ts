import { describe, expect, test } from "vitest";
import { formatUsdc, multiplier, impliedPct, secondsLeft } from "./format";

test("formatUsdc renders 6-decimal base units at 2dp with grouping", () => {
  expect(formatUsdc(1_000_000n)).toBe("1.00");
  expect(formatUsdc(316_200_000n)).toBe("316.20");
  expect(formatUsdc(1_234_567_890n)).toBe("1,234.57");
});

test("multiplier is maxPayout/premium at 2dp", () => {
  expect(multiplier(100_000_000n, 316_200_000n)).toBe("3.16x");
  expect(multiplier(0n, 1n)).toBe("—");
});

test("impliedPct rounds a mid to whole percent", () => {
  expect(impliedPct(0.56667)).toBe("57%");
  expect(impliedPct(0)).toBe("0%");
});

test("secondsLeft floors and clamps at zero", () => {
  expect(secondsLeft(1030n, 1_000_000)).toBe(30);
  expect(secondsLeft(1030n, 1_030_500)).toBe(0);
  expect(secondsLeft(1030n, 2_000_000)).toBe(0);
});
