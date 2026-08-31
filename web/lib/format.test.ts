import { describe, expect, it, test, vi } from "vitest";
import {
  WAD,
  edgeSteps,
  formatVolume,
  formatUsdc,
  multiplier,
  impliedPct,
  pct1,
  priceBreakdown,
  quotedOverround,
  secondsLeft,
  shortAddress,
  until,
} from "./format";

test("formatUsdc renders 6-decimal base units at 2dp with grouping", () => {
  expect(formatUsdc(1_000_000n)).toBe("1.00");
  expect(formatUsdc(316_200_000n)).toBe("316.20");
  expect(formatUsdc(1_234_567_890n)).toBe("1,234.57");
});

test("formatVolume renders compact 24h USDC notional", () => {
  expect(formatVolume(0)).toBe("$0");
  expect(formatVolume(1_234)).toBe("$1.2K");
  expect(formatVolume(undefined)).toBe("—");
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

describe("shortAddress", () => {
  it("keeps 6 leading and 4 trailing characters", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});

describe("priceBreakdown", () => {
  const wad = (p: number) => (BigInt(Math.round(p * 1e6)) * 10n ** 18n / 1_000_000n).toString();

  it("rebuilds fair odds and edge from the writer's inputs", () => {
    // 0.5 * 0.4 = 0.2 fair -> 5x. With 5% edge: 1/(0.2*1.05) = 4.7619x
    const b = priceBreakdown([wad(0.5), wad(0.4)], "500", "0", undefined, 100_000_000n, 476_190_476n)!;
    expect(b.fairMultiplier).toBeCloseTo(5, 6);
    expect(b.legOdds[0]).toBeCloseTo(2, 6);
    expect(b.edgePct).toBe(0.05);
    expect(b.actualMultiplier).toBeCloseTo(4.7619, 4);
  });

  it("folds the joint probability into a correlated fair multiplier", () => {
    // Two 0.50 legs, joint 0.30 — positively correlated, so fair odds tighten.
    const bd = priceBreakdown(
      [String(WAD / 2n), String(WAD / 2n)],
      "500",
      "300",
      String((WAD * 30n) / 100n),
      1_000_000n,
      2_900_000n,
    )!;
    expect(bd.fairMultiplier).toBeCloseTo(4, 6);
    expect(bd.correlatedMultiplier).toBeCloseTo(1 / 0.3, 6);
  });

  it("reports a positive correlation step for anti-correlated legs", () => {
    const bd = priceBreakdown(
      [String(WAD / 2n), String(WAD / 2n)],
      "500",
      "300",
      String((WAD * 10n) / 100n),
      1_000_000n,
      8_000_000n,
    )!;
    const { afterCorrelation } = edgeSteps(bd);
    expect(afterCorrelation).toBeGreaterThan(bd.fairMultiplier);
  });

  it("falls back to the naive product when the writer sends no joint probability", () => {
    const bd = priceBreakdown([String(WAD / 2n), String(WAD / 2n)], "500", "300", undefined, 1_000_000n, 3_600_000n)!;
    expect(bd.correlatedMultiplier).toBeCloseTo(bd.fairMultiplier, 6);
  });

  it("overround measures house margin only, not correlation", () => {
    const bd = priceBreakdown(
      [String(WAD / 2n), String(WAD / 2n)],
      "500",
      "300",
      String((WAD * 30n) / 100n),
      1_000_000n,
      3_000_000n,
    )!;
    // fair 4x, correlated fair 3.33x, actual 3x -> margin is 3.33/3 - 1, not 4/3 - 1.
    expect(quotedOverround(bd)).toBeCloseTo(1 / 0.3 / 3 - 1, 6);
  });

  it("rejects impossible leg prices and empty input", () => {
    expect(priceBreakdown([wad(1)], "500", "0", undefined, 1n, 1n)).toBeNull();
    expect(priceBreakdown(["0"], "500", "0", undefined, 1n, 1n)).toBeNull();
    expect(priceBreakdown([], "500", "0", undefined, 1n, 1n)).toBeNull();
  });
});

describe("edgeSteps", () => {
  const wad = (p: number) => (BigInt(Math.round(p * 1e6)) * 10n ** 18n / 1_000_000n).toString();

  it("applies each edge component in turn, cumulatively", () => {
    // 0.5 * 0.5 = 0.25 fair -> 4x. No joint prob sent -> correlatedMultiplier
    // falls back to fairMultiplier. edge 5%, legs 3% -> 1/(0.25*1.08) = 3.7037x
    const bd = priceBreakdown([wad(0.5), wad(0.5)], "500", "300", undefined, 1_000_000n, 3_703_703n)!;
    const { afterCorrelation, afterEdge, afterLegs, modelled } = edgeSteps(bd);
    expect(bd.fairMultiplier).toBeCloseTo(4, 6);
    expect(afterCorrelation).toBeCloseTo(4, 6);
    expect(afterEdge).toBeCloseTo(4 / 1.05, 6);
    expect(afterLegs).toBeCloseTo(4 / 1.08, 6);
    expect(modelled).toBeCloseTo(4 / 1.08, 6);
    // each step takes strictly more off the payout
    expect(afterEdge).toBeGreaterThan(afterLegs);
    expect(modelled).toBeCloseTo(bd.actualMultiplier, 3);
  });

  it("treats a writer without legBps as zero leg surcharge", () => {
    const bd = priceBreakdown([wad(0.5), wad(0.5)], "500", undefined, undefined, 1n, 1n)!;
    expect(bd.legPct).toBe(0);
    const { afterEdge, afterLegs } = edgeSteps(bd);
    expect(afterLegs).toBe(afterEdge);
  });
});

test("until counts down in the largest useful unit", () => {
  // until() reads the clock itself, so the test must freeze it — otherwise a
  // millisecond elapsing between here and the call floors 18m to 17m.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const now = Date.now();
  expect(until(now - 1000)).toBe("expired");
  expect(until(now)).toBe("expired");
  expect(until(now + 18 * 60_000)).toBe("18m");
  expect(until(now + 4 * 3_600_000)).toBe("4h");
  expect(until(now + 11 * 86_400_000 + 60_000)).toBe("11d");
  // the unit transitions themselves, assertable now the clock is frozen
  expect(until(now + 3_600_000)).toBe("1h");
  expect(until(now + 86_400_000)).toBe("1d");
  vi.useRealTimers();
});

test("pct1 renders a mid at one decimal place", () => {
  expect(pct1(0.614)).toBe("61.4%");
  expect(pct1(0.5)).toBe("50.0%");
  expect(pct1(0)).toBe("0.0%");
});

test("quotedOverround is how far fair odds exceed the quoted odds", () => {
  // Fair 3.33x quoted down to 3.16x is a 5.4% margin.
  const bd = {
    legOdds: [],
    legProbs: [],
    fairMultiplier: 3.33,
    correlatedMultiplier: 3.33,
    edgePct: 0,
    legPct: 0,
    actualMultiplier: 3.16,
  };
  expect(quotedOverround(bd)).toBeCloseTo(0.0538, 4);
  // A quote that pays fair odds has no margin.
  expect(quotedOverround({ ...bd, actualMultiplier: 3.33 })).toBe(0);
  // A degenerate quote can't produce a margin at all.
  expect(quotedOverround({ ...bd, actualMultiplier: 0 })).toBe(0);
});
