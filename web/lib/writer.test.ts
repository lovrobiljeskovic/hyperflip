import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compareMarketVolume, currentPricing, fetchLimits, groupMarkets, marketMid, requestQuote, sideLabel, withMarketVolumes, type Market } from "./writer";

test("public pricing follows writer configuration and never invents missing fees", async () => {
  const limits = { maxStake: "1000000", edgeBps: "725", legEdgeBps: "150", quoteTtlMs: 30000 };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(limits))));
  expect(currentPricing(await fetchLimits())).toEqual({ base: "7.25", perLeg: "1.50" });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/limits"), expect.objectContaining({ cache: "no-store" }));
  expect(currentPricing({ ...limits, edgeBps: "0", legEdgeBps: "0" })).toEqual({ base: "0.00", perLeg: "0.00" });
  for (const legEdgeBps of [undefined, "", "-1", "NaN", "1.5", "9007199254740992"]) {
    expect(currentPricing({ ...limits, legEdgeBps })).toBeNull();
  }
  expect(currentPricing({ ...limits, edgeBps: "bad" })).toBeNull();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
  expect(currentPricing(await fetchLimits())).toBeNull();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(currentPricing(await fetchLimits())).toBeNull();
});

test("marketMid: (0,1) only, and the empty-book 0.5 placeholder is null unless the market has traded", () => {
  const mids = { a: "0.61", b: "0.5", c: "6400000", d: "0" };
  expect(marketMid(mids, {}, "a")).toBe(0.61);
  expect(marketMid(mids, {}, "b")).toBeNull();
  expect(marketMid(mids, { volume24h: 12 }, "b")).toBe(0.5);
  expect(marketMid(mids, {}, "c")).toBeNull();
  expect(marketMid(mids, {}, "d")).toBeNull();
  expect(marketMid(mids, {}, "zzz")).toBeNull();
});

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

test("withMarketVolumes uses Hyperliquid's side-0 market volume", () => {
  expect(withMarketVolumes([MARKET], { "#100": 12.5, "#101": 7.25 })[0].volume24h).toBe(12.5);
  expect(withMarketVolumes([MARKET], { "#101": 7.25 })[0].volume24h).toBeUndefined();
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

test("sideLabel uses registry side names and falls back to YES/NO", () => {
  expect(sideLabel({ sideYes: "Twins", sideNo: "Orioles" }, true)).toBe("Twins");
  expect(sideLabel({ sideYes: "Twins", sideNo: "Orioles" }, false)).toBe("Orioles");
  expect(sideLabel({}, true)).toBe("YES");
  expect(sideLabel(undefined, false)).toBe("NO");
});

test("groupMarkets collapses a question's vaults into one entry at the first member's position", () => {
  const m = (vault: string, extra: Partial<Market> = {}): Market =>
    ({ vault: vault as `0x${string}`, title: vault, category: "sports", coinYes: "#1", coinNo: "#2", ...extra });
  const entries = groupMarkets([
    m("0xa", { group: "q844", groupTitle: "Saudi Arabia vs Uruguay" }),
    m("0xb"),
    m("0xc", { group: "q844", groupTitle: "Saudi Arabia vs Uruguay" }),
  ]);
  expect(entries.map((e) => e.kind)).toEqual(["group", "market"]);
  const group = entries[0];
  if (group.kind !== "group") throw new Error("expected group");
  expect(group.title).toBe("Saudi Arabia vs Uruguay");
  expect(group.members.map((x) => x.vault)).toEqual(["0xa", "0xc"]);
});
