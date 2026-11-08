import "server-only";
import { createPublicClient, fallback, http, isAddress, type Address, type PublicClient } from "viem";
import { appChain } from "./chain";
import { DEPLOY_BLOCK, MULTICALL3, PARLAY_VAULT, outcomeVaultAbi, parlayMintedEvent, parlayVaultAbi, STATUS } from "./contracts";
import { INDEXED_POSITIONS, legVerdict, type Leg, type ParlayData, type Row } from "./positions";
import { WAD } from "./format";

type Minted = { id: bigint; taker: Address; premium: bigint; maxPayout: bigint; block: bigint; mintedAtMs: number };
type Legs = { legs: readonly Leg[]; writer: Address };
type Source = {
  client: PublicClient;
  /** `subgraph` lists tickets from Goldsky (998); `logs` scans ParlayMinted over RPC (Elysium, no range cap). */
  mode: "subgraph" | "logs";
  subgraph?: { url: string; token?: string };
  fetcher?: typeof fetch;
};

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const SCOPE = `${appChain.id}:${PARLAY_VAULT.toLowerCase()}`;
const TICKETS_QUERY = `query Tickets($scope: String!) {
  tickets(first: 1000, orderBy: number, where: { deployment: $scope }) { number taker premium maxPayout mintBlock mintTimestamp }
}`;
const UNAVAILABLE = "Leaderboard source is unavailable";

/** Every ticket on this lane with the leg verdicts the Positions page derives status from.
 * Status is left Open on purpose: all-hit, a lost leg, or a fractional leg decide won / lost /
 * void on their own, so legs (immutable) are read once and only vault states are re-read.
 * Same reads as positions-index.ts, through Multicall3 (public RPCs admit ~7 calls a burst),
 * without its per-wallet paging and snapshot pinning. */
