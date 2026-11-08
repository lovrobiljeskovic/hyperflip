import { expect, test } from "vitest";
import { cardHeight, recordCardState, slipCardState, ticketCardState, ticketState } from "./share-card";
import { STATUS } from "./contracts";
import type { Row } from "./positions";

const vault = `0x${"1".repeat(40)}` as const;
const legs = [
  { isYes: true, title: "Texans vs Colts", label: "HOU" },
  { isYes: false, title: "Rams vs Broncos", label: "DEN" },
  { isYes: true, title: "Over 44.5", label: undefined, group: undefined },
];
function row(status: number, legVerdicts: Row["legVerdicts"], burned = false): Row {
  return { id: 7n, block: 1n, mintedAtMs: 0, burned, legVerdicts, owner: vault,
    parlay: { legs: legVerdicts.map(() => ({ vault, isYes: true })), writer: vault, premium: 5_000_000n, maxPayout: 40_000_000n, status } };
}

test("slip card: headline, legs with side labels, stake rows and TO WIN hero", () => {
  const s = slipCardState(legs, 5_000_000n, 40_000_000n);
  expect(s.headline).toBe("3 leg combo");
  expect(s.subline).toBe("All legs must hit.");
  expect(s.legs.map(l => l.label)).toEqual(["HOU", "DEN", "YES"]);
  expect(s.legs.every(l => l.dot === undefined)).toBe(true);
  expect(s.rows).toEqual([["Stake", "5.00 USDC"], ["Multiplier", "8.00x"]]);
  expect(s.hero).toEqual({ label: "TO WIN", value: "40.00", tone: "accent" });
});

test("slip card from a link alone has no stake rows and no hero", () => {
  const s = slipCardState(legs);
  expect(s.rows).toEqual([]);
  expect(s.hero).toBeNull();
});

test("ticketState maps every Positions status label", () => {
  expect(ticketState({ statusLabel: "Claimable" })).toBe("won");
  expect(ticketState({ statusLabel: "Claimed" })).toBe("won");
  expect(ticketState({ statusLabel: "Lost" })).toBe("lost");
  expect(ticketState({ statusLabel: "Voidable" })).toBe("void");
  expect(ticketState({ statusLabel: "Voided - premium refunded" })).toBe("void");
  expect(ticketState({ statusLabel: "1 of 3 settled" })).toBe("open");
  expect(ticketState({ statusLabel: "Updating outcomes" })).toBe("open");
});

test("ticket card: open shows settled count and dots, won/lost/void change subline and hero", () => {
  const open = ticketCardState(row(STATUS.Open, ["hit", "pending", "pending"]), legs, { statusLabel: "1 of 3 settled" });
  expect(open.subline).toBe("1 of 3 settled");
  expect(open.legs.map(l => l.dot)).toEqual(["hit", "pending", "pending"]);
  expect(open.hero).toEqual({ label: "TO WIN", value: "40.00", tone: "accent" });

  const won = ticketCardState(row(STATUS.Won, ["hit", "hit", "hit"], true), legs, { statusLabel: "Claimed" });
  expect(won.subline).toBe("WON");
  expect(won.hero).toEqual({ label: "WON", value: "+35.00", tone: "yes" });

  const lost = ticketCardState(row(STATUS.Open, ["hit", "lost", "pending"]), legs, { statusLabel: "Lost" });
  expect(lost.subline).toBe("LOST");
  expect(lost.hero).toEqual({ label: "LOST", value: "−5.00", tone: "no" });

  const voided = ticketCardState(row(STATUS.Void, ["fractional", "hit", "hit"]), legs, { statusLabel: "Voided - premium refunded" });
  expect(voided.subline).toBe("VOID");
  expect(voided.hero).toEqual({ label: "RETURNED", value: "5.00", tone: "dim" });
  expect(voided.rows).toEqual([["Stake", "5.00 USDC"], ["Multiplier", "8.00x"]]);
});

test("ticket card with an unknown verdict still renders as open", () => {
  const s = ticketCardState(row(STATUS.Open, ["unknown", "hit", "pending"]), legs, { statusLabel: "Updating outcomes" });
  expect(s.subline).toBe("1 of 3 settled");
  expect(s.legs[0].dot).toBe("pending");
});

test("record card: W-L headline, chain subline, Win % and Settled rows, RANK hero", () => {
  const s = recordCardState({ wins: 7, losses: 2, rank: 3, winRate: 7 / 9 }, "HyperEVM Testnet");
  expect(s.headline).toBe("7-2");
  expect(s.subline).toBe("on HyperEVM Testnet");
  expect(s.legs).toEqual([]);
  expect(s.rows).toEqual([["Win %", "77.8%"], ["Settled", "9"]]);
  expect(s.hero).toEqual({ label: "RANK", value: "#3", tone: "accent" });
});

test("cardHeight follows the canvas card: 520 + legs × 112 + 300; record is 780", () => {
  expect(cardHeight(3)).toBe(1156);
  expect(cardHeight(0)).toBe(780);
});
