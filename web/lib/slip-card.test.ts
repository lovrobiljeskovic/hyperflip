import { expect, test } from "vitest";
import { loadSlipCard } from "./slip-card";

const a = `0x${"a".repeat(40)}` as const, b = `0x${"b".repeat(40)}` as const;
const markets = async () => [{ vault: a, title: "Texans vs Colts", category: "sports", coinYes: "#1", coinNo: "#2", sideYes: "HOU", sideNo: "IND" }];

test("loadSlipCard resolves legs on the board, drops the rest, and is null when none resolve", async () => {
  const card = await loadSlipCard(`?leg=${a}&leg=${b}%3An`, markets);
  expect(card?.headline).toBe("1 leg combo");
  expect(card?.legs[0]).toMatchObject({ label: "HOU", isYes: true });
  expect(card?.hero).toBeNull();
  expect(await loadSlipCard(`?leg=${b}`, markets)).toBeNull();
  expect(await loadSlipCard("", markets)).toBeNull();
  expect(await loadSlipCard(`?leg=${a}`, async () => { throw new Error("writer down"); })).toBeNull();
});
