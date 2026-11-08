import { expect, test, vi } from "vitest";
import { createLeaderboardSource } from "./leaderboard-source";
import { DEPLOY_BLOCK, PARLAY_VAULT } from "./contracts";
import { appChain } from "./chain";

const taker = `0x${"1".repeat(40)}` as const;
const vault = `0x${"2".repeat(40)}` as const;
const head = { number: DEPLOY_BLOCK + 500n, hash: `0x${"a".repeat(64)}`, timestamp: 1_700_000_000n };

function client(logs = 2) {
  return {
    getBlock: vi.fn().mockResolvedValueOnce(head).mockResolvedValue({ ...head, number: head.number + 1n }),
    getLogs: vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => fromBlock > DEPLOY_BLOCK ? [] :
      Array.from({ length: logs }, (_, i) => ({ blockNumber: DEPLOY_BLOCK + BigInt(i), args: { id: BigInt(i + 1), taker, premium: 1_000_000n, maxPayout: 3_000_000n } }))),
    // Multicall3 answers every read in one eth_call; results mirror the contracts array.
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string; args?: unknown[] }[] }) => contracts.map(({ functionName }) => {
      if (functionName === "parlay") return { status: "success", result: { legs: [{ vault, isYes: true }], writer: taker, premium: 1_000_000n, maxPayout: 3_000_000n, status: 0 } };
      if (functionName === "settled") return { status: "success", result: true };
      if (functionName === "settleFractionWad") return { status: "success", result: 10n ** 18n };
      return { status: "failure", error: new Error(`unexpected ${functionName}`) };
    })),
  };
}

test("log scan builds rows with leg verdicts, then only rescans new blocks and keeps legs cached", async () => {
  const c = client();
  const load = createLeaderboardSource({ client: c as never, mode: "logs" });
  const first = await load();
  expect(first.rows).toHaveLength(2);
  expect(first.rows[0]).toMatchObject({ id: 1n, taker, legVerdicts: ["hit"], parlay: { premium: 1_000_000n, maxPayout: 3_000_000n } });
  expect(c.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: PARLAY_VAULT, fromBlock: DEPLOY_BLOCK, toBlock: head.number }));
  const parlayReads = () => c.multicall.mock.calls.flatMap(([a]) => a.contracts).filter(x => x.functionName === "parlay").length;
  expect(parlayReads()).toBe(2);
  expect(c.multicall).toHaveBeenCalledTimes(2); // legs, then vault states
  const second = await load();
  expect(second.rows).toHaveLength(2);
  expect(c.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: head.number + 1n }));
  expect(parlayReads()).toBe(2); // legs are immutable
});

test("subgraph mode lists tickets with the bearer token and never leaks the endpoint on failure", async () => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ data: { tickets: [
    { number: "7", taker, premium: "1000000", maxPayout: "3000000", mintBlock: String(DEPLOY_BLOCK), mintTimestamp: "1700000000" },
  ] } }));
  const load = createLeaderboardSource({ client: client() as never, mode: "subgraph", subgraph: { url: "https://index.invalid/secret-path", token: "tok" }, fetcher: fetcher as never });
  const { rows } = await load();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 7n, taker, mintedAtMs: 1_700_000_000_000, legVerdicts: ["hit"] });
  expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) });
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).variables.scope).toBe(`${appChain.id}:${PARLAY_VAULT.toLowerCase()}`);
  fetcher.mockRejectedValue(new Error("ECONNREFUSED https://index.invalid/secret-path"));
  await expect(load()).rejects.toThrow(/^Leaderboard source is unavailable$/);
});

test("a failed ticket read yields an unknown row instead of dropping the ticket", async () => {
  const c = client(1);
  c.multicall.mockResolvedValueOnce([{ status: "failure", error: new Error("boom") }]);
  const { rows } = await createLeaderboardSource({ client: c as never, mode: "logs" })();
  expect(rows[0]).toMatchObject({ dataError: true, legVerdicts: [] });
});
