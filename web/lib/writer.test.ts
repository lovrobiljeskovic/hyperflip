vi.mock("@privy-io/react-auth", () => ({ getAccessToken: vi.fn().mockResolvedValue("verified-token") }));
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compareKickoff, kickoffKey, isMatchQuestion, currentPricing, fetchLimits, fetchMarkets, groupMarkets, isPriced, marketMid, sportLabel, requestQuote, sideLabel, withMarketVolumes, type Market } from "./writer";

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
  // House prior fills in for an empty or untraded book; NO side is the complement.
  expect(marketMid(mids, { priorYes: 0.4, coinYes: "b" }, "b")).toBe(0.4);
  expect(marketMid(mids, { priorYes: 0.4, coinYes: "b" }, "zzz")).toBeCloseTo(0.6);
  expect(marketMid(mids, { priorYes: 0.4, coinYes: "a" }, "a")).toBe(0.61);
});

test("isPriced: both sides need a usable mid; a house prior covers an empty book", () => {
  const m = { vault: "0x1", title: "", category: "sports", coinYes: "y", coinNo: "n" } as Market;
  expect(isPriced({ y: "0.6", n: "0.4" }, m)).toBe(true);
  expect(isPriced({ y: "0.6" }, m)).toBe(false);
  expect(isPriced({ y: "0.5", n: "0.5" }, m)).toBe(false);
  expect(isPriced({}, { ...m, priorYes: 0.3 })).toBe(true);
});

test("sportLabel folds deployer spellings into one tab per sport", () => {
  expect(sportLabel({ sport: "American football", category: "sports" })).toBe("Football");
  expect(sportLabel({ sport: "American Football", category: "sports" })).toBe("Football");
  expect(sportLabel({ sport: "Association Football", category: "sports" })).toBe("Soccer");
  expect(sportLabel({ sport: "Soccer", category: "sports" })).toBe("Soccer");
  expect(sportLabel({ sport: "F1", category: "sports" })).toBe("F1");
  expect(sportLabel({ category: "sports" })).toBe("Sports");
});

const REQ = {
  taker: "0x1111111111111111111111111111111111111111" as const,
  legs: [],
  stake: "1000000",
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
  title: "Twins vs Orioles",
  category: "sports",
  coinYes: "#100",
  coinNo: "#101",
} satisfies Market;

test("withMarketVolumes uses Hyperliquid's side-0 market volume", () => {
  expect(withMarketVolumes([MARKET], { "#100": 12.5, "#101": 7.25 })[0].volume24h).toBe(12.5);
  expect(withMarketVolumes([MARKET], { "#101": 7.25 })[0].volume24h).toBeUndefined();
});

test("compareKickoff sorts soonest first, falls back to expiry, sinks markets with neither", () => {
  const D = 86_400_000;
  const m = (startMs?: number, expiryMs?: number, group?: string) => ({ startMs, expiryMs, group }) as Market;
  // The grouped season started at 1 but settles at 40 days: it ranks on settlement. A grouped
  // match (3-way soccer question, deadline 3 days after kickoff) ranks on its kickoff like any game.
  const season = m(1, 40 * D, "q1");
  const match = m(25 * D, 28 * D, "q2");
  const markets = [m(30 * D), m(undefined, 20 * D), m(), m(10 * D), season, match];
  expect(isMatchQuestion(season)).toBe(false);
  expect(isMatchQuestion(match)).toBe(true);
  expect(isMatchQuestion(m(10 * D))).toBe(false);
  expect([...markets].sort((a, b) => compareKickoff(a, b)).map(kickoffKey)).toEqual([10 * D, 20 * D, 25 * D, 30 * D, 40 * D, undefined]);
  expect([...markets].sort((a, b) => compareKickoff(a, b, false)).map(kickoffKey)).toEqual([40 * D, 30 * D, 25 * D, 20 * D, 10 * D, undefined]);
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

test("fetchMarkets filters unsupported markets from active and historical responses", async () => {
  const legacy = { ...MARKET, category: "other", title: "Legacy market" };
  const archived = { ...MARKET, title: "Past game" };
  const response = { markets: [MARKET, legacy], archived: [archived, legacy] };
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(response))));
  expect(await fetchMarkets()).toEqual([MARKET]);
  expect(await fetchMarkets(true)).toEqual([MARKET, archived]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([MARKET, legacy]))));
  expect(await fetchMarkets()).toEqual([MARKET]);
});

test("quotes use the current authenticated token, never an invite code", async () => {
  const { getAccessToken } = await import("@privy-io/react-auth");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "wallet-not-linked" }), { status: 403 })));
  expect(await requestQuote(REQ)).toEqual({ ok: false, status: 403, error: "wallet-not-linked" });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/quote"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer verified-token" }), body: JSON.stringify(REQ) }));
  vi.mocked(getAccessToken).mockResolvedValueOnce(null);
  vi.mocked(fetch).mockClear();
  expect(await requestQuote(REQ)).toEqual({ ok: false, status: 401, error: "unauthenticated" });
  expect(fetch).not.toHaveBeenCalled();
});
