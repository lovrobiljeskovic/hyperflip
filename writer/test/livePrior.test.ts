import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { espnDate, LivePrior, mainnetYesCoin, pmSlug, toWad, yesOutcomeIndex } from "../src/livePrior.js";
import type { MarketInfo } from "../src/markets.js";
import { WAD } from "../src/pure.js";

const V = "0x1111111111111111111111111111111111111111" as Address;
const KICKOFF = Date.UTC(2026, 8, 20, 17, 0); // 2026-09-20 13:00 EDT
const MARKET: MarketInfo = {
  vault: V, coinYes: "#194630", coinNo: "#194631", underlying: "car-atl", cluster: "NFL", title: "Carolina Panthers vs Atlanta Falcons",
  category: "sports", sport: "American football", startMs: KICKOFF, expiryMs: KICKOFF + 3 * 86400_000, sideYes: "CAR", sideNo: "ATL", priorYes: 0.5635,
};
const TOKEN = "6168258840971315689286506602437972390305170003051738207675972438220875706388";
const gamma = [{ markets: [{ sportsMarketType: "spread" }, { sportsMarketType: "moneyline", closed: true, outcomes: "[]", clobTokenIds: "[]" }, { sportsMarketType: "moneyline", outcomes: JSON.stringify(["Panthers", "Falcons"]), clobTokenIds: JSON.stringify([TOKEN, "999"]) }] }];
const espnBoard = (state: "pre" | "in" | "post", away?: number) => ({
  events: [{
    competitions: [{
      competitors: [{ homeAway: "away", team: { abbreviation: "CAR" } }, { homeAway: "home", team: { abbreviation: "ATL" } }],
      status: { type: { state, completed: state === "post" } },
      ...(away === undefined ? {} : { situation: { lastPlay: { probability: { awayWinPercentage: away, homeWinPercentage: 1 - away, tiePercentage: 0 } } } }),
    }],
  }],
});

const MAINNET = "https://mainnet.test/info";
const MN_DESC = (a: string, b: string) => `competition:NFL|contestType:Match|participantA:${a}|participantB:${b}|scheduledStart:20260920-1700|season:2026|sport:Football`;
const mnMeta = { outcomes: [
  { outcome: 1, name: "template:priceTouch", description: "perp:HYPE" },
  { outcome: 3898, name: "template:sportsContestWinner", description: MN_DESC("Tampa Bay Buccaneers", "Cleveland Browns") },
  { outcome: 3904, name: "template:sportsContestWinner", description: MN_DESC("Atlanta Falcons", "Carolina Panthers") },
] };
const mnBook = (bid: string, ask: string) => ({ levels: [[{ px: bid, sz: "100" }], [{ px: ask, sz: "100" }]] });

function harness(routes: Record<string, (body?: unknown) => unknown>, opts: Partial<{ staleMs: number; jumpWad: bigint; suspendMs: number; mainnet: boolean }> = {}) {
  let now = KICKOFF + 60_000;
  const calls: string[] = [];
  const log: Record<string, unknown>[] = [];
  const live = new LivePrior({
    markets: [MARKET],
    fetchJson: async (url, body) => {
      const type = (body as { type?: string } | undefined)?.type;
      calls.push(type ? `${url}#${type}` : url);
      const key = Object.keys(routes).find((k) => (type ?? url).includes(k));
      if (!key) throw new Error(`no route for ${url}`);
      return routes[key](body);
    },
    ...(opts.mainnet ? { mainnetInfoUrl: MAINNET } : {}),
    now: () => now,
    staleMs: opts.staleMs ?? 60_000,
    jumpWad: opts.jumpWad ?? WAD / 10n,
    suspendMs: opts.suspendMs ?? 30_000,
    log: (m) => log.push(m),
  });
  return { live, calls, log, advance: (ms: number) => { now += ms; } };
}

