import { test } from "node:test";
import assert from "node:assert/strict";
import { bestAskWad, fetchBestAskWad } from "../src/infoApi.js";

test("fetchBestAskWad returns null on an empty book instead of consulting allMids", async (t) => {
  // allMids carries zero outcome coins (verified 2026-08-25), so the old
  // allMids fallback could never answer — empty book must surface as null so
  // the caller can fall back to the 0x808 spotPx precompile instead.
  const calls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: { body?: string }) => {
    calls.push(JSON.parse(init?.body ?? "{}"));
    return new Response(JSON.stringify({ levels: [[], []] }), { status: 200 });
  });
  assert.equal(await fetchBestAskWad("https://info.example/info", "#137340"), null);
  assert.equal(calls.length, 1); // one l2Book call, no second allMids request
});

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
