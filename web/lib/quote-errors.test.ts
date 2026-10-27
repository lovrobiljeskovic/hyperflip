import { expect, test } from "vitest";
import { errorMessage } from "./quote-errors";
import type { BuilderLeg } from "./ticket";

const fail = (status: number, error: string, extra: { maxStake?: string; vault?: string } = {}) =>
  ({ ok: false, status, error, ...extra }) as const;

const leg: BuilderLeg = { vault: "0xAbC0000000000000000000000000000000000001", isYes: true, title: "Arsenal win", coin: "#10" };

test.each([
  ["dominated, named leg", fail(400, "dominated", { vault: "0xabc0000000000000000000000000000000000001" }), [leg],
    'This ticket pays less than "Arsenal win" alone. Remove a leg or choose another game.'],
  ["dominated, unknown leg", fail(400, "dominated", { vault: "0xdead" }), [leg],
    "This ticket pays less than one leg alone. Remove a leg or choose another game."],
  ["clock-skew", fail(400, "clock-skew"), [], "Quote expired immediately - check your clock."],
  ["stale-book", fail(503, "stale-book"), [], "No live price for one of these markets right now - try again shortly."],
  ["unpriced-leg", fail(400, "unpriced-leg"), [],
    "One leg has no live price right now. Soccer markets close at kickoff - remove it and requote."],
  ["warming-up", fail(503, "warming-up"), [], "Writer just restarted and is warming up - retry in a few seconds."],
  ["rpc-down", fail(503, "rpc-down"), [], "Chain RPC is rate-limiting the writer - retry in a moment."],
  ["status 0", fail(0, "network"), [], "Writer unreachable - retrying."],
  ["status 503", fail(503, "busy"), [], "Writer unreachable - retrying."],
  ["status 429", fail(429, "rate-limited"), [], "Too many quotes too fast - pausing a moment."],
  ["status 401", fail(401, "unauthenticated"), [], "Sign in with this wallet again to continue."],
  ["status 403", fail(403, "forbidden"), [], "Sign in with this wallet again to continue."],
  ["409 leg-settled", fail(409, "leg-settled"), [], "A leg just settled - remove it and requote."],
  ["409 quota-cap", fail(409, "quota-cap"), [],
    "This account has hit its open-ticket quota - wait for reservations to clear."],
  ["409 with a fitting stake", fail(409, "market-cap", { maxStake: "2500000" }), [],
    "Payout too large for the house limit - stake up to 2.50 USDC on this ticket."],
  ["409 at-capacity", fail(409, "at-capacity", { maxStake: "0" }), [],
    "House bankroll is fully committed - try again shortly."],
  ["409 no fit", fail(409, "market-cap"), [], "Payout too large for the house limit on one of these markets."],
  ["409 market-cap names the leg, fitting stake", fail(409, "market-cap", { maxStake: "2500000", vault: "0xabc0000000000000000000000000000000000001" }), [leg],
    '"Arsenal win" is at the house limit - stake up to 2.50 USDC on this ticket.'],
  ["409 market-cap names the leg, no fit", fail(409, "market-cap", { maxStake: "0", vault: "0xabc0000000000000000000000000000000000001" }), [leg],
    '"Arsenal win" is at the house limit right now - drop it or try again later.'],
  ["409 market-cap unknown vault falls back", fail(409, "market-cap", { maxStake: "2500000", vault: "0xdead" }), [leg],
    "Payout too large for the house limit - stake up to 2.50 USDC on this ticket."],
  ["cannot-win", fail(400, "cannot-win"), [], "These legs contradict each other - this ticket can never win."],
  ["same-game", fail(400, "same-game"), [], "Two legs from the same game - parlays need different games. Drop one."],
  ["fallback", fail(400, "bad-legs"), [], "Could not quote this ticket. Check your selections and try again."],
] as const)("%s", (_, res, legs, want) => {
  expect(errorMessage(res, [...legs])).toBe(want);
});
