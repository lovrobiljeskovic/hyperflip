import { beforeEach, expect, test, vi } from "vitest";
import { scanParlayIds } from "./scan";
import { DEPLOY_BLOCK } from "./contracts";

const TAKER = "0x1111111111111111111111111111111111111111" as const;

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

/** Records every range asked for, and how many calls were in flight at once. */
function fakeClient(head: bigint, logsAt: Record<string, { id: bigint; block: bigint }> = {}) {
  const ranges: [bigint, bigint][] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    ranges,
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const hit = logsAt[fromBlock.toString()];
      return hit ? [{ args: { id: hit.id }, blockNumber: hit.block }] : [];
    },
  };
}

test("covers every 1000-block range from the deploy block to head, with no gaps", async () => {
  const head = DEPLOY_BLOCK + 4500n;
  const client = fakeClient(head);
  await scanParlayIds(client as never, TAKER);

  const sorted = [...client.ranges].sort((a, b) => Number(a[0] - b[0]));
  expect(sorted.length).toBe(5);
  expect(sorted[0][0]).toBe(DEPLOY_BLOCK);
  expect(sorted.at(-1)![1]).toBe(head); // last chunk stops at head, not past it
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i][0]).toBe(sorted[i - 1][1] + 1n); // contiguous
  }
});

test("runs chunks concurrently rather than one at a time", async () => {
  const client = fakeClient(DEPLOY_BLOCK + 50_000n);
  await scanParlayIds(client as never, TAKER);
  expect(client.peak()).toBeGreaterThan(1);
});

test("checkpoints head and resumes from it, keeping already-found ids", async () => {
  const head = DEPLOY_BLOCK + 1500n;
  const first = fakeClient(head, { [DEPLOY_BLOCK.toString()]: { id: 7n, block: DEPLOY_BLOCK + 5n } });
  const found = await scanParlayIds(first as never, TAKER);
  expect(found).toEqual([{ id: 7n, block: DEPLOY_BLOCK + 5n }]);

  const second = fakeClient(head + 1000n);
  const again = await scanParlayIds(second as never, TAKER);
  expect(again).toEqual([{ id: 7n, block: DEPLOY_BLOCK + 5n }]); // survives the checkpoint round trip
  expect(second.ranges[0][0]).toBe(head + 1n); // resumed, did not rescan from deploy
});

test("a failing chunk leaves no checkpoint, so the next load rescans the hole", async () => {
  const client = fakeClient(DEPLOY_BLOCK + 3000n);
  const boom = { ...client, getLogs: async () => { throw new Error("upstream missing data"); } };
  await expect(scanParlayIds(boom as never, TAKER)).rejects.toThrow();
  expect([...store.keys()]).toEqual([]);
});
