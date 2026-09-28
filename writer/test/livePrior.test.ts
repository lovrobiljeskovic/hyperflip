import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { espnDate, LivePrior, mainnetYesCoin, pmQuestionToken, pmSlug, toWad, yesOutcomeIndex } from "../src/livePrior.js";
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

// ---- Soccer 3-way question members (Polymarket public-search) ----

const SOCCER_KICKOFF = Date.UTC(2026, 9, 11, 15, 30);
const pmMarket = (question: string, yes: string, extra: Record<string, unknown> = {}) => ({
  question, sportsMarketType: "moneyline", outcomes: JSON.stringify(["Yes", "No"]), clobTokenIds: JSON.stringify([yes, `${yes}-no`]), ...extra,
});
const pmEvent = (slug: string, home: string, away: string, extra: Record<string, unknown> = {}) => ({
  slug,
  markets: [
    { sportsMarketType: "spread", question: "spread" },
    pmMarket(`Will ${home} win on 2026-10-11?`, `${slug}-home`, extra),
    pmMarket(`Will ${home} vs. ${away} end in a draw?`, `${slug}-draw`, extra),
    pmMarket(`Will ${away} win on 2026-10-11?`, `${slug}-away`, extra),
  ],
});
const LIV = "epl-liv-mac-2026-10-11";
const soccerRow = (title: string, groupTitle = "Liverpool vs Manchester City") =>
  ({ title, groupTitle, startMs: SOCCER_KICKOFF }) as Pick<MarketInfo, "title" | "groupTitle" | "startMs">;

test("pmQuestionToken: home, away and Draw pick the right Yes token; wrong date and closed events are ignored", () => {
  const events = [
    pmEvent("epl-liv-mac-2026-10-04", "Liverpool FC", "Manchester City FC"), // last week, same clubs
    pmEvent(LIV, "Liverpool FC", "Manchester City FC"),
  ];
  assert.deepEqual(pmQuestionToken(events, soccerRow("Liverpool")), { token: `${LIV}-home`, slug: LIV, question: "Will Liverpool FC win on 2026-10-11?" });
  assert.equal(pmQuestionToken(events, soccerRow("Manchester City"))?.token, `${LIV}-away`);
  assert.equal(pmQuestionToken(events, soccerRow("Draw"))?.token, `${LIV}-draw`);
  assert.equal(pmQuestionToken([pmEvent(LIV, "Liverpool FC", "Manchester City FC", { closed: true })], soccerRow("Draw")), null);
  assert.equal(pmQuestionToken([], soccerRow("Draw")), null);
  assert.equal(pmQuestionToken(events, soccerRow("Liverpool", "Liverpool")), null, "no ' vs ' in groupTitle");
});

test("pmQuestionToken: accent-insensitive match, first candidate wins, index fallback only around a draw at index 1", () => {
  const MAL = "lal-mala-esp-2026-10-09";
  const malaga = pmEvent(MAL, "Málaga CF", "RCD Espanyol de Barcelona");
  const row = { title: "Malaga", groupTitle: "Malaga vs Espanyol", startMs: Date.UTC(2026, 9, 9, 19, 0) };
  assert.equal(pmQuestionToken([malaga], row)?.token, `${MAL}-home`);
  assert.equal(pmQuestionToken([malaga], { ...row, title: "Espanyol" })?.token, `${MAL}-away`);
  // Two candidates on the date: the first is used.
  assert.equal(pmQuestionToken([malaga, pmEvent(`${MAL}-replay-2026-10-09`, "Málaga CF", "RCD Espanyol de Barcelona")], row)?.slug, MAL);
  // Polymarket spells the club differently: fall back to market order (home 0, draw 1, away 2).
  const odd = pmEvent(MAL, "Malaga Club", "Espanyol Club");
  assert.equal(pmQuestionToken([odd], { ...row, groupTitle: "Málaga CF vs RCD Espanyol", title: "Málaga CF" })?.token, `${MAL}-home`);
  assert.equal(pmQuestionToken([odd], { ...row, groupTitle: "Málaga CF vs RCD Espanyol", title: "RCD Espanyol" })?.token, `${MAL}-away`);
  // No draw at index 1: no fallback.
  const noDraw = { slug: MAL, markets: [pmMarket("Will Malaga Club win on 2026-10-09?", "h"), pmMarket("Will Espanyol Club win on 2026-10-09?", "a"), pmMarket("Will Malaga Club vs. Espanyol Club end in a draw?", "d")] };
  assert.equal(pmQuestionToken([noDraw], { ...row, groupTitle: "Málaga CF vs RCD Espanyol", title: "Málaga CF" }), null);
  assert.equal(pmQuestionToken([noDraw], { ...row, title: "Draw" })?.token, "d");
});

const SOCCER: MarketInfo[] = (["Liverpool", "Draw", "Manchester City"] as const).map((title, i) => ({
  vault: `0x${String(i + 2).repeat(40)}` as Address, coinYes: `#${13920 + i * 10}`, coinNo: `#${13921 + i * 10}`, underlying: "q1392", cluster: "Premier League",
  title, groupTitle: "Liverpool vs Manchester City", question: 1392, group: "q1392", sideYes: title, sideNo: `Not ${title}`, category: "sports", sport: "Soccer",
  startMs: SOCCER_KICKOFF, expiryMs: SOCCER_KICKOFF + 3 * 86400_000, priorYes: 0.4,
}));