test("pmSlug: away-home-UTC date, with Polymarket's spellings", () => {
  assert.equal(pmSlug(MARKET), "nfl-car-atl-2026-09-20");
  assert.equal(pmSlug({ sideYes: "WSH", sideNo: "DAL", startMs: KICKOFF }), "nfl-was-dal-2026-09-20");
  // 8:15 PM EDT Thursday is already Friday in UTC — Polymarket dates by UTC.
  assert.equal(pmSlug({ sideYes: "DET", sideNo: "BUF", startMs: Date.UTC(2026, 8, 18, 0, 15) }), "nfl-det-buf-2026-09-18");
  assert.equal(pmSlug({ sideYes: undefined, sideNo: "BUF", startMs: 1 }), null);
});

test("espnDate is the US/Eastern day; yesOutcomeIndex matches the away nickname", () => {
  assert.equal(espnDate(Date.UTC(2026, 8, 18, 0, 15)), "20260917");
  assert.equal(yesOutcomeIndex(["Panthers", "Falcons"], MARKET.title), 0);
  assert.equal(yesOutcomeIndex(["Falcons", "Panthers"], MARKET.title), 1);
  assert.equal(yesOutcomeIndex(["Jets", "Giants"], MARKET.title), -1);
});

test("Polymarket mid prices both coins and overlays priorYes; ESPN is not consulted", async () => {
  const h = harness({ "gamma": () => gamma, "midpoint": () => ({ mid: "0.565" }), "espn": () => espnBoard("in", 0.9) });
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.565));
  assert.equal(h.live.prior("#194631"), WAD - toWad(0.565));
  assert.equal(h.live.priorYes(V), 0.565);
  assert.ok(h.calls.some((u) => u.includes(`midpoint?token_id=${TOKEN}`)));
  assert.ok(!h.calls.some((u) => u.includes("espn")));
  assert.equal(h.live.status()["#194630"].source, "polymarket");
});

test("falls back to ESPN in-play win probability when Polymarket has no market, and goes final on completion", async () => {
  let state: "pre" | "in" | "post" = "in";
  const h = harness({ "gamma": () => [], "espn": () => espnBoard(state, state === "in" ? 0.62 : undefined) });
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.62));
  assert.equal(h.live.status()["#194630"].source, "espn");
  state = "post";
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), undefined);
  assert.equal(h.live.status()["#194630"].final, true);
});

test("ESPN pregame board yields no live sample, so the registry prior stays in charge", async () => {
  const h = harness({ "gamma": () => [], "espn": () => espnBoard("pre") });
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), undefined);
});

test("a jump above jumpWad suspends the leg for suspendMs, then the new price serves", async () => {
  let mid = "0.50";
  const h = harness({ "gamma": () => gamma, "midpoint": () => ({ mid }) });
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.5));
  mid = "0.75";
  h.advance(15_000);
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), undefined, "suspended right after the jump");
  assert.equal(h.log.filter((m) => m.event === "live-prior-jump").length, 1);
  h.advance(30_000);
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.75));
});

test("a stale sample is not served; a fetch failure is logged and keeps the last sample until stale", async () => {
  let fail = false;
  const h = harness({ "gamma": () => gamma, "midpoint": () => { if (fail) throw new Error("boom"); return { mid: "0.4" }; } }, { staleMs: 20_000 });
  await h.live.tick();
  fail = true;
  h.advance(15_000);
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.4));
  assert.ok(h.log.some((m) => m.event === "live-prior-failed"));
  h.advance(10_000);
  assert.equal(h.live.prior("#194630"), undefined);
});

test("an unlisted Polymarket game is retried after ten minutes, not forever ignored", async () => {
  let listed = false;
  const h = harness({ "gamma": () => (listed ? gamma : []), "midpoint": () => ({ mid: "0.3" }), "espn": () => espnBoard("pre") });
  await h.live.tick();
  await h.live.tick();
  assert.equal(h.calls.filter((u) => u.includes("gamma")).length, 1);
  listed = true;
  h.advance(10 * 60_000);
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.3));
});

