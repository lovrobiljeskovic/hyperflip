import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { assertCandleRecord } from "./types.js";
import { atomicWrite, atomicWriteNew, canonicalJson, durableAppend, readCandlePartition, sha256 } from "./store.js";
import type { CandleRecord, SourceEntry, SourceRegistry } from "./types.js";

const HOUR_MS = 3_600_000;
const INITIAL_RANGE_MS = 5_000 * HOUR_MS;
const RETRY_DELAYS_MS = [250, 1_000, 4_000];

export interface CandleRequest {
  source: SourceEntry;
  startTime: number;
  endTime: number;
}

export interface CollectionSummary {
  accepted: number;
  conflicts: number;
  failures: { underlying: string; error: string }[];
}

export interface CollectionDeps {
  root: string;
  registry: SourceRegistry;
  nowMs?: number;
  apiUrl?: string;
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

export function parseCandleSnapshot(source: SourceEntry, body: string, retrievedAtMs: number): CandleRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("candle snapshot must be valid JSON");
  }
  if (!Array.isArray(value)) throw new Error("candle snapshot must be an array");
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("candle snapshot row must be an object");
    const row = entry as Record<string, unknown>;
    const keys = ["t", "T", "s", "i", "o", "h", "l", "c", "v", "n"];
    if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))) throw new Error("candle snapshot row must use exact Hyperliquid fields");
    const openTimeMs = validTimestamp(row.t, "open time");
    const closeTimeMs = validTimestamp(row.T, "close time");
    if (closeTimeMs <= openTimeMs) throw new Error("candle snapshot has reverse time");
    if (row.s !== source.sourceCoin || row.i !== "1h") throw new Error("candle snapshot source or interval mismatch");
    const open = validNumber(row.o, "open");
    const high = validNumber(row.h, "high");
    const low = validNumber(row.l, "low");
    const close = validNumber(row.c, "close");
    const volume = validNumber(row.v, "volume");
    if (Number(volume) < 0 || Number(high) < Math.max(Number(open), Number(close)) || Number(low) > Math.min(Number(open), Number(close))) throw new Error("candle snapshot has invalid OHLC ordering");
    if (!Number.isSafeInteger(row.n) || (row.n as number) < 0) throw new Error("trade count must be a non-negative safe integer");
    const candle: CandleRecord = { schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "mainnet", underlying: source.underlying, sourceCoin: source.sourceCoin, interval: "1h", openTimeMs, closeTimeMs, open, high, low, close, volume, tradeCount: row.n as number, retrievedAtMs };
    assertCandleRecord(candle);
    return candle;
  });
}

export function nextCandleRequest(source: SourceEntry, lastOpenTimeMs: number | null, nowMs: number): CandleRequest {
  return { source, startTime: lastOpenTimeMs === null ? Math.max(0, nowMs - INITIAL_RANGE_MS) : lastOpenTimeMs + HOUR_MS, endTime: nowMs };
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

function existingCandles(root: string, source: SourceEntry): Map<string, CandleRecord> {
  const raw = join(root, "raw", "candles");
  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  };
  const records = walk(raw).filter((file) => file.endsWith(".jsonl.gz")).flatMap(readCandlePartition).filter((candle) => candle.sourceNetwork === source.sourceNetwork && candle.sourceCoin === source.sourceCoin && candle.interval === "1h");
  return new Map(records.map((candle) => [candleKey(candle), candle]));
}

function loadState(root: string): { sourceRegistrySha256?: string; sources: Record<string, number> } {
  const file = join(root, "state", "collector.json");
  if (!existsSync(file)) return { sources: {} };
  const state = JSON.parse(readFileSync(file, "utf8")) as { sourceRegistrySha256?: string; sources?: unknown };
  if (state.sources === null || typeof state.sources !== "object" || Array.isArray(state.sources)) throw new Error("collector state is invalid");
  return { sourceRegistrySha256: state.sourceRegistrySha256, sources: state.sources as Record<string, number> };
}