export function createLeaderboardSource({ client, mode, subgraph, fetcher = fetch }: Source) {
  // ponytail: per-process memory. Scan checkpoint and legs; one Vercel instance per lane, and
  // the page itself is ISR-cached, so a cold instance costs one full scan.
  const scan = { to: DEPLOY_BLOCK - 1n, minted: [] as Minted[] };
  const legsById = new Map<bigint, Legs>();

  async function listFromLogs(head: bigint): Promise<Minted[]> {
    if (head > scan.to) {
      const logs = await client.getLogs({ address: PARLAY_VAULT, event: parlayMintedEvent, fromBlock: scan.to + 1n, toBlock: head });
      for (const log of logs) {
        const { id, taker, premium, maxPayout } = log.args;
        if (id === undefined || !taker || premium === undefined || maxPayout === undefined || log.blockNumber === null) continue;
        scan.minted.push({ id, taker, premium, maxPayout, block: log.blockNumber, mintedAtMs: 0 });
      }
      scan.to = head;
    }
    return scan.minted;
  }

  async function listFromSubgraph(): Promise<Minted[]> {
    if (!subgraph) throw new Error(UNAVAILABLE);
    const response = await fetcher(subgraph.url, { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", ...(subgraph.token ? { Authorization: `Bearer ${subgraph.token}` } : {}) },
      body: JSON.stringify({ query: TICKETS_QUERY, variables: { scope: SCOPE } }),
      // Cached with the page's revalidate window; an explicit no-store would make the route dynamic.
      next: { revalidate: 60 } });
    const body = await response.json();
    const tickets = body?.data?.tickets;
    if (!response.ok || body.errors?.length || !Array.isArray(tickets)) throw new Error(UNAVAILABLE);
    return tickets.map((t: Record<string, string>) => {
      if (![t.number, t.premium, t.maxPayout, t.mintBlock, t.mintTimestamp].every(v => typeof v === "string" && DECIMAL.test(v)) ||
          !isAddress(t.taker, { strict: false })) throw new Error(UNAVAILABLE);
      return { id: BigInt(t.number), taker: t.taker as Address, premium: BigInt(t.premium), maxPayout: BigInt(t.maxPayout),
        block: BigInt(t.mintBlock), mintedAtMs: Number(t.mintTimestamp) * 1000 };
    });
  }

  type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };
  const call = (contracts: unknown[], blockNumber: bigint): Promise<Result[]> =>
    client.multicall({ contracts: contracts as never, blockNumber, allowFailure: true, batchSize: 0 }) as Promise<Result[]>;

  /** Legs for every ticket, one Multicall3 round trip for the ones not yet known. */
  async function readLegs(minted: Minted[], blockNumber: bigint): Promise<(Legs | null)[]> {
    const missing = minted.filter(m => !legsById.has(m.id));
    if (missing.length) {
      const results = await call(missing.map(m => ({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "parlay", args: [m.id] })), blockNumber);
      missing.forEach((m, i) => {
        const r = results[i];
        if (r?.status !== "success") return;
        const parlay = r.result as ParlayData;
        if (parlay.premium !== m.premium || parlay.maxPayout !== m.maxPayout || !parlay.legs.length || parlay.legs.length > 10) return;
        legsById.set(m.id, { legs: parlay.legs, writer: parlay.writer });
      });
    }
    return minted.map(m => legsById.get(m.id) ?? null);
  }

  /** settled + settleFractionWad per vault, one Multicall3 round trip. */
  async function readOutcomes(vaults: Address[], blockNumber: bigint) {
    const results = await call(vaults.flatMap(address => [
      { address, abi: outcomeVaultAbi, functionName: "settled" },
      { address, abi: outcomeVaultAbi, functionName: "settleFractionWad" },
    ]), blockNumber);
    type Outcome = { settled: boolean; fraction: bigint | null } | null;
    return new Map(vaults.map((v, i): [Address, Outcome] => {
      const settled = results[2 * i], fraction = results[2 * i + 1];
      if (settled?.status !== "success") return [v, null];
      if (settled.result === false) return [v, { settled: false, fraction: null }];
      const wad = fraction?.status === "success" ? fraction.result as bigint : null;
      return [v, wad === null || wad < 0n || wad > WAD ? null : { settled: true, fraction: wad }];
    }));
  }

  return async function load(): Promise<{ rows: Row[]; observedAt: number }> {
    const { head, minted, legs, outcomes } = await (async () => {
      const head = await client.getBlock({ blockTag: "latest" });
      if (head.number === null) throw new Error(UNAVAILABLE);
      const minted = mode === "logs" ? await listFromLogs(head.number) : await listFromSubgraph();
      const legs = await readLegs(minted, head.number);
      const vaults = [...new Set(legs.flatMap(l => l?.legs.map(leg => leg.vault.toLowerCase() as Address) ?? []))];
      const outcomes = await readOutcomes(vaults, head.number);
      return { head, minted, legs, outcomes };
    })().catch(() => {
      // Provider errors can carry credential-bearing URLs. Never surface them.
      throw new Error(UNAVAILABLE);
    });
    const rows = minted.map((m, i): Row => {
      const l = legs[i];
      const verdicts = (l?.legs ?? []).map(leg => {
        const s = outcomes.get(leg.vault.toLowerCase() as Address);
        return s ? legVerdict(leg.isYes, s.settled, s.fraction) : "unknown" as const;
      });
      return { id: m.id, block: m.block, mintedAtMs: m.mintedAtMs, taker: m.taker, owner: null, burned: false,
        parlay: { legs: l?.legs ?? [], writer: l?.writer ?? `0x${"0".repeat(40)}`, premium: m.premium, maxPayout: m.maxPayout, status: STATUS.Open },
        legVerdicts: verdicts, dataError: l === null || verdicts.includes("unknown") };
    });
    return { rows, observedAt: Number(head.timestamp) * 1000 };
  };
}

let source: ReturnType<typeof createLeaderboardSource> | undefined;

/** The lane's leaderboard rows. RPC list: POSITIONS_RPC_URL, else APP_RPC, else the chain default. */
export function loadLeaderboardRows() {
  source ??= createLeaderboardSource({
    client: createPublicClient({ chain: { ...appChain, contracts: { multicall3: { address: MULTICALL3 } } }, transport: fallback(
      (process.env.POSITIONS_RPC_URL || process.env.APP_RPC || appChain.rpcUrls.default.http[0]).split(",").map(u => u.trim()).filter(Boolean)
        .map(u => http(u, { timeout: 8_000, retryCount: 0 }))) }),
    mode: INDEXED_POSITIONS ? "subgraph" : "logs",
    subgraph: process.env.POSITIONS_SUBGRAPH_URL ? { url: process.env.POSITIONS_SUBGRAPH_URL, token: process.env.POSITIONS_SUBGRAPH_TOKEN } : undefined,
  });
  return source();
}
