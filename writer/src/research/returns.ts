import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { canonicalJson, readCandlePartition, sha256, verifyManifest } from "./store.js";
import { parseSourceRegistry } from "./types.js";
import type { CandleRecord, DataManifest, ExclusionRecord, SourceEntry } from "./types.js";

export const HOUR = 3_600_000;
export const TRANSFORMATION_VERSION = "returns-v1";

export interface Window { asOfMs: number; lookbackMs: number }
export type QualityMode = "hourly-within-cluster" | "daily-cross-session";
export interface ReturnRecord {
  schemaVersion: 1;
  transformationVersion: typeof TRANSFORMATION_VERSION;
  underlying: string;
  interval: "1h" | "1d";
  timestampMs: number;
  /** Earliest close timestamp at which both prices used by this return were known. */
  observationCloseTimeMs?: number;
  sessionDate: string;
  value: number;
  sourceKeys: string[];
}
export interface QualityResult {
  eligible: boolean;
  observations: number;
  expected: number;
  coverage: number;
  exclusions: ExclusionRecord[];
  mode: QualityMode;
}
export interface PairSample {
  samples: { timestampMs: number; a: number; b: number }[];
  a: ReturnRecord[];
  b: ReturnRecord[];
  quality: QualityResult;
  fresh: boolean;
}

interface Series { records: ReturnRecord[]; possible: string[]; exclusions: ExclusionRecord[] }
const key = (candle: CandleRecord): string => `${candle.sourceNetwork}:${candle.sourceCoin}:${candle.interval}:${candle.openTimeMs}`;
const fromWindow = (window: Window): number => {
  if (!Number.isSafeInteger(window.asOfMs) || !Number.isSafeInteger(window.lookbackMs) || window.lookbackMs < 0) throw new Error("window must use safe non-negative millisecond values");
  return window.asOfMs - window.lookbackMs;
};
const positiveClose = (candle: CandleRecord): boolean => Number.isFinite(Number(candle.close)) && Number(candle.close) > 0;
const exclusion = (source: SourceEntry, reason: ExclusionRecord["reason"], timestampMs: number | null, sourceKeys: string[], peerUnderlying: string | null = null): ExclusionRecord => ({ schemaVersion: 1, stage: "returns", underlying: source.underlying, peerUnderlying, timestampMs, reason, sourceKeys });

function localParts(timestampMs: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestampMs)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function localDateTimeMs(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = localParts(candidate, timeZone);
    candidate += target - Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  }
  return candidate;
}

function calendarDates(window: Window): string[] {
  const dates: string[] = [];
  for (let timestamp = Date.UTC(new Date(fromWindow(window)).getUTCFullYear(), new Date(fromWindow(window)).getUTCMonth(), new Date(fromWindow(window)).getUTCDate()) - 2 * 86_400_000; timestamp <= window.asOfMs + 2 * 86_400_000; timestamp += 86_400_000) dates.push(new Date(timestamp).toISOString().slice(0, 10));
  return dates;
}

export function expectedIntervals(source: SourceEntry, window: Window): number[] {
  const from = fromWindow(window);
  if (source.calendar === "continuous") {
    const first = Math.ceil(from / HOUR) * HOUR;
    const result: number[] = [];
    for (let timestamp = first; timestamp <= window.asOfMs; timestamp += HOUR) result.push(timestamp);
    return result;
  }
  const session = source.session!;
  const intervals: number[] = [];
  for (const date of calendarDates(window)) {
    const open = localDateTimeMs(date, session.openLocal, session.timeZone);
    const parts = localParts(open, session.timeZone);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    if (!session.weekdays.includes(weekday) || session.closedDates.includes(date)) continue;
    const [openHour, openMinute] = session.openLocal.split(":").map(Number);
    const [closeHour, closeMinute] = session.closeLocal.split(":").map(Number);
    const openMinutes = openHour * 60 + openMinute;
    for (let minute = openHour * 60 + openMinute; minute < closeHour * 60 + closeMinute; minute += 60) {
      const timestamp = open + (minute - openMinutes) * 60_000;
      if (timestamp >= from && timestamp <= window.asOfMs) intervals.push(timestamp);
    }
  }
  return intervals.sort((a, b) => a - b);
}

