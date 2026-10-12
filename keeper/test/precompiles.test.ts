import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters, encodeAbiParameters, getAddress } from "viem";
import {
  encodedOutcomeAssetId,
  OUTCOME_STATUS_PRECOMPILE,
  outcomeCoin,
  readOutcomeStatus,
  readSpotBalanceWei,
  readSpotPxWad,
  SPOT_BALANCE_PRECOMPILE,
  SPOT_PX_PRECOMPILE,
} from "../../services/precompiles.mjs";

const VAULT = "0x91a572427334c35bbe64d0f0354bcdc161769a57" as const;

/** Fake viem client: records the call, returns a canned response. */
function fakeClient(ret: `0x${string}`) {
  const calls: { to?: string; data?: `0x${string}`; blockNumber?: bigint }[] = [];
  return {
    calls,
    call: async (args: { to?: string; data?: `0x${string}`; blockNumber?: bigint }) => {
      calls.push(args);
      return { data: ret };
    },
  };
}

test("readSpotBalanceWei sends abi.encode(user, token) to 0x801 and returns only total", async () => {
  // hold and entryNtl must be ignored
  const client = fakeClient(encodeAbiParameters([{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }], [123_450n, 7n, 9n]));
  const total = await readSpotBalanceWei(client as never, VAULT, 100_137_340n);
  assert.equal(total, 123_450n);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].to, SPOT_BALANCE_PRECOMPILE);
  assert.equal(client.calls[0].data, encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [VAULT, 100_137_340n]));
  const [user, token] = decodeAbiParameters(
    [{ type: "address" }, { type: "uint64" }],
    client.calls[0].data!,
  );
  assert.equal(user.toLowerCase(), VAULT.toLowerCase());
  assert.equal(token, 100_137_340n);
});

test("readSpotBalanceWei throws on an empty response rather than inventing a zero balance", async () => {
  const client = { call: async () => ({ data: undefined }) };
  await assert.rejects(() => readSpotBalanceWei(client as never, VAULT, 100_137_340n), /empty spotBalance/);
});

test("readSpotBalanceWei throws on a response shorter than the words read", async () => {
  const client = fakeClient("0x1234");
  await assert.rejects(() => readSpotBalanceWei(client as never, VAULT, 100_137_340n), /short precompile response/);
});

test("readSpotBalanceWei calldata for a checksummed user equals viem's encoding", async () => {
  const mixed = getAddress(VAULT);
  assert.notEqual(mixed, VAULT);
  const client = fakeClient(encodeAbiParameters([{ type: "uint64" }], [1n]));
  await readSpotBalanceWei(client as never, mixed, 5n);
  assert.equal(client.calls[0].data, encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [mixed, 5n]));
});

test("readOutcomeStatus sends abi.encode(uint32 outcome) to 0x814 and decodes status, settledValue, question", async () => {
  const client = fakeClient(
    encodeAbiParameters([{ type: "uint8" }, { type: "uint64" }, { type: "uint32" }], [2, 100_000_000n, 4321]),
  );
  assert.deepEqual(await readOutcomeStatus(client as never, 13734), { status: 2, settledValue: 100_000_000n, question: 4321 });
  assert.equal(client.calls[0].to, OUTCOME_STATUS_PRECOMPILE);
  assert.equal(client.calls[0].data, encodeAbiParameters([{ type: "uint32" }], [13734]));
  const empty = { call: async () => ({ data: undefined }) };
  await assert.rejects(() => readOutcomeStatus(empty as never, 13734), /empty outcomeStatus/);
});

test("readSpotPxWad sends the encoded outcome asset id to 0x808 and scales 1e8 px to WAD", async () => {
  // Testnet-verified: NVDA outcome coin 137340, l2Book mid 0.1319,
  // spotPx raw 13190000 — so the raw px is 1e8-scaled and WAD = raw * 1e10.
  const client = fakeClient(encodeAbiParameters([{ type: "uint64" }], [13_190_000n]));
  const wad = await readSpotPxWad(client as never, 137340n);
  assert.equal(wad, 131_900_000_000_000_000n); // 0.1319e18
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].to, SPOT_PX_PRECOMPILE);
  assert.equal(client.calls[0].data, encodeAbiParameters([{ type: "uint32" }], [100_137_340]));
  const [index] = decodeAbiParameters([{ type: "uint32" }], client.calls[0].data!);
  assert.equal(index, 100_137_340); // 100000000 + coin id
});

test("readSpotPxWad throws on an empty response rather than inventing a zero price", async () => {
  const client = { call: async () => ({ data: undefined }) };
  await assert.rejects(() => readSpotPxWad(client as never, 137340n), /empty spotPx/);
});

test("encodedOutcomeAssetId matches L1Read.sol: 100000000 + 10*outcome + side", () => {
  // outcome 13734 = live NVDA market, coinYes "#137340" -> asset id 100137340 (testnet-verified)
  assert.equal(encodedOutcomeAssetId(13734, true), 100_137_340n);
  assert.equal(encodedOutcomeAssetId(13734, false), 100_137_341n);
  assert.equal(encodedOutcomeAssetId(0, true), 100_000_000n);
});

test("outcomeCoin: #<id*10> for yes, +1 for no", () => {
  assert.equal(outcomeCoin(13734, true), "#137340");
  assert.equal(outcomeCoin(13734, false), "#137341");
});
