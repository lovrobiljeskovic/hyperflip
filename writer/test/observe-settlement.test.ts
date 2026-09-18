import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseError, ExecutionRevertedError, encodeAbiParameters } from "viem";
import { observeSettlement, requireTestnet } from "../src/observe-settlement.js";

test("settlement observer records full Core state and separates pruning reverts from RPC errors", async () => {
  let call = 0;
  const result = await observeSettlement({ call: async () => {
    switch (call++) {
      case 0: return { data: encodeAbiParameters([{ type: "uint8" }, { type: "uint64" }, { type: "uint32" }], [3, 100000000n, 4294967295]) };
      case 1: return { data: encodeAbiParameters([{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }], [1900000000n, 0n, 0n]) };
      case 2: throw new BaseError("call failed", { cause: new ExecutionRevertedError({ message: "execution reverted" }) });
      default: throw new Error("HTTP 429 https://private.example/SECRET");
    }
  } } as Parameters<typeof observeSettlement>[0]);
  assert.equal(call, 4);
  const reads = result.reads as Record<string, unknown>[];
  assert.equal(reads[0].status, 3);
  assert.equal(reads[0].settledValue, "100000000");
  assert.equal(reads[1].total, "1900000000");
  assert.equal(reads[1].hold, "0");
  assert.equal(reads[1].entryNtl, "0");
  assert.equal(reads[2].error, "revert");
  assert.equal(reads[3].error, "rpc-error");
  assert(!JSON.stringify(result).includes("SECRET"));
});

test("settlement observer refuses a non-testnet RPC", async () => {
  await assert.rejects(requireTestnet({ getChainId: async () => 999 }), /requires testnet/);
  await requireTestnet({ getChainId: async () => 998 });
});
