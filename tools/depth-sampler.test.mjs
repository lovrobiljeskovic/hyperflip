import { test } from "node:test";
import assert from "node:assert/strict";
import { bookStats, nflCoins, summarize } from "./depth-sampler.mjs";

const NFL = {
  outcome: 3003,
  name: "template:sportsContestWinner",
  venue: "txyz",
  description: "competition:NFL|contestType:game|participantA:Miami Dolphins|participantB:San Francisco 49ers|scheduledStart:20260920-2025|shortNameA:Dolphins|shortNameB:49ers|sport:football",
};

test("nflCoins maps NFL winners to both coins and skips everything else", () => {
  const coins = nflCoins([NFL, { ...NFL, outcome: 1, description: NFL.description.replace("NFL", "MLB") }, { outcome: 2, name: "template:priceTouch", description: "perp:HYPE" }]);
  assert.deepEqual(coins, [
    { coin: "#30030", outcome: 3003, venue: "txyz", game: "Dolphins-49ers", side: "Dolphins", startMs: Date.UTC(2026, 8, 20, 20, 25) },
    { coin: "#30031", outcome: 3003, venue: "txyz", game: "Dolphins-49ers", side: "49ers", startMs: Date.UTC(2026, 8, 20, 20, 25) },
  ]);
});

test("bookStats reads top of book in USDC notional and nulls an empty side", () => {
  const book = { levels: [[{ px: "0.09922", sz: "95.0" }, { px: "0.09914", sz: "42.0" }, { px: "0.09913", sz: "5000.0" }, { px: "0.01", sz: "1" }], [{ px: "0.11093", sz: "45.0" }, { px: "0.11094", sz: "4545.0" }]] };
  const s = bookStats(book);
  assert.equal(s.bid, 0.09922);
  assert.equal(s.ask, 0.11093);
  assert.equal(s.spread, 0.01171);
  assert.equal(s.askTop1Usdc, 4.99);
  assert.equal(s.askTop3Usdc, +(0.11093 * 45 + 0.11094 * 4545).toFixed(2));
  assert.equal(s.bidTop3Usdc, +(0.09922 * 95 + 0.09914 * 42 + 0.09913 * 5000).toFixed(2));
  assert.deepEqual(bookStats({ levels: [[], []] }), { bid: null, ask: null, spread: null, bidTop1Usdc: 0, bidTop3Usdc: 0, askTop1Usdc: 0, askTop3Usdc: 0 });
});

test("summarize splits pre-kickoff from in-play and takes medians", () => {
  const row = (ts, startMs, spread, ask) => ({ ts, startMs, game: "A-B", spread, ask, bid: ask - spread, askTop1Usdc: ask * 100, askTop3Usdc: ask * 300, bidTop1Usdc: 1 });
  const r = summarize([row(1, 10, 0.01, 0.5), row(2, 10, 0.03, 0.6), row(3, 10, 0.02, 0.7), row(11, 10, 0.1, 0.9), { ...row(12, 10, null, 0.9), ask: null }]);
  assert.equal(r.games, 1);
  assert.equal(r.preKickoff.samples, 3);
  assert.equal(r.preKickoff.medianSpread, 0.02);
  assert.equal(r.preKickoff.medianAskTop1Usdc, 60);
  assert.equal(r.inPlay.samples, 2);
  assert.equal(r.inPlay.emptyBooks, 1);
  assert.equal(r.inPlay.medianSpread, 0.1);
});
