import { afterEach, expect, test, vi } from "vitest";
import { createPositionsIndex, parsePositionQuery } from "./positions-index";
import { DEPLOY_BLOCK, PARLAY_VAULT } from "./contracts";

const wallet = `0x${"1".repeat(40)}`;
const vault = `0x${"2".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
const scope = `998:${PARLAY_VAULT.toLowerCase()}`;
const block = Number(DEPLOY_BLOCK) + 100;
const query = (extra = "") => new URLSearchParams(`wallet=${wallet}${extra}`);
afterEach(() => vi.useRealTimers());

function setup(count = 21) {
  const now = Math.floor(Date.now() / 1000);
  const meta = { block: { number: block, hash, timestamp: now }, hasIndexingErrors: false };
  const tickets = Array.from({ length: count }, (_, i) => ({ ticket: {
    id: `${scope}:${count - i}`, number: String(count - i), taker: wallet, owner: wallet,
    premium: "1000000", maxPayout: "2000000", status: 0, burned: false, burnHolder: null,
    mintBlock: String(DEPLOY_BLOCK), mintHash: hash, mintTimestamp: String(now - 100),
  } }));
  const page = { _meta: meta, deployment: { chainId: "998", vault: PARLAY_VAULT, startBlock: String(DEPLOY_BLOCK), schemaVersion: 1 }, walletTickets: tickets };
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ data: body.variables ? { ...page, walletTickets: tickets.filter(t => BigInt(t.ticket.number) < BigInt(body.variables.before)).slice(0, body.variables.first) } : { _meta: meta } });
  });
  const client = {
    getChainId: vi.fn(async () => 998),
    getBlock: vi.fn(async () => ({ number: BigInt(block), hash, timestamp: BigInt(now) })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "parlay") return { writer: wallet, premium: 1000000n, maxPayout: 2000000n, status: 0,
        legs: [{ vault, isYes: true }, { vault, isYes: false }] };
      if (functionName === "settled") return false;
      if (functionName === "settleFractionWad") return 10n ** 18n;
      throw new Error("unexpected RPC");
    }),
  };
  const load = createPositionsIndex(client as never, "https://index.invalid", "secret-token", fetcher as typeof fetch);
  return { load, page, tickets, meta, client, fetcher };
}

test("20-ticket pages dedupe repeated legs and concurrent requests; pagination pins the snapshot", async () => {
  const s = setup();
  const [a, b] = await Promise.all([s.load(query()), s.load(query())]);
  expect(a).toEqual(b);
  expect(a.rows).toHaveLength(20);
  expect(a.next).toBe("2");
  expect(a.rows[0].id).toBe(21n);
  expect(a.rows[0].legVerdicts).toEqual(["pending", "pending"]);
  expect(s.client.readContract).toHaveBeenCalledTimes(21); // 20 tickets + one unique market.
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  const next = await s.load(query(`&before=2&block=${block}&snapshot=${hash}`));
  expect(next.rows.map(r => r.id)).toEqual([1n]);
  expect(next.next).toBeNull();
  expect(JSON.parse(String(s.fetcher.mock.calls.at(-1)![1]!.body)).variables.block).toEqual({ hash });
});

test("input validation rejects malformed wallets, unbounded pages and unpinned cursors", () => {
  for (const value of ["wallet=bad", `wallet=${wallet}&limit=51`, `wallet=${wallet}&limit=0`,
    `wallet=${wallet}&before=1`, `wallet=${wallet}&snapshot=${hash}`, `wallet=${wallet}&before=-1&block=1&snapshot=${hash}`]) {
    expect(() => parsePositionQuery(new URLSearchParams(value))).toThrow("Invalid positions query");
  }
});

test("GraphQL HTTP-200 errors, index errors, identity mismatches and timeouts never become an empty wallet", async () => {
  for (const failure of ["graphql", "index", "identity", "timeout"] as const) {
    const s = setup();
    if (failure === "graphql") s.fetcher.mockResolvedValue(Response.json({ errors: [{ message: "private detail" }] }));
    if (failure === "index") s.meta.hasIndexingErrors = true;
    if (failure === "identity") s.page.deployment.chainId = "999";
    if (failure === "timeout") s.fetcher.mockRejectedValue(new Error("Timeout at credential-bearing URL"));
    await expect(s.load(query())).rejects.toThrow(/Index is not ready|index is temporarily unavailable|deployment mismatch/);
  }
});

test("reorged snapshots fail; old index heads are marked stale", async () => {
  const reorg = setup();
  reorg.client.getBlock.mockResolvedValue({ number: BigInt(block), hash: `0x${"b".repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  await expect(reorg.load(query())).rejects.toMatchObject({ status: 409 });
  const lag = setup();
  lag.meta.block.timestamp -= 61;
  expect((await lag.load(query())).stale).toBe(true);
});

test("RPC failures keep ticket shells and unknown outcomes; burnt tickets still hydrate", async () => {
  const s = setup(2);
  s.tickets[0].ticket.status = 1;
  s.tickets[0].ticket.burned = true;
  Object.assign(s.tickets[0].ticket, { owner: null, burnHolder: wallet });
  s.client.readContract.mockRejectedValueOnce(new Error("Ticket RPC failed"));
  const page = await s.load(query());
  expect(page.rows).toHaveLength(2);
  expect(page.failed).toBe(1);
  expect(page.rows[0]).toMatchObject({ burned: true, dataError: true });
  const outcomes = setup(1);
  const read = outcomes.client.readContract.getMockImplementation()!;
  outcomes.client.readContract.mockImplementation(async args => {
    if (args.functionName === "settled") throw new Error("RPC offline");
    return read(args);
  });
  expect((await outcomes.load(query())).rows[0].legVerdicts).toEqual(["unknown", "unknown"]);
});

test("warm pages retain immutable legs and refresh market reads after expiry", async () => {
  vi.useFakeTimers();
  const s = setup(2);
  await s.load(query());
  expect(s.client.readContract).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.now() + 16_000);
  await s.load(query());
  expect(s.client.readContract).toHaveBeenCalledTimes(4);
});