export async function collectSources(deps: CollectionDeps): Promise<CollectionSummary> {
  const nowMs = deps.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs)) throw new Error("nowMs must be a safe integer timestamp");
  const apiUrl = deps.apiUrl ?? "https://api.hyperliquid.xyz/info";
  const requestFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const registryBytes = canonicalJson(deps.registry);
  const sourceRegistrySha256 = sha256(registryBytes);
  const fact = join(deps.root, "facts", "source-registries", `${sourceRegistrySha256}.json`);
  if (existsSync(fact) && readFileSync(fact, "utf8") !== registryBytes) throw new Error("immutable source registry fact differs");
  if (!existsSync(fact)) atomicWrite(fact, registryBytes);
  const state = loadState(deps.root);
  const summary: CollectionSummary = { accepted: 0, conflicts: 0, failures: [] };
  for (const source of deps.registry.sources) {
    const sourceKey = `${source.sourceNetwork}:${source.sourceCoin}`;
    const known = existingCandles(deps.root, source);
    const durableLastOpenTimeMs = Math.max(state.sources[sourceKey] ?? -1, ...[...known.values()].map((candle) => candle.openTimeMs));
    const request = nextCandleRequest(source, durableLastOpenTimeMs < 0 ? null : durableLastOpenTimeMs, nowMs);
    if (request.startTime > request.endTime) continue;
    let candles: CandleRecord[] | undefined;
    let failure = "request failed";
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const retrievedAtMs = nowMs;
      await sleep(RETRY_DELAYS_MS[attempt]);
      let httpStatus: number | null = null;
      try {
        const response = await requestFetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: source.sourceCoin, interval: "1h", startTime: request.startTime, endTime: nowMs } }), signal: AbortSignal.timeout(10_000) });
        httpStatus = response.status;
        const body = await response.text();
        if (!response.ok) throw new Error(`info API ${response.status}: ${body}`);
        candles = parseCandleSnapshot(source, body, retrievedAtMs);
        durableAppend(join(deps.root, "journal", "requests", `${dayPath(retrievedAtMs)}.jsonl`), canonicalJson({ schemaVersion: 1, sourceKey, startTime: request.startTime, endTime: nowMs, retrievedAtMs, httpStatus: response.status, error: null, returnedRows: candles.length }));
        break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        durableAppend(join(deps.root, "journal", "requests", `${dayPath(retrievedAtMs)}.jsonl`), canonicalJson({ schemaVersion: 1, sourceKey, startTime: request.startTime, endTime: nowMs, retrievedAtMs, httpStatus, error: failure, returnedRows: 0 }));
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
        durableAppend(join(deps.root, "quarantine", "candles", `${dayPath(nowMs)}.jsonl`), canonicalJson(candle));
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
      const shard = join(deps.root, "raw", "candles", dayPath(nowMs), source.underlying, `${request.startTime}-${request.endTime}-${nowMs}.jsonl.gz`);
      const provenance = `${shard}.provenance.json`;
      const provenanceBytes = canonicalJson({ schemaVersion: 1, sourceRegistrySha256 });
      const provenanceMatches = existsSync(provenance) ? readFileSync(provenance, "utf8") === provenanceBytes : atomicWriteNew(provenance, provenanceBytes);
      if (!provenanceMatches) {
        for (const candle of accepted) durableAppend(join(deps.root, "quarantine", "candles", `${dayPath(nowMs)}.jsonl`), canonicalJson(candle));
        summary.conflicts += accepted.length;
      } else {
        const shardBytes = gzipSync(`${accepted.map(canonicalJson).join("\n")}\n`);
        if (atomicWriteNew(shard, shardBytes)) {
          summary.accepted += accepted.length;
          for (const candle of accepted) {
            known.set(candleKey(candle), candle);
            lastDurable = Math.max(lastDurable, candle.openTimeMs);
          }
        } else if (!readFileSync(shard).equals(shardBytes)) {
          for (const candle of accepted) durableAppend(join(deps.root, "quarantine", "candles", `${dayPath(nowMs)}.jsonl`), canonicalJson(candle));
          summary.conflicts += accepted.length;
        } else {
          for (const candle of readCandlePartition(shard)) lastDurable = Math.max(lastDurable, candle.openTimeMs);
        }
      }
    }
    state.sources[sourceKey] = lastDurable;
  }
  atomicWrite(join(deps.root, "state", "collector.json"), canonicalJson({ schemaVersion: 1, sourceRegistrySha256, sources: state.sources }));
  return summary;
}
