import { test } from "node:test";
import assert from "node:assert/strict";
import { bestAskWad } from "../src/infoApi.js";

test("bestAskWad takes first ask level px as WAD", () => {
  const book = {
    levels: [
      [{ px: "0.60", sz: "100", n: 1 }],
      [{ px: "0.65", sz: "50", n: 1 }],
    ],
  };
  assert.equal(bestAskWad(book), 650_000_000_000_000_000n);
});

test("bestAskWad returns null on empty ask side", () => {
  assert.equal(bestAskWad({ levels: [[{ px: "0.6", sz: "1", n: 1 }], []] }), null);
  assert.equal(bestAskWad({}), null);
});
