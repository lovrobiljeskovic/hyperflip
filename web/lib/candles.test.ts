import { expect, test } from "vitest";
import { parseBook, parseCandles } from "./candles";

test("parseCandles keeps finite probability closes, oldest first, and drops junk", () => {
  expect(
    parseCandles([
      { t: 2000, c: "0.60" },
      { t: 1000, c: "0.55" },
      { t: 3000, c: "1.5" },
      { t: 4000, c: "nope" },
      { t: "x", c: "0.5" },
      null,
    ]),
  ).toEqual([
    { t: 1000, c: 0.55 },
    { t: 2000, c: 0.6 },
  ]);
  expect(parseCandles({ error: "bad" })).toEqual([]);
});

test("parseBook keeps the top levels per side and drops junk", () => {
  expect(
    parseBook(
      {
        levels: [
          [{ px: "0.56", sz: "40" }, { px: "0.55", sz: "0" }, { px: "x", sz: "1" }, { px: "0.54", sz: "25" }, { px: "0.53", sz: "1" }],
          [{ px: "0.60", sz: "44" }],
        ],
      },
      2,
    ),
  ).toEqual({ bids: [{ px: 0.56, sz: 40 }, { px: 0.54, sz: 25 }], asks: [{ px: 0.6, sz: 44 }] });
  expect(parseBook({ levels: [[]] })).toEqual({ bids: [], asks: [] });
  expect(parseBook(null)).toEqual({ bids: [], asks: [] });
});
