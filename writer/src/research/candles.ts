import { gzipSync } from "node:zlib";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { assertCandleRecord } from "./types.js";
import { canonicalJson, publishRollingManifest, readCandlePartition, sha256 } from "./store.js";
import type { LoadedResearchNetworkProfile } from "./network.js";
import type { CandleRawManifest, CandleRecord, CandleRequestJournal, SourceEntry, SourceRegistry } from "./types.js";

const HOUR_MS = 3_600_000;
const INITIAL_RANGE_MS = 5_000 * HOUR_MS;
const RETRY_DELAYS_MS = [250, 1_000, 4_000];

export interface CandleRequest {
  source: SourceEntry;
  startTimeMs: number;
  endTimeMs: number;
}

export interface CollectionSummary {
  accepted: number;
  conflicts: number;
  failures: { underlying: string; error: string }[];
  manifestPath?: string;
  manifestSha256?: string;
}

export interface CollectionDeps {
  root: string;
  registry?: SourceRegistry;
  profile?: LoadedResearchNetworkProfile;
  nowMs?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function validNumber(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value))) throw new Error(`${label} must be a finite numeric string`);
  return value;
}

function validTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer timestamp`);
  return value;
}

export class CandleBatchConflictError extends Error {
  constructor(readonly conflicts: CandleRecord[]) {
    super("candle snapshot contains conflicting duplicate timestamps");
  }
}

type ClosedPageRequest = {
  coin: string;
  startTimeMs: number;
  endTimeMs: number;
  retrievedAtMs: number;
  source?: SourceEntry;
};

function snapshotRows(body: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("candle snapshot must be valid JSON");
  }
  if (!Array.isArray(value)) throw new Error("candle snapshot must be an array");
  return value;
}

function parseCandleRow(entry: unknown, request: ClosedPageRequest): CandleRecord {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("candle snapshot row must be an object");
    const row = entry as Record<string, unknown>;
    const keys = ["t", "T", "s", "i", "o", "h", "l", "c", "v", "n"];
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw new Error("candle snapshot row must use exact Hyperliquid fields");
    const openTimeMs = validTimestamp(row.t, "open time");
    const closeTimeMs = validTimestamp(row.T, "close time");
    if (closeTimeMs <= openTimeMs) throw new Error("candle snapshot has reverse time");
    if (openTimeMs % HOUR_MS !== 0 || closeTimeMs - openTimeMs !== HOUR_MS - 1) throw new Error("candle snapshot row must cover exactly one hour");
    if (openTimeMs < request.startTimeMs || closeTimeMs > request.endTimeMs) throw new Error("candle snapshot row is outside the request range");
    if (closeTimeMs >= request.retrievedAtMs) throw new Error("candle snapshot row must be closed before retrieval");
    if (row.s !== request.coin || row.i !== "1h") throw new Error("candle snapshot source or interval mismatch");
    const open = validNumber(row.o, "open");
    const high = validNumber(row.h, "high");
    const low = validNumber(row.l, "low");
    const close = validNumber(row.c, "close");
    const volume = validNumber(row.v, "volume");
    if (Number(volume) < 0 || Number(high) < Math.max(Number(open), Number(close)) || Number(low) > Math.min(Number(open), Number(close))) throw new Error("candle snapshot has invalid OHLC ordering");
    if (!Number.isSafeInteger(row.n) || (row.n as number) < 0) throw new Error("trade count must be a non-negative safe integer");
    const source = request.source ?? { sourceNetwork: "testnet", underlying: request.coin, sourceCoin: request.coin };
    const candle: CandleRecord = { schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: source.sourceNetwork, underlying: source.underlying, sourceCoin: source.sourceCoin, interval: "1h", openTimeMs, closeTimeMs, open, high, low, close, volume, tradeCount: row.n as number, retrievedAtMs: request.retrievedAtMs };
    assertCandleRecord(candle);
    return candle;
}

function validateCandleSequence(candles: CandleRecord[]): void {
  const known = new Map<number, CandleRecord>();
  for (const candle of candles) {
    const prior = known.get(candle.openTimeMs);
    if (prior) {
      if (immutableObservation(prior) !== immutableObservation(candle)) throw new CandleBatchConflictError([candle]);
      throw new Error("candle snapshot contains a duplicate timestamp");
    }
    known.set(candle.openTimeMs, candle);
  }
  for (let index = 1; index < candles.length; index++) if (candles[index].openTimeMs <= candles[index - 1].openTimeMs) throw new Error("candle snapshot must be strictly increasing");
}

export function selectClosedPage(rows: unknown[], request: ClosedPageRequest): { candles: CandleRecord[]; ignoredBefore: number; ignoredAfter: number } {
  if (!Number.isSafeInteger(request.startTimeMs) || !Number.isSafeInteger(request.endTimeMs) || request.startTimeMs % HOUR_MS !== 0 || request.endTimeMs - request.startTimeMs < HOUR_MS - 1 || (request.endTimeMs + 1) % HOUR_MS !== 0) throw new Error("candle request bounds are invalid");
  if (request.endTimeMs >= request.retrievedAtMs) throw new Error("candle request must be closed before retrieval");
  const retained: unknown[] = [];
  let ignoredBefore = 0;
  let ignoredAfter = 0;
  for (const entry of rows) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("candle snapshot row must be an object");
    const openTimeMs = validTimestamp((entry as Record<string, unknown>).t, "open time");
    if (openTimeMs < request.startTimeMs) {
      if (openTimeMs !== request.startTimeMs - HOUR_MS || ++ignoredBefore > 1) throw new Error("candle snapshot has a non-adjacent row before the request");
    } else if (openTimeMs > request.endTimeMs) {
      if (openTimeMs !== request.endTimeMs + 1 || ++ignoredAfter > 1) throw new Error("candle snapshot has a non-adjacent row after the request");
    } else {
      retained.push(entry);
    }
  }
  if (retained.length > 5_000) throw new Error("candle snapshot must contain at most 5,000 retained rows");
  const candles = retained.map((entry) => parseCandleRow(entry, request));
  validateCandleSequence(candles);
  return { candles, ignoredBefore, ignoredAfter };
}

export function parseCandleSnapshot(source: SourceEntry, body: string, retrievedAtMs: number, request?: { startTime: number; endTime: number }): CandleRecord[] {
  const rows = snapshotRows(body);
  if (request) return selectClosedPage(rows, { coin: source.sourceCoin, startTimeMs: request.startTime, endTimeMs: request.endTime, retrievedAtMs, source }).candles;
  if (rows.length > 5_000) throw new Error("candle snapshot must contain at most 5,000 rows");
  const candles = rows.map((row) => parseCandleRow(row, { coin: source.sourceCoin, startTimeMs: 0, endTimeMs: Number.MAX_SAFE_INTEGER - 1, retrievedAtMs, source }));
  validateCandleSequence(candles);
  return candles;
}

export function lastClosedHour(nowMs: number): { lastOpenTimeMs: number; endTimeMs: number } {
  if (!Number.isSafeInteger(nowMs)) throw new Error("nowMs must be a safe integer timestamp");
  const lastOpenTimeMs = (Math.floor(nowMs / HOUR_MS) * HOUR_MS) - HOUR_MS;
  return { lastOpenTimeMs, endTimeMs: lastOpenTimeMs + HOUR_MS - 1 };
}

export function nextCandleRequest(source: SourceEntry, lastOpenTimeMs: number | null, nowMs: number): CandleRequest {
  const closed = lastClosedHour(nowMs);
  const startTimeMs = lastOpenTimeMs === null ? Math.max(0, closed.lastOpenTimeMs - INITIAL_RANGE_MS + HOUR_MS) : lastOpenTimeMs + HOUR_MS;
  return { source, startTimeMs, endTimeMs: Math.min(closed.lastOpenTimeMs, startTimeMs + INITIAL_RANGE_MS - HOUR_MS) + HOUR_MS - 1 };
}

function dayPath(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10).replace(/-/g, "/");
}

function candleKey(candle: CandleRecord): string {
  return `${candle.sourceNetwork}:${candle.sourceCoin}:${candle.interval}:${candle.openTimeMs}`;
}

function immutableObservation(candle: CandleRecord): string {
  const { openTimeMs, closeTimeMs, open, high, low, close, volume, tradeCount } = candle;
  return canonicalJson({ openTimeMs, closeTimeMs, open, high, low, close, volume, tradeCount });
}

function existingCandles(storage: ResearchPersistence, source: SourceEntry): Map<string, CandleRecord> {
  const records = storage.list("raw/candles").filter((file) => file.endsWith(".jsonl.gz")).flatMap((file) => readCandlePartition(storage, file)).filter((candle) => candle.sourceNetwork === source.sourceNetwork && candle.sourceCoin === source.sourceCoin && candle.interval === "1h");
  return new Map(records.map((candle) => [candleKey(candle), candle]));
}

function loadState(storage: ResearchPersistence): { sourceRegistrySha256?: string; sources: Record<string, number> } {
  if (!storage.exists("state/collector.json")) return { sources: {} };
  const state = JSON.parse(storage.readText("state/collector.json")) as { sourceRegistrySha256?: string; sources?: unknown };
  if (state.sources === null || typeof state.sources !== "object" || Array.isArray(state.sources)) throw new Error("collector state is invalid");
  return { sourceRegistrySha256: state.sourceRegistrySha256, sources: state.sources as Record<string, number> };
}

export async function collectSources(deps: CollectionDeps): Promise<CollectionSummary> {
  const storage = openResearchPersistence(deps.root);
  const nowMs = deps.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs)) throw new Error("nowMs must be a safe integer timestamp");
  const registry = deps.profile?.sources ?? deps.registry;
  if (!registry) throw new Error("loaded research network profile is required");
  if (deps.profile && deps.registry && canonicalJson(deps.profile.sources) !== canonicalJson(deps.registry)) throw new Error("loaded profile and source registry differ");
  const requestFetch = deps.fetch ?? fetch;
  const apiUrl = deps.profile?.profile.infoApiUrl;
  if (!apiUrl && !deps.fetch) throw new Error("loaded research network profile is required");
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const registryBytes = canonicalJson(registry);
  const sourceRegistrySha256 = deps.profile?.sourceRegistrySha256 ?? sha256(registryBytes);
  if (sha256(registryBytes) !== sourceRegistrySha256) throw new Error("loaded profile source registry hash differs");
  const network = deps.profile?.profile.network ?? registry.network;
  const profileSha256 = deps.profile?.profileSha256 ?? null;
  const fact = `facts/source-registries/${sourceRegistrySha256}.json`;
  if (storage.exists(fact) && storage.readText(fact) !== registryBytes) throw new Error("immutable source registry fact differs");
  if (!storage.exists(fact)) storage.writeAtomic(fact, registryBytes);
  const state = loadState(storage);
  const summary: CollectionSummary = { accepted: 0, conflicts: 0, failures: [] };
  for (const source of registry.sources) {
    if (!source.measurementEnabled) continue;
    const sourceKey = `${source.sourceNetwork}:${source.sourceCoin}`;
    const known = existingCandles(storage, source);
    const durableLastOpenTimeMs = Math.max(state.sources[sourceKey] ?? -1, ...[...known.values()].map((candle) => candle.openTimeMs));
    const request = nextCandleRequest(source, durableLastOpenTimeMs < 0 ? null : durableLastOpenTimeMs, nowMs);
    if (request.startTimeMs > request.endTimeMs) continue;
    let candles: CandleRecord[] | undefined;
    let ignoredBefore = 0;
    let ignoredAfter = 0;
    let failure = "request failed";
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const retrievedAtMs = nowMs;
      await sleep(RETRY_DELAYS_MS[attempt]);
      let httpStatus: number | null = null;
      try {
        const response = await requestFetch(apiUrl ?? "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: source.sourceCoin, interval: "1h", startTime: request.startTimeMs, endTime: request.endTimeMs } }), signal: AbortSignal.timeout(10_000) });
        httpStatus = response.status;
        const body = await response.text();
        if (!response.ok) throw new Error(`info API ${response.status}: ${body}`);
        const page = selectClosedPage(snapshotRows(body), { coin: source.sourceCoin, startTimeMs: request.startTimeMs, endTimeMs: request.endTimeMs, retrievedAtMs, source });
        candles = page.candles;
        ignoredBefore = page.ignoredBefore;
        ignoredAfter = page.ignoredAfter;
        storage.append(`journal/requests/${dayPath(retrievedAtMs)}.jsonl`, canonicalJson({ schemaVersion: 2, sourceKey, network, profileSha256, startTimeMs: request.startTimeMs, endTimeMs: request.endTimeMs, retrievedAtMs, httpStatus: response.status, error: null, returnedRows: candles.length, ignoredBefore, ignoredAfter } satisfies CandleRequestJournal));
        break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        storage.append(`journal/requests/${dayPath(retrievedAtMs)}.jsonl`, canonicalJson({ schemaVersion: 2, sourceKey, network, profileSha256, startTimeMs: request.startTimeMs, endTimeMs: request.endTimeMs, retrievedAtMs, httpStatus, error: failure, returnedRows: 0, ignoredBefore: 0, ignoredAfter: 0 } satisfies CandleRequestJournal));
        if (error instanceof CandleBatchConflictError) {
          for (const candle of error.conflicts) storage.append(`quarantine/candles/${dayPath(nowMs)}.jsonl`, canonicalJson(candle));
          summary.conflicts += error.conflicts.length;
          break;
        }
      }
    }
    if (!candles) {
      summary.failures.push({ underlying: source.underlying, error: failure });
      continue;
    }
    const accepted: CandleRecord[] = [];
    let lastDurable = durableLastOpenTimeMs;
    for (const candle of candles) {
      const key = candleKey(candle);
      const prior = known.get(key);
      if (prior && immutableObservation(prior) !== immutableObservation(candle)) {
        storage.append(`quarantine/candles/${dayPath(nowMs)}.jsonl`, canonicalJson(candle));
        summary.conflicts++;
        continue;
      }
      if (!prior) {
        accepted.push(candle);
      } else {
        lastDurable = Math.max(lastDurable, candle.openTimeMs);
      }
    }
    if (accepted.length) {
      const shard = `raw/candles/${dayPath(nowMs)}/${source.underlying}/${request.startTimeMs}-${request.endTimeMs}-${nowMs}.jsonl.gz`;
      const provenance = `${shard}.provenance.json`;
      const provenanceBytes = canonicalJson({ schemaVersion: 1, sourceRegistrySha256, network, profileSha256, startTimeMs: request.startTimeMs, endTimeMs: request.endTimeMs, ignoredBefore, ignoredAfter } satisfies CandleRawManifest);
      const provenanceMatches = storage.exists(provenance) ? storage.readText(provenance) === provenanceBytes : storage.writeNew(provenance, provenanceBytes);
      if (!provenanceMatches) {
        for (const candle of accepted) storage.append(`quarantine/candles/${dayPath(nowMs)}.jsonl`, canonicalJson(candle));
        summary.conflicts += accepted.length;
      } else {
        const shardBytes = gzipSync(`${accepted.map(canonicalJson).join("\n")}\n`);
        if (storage.writeNew(shard, shardBytes)) {
          summary.accepted += accepted.length;
          for (const candle of accepted) {
            known.set(candleKey(candle), candle);
            lastDurable = Math.max(lastDurable, candle.openTimeMs);
          }
        } else if (!storage.read(shard).equals(shardBytes)) {
          for (const candle of accepted) storage.append(`quarantine/candles/${dayPath(nowMs)}.jsonl`, canonicalJson(candle));
          summary.conflicts += accepted.length;
        } else {
          for (const candle of readCandlePartition(storage, shard)) lastDurable = Math.max(lastDurable, candle.openTimeMs);
        }
      }
    }
    state.sources[sourceKey] = lastDurable;
  }
  storage.writeAtomic("state/collector.json", canonicalJson({ schemaVersion: 2, sourceRegistrySha256, network, profileSha256, sources: state.sources }));
  try {
    Object.assign(summary, publishRollingManifest(deps.root, sourceRegistrySha256, storage));
  } catch (error) {
    summary.failures.push({ underlying: "manifest", error: error instanceof Error ? error.message : String(error) });
  }
  return summary;
}
