import { expect, test } from "vitest";
import { parseCandles } from "./candles";

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