test("non-NFL rows are not tracked; a 404 midpoint (settled market) drops the token and falls to ESPN", async () => {
  const soccer = new LivePrior({ markets: [{ ...MARKET, sport: "Soccer" }], fetchJson: async () => { throw new Error("must not fetch"); }, now: () => KICKOFF, staleMs: 1, jumpWad: 1n, suspendMs: 1 });
  await soccer.tick();
  assert.deepEqual(soccer.status(), {});
  const h = harness({ "gamma": () => gamma, "midpoint": () => { throw new Error("x: HTTP 404"); }, "espn": () => espnBoard("in", 0.7) });
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.7));
  assert.equal(h.log.filter((m) => m.event === "live-prior-failed").length, 0);
  await h.live.tick();
  assert.equal(h.calls.filter((u) => u.includes("midpoint")).length, 1, "token dropped after the 404, no second midpoint call");
});

test("mainnetYesCoin matches both teams on the UTC kickoff day, either participant order", () => {
  // Our away team (Panthers) is participant B on this deployer, so YES is the +1 coin.
  assert.equal(mainnetYesCoin(mnMeta.outcomes, MARKET), "#39041");
  assert.equal(mainnetYesCoin([{ outcome: 7, name: "template:sportsContestWinner", description: MN_DESC("Carolina Panthers", "Atlanta Falcons") }], MARKET), "#70");
  assert.equal(mainnetYesCoin(mnMeta.outcomes, { ...MARKET, startMs: KICKOFF + 86400_000 }), null);
  assert.equal(mainnetYesCoin(mnMeta.outcomes, { ...MARKET, title: "New York Jets vs Atlanta Falcons" }), null);
});

test("mainnet book mid is the first source: beats Polymarket, wide book falls through to Polymarket then ESPN, off when unset", async () => {
  let book = mnBook("0.42792", "0.42793");
  const routes = { "gamma": () => gamma, "midpoint": () => ({ mid: "0.435" }), "outcomeMeta": () => mnMeta, "l2Book": () => book, "espn": () => espnBoard("in", 0.9) };
  const h = harness(routes, { mainnet: true });
  await h.live.tick();
  assert.equal(h.live.prior("#194630"), toWad(0.427925));
  assert.equal(h.live.status()["#194630"].source, "mainnet");
  assert.ok(h.calls.some((u) => u === `${MAINNET}#l2Book`));
  assert.ok(!h.calls.some((u) => u.includes("midpoint")));
  assert.ok(!h.calls.some((u) => u.includes("espn")));
  assert.equal(h.calls.filter((u) => u.endsWith("#outcomeMeta")).length, 1);
  // Wide book: nobody's price, Polymarket takes over.
  book = mnBook("0.10", "0.90");
  await h.live.tick();
  assert.equal(h.live.status()["#194630"].source, "polymarket");
  assert.equal(h.live.prior("#194630"), toWad(0.435)); // within the jump guard of the last mainnet mid
  assert.equal(h.calls.filter((u) => u.endsWith("#outcomeMeta")).length, 1);
  // Wide book and no Polymarket market: ESPN.
  const noPm = harness({ ...routes, "gamma": () => [] }, { mainnet: true });
  await noPm.live.tick();
  assert.equal(noPm.live.status()["#194630"].source, "espn");
  // Mainnet off: never asked, Polymarket first as before.
  const off = harness(routes);
  await off.live.tick();
  assert.equal(off.live.status()["#194630"].source, "polymarket");
  assert.ok(!off.calls.some((u) => u.startsWith(MAINNET)));
});

test("a pruned mainnet coin (l2Book error) drops the coin and re-resolves after the retry window", async () => {
  let fail = false;
  const h = harness({ "gamma": () => [], "outcomeMeta": () => mnMeta, "l2Book": () => { if (fail) throw new Error("HTTP 500"); return mnBook("0.4", "0.41"); }, "espn": () => espnBoard("pre") }, { mainnet: true });
  await h.live.tick();
  assert.equal(h.live.status()["#194630"].source, "mainnet");
  fail = true;
  await h.live.tick();
  await h.live.tick();
  assert.equal(h.calls.filter((u) => u.endsWith("#l2Book")).length, 2);
  h.advance(10 * 60_000 + 1);
  fail = false;
  await h.live.tick();
  assert.equal(h.calls.filter((u) => u.endsWith("#outcomeMeta")).length, 2);
  assert.equal(h.calls.filter((u) => u.endsWith("#l2Book")).length, 3);
});
