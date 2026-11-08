import { formatUsdc, multiplier, pct1 } from "./format";
import type { Row } from "./positions";
import { legLabel, type BuilderLeg } from "./ticket";

export type CardLeg = { label: string; title: string; isYes: boolean; dot?: "pending" | "hit" | "lost" | "fractional" };
export type CardHero = { label: string; value: string; tone: "accent" | "yes" | "no" | "dim" };
/** Everything the share card draws, for a slip, a ticket or a record; the renderer owns the pixels. */
export type CardState = { headline: string; subline: string; legs: CardLeg[]; rows: [string, string][]; hero: CardHero | null };
export type TicketState = "open" | "won" | "lost" | "void";
type LegInput = Pick<BuilderLeg, "isYes" | "title" | "label" | "group">;

/** Pixel height of the natural (unscaled) card: header, one 112px row per leg, and the stake and
 * hero blocks only when the state has them (a link-only slip has neither). A full three-leg ticket
 * is 1156, the height of the retired canvas card. */
export const cardHeight = (state: Pick<CardState, "legs" | "rows" | "hero">): number =>
  300 + state.legs.length * 112 + (state.rows.length ? 140 : 0) + (state.hero ? 200 : 0) + 180;

const toLeg = (l: LegInput): CardLeg => ({ label: l.group ? legLabel(l) : legLabel(l).toUpperCase(), title: l.title, isYes: l.isYes });
const stakeRows = (premium: bigint, maxPayout: bigint): [string, string][] =>
  [["Stake", `${formatUsdc(premium)} USDC`], ["Multiplier", multiplier(premium, maxPayout)]];

export function slipCardState(legs: LegInput[], premium?: bigint, maxPayout?: bigint): CardState {
  const priced = premium !== undefined && maxPayout !== undefined;
  return {
    headline: `${legs.length} leg combo`,
    subline: "All legs must hit.",
    legs: legs.map(toLeg),
    rows: priced ? stakeRows(premium, maxPayout) : [],
    hero: priced ? { label: "TO WIN", value: formatUsdc(maxPayout), tone: "accent" } : null,
  };
}

/** One mapping from the Positions status label; "Updating outcomes" and partial settlement are open. */
export function ticketState(view: { statusLabel: string }): TicketState {
  const l = view.statusLabel;
  if (l === "Claimable" || l === "Claimed") return "won";
  if (l === "Lost") return "lost";
  if (l.startsWith("Void")) return "void";
  return "open";
}

export function ticketCardState(row: Row, legs: LegInput[], view: { statusLabel: string }): CardState {
  const state = ticketState(view);
  const { premium, maxPayout } = row.parlay;
  const dots = row.legVerdicts.map((v) => (v === "unknown" ? "pending" : v));
  const settled = dots.filter((d) => d !== "pending").length;
  const subline = state === "open" ? `${settled} of ${dots.length} settled` : state.toUpperCase();
  const hero: CardHero = state === "won" ? { label: "WON", value: `+${formatUsdc(maxPayout - premium)}`, tone: "yes" }
    : state === "lost" ? { label: "LOST", value: `−${formatUsdc(premium)}`, tone: "no" }
    : state === "void" ? { label: "RETURNED", value: formatUsdc(premium), tone: "dim" }
    : { label: "TO WIN", value: formatUsdc(maxPayout), tone: "accent" };
  return {
    headline: `${legs.length} leg combo`,
    subline,
    legs: legs.map((l, i) => ({ ...toLeg(l), dot: dots[i] ?? "pending" })),
    rows: stakeRows(premium, maxPayout),
    hero,
  };
}

export function recordCardState(e: { wins: number; losses: number; rank: number; winRate: number }, chainName: string): CardState {
  return {
    headline: `${e.wins}-${e.losses}`,
    subline: `on ${chainName}`,
    legs: [],
    rows: [["Win %", pct1(e.winRate)], ["Settled", String(e.wins + e.losses)]],
    hero: { label: "RANK", value: `#${e.rank}`, tone: "accent" },
  };
}

/** Rows the holder can brag about or own up to; not tickets that moved to another wallet or whose outcome is unknown. */
const HIDDEN = new Set(["Updating outcomes", "Transferred out", "Paid to later owner"]);
export const shareableTicket = (view: { statusLabel: string }): boolean => !HIDDEN.has(view.statusLabel);
