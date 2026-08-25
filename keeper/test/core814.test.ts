import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import { readSpotBalanceWei, SPOT_BALANCE_PRECOMPILE } from "../src/core814.js";

const VAULT = "0x91a572427334c35bbe64d0f0354bcdc161769a57" as const;

/** Fake viem client: records the call, returns a canned 96-byte SpotBalance encoding. */
function fakeClient(total: bigint) {
  const calls: { to?: string; data?: `0x${string}`; blockNumber?: bigint }[] = [];
  return {
    calls,
    call: async (args: { to?: string; data?: `0x${string}`; blockNumber?: bigint }) => {
      calls.push(args);
      return {
        data: encodeAbiParameters(
          [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
          [total, 7n, 9n], // hold and entryNtl must be ignored
        ),
      };
    },
  };
}

test("readSpotBalanceWei sends abi.encode(user, token) to 0x801 and returns only total", async () => {
  const client = fakeClient(123_450n);
  const total = await readSpotBalanceWei(client as never, VAULT, 100_137_340n);
  assert.equal(total, 123_450n);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].to, SPOT_BALANCE_PRECOMPILE);
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
