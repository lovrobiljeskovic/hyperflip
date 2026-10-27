import type { BuilderLeg } from "./ticket";
import type { QuoteResult } from "./writer";
import { formatUsdc } from "./format";

export function errorMessage(res: Extract<QuoteResult, { ok: false }>, legs: BuilderLeg[] = []): string {
  if (res.status === 400 && res.error === "dominated") {
    const keep = legs.find((l) => l.vault.toLowerCase() === res.vault?.toLowerCase());
    return keep
      ? `This ticket pays less than "${keep.title}" alone. Remove a leg or choose another game.`
      : "This ticket pays less than one leg alone. Remove a leg or choose another game.";
  }
  if (res.error === "clock-skew") return "Quote expired immediately - check your clock.";
  if (res.error === "stale-book") return "No live price for one of these markets right now - try again shortly.";
  if (res.error === "unpriced-leg") return "One leg has no live price right now. Soccer markets close at kickoff - remove it and requote.";
  if (res.error === "warming-up") return "Writer just restarted and is warming up - retry in a few seconds.";
  if (res.error === "rpc-down") return "Chain RPC is rate-limiting the writer - retry in a moment.";
  if (res.status === 0 || res.status === 503) return "Writer unreachable - retrying.";
  if (res.status === 429) return "Too many quotes too fast - pausing a moment.";
  if (res.status === 401 || res.status === 403) return "Sign in with this wallet again to continue.";
  if (res.status === 409) {
    if (res.error === "leg-settled") return "A leg just settled - remove it and requote.";
    if (res.error === "quota-cap")
      return "This account has hit its open-ticket quota - wait for reservations to clear.";
    const fit = res.maxStake === undefined ? 0n : BigInt(res.maxStake);
    const full = legs.find((l) => l.vault.toLowerCase() === res.vault?.toLowerCase());
    if (full && fit > 0n) return `"${full.title}" is at the house limit - stake up to ${formatUsdc(fit)} USDC on this ticket.`;
    if (full) return `"${full.title}" is at the house limit right now - drop it or try again later.`;
    if (fit > 0n) return `Payout too large for the house limit - stake up to ${formatUsdc(fit)} USDC on this ticket.`;
    if (res.error === "at-capacity") return "House bankroll is fully committed - try again shortly.";
    return "Payout too large for the house limit on one of these markets.";
  }
  if (res.status === 400 && res.error === "cannot-win")
    return "These legs contradict each other - this ticket can never win.";
  if (res.status === 400 && res.error === "same-game")
    return "Two legs from the same game - parlays need different games. Drop one.";
  return "Could not quote this ticket. Check your selections and try again.";
}
