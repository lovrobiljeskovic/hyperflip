import { isAddress, type Address, type PublicClient } from "viem";
import { DEPLOY_BLOCK, PARLAY_VAULT, outcomeVaultAbi, parlayVaultAbi } from "./contracts";
import { appChain } from "./chain";
import { legVerdict, type Leg, type ParlayData, type Row } from "./positions";
import { WAD } from "./format";
import { ZERO_ADDRESS, type PositionPage, type PositionSnapshot } from "./positions-api";

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_ID = (1n << 256n) - 1n;
const SCOPE = `${appChain.id}:${PARLAY_VAULT.toLowerCase()}`;

export class PositionsError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

export function parsePositionQuery(query: URLSearchParams) {
  const wallet = query.get("wallet") ?? "";
  const before = query.get("before");
  const limit = query.get("limit") ?? "20";
  const hash = query.get("snapshot");
  const block = query.get("block");
  if (!isAddress(wallet, { strict: false }) || ZERO_ADDRESS.test(wallet) || !/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50 ||
      (before !== null && (!DECIMAL.test(before) || BigInt(before) === 0n || BigInt(before) > MAX_ID)) ||
      (hash !== null && !HASH.test(hash)) || (block !== null && (!DECIMAL.test(block) || BigInt(block) > MAX_ID)) ||
      (hash === null) !== (block === null) || (before !== null && hash === null)) {
    throw new PositionsError("Invalid positions query", 400);
  }
  return { wallet: wallet.toLowerCase(), before, limit: Number(limit), snapshot: hash && block ? { hash: hash.toLowerCase() as `0x${string}`, number: block } : null };
}

type Meta = { block: { number: number; hash: string; timestamp: number }; hasIndexingErrors: boolean };
type Ticket = {
  id: string; number: string; taker: Address; owner: Address | null;
  premium: string; maxPayout: string; status: number; burned: boolean; burnHolder: Address | null;
  mintBlock: string; mintHash: string; mintTimestamp: string;
};
const FIELDS = `id number taker owner premium maxPayout status burned burnHolder mintBlock mintHash mintTimestamp`;
const META_QUERY = `query { _meta { block { number hash timestamp } hasIndexingErrors } }`;
const PAGE_QUERY = `query Positions($wallet: Bytes!, $scope: ID!, $deployment: String!, $before: BigInt!, $first: Int!, $block: Block_height!) {
  _meta(block: $block) { block { number hash timestamp } hasIndexingErrors }
  deployment(id: $scope, block: $block) { chainId vault startBlock schemaVersion }
  walletTickets(first: $first, orderBy: number, orderDirection: desc,
    where: { wallet: $wallet, deployment: $deployment, number_lt: $before }, block: $block) { ticket { ${FIELDS} } }
}`;

function metaSnapshot(meta: Meta): PositionSnapshot {
  if (!meta || meta.hasIndexingErrors !== false || !Number.isSafeInteger(meta.block?.number) || meta.block.number < 0 ||
      !HASH.test(meta.block.hash) || !Number.isSafeInteger(meta.block.timestamp)) throw new PositionsError("Index is not ready");
  return { number: String(meta.block.number), hash: meta.block.hash.toLowerCase() as `0x${string}` };
}

function validateTicket(ticket: Ticket, snapshot: PositionSnapshot) {
  const amounts = [ticket.number, ticket.premium, ticket.maxPayout, ticket.mintBlock, ticket.mintTimestamp];
  if (amounts.some(v => typeof v !== "string" || !DECIMAL.test(v) || BigInt(v) > MAX_ID) || BigInt(ticket.number) < 1n ||
      ticket.id !== `${SCOPE}:${ticket.number}` || BigInt(ticket.mintBlock) < DEPLOY_BLOCK || BigInt(ticket.mintBlock) > BigInt(snapshot.number) ||
      !HASH.test(ticket.mintHash) || !Number.isSafeInteger(Number(ticket.mintTimestamp) * 1000) ||
      !isAddress(ticket.taker, { strict: false }) || ZERO_ADDRESS.test(ticket.taker) ||
      !Number.isInteger(ticket.status) || ticket.status < 0 || ticket.status > 3 || typeof ticket.burned !== "boolean" ||
      BigInt(ticket.maxPayout) <= BigInt(ticket.premium) ||
      (ticket.burned ? ticket.owner !== null || !ticket.burnHolder || !isAddress(ticket.burnHolder, { strict: false }) || ZERO_ADDRESS.test(ticket.burnHolder) || ![1, 3].includes(ticket.status)
        : !ticket.owner || !isAddress(ticket.owner, { strict: false }) || ZERO_ADDRESS.test(ticket.owner) || ticket.burnHolder !== null || ticket.status === 3)) {
    throw new PositionsError("Invalid indexed ticket");
  }
}