export function sessionDates(window: Window, source: SourceEntry): string[] {
  const timeZone = source.calendar === "session" ? source.session!.timeZone : "UTC";
  return [...new Set(expectedIntervals(source, window).map((timestamp) => `${localParts(timestamp, timeZone).year}-${localParts(timestamp, timeZone).month}-${localParts(timestamp, timeZone).day}`))];
}

export function classifyCandle(candle: CandleRecord, source: SourceEntry, previous: CandleRecord | undefined): "active" | "stale" {
  if (source.calendar === "continuous") return "active";
  return Number(candle.volume) > 0 || candle.tradeCount > 0 || (previous !== undefined && candle.close !== previous.close) ? "active" : "stale";
}

function candlesAt(candles: CandleRecord[]): { byTime: Map<number, CandleRecord>; previous: Map<number, CandleRecord | undefined> } {
  const sorted = [...candles].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const byTime = new Map<number, CandleRecord>();
  const previous = new Map<number, CandleRecord | undefined>();
  for (let index = 0; index < sorted.length; index++) {
    byTime.set(sorted[index].openTimeMs, sorted[index]);
    previous.set(sorted[index].openTimeMs, sorted[index - 1]);
  }
  return { byTime, previous };
}

function usable(candle: CandleRecord | undefined, source: SourceEntry, previous: CandleRecord | undefined, exclusions: ExclusionRecord[]): candle is CandleRecord {
  if (!candle) return false;
  if (!positiveClose(candle)) {
    exclusions.push(exclusion(source, "non-positive-close", candle.openTimeMs, [key(candle)]));
    return false;
  }
  if (classifyCandle(candle, source, previous) === "stale") {
    exclusions.push(exclusion(source, "stale-session-bar", candle.openTimeMs, [key(candle)]));
    return false;
  }
  return true;
}

function hourlySeries(candles: CandleRecord[], source: SourceEntry, window: Window): Series {
  const intervals = expectedIntervals(source, window);
  const { byTime, previous } = candlesAt(candles);
  const exclusions: ExclusionRecord[] = [];
  const active = new Map<number, CandleRecord>();
  for (const timestamp of intervals) {
    const candle = byTime.get(timestamp);
    if (!candle) exclusions.push(exclusion(source, "missing-interval", timestamp, []));
    else if (usable(candle, source, previous.get(timestamp), exclusions)) active.set(timestamp, candle);
  }
  const records: ReturnRecord[] = [];
  const possible: string[] = [];
  for (let index = 1; index < intervals.length; index++) {
    const before = intervals[index - 1];
    const timestamp = intervals[index];
    if (timestamp - before !== HOUR) continue;
    possible.push(String(timestamp));
    const prior = active.get(before);
    const current = active.get(timestamp);
    if (prior && current) records.push({ schemaVersion: 1, transformationVersion: TRANSFORMATION_VERSION, underlying: source.underlying, interval: "1h", timestampMs: timestamp, observationCloseTimeMs: current.closeTimeMs, sessionDate: localDate(source, timestamp), value: Math.log(Number(current.close) / Number(prior.close)), sourceKeys: [key(prior), key(current)] });
  }
  return { records, possible, exclusions };
}

