import { expect, test, vi } from "vitest";
import { loadTicketCard, parseTicketId } from "./ticket-card";
import { STATUS } from "./contracts";

const vault = `0x${"1".repeat(40)}` as const;
const markets = async () => [{ vault, title: "Texans vs Colts", category: "sports", coinYes: "#1", coinNo: "#2", sideYes: "HOU", sideNo: "IND" }];

test("parseTicketId accepts plain decimal ids only", () => {
  expect(parseTicketId("7")).toBe(7n);
  expect(parseTicketId("abc")).toBeNull();
  expect(parseTicketId("-1")).toBeNull();
  expect(parseTicketId("99999999999999999999")).toBeNull();
  expect(parseTicketId("")).toBeNull();
});

test("loadTicketCard maps a claimed ticket to a WON card and a failed read to null", async () => {
  const read = vi.fn().mockResolvedValue({ id: 7n, burned: true, owner: null, legVerdicts: ["hit"],
    parlay: { legs: [{ vault, isYes: true }], writer: vault, premium: 5_000_000n, maxPayout: 40_000_000n, status: STATUS.Won } });
  const card = await loadTicketCard(7n, { read, markets, client: {} as never });
  expect(card?.subline).toBe("WON");
  expect(card?.legs[0]).toMatchObject({ label: "HOU", dot: "hit" });
  read.mockRejectedValue(new Error("rpc https://provider.invalid/secret"));
  expect(await loadTicketCard(7n, { read, markets, client: {} as never })).toBeNull();
});

test("a leg whose market left the registry still renders with YES/NO and the vault as title", async () => {
  const read = vi.fn().mockResolvedValue({ id: 8n, burned: false, owner: vault, legVerdicts: ["pending"],
    parlay: { legs: [{ vault: `0x${"2".repeat(40)}`, isYes: false }], writer: vault, premium: 1_000_000n, maxPayout: 2_000_000n, status: STATUS.Open } });
  const card = await loadTicketCard(8n, { read, markets, client: {} as never });
  expect(card?.legs[0]).toMatchObject({ label: "NO", dot: "pending" });
  expect(card?.legs[0].title).toMatch(/^0x2222…2222$/);
});

test("an unminted id (empty parlay, ownerOf reverted) is not a ticket", async () => {
  const read = vi.fn().mockResolvedValue({ id: 99_999_999_999n, burned: true, owner: null, legVerdicts: [],
    parlay: { legs: [], writer: `0x${"0".repeat(40)}`, premium: 0n, maxPayout: 0n, status: STATUS.Open } });
  expect(await loadTicketCard(99_999_999_999n, { read, markets, client: {} as never })).toBeNull();
});