export function createPositionsIndex(client: PublicClient, endpoint: string, token?: string, request: typeof fetch = fetch) {
  // ponytail: per-process cache, add shared caching only if multi-instance RPC use warrants it.
  const cache = new Map<string, { until: number; value: Promise<unknown> }>();
  function cached<T>(key: string, ttl: number, read: () => Promise<T>): Promise<T> {
    const entry = cache.get(key);
    if (entry && entry.until > Date.now()) return entry.value as Promise<T>;
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    const value = read();
    cache.set(key, { until: Date.now() + ttl, value });
    void value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  }
  let active = 0;
  const queue: (() => void)[] = [];
  async function rpc<T>(read: () => Promise<T>): Promise<T> {
    if (active >= 6) {
      if (queue.length >= 512) throw new PositionsError("Positions are busy; retry shortly");
      await new Promise<void>(resolve => queue.push(resolve));
    } else active++;
    try { return await read(); }
    finally { const next = queue.shift(); if (next) next(); else active--; }
  }
  async function graph<T>(query: string, variables?: object): Promise<T> {
    try {
      const response = await request(endpoint, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ query, variables }) });
      const body = await response.json();
      if (!response.ok || body.errors?.length || !body.data) throw new Error();
      return body.data as T;
    } catch { throw new PositionsError("Positions index is temporarily unavailable"); }
  }

  async function load(query: ReturnType<typeof parsePositionQuery>): Promise<PositionPage> {
    const deadline = Date.now() + 20_000;
    const readRpc = <T>(read: () => Promise<T>): Promise<T> => rpc(() => {
      if (Date.now() >= deadline) throw new PositionsError("Positions reads timed out");
      return read();
    });
    await cached("chain", 60_000, async () => {
      if (await readRpc(() => client.getChainId()) !== appChain.id) throw new PositionsError("Positions RPC chain mismatch");
    });
    const [meta, head] = await Promise.all([
      cached("meta", 10_000, () => graph<{ _meta: Meta }>(META_QUERY)),
      cached("head", 10_000, () => readRpc(() => client.getBlock({ blockTag: "latest" }))),
    ]);
    const indexed = metaSnapshot(meta._meta);
    const snapshot = query.snapshot ?? indexed;
    if (!head.hash || head.number === null || BigInt(snapshot.number) > head.number || BigInt(snapshot.number) > BigInt(indexed.number)) {
      throw new PositionsError("Positions snapshot is unavailable; refresh", 409);
    }
    const canonical = await readRpc(() => client.getBlock({ blockNumber: BigInt(snapshot.number) }));
    if (canonical.hash?.toLowerCase() !== snapshot.hash) {
      cache.clear();
      throw new PositionsError("Positions changed; refresh", 409);
    }
    let page;
    try {
      page = await graph<{ _meta: Meta; deployment: { chainId: string; vault: string; startBlock: string; schemaVersion: number } | null;
        walletTickets: { ticket: Ticket }[] }>(PAGE_QUERY, { wallet: query.wallet, scope: SCOPE, deployment: SCOPE,
        before: query.before ?? String(MAX_ID), first: query.limit + 1, block: { hash: snapshot.hash } });
    } catch (error) {
      if (query.snapshot) throw new PositionsError("Positions snapshot is unavailable; refresh", 409);
      throw error;
    }
    if (metaSnapshot(page._meta).hash !== snapshot.hash) throw new PositionsError("Positions snapshot mismatch", 409);
    const deployment = page.deployment;
    // An empty, caught-up deployment has no event-created entity yet.
    if (!deployment || deployment.chainId !== String(appChain.id) || deployment.vault.toLowerCase() !== PARLAY_VAULT.toLowerCase() ||
        deployment.startBlock !== String(DEPLOY_BLOCK) || deployment.schemaVersion !== 1) throw new PositionsError("Positions deployment mismatch");
    if (!Array.isArray(page.walletTickets) || page.walletTickets.length > query.limit + 1) throw new PositionsError("Invalid positions response");
    let previous = BigInt(query.before ?? String(MAX_ID));
    for (const { ticket } of page.walletTickets) {
      validateTicket(ticket, snapshot);
      if (BigInt(ticket.number) >= previous) throw new PositionsError("Invalid positions ordering");
      previous = BigInt(ticket.number);
    }
    const tickets = page.walletTickets.slice(0, query.limit).map(v => v.ticket);
    type Result = { status: "success"; result: unknown } | { status: "failure"; error: Error };
    // One Multicall3 round trip per batch, pinned to head: a 20-ticket page is a handful of eth_calls,
    // not ~100, which is what keeps it under a keyless provider's rate cap.
    const multicall = (contracts: unknown[]): Promise<Result[]> =>
      readRpc(() => client.multicall({ contracts: contracts as never, blockNumber: head.number!, allowFailure: true, batchSize: 0 }) as Promise<Result[]>);
    const pick = <T>(batch: Promise<Result[]>, i: number, check: (r: Result) => T) => batch.then(results => check(results[i]));
    const fresh = (key: string) => (cache.get(key)?.until ?? 0) > Date.now();
    const settledValue = <T>(key: string) => (cache.get(key)?.value as Promise<T> | undefined)?.catch(() => null) ?? null;
    const missingTickets = tickets.filter(t => !fresh(`legs:${t.id}:${t.mintHash}`));
    const legsBatch = missingTickets.length ? multicall(missingTickets.map(t => ({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "parlay", args: [BigInt(t.number)] }))) : Promise.resolve([]);
    missingTickets.forEach((ticket, i) => void cached(`legs:${ticket.id}:${ticket.mintHash}`, 3_600_000, () => pick(legsBatch, i, r => {
      if (r?.status !== "success") throw r?.error ?? new Error("No result");
      const parlay = r.result as ParlayData;
      if (String(parlay.premium) !== ticket.premium ||
          String(parlay.maxPayout) !== ticket.maxPayout || !parlay.legs.length || parlay.legs.length > 10) throw new Error("Ticket mismatch");
      return { legs: parlay.legs, writer: parlay.writer };
    })).catch(() => {}));
    const hydrated = await Promise.all(tickets.map(t => settledValue<{ legs: Leg[]; writer: Address }>(`legs:${t.id}:${t.mintHash}`)));
    const vaults = [...new Set(hydrated.flatMap(entry => entry?.legs.map(l => l.vault.toLowerCase() as Address) ?? []))];
    const missingVaults = vaults.filter(v => !fresh(`outcome:${head.hash}:${v}`));
    const outcomesBatch = missingVaults.length ? multicall(missingVaults.flatMap(address => [
      { address, abi: outcomeVaultAbi, functionName: "settled" },
      { address, abi: outcomeVaultAbi, functionName: "settleFractionWad" },
    ])) : Promise.resolve([]);
    // Pin both getters to one observation; a recent reorg cannot leave a permanent settled cache entry.
    missingVaults.forEach((vault, i) => void cached(`outcome:${head.hash}:${vault}`, 15_000, () => outcomesBatch.then(results => {
      const settled = results[2 * i], fraction = results[2 * i + 1];
      if (settled?.status !== "success") throw settled?.error ?? new Error("No result");
      if (settled.result === false) return { settled: false, fraction: null };
      if (fraction?.status !== "success") throw fraction?.error ?? new Error("No result");
      const wad = fraction.result as bigint;
      if (wad < 0n || wad > WAD) throw new Error("Invalid fraction");
      return { settled: true, fraction: wad };
    })).catch(() => {}));
    const states = await Promise.all(vaults.map(v => settledValue<{ settled: boolean; fraction: bigint | null }>(`outcome:${head.hash}:${v}`)));
    const outcomes = new Map(vaults.map((vault, i) => [vault, states[i]]));
    const rows: Row[] = tickets.map((ticket, i) => {
      const legs = hydrated[i]?.legs ?? [] as Leg[];
      const verdicts = legs.map(leg => {
        const state = outcomes.get(leg.vault.toLowerCase() as Address);
        return state ? legVerdict(leg.isYes, state.settled, state.fraction) : "unknown" as const;
      });
      return { id: BigInt(ticket.number), block: BigInt(ticket.mintBlock), mintedAtMs: Number(ticket.mintTimestamp) * 1000,
        taker: ticket.taker, owner: ticket.owner, burned: ticket.burned, burnHolder: ticket.burnHolder,
        parlay: { legs, writer: hydrated[i]?.writer ?? `0x${"0".repeat(40)}`, premium: BigInt(ticket.premium), maxPayout: BigInt(ticket.maxPayout), status: ticket.status },
        legVerdicts: verdicts, dataError: hydrated[i] === null || verdicts.includes("unknown") };
    });
    const indexAge = Number(head.timestamp) - meta._meta.block.timestamp;
    const snapshotAge = Number(head.timestamp) - Number(canonical.timestamp);
    return { rows, next: page.walletTickets.length > query.limit ? tickets.at(-1)!.number : null,
      snapshot, indexed, observed: { number: String(head.number), hash: head.hash, timestamp: Number(head.timestamp) },
      stale: indexAge > 60 || snapshotAge > 60 || Date.now() / 1000 - Number(head.timestamp) > 60,
      failed: rows.filter(row => row.dataError).length };
  }
  return (query: URLSearchParams) => {
    const parsed = parsePositionQuery(query);
    return cached(`page:${JSON.stringify(parsed)}`, 10_000, () => load(parsed));
  };
}