function localDate(source: SourceEntry, timestamp: number): string {
  const parts = localParts(timestamp, source.calendar === "session" ? source.session!.timeZone : "UTC");
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dailySeries(candles: CandleRecord[], source: SourceEntry, window: Window): Series {
  const intervals = expectedIntervals(source, window);
  const { byTime, previous } = candlesAt(candles);
  const exclusions: ExclusionRecord[] = [];
  const closes = new Map<string, CandleRecord>();
  for (const timestamp of intervals) {
    const candle = byTime.get(timestamp);
    if (!candle) exclusions.push(exclusion(source, "missing-interval", timestamp, []));
    else if (usable(candle, source, previous.get(timestamp), exclusions)) closes.set(localDate(source, timestamp), candle);
  }
  const dates = sessionDates(window, source);
  const records: ReturnRecord[] = [];
  const possible: string[] = [];
  for (let index = 1; index < dates.length; index++) {
    const previousClose = closes.get(dates[index - 1]);
    const current = closes.get(dates[index]);
    possible.push(dates[index]);
    if (previousClose && current) records.push({ schemaVersion: 1, transformationVersion: TRANSFORMATION_VERSION, underlying: source.underlying, interval: "1d", timestampMs: current.openTimeMs, observationCloseTimeMs: current.closeTimeMs, sessionDate: dates[index], value: Math.log(Number(current.close) / Number(previousClose.close)), sourceKeys: [key(previousClose), key(current)] });
  }
  return { records, possible, exclusions };
}

export function buildHourlyReturns(candles: CandleRecord[], source: SourceEntry, window: Window): ReturnRecord[] { return hourlySeries(candles, source, window).records; }
export function buildDailyReturns(candles: CandleRecord[], source: SourceEntry, window: Window): ReturnRecord[] { return dailySeries(candles, source, window).records; }

export function trailingFresh(source: SourceEntry, observedTimes: number[], asOfMs: number, graceMs = 6 * HOUR): boolean {
  if (!Number.isSafeInteger(asOfMs) || !Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("freshness values must be safe non-negative milliseconds");
  const cutoff = asOfMs - graceMs;
  const window = { asOfMs: cutoff, lookbackMs: source.calendar === "continuous" ? 2 * HOUR : 400 * 86_400_000 };
  const expected = expectedIntervals(source, window).filter((timestamp) => timestamp + HOUR - 1 <= cutoff).at(-1);
  return expected === undefined || observedTimes.some((timestamp) => timestamp >= expected && timestamp <= asOfMs);
}

export function quality(observations: number, expected: number, mode: QualityMode, exclusions: ExclusionRecord[] = []): QualityResult {
  const coverage = expected === 0 ? 0 : observations / expected;
  const minimum = mode === "hourly-within-cluster" ? 1_000 : 90;
  const result = [...exclusions];
  if (observations < minimum) result.push(exclusion({ schemaVersion: 1, underlying: "pair", sourceNetwork: "testnet", sourceCoin: "pair", cluster: "crypto", calendar: "continuous", measurementEnabled: true, fallbackEligible: false }, "insufficient-sample", null, []));
  if (coverage < 0.8) result.push(exclusion({ schemaVersion: 1, underlying: "pair", sourceNetwork: "testnet", sourceCoin: "pair", cluster: "crypto", calendar: "continuous", measurementEnabled: true, fallbackEligible: false }, "coverage-below-80pct", null, []));
  return { eligible: observations >= minimum && coverage >= 0.8, observations, expected, coverage, exclusions: result, mode };
}

export function alignPair(a: CandleRecord[], b: CandleRecord[], sourceA: SourceEntry, sourceB: SourceEntry, window: Window, mode: QualityMode): PairSample {
  const first = mode === "hourly-within-cluster" ? hourlySeries(a, sourceA, window) : dailySeries(a, sourceA, window);
  const second = mode === "hourly-within-cluster" ? hourlySeries(b, sourceB, window) : dailySeries(b, sourceB, window);
  const lookup = (records: ReturnRecord[]) => new Map(records.map((record) => [mode === "hourly-within-cluster" ? String(record.timestampMs) : record.sessionDate, record]));
  const aByKey = lookup(first.records);
  const bByKey = lookup(second.records);
  const possible = [...new Set(first.possible.filter((item) => second.possible.includes(item)))];
  const exclusions = [...first.exclusions, ...second.exclusions];
  const samples: PairSample["samples"] = [];
  for (const item of possible) {
    const left = aByKey.get(item);
    const right = bByKey.get(item);
    if (left && right) samples.push({ timestampMs: Math.max(left.timestampMs, right.timestampMs), a: left.value, b: right.value });
    else exclusions.push(exclusion(sourceA, "no-synchronized-peer", mode === "hourly-within-cluster" ? Number(item) : null, left?.sourceKeys ?? [], sourceB.underlying));
  }
  const usableTimes = (candles: CandleRecord[], source: SourceEntry) => {
    const { byTime, previous } = candlesAt(candles);
    return [...byTime.values()].filter((candle) => positiveClose(candle) && classifyCandle(candle, source, previous.get(candle.openTimeMs)) === "active").map((candle) => candle.openTimeMs);
  };
  const fresh = trailingFresh(sourceA, usableTimes(a, sourceA), window.asOfMs) && trailingFresh(sourceB, usableTimes(b, sourceB), window.asOfMs);
  if (!fresh) exclusions.push(exclusion(sourceA, "missing-interval", null, [], sourceB.underlying));
  const result = quality(samples.length, possible.length, mode, exclusions);
  return { samples, a: first.records, b: second.records, quality: { ...result, eligible: result.eligible && fresh }, fresh };
}

export interface DerivedOutput { path: string; exclusionPath: string; manifestPath: string; rows: number; exclusions: number }

function writeImmutable(storage: ResearchPersistence, file: string, bytes: string | Uint8Array, label: string): void {
  const expected = Buffer.from(bytes);
  if (storage.exists(file)) {
    if (!storage.read(file).equals(expected)) throw new Error(`${label} already exists with different bytes`);
    return;
  }
  if (!storage.writeNew(file, expected) && !storage.read(file).equals(expected)) throw new Error(`${label} already exists with different bytes`);
}

export function deriveReturns(root: string, manifest: DataManifest, window: Window, storage = openResearchPersistence(root)): DerivedOutput {
  verifyManifest(root, manifest, storage);
  const registry = parseSourceRegistry(storage.readText(`facts/source-registries/${manifest.sourceRegistrySha256}.json`));
  const candles = manifest.files.filter((file) => file.path.endsWith(".jsonl.gz")).flatMap((file) => readCandlePartition(storage, file.path));
  const derived = registry.sources.flatMap((source) => {
    const own = candles.filter((candle) => candle.underlying === source.underlying && candle.sourceNetwork === source.sourceNetwork && candle.sourceCoin === source.sourceCoin && candle.interval === "1h");
    return [hourlySeries(own, source, window), dailySeries(own, source, window)];
  });
  const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const records = derived.flatMap((series) => series.records).sort((a, b) => lexical(a.underlying, b.underlying) || lexical(a.interval, b.interval) || a.timestampMs - b.timestampMs);
  const exclusions = derived.flatMap((series) => series.exclusions).sort((a, b) => lexical(canonicalJson(a), canonicalJson(b)));
  const identity = sha256(canonicalJson({ dataManifestSha256: sha256(canonicalJson(manifest)), transformationVersion: TRANSFORMATION_VERSION, window }));
  const day = new Date(window.asOfMs).toISOString().slice(0, 10).replace(/-/g, "/");
  const path = `derived/returns/${day}/${identity}.jsonl.gz`;
  const bytes = gzipSync(`${records.map(canonicalJson).join("\n")}${records.length ? "\n" : ""}`);
  writeImmutable(storage, path, bytes, "immutable derived returns");
  const exclusionPath = `derived/exclusions/${day}/${identity}.jsonl.gz`;
  const exclusionBytes = gzipSync(`${exclusions.map(canonicalJson).join("\n")}${exclusions.length ? "\n" : ""}`);
  writeImmutable(storage, exclusionPath, exclusionBytes, "immutable derived exclusions");
  const manifestPath = `${path}.manifest.json`;
  const derivedManifest = canonicalJson({
    schemaVersion: 1, transformationVersion: TRANSFORMATION_VERSION, dataManifestSha256: sha256(canonicalJson(manifest)), sourceRegistrySha256: manifest.sourceRegistrySha256, window,
    files: [
      { kind: "returns", path, bytes: bytes.length, sha256: sha256(bytes), rows: records.length, schemaVersion: 1 },
      { kind: "exclusions", path: exclusionPath, bytes: exclusionBytes.length, sha256: sha256(exclusionBytes), rows: exclusions.length, schemaVersion: 1 },
    ],
  });
  writeImmutable(storage, manifestPath, derivedManifest, "immutable derived manifest");
  return { path: resolve(root, path), exclusionPath: resolve(root, exclusionPath), manifestPath: resolve(root, manifestPath), rows: records.length, exclusions: exclusions.length };
}