function soccerHarness(routes: Record<string, (url: string, body?: unknown) => unknown>, extra: MarketInfo[] = []) {
  let now = SOCCER_KICKOFF + 60_000;
  const calls: string[] = [];
  const log: Record<string, unknown>[] = [];
  const live = new LivePrior({
    markets: [...SOCCER, ...extra],
    fetchJson: async (url, body) => {
      const type = (body as { type?: string } | undefined)?.type;
      calls.push(type ? `${url}#${type}` : url);
      const key = Object.keys(routes).find((k) => (type ?? url).includes(k));
      if (!key) throw new Error(`no route for ${url}`);
      return routes[key](url, body);
    },
    mainnetInfoUrl: MAINNET,
    now: () => now,
    staleMs: 60_000,
    jumpWad: WAD / 10n,
    suspendMs: 30_000,
    log: (m) => log.push(m),
  });
  return { live, calls, log, advance: (ms: number) => { now += ms; } };
}

test("soccer question members: each resolves via public-search to its own token, prices both coins, never asks ESPN or mainnet", async () => {
  const search = [pmEvent(LIV, "Liverpool FC", "Manchester City FC")];
  const mids: Record<string, string> = { [`${LIV}-home`]: "0.45", [`${LIV}-draw`]: "0.25", [`${LIV}-away`]: "0.30" };
  const h = soccerHarness({
    "public-search": () => ({ events: search }),
    "midpoint": (url) => ({ mid: mids[/token_id=(.*)$/.exec(url)![1]] }),
    "espn": () => { throw new Error("espn must not be called"); },
    "outcomeMeta": () => { throw new Error("mainnet must not be called"); },
  });
  await h.live.tick();
  assert.equal(h.live.prior("#13920"), toWad(0.45));
  assert.equal(h.live.prior("#13921"), WAD - toWad(0.45));
  assert.equal(h.live.prior("#13930"), toWad(0.25));
  assert.equal(h.live.prior("#13940"), toWad(0.30));
  assert.equal(h.live.priorYes(SOCCER[2].vault), 0.3);
  const searches = h.calls.filter((u) => u.includes("public-search"));
  assert.equal(searches.length, 3);
  assert.ok(searches[0].includes(encodeURIComponent("Liverpool Manchester City")));
  assert.ok(!h.calls.some((u) => u.includes("espn") || u.startsWith(MAINNET)));
  assert.equal(h.live.status()["#13930"].source, "polymarket");
  assert.ok(h.log.some((m) => m.event === "live-prior-resolved" && m.slug === LIV && m.question === "Will Liverpool FC vs. Manchester City FC end in a draw?"));
});

test("soccer member with no Polymarket event is null, retried after ten minutes; a malformed row does not break the tick", async () => {
  let listed = false;
  const bad: MarketInfo = { ...SOCCER[0], vault: `0x${"9".repeat(40)}` as Address, coinYes: "#99990", coinNo: "#99991", groupTitle: "Liverpool" };
  const h = soccerHarness({ "public-search": () => ({ events: listed ? [pmEvent(LIV, "Liverpool FC", "Manchester City FC")] : [] }), "midpoint": () => ({ mid: "0.5" }) }, [bad]);
  await h.live.tick();
  await h.live.tick();
  assert.equal(h.calls.filter((u) => u.includes("public-search")).length, 3, "three searchable members, one search each, none repeated");
  assert.equal(h.live.prior("#13920"), undefined);
  assert.equal(h.live.prior("#99990"), undefined);
  assert.equal(h.log.filter((m) => m.event === "live-prior-failed").length, 0);
  listed = true;
  h.advance(10 * 60_000);
  await h.live.tick();
  assert.equal(h.live.prior("#13920"), toWad(0.5));
});

test("NFL rows are unaffected by the soccer admit; a non-soccer question member is still skipped", async () => {
  const tournament: MarketInfo = { ...MARKET, expiryMs: SOCCER_KICKOFF + 86400_000, vault: `0x${"8".repeat(40)}` as Address, coinYes: "#88880", coinNo: "#88881", question: 7, groupTitle: "Super Bowl LXI winner", title: "Chiefs" };
  const h = soccerHarness({ "events?slug": () => gamma, "public-search": () => ({ events: [] }), "midpoint": () => ({ mid: "0.5" }), "outcomeMeta": () => mnMeta, "l2Book": () => mnBook("0.42", "0.43") }, [{ ...MARKET, expiryMs: SOCCER_KICKOFF + 86400_000 }, tournament]);
  await h.live.tick();
  assert.ok(Object.keys(h.live.status()).includes("#194630"));
  assert.equal(h.live.status()["#194630"].source, "mainnet");
  assert.ok(!Object.keys(h.live.status()).includes("#88880"));
});

test("pmQuestionToken: a label inside the opponent's Polymarket name is ambiguous, so order breaks the tie (Espanyol v Barcelona)", () => {
  const DERBY = "lal-esp-bar-2026-11-01";
  const ev = pmEvent(DERBY, "RCD Espanyol de Barcelona", "FC Barcelona");
  const row = { groupTitle: "Espanyol vs Barcelona", startMs: Date.UTC(2026, 10, 1, 20, 0) };
  assert.equal(pmQuestionToken([ev], { ...row, title: "Barcelona" })?.token, `${DERBY}-away`);
  assert.equal(pmQuestionToken([ev], { ...row, title: "Espanyol" })?.token, `${DERBY}-home`);
});
