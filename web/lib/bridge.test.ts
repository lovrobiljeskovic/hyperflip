import { describe, expect, it, vi } from "vitest";
import { BRIDGE, BRIDGE_GAS, bridgeFees, bridgeUsdc, outboundData } from "./bridge";

describe("bridge", () => {
  it("prices a retryable with both fee legs doubled", () => {
    expect(bridgeFees(1_000n, 7n)).toEqual({ maxSubmissionCost: 2_000n, maxGas: BRIDGE_GAS, gasPriceBid: 14n, value: 2_000n + BRIDGE_GAS * 14n });
  });

  it("encodes router data as (maxSubmissionCost, empty hook data)", () => {
    expect(outboundData(5n)).toBe(`0x${"5".padStart(64, "0")}${"40".padStart(64, "0")}${"0".repeat(64)}`);
  });

  it("skips approve when the gateway allowance covers the deposit and sends the fee as value", async () => {
    const taker = `0x${"a".repeat(40)}` as const;
    const fees = bridgeFees(1_000n, 7n);
    const core = { readContract: vi.fn(async () => 5_000_000n), waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) };
    const write = vi.fn(async (_args: unknown) => "0xhash" as `0x${string}`);
    await bridgeUsdc({ core: core as never, write, taker, amount: 5_000_000n, fees });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ address: BRIDGE.router, functionName: "outboundTransfer", value: fees.value, chainId: 998,
      args: [BRIDGE.usdc, taker, 5_000_000n, BRIDGE_GAS, 14n, outboundData(2_000n)] });
    core.readContract.mockResolvedValueOnce(0n);
    await bridgeUsdc({ core: core as never, write, taker, amount: 5_000_000n, fees });
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[1][0]).toMatchObject({ address: BRIDGE.usdc, functionName: "approve", args: [BRIDGE.gateway, 5_000_000n] });
  });
});
