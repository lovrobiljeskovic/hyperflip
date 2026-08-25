import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import { readSpotPxWad, SPOT_PX_PRECOMPILE } from "../src/spotPx.js";

/** Fake viem client: records the call, returns a canned uint64 px encoding. */
function fakeClient(raw: bigint) {
  const calls: { to?: string; data?: `0x${string}` }[] = [];
  return {
    calls,
    call: async (args: { to?: string; data?: `0x${string}` }) => {
      calls.push(args);
      return { data: encodeAbiParameters([{ type: "uint64" }], [raw]) };
    },
  };
}

test("readSpotPxWad sends the encoded outcome asset id to 0x808 and scales 1e8 px to WAD", async () => {
  // Testnet-verified 2026-08-25: NVDA outcome coin 137340, l2Book mid 0.1319,
  // spotPx raw 13190000 — so the raw px is 1e8-scaled and WAD = raw * 1e10.
  const client = fakeClient(13_190_000n);
  const wad = await readSpotPxWad(client as never, 137340n);
  assert.equal(wad, 131_900_000_000_000_000n); // 0.1319e18
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].to, SPOT_PX_PRECOMPILE);
  const [index] = decodeAbiParameters([{ type: "uint32" }], client.calls[0].data!);
  assert.equal(index, 100_137_340); // 100000000 + coin id
});

test("readSpotPxWad throws on an empty response rather than inventing a zero price", async () => {
  const client = { call: async () => ({ data: undefined }) };
  await assert.rejects(() => readSpotPxWad(client as never, 137340n), /empty spotPx/);
});
