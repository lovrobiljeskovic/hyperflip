import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compareMarketVolume, correlationEvidence, requestQuote, withMarketVolumes, type Market } from "./writer";

const REQ = {
  taker: "0x1111111111111111111111111111111111111111" as const,
  legs: [],
  stake: "1000000",
  inviteCode: "OVR-TEST",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("requestQuote surfaces a hung writer as the status-0 unreachable shape after ~10s", async () => {
  // Never resolves on its own — only reacts to the AbortController's signal,
  // same as a writer that accepted the connection but never answered.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ),
  );

  const pending = requestQuote(REQ);
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(pending).resolves.toEqual({ ok: false, status: 0, error: "writer-unreachable" });
});

const MARKET = {
  vault: "0x1111111111111111111111111111111111111111",
  title: "BTC above 80k?",
  category: "crypto",
  coinYes: "#100",
  coinNo: "#101",
} satisfies Market;

test("withMarketVolumes sums both HIP-4 sides and leaves partial totals unknown", () => {
  expect(withMarketVolumes([MARKET], { "#100": 12.5, "#101": 7.25 })[0].volume24h).toBe(19.75);
  expect(withMarketVolumes([MARKET], { "#100": 12.5 })[0].volume24h).toBeUndefined();
});

test("compareMarketVolume sorts highest first and always sinks unknown volume", () => {
  const markets = [
    { ...MARKET, vault: "0x2222222222222222222222222222222222222222", volume24h: undefined },
    { ...MARKET, vault: "0x3333333333333333333333333333333333333333", volume24h: 4 },
    { ...MARKET, vault: "0x4444444444444444444444444444444444444444", volume24h: 9 },
  ] satisfies Market[];
  expect([...markets].sort((a, b) => compareMarketVolume(a, b, false)).map((m) => m.volume24h)).toEqual([9, 4, undefined]);
  expect([...markets].sort((a, b) => compareMarketVolume(a, b, true)).map((m) => m.volume24h)).toEqual([4, 9, undefined]);
});

test("correlationEvidence names measured and fallback pairs", () => {
  expect(
    correlationEvidence([
      { pair: ["BTC", "ETH"], status: "direct" },
      { pair: ["BTC", "ZEC"], status: "fallback" },
    ]),
  ).toBe("BTC/ETH measured · BTC/ZEC fallback estimate");
  expect(correlationEvidence([])).toBe("Same-underlying model");
});
