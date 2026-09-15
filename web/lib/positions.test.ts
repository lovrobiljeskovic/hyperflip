import { expect, test, vi } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { deriveRow, loadPositions, loadRow, type Row } from "./positions";
import { DEPLOY_BLOCK, parlayVaultAbi, STATUS } from "./contracts";
import { fetchParlays } from "./writer";

vi.mock("./writer", () => ({ fetchParlays: vi.fn() }));
const vault = `0x${"1".repeat(40)}` as const;
const parlay = { legs: [{ vault, isYes: true }], writer: vault, premium: 1000000n, maxPayout: 2000000n, status: STATUS.Won };
const row: Row = { id: 1n, block: DEPLOY_BLOCK, mintedAtMs: 0, parlay, burned: false, legVerdicts: ["hit"] };

function client(ownerError?: Error) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "parlay") return parlay;
      if (functionName === "ownerOf") { if (ownerError) throw ownerError; return vault; }
      if (functionName === "settled") return true;
      if (functionName === "settleFractionWad") return 10n ** 18n;
      throw new Error("unexpected read");
    },
    getBlock: async () => ({ timestamp: 10n }),
  };
}

test("position ownership RPC failures are not treated as burned tickets", async () => {
  await expect(loadRow(client(new Error("RPC unavailable")) as never, row)).rejects.toThrow("RPC unavailable");
  const burned = new ContractFunctionRevertedError({ abi: parlayVaultAbi, functionName: "ownerOf",
    data: encodeErrorResult({ abi: parlayVaultAbi, errorName: "ERC721NonexistentToken", args: [1n] }) });
  expect((await loadRow(client(burned) as never, row)).burned).toBe(true);
  expect((await loadRow(client() as never, row)).legVerdicts).toEqual(["hit"]);
});

test("position statuses retain claim, resolve, lost and refunded behavior", () => {
  expect(deriveRow(row).action?.kind).toBe("claim");
  expect(deriveRow({ ...row, burned: true }).statusLabel).toBe("Claimed");
  for (const [legVerdicts, label, kind] of [
    [["pending"], "0 of 1 settled", undefined], [["hit"], "Claimable", "claim"],
    [["lost"], "Lost", undefined], [["fractional"], "Voidable", "resolve"],
  ] as const) {
    const view = deriveRow({ ...row, parlay: { ...parlay, status: STATUS.Open }, legVerdicts: [...legVerdicts] });
    expect(view.statusLabel).toBe(label);
    expect(view.action?.kind).toBe(kind);
  }
  expect(deriveRow({ ...row, parlay: { ...parlay, status: STATUS.Dead } }).statusLabel).toBe("Lost");
  expect(deriveRow({ ...row, parlay: { ...parlay, status: STATUS.Void } }).statusLabel).toContain("premium refunded");
});

test("partial row failures retain other positions with bounded concurrency", async () => {
  vi.mocked(fetchParlays).mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({ id: BigInt(i), block: DEPLOY_BLOCK })));
  let active = 0;
  let peak = 0;
  const fake = client();
  const read = fake.readContract;
  fake.readContract = async (request) => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (request.functionName === "parlay" && (request as { args?: bigint[] }).args?.[0] === 1n) throw new Error("partial failure");
    return read(request);
  };
  const loaded = await loadPositions(fake as never, vault);
  expect(loaded.failed).toBe(1);
  expect(loaded.rows.length).toBe(13);
  expect(loaded.rows[0].id).toBe(13n);
  expect(peak).toBeLessThanOrEqual(6);
});
