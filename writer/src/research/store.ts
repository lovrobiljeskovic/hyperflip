import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { assertCandleRecord, assertDataManifest, parseSourceRegistry } from "./types.js";
import type { CandleRecord, DataManifest, SourceRegistry } from "./types.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") throw new Error("canonical JSON rejects undefined");
  if (typeof value === "bigint") throw new Error("canonical JSON rejects bigint");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface OperationState {
  schemaVersion: 1;
  operation: "calibrator" | "daily" | "join" | "backup";
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  details: Record<string, string | number | boolean | null>;
}

export function writeOperationState(root: string, file: string, state: OperationState, storage = openResearchPersistence(root)): void {
  storage.writeAtomic(`state/${file}`, `${canonicalJson(state)}\n`);
}

export function operationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 1_000);
}

// Compatibility exports for callers that persist one already-resolved file.
export function durableAppend(file: string, line: string): void {
  openResearchPersistence(dirname(resolve(file))).append(basename(file), line);
}

export function atomicWrite(file: string, bytes: string | Uint8Array, hooks?: { beforeRename?: () => void }): void {
  openResearchPersistence(dirname(resolve(file)), { beforeLeafOpen: hooks?.beforeRename }).writeAtomic(basename(file), Buffer.from(bytes));
}

export function atomicWriteNew(file: string, bytes: string | Uint8Array): boolean {
  return openResearchPersistence(dirname(resolve(file))).writeNew(basename(file), Buffer.from(bytes));
}

function parseCandleBytes(bytes: Buffer): CandleRecord[] {
  const rows = gunzipSync(bytes).toString("utf8").trim();
  if (!rows) return [];
  return rows.split("\n").map((line) => {
    const record = JSON.parse(line) as CandleRecord;
    assertCandleRecord(record);
    return record;
  });
}

export function readCandlePartition(file: string): CandleRecord[];
export function readCandlePartition(storage: ResearchPersistence, relativePath: string): CandleRecord[];
export function readCandlePartition(fileOrStorage: string | ResearchPersistence, relativePath?: string): CandleRecord[] {
  if (typeof fileOrStorage === "string") {
    const file = resolve(fileOrStorage);
    return parseCandleBytes(openResearchPersistence(dirname(file)).read(basename(file)));
  }
  return parseCandleBytes(fileOrStorage.read(relativePath!));
}

const bytewise = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const HOUR = 3_600_000;
export const RESEARCH_LOOKBACK_MS = 180 * 86_400_000;

export function researchRelativePath(rootInput: string, pathInput: string): string {
  if (!isAbsolute(pathInput) && (!pathInput || pathInput.startsWith("/") || pathInput.endsWith("/") || pathInput.includes("//") || pathInput.includes("\\") || pathInput.includes("\0") || pathInput.split("/").some((part) => part === "." || part === ".."))) throw new Error("research path escapes root");
  const root = resolve(rootInput);
  const path = resolve(root, pathInput);
  const result = relative(root, path);
  if (!result || result === ".." || result.startsWith(`..${sep}`)) throw new Error("research path escapes root");
  return result.split(sep).join("/");
}

export function containedPath(rootInput: string, pathInput: string): string {
  const root = resolve(rootInput);
  const path = researchRelativePath(root, pathInput);
  const storage = openResearchPersistence(root);
  if (!storage.exists(path)) throw new Error(`research path is missing: ${path}`);
  return resolve(root, path);
}

function dateParts(day: string): [string, string, string] {
  const parts = day.split("-");
  if (parts.length !== 3 || parts.some((part) => !/^\d{2,4}$/.test(part))) throw new Error("day must be YYYY-MM-DD");
  return parts as [string, string, string];
}

export function readSourceRegistryFact(root: string, hash: string, storage = openResearchPersistence(root)): { registry: SourceRegistry; hash: string; path: string } {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("source registry fact hash is invalid");
  const relativePath = `facts/source-registries/${hash}.json`;
  const bytes = storage.readText(relativePath);
  if (sha256(bytes) !== hash) throw new Error("source registry fact hash mismatch");
  return { registry: parseSourceRegistry(bytes), hash, path: resolve(root, relativePath) };
}

function sourceRegistry(root: string, rawFiles: string[], storage: ResearchPersistence): { registry: SourceRegistry; hash: string; path: string } {
  const provenanceHashes = [...new Set(rawFiles.map((file) => {
    const provenance = JSON.parse(storage.readText(`${file}.provenance.json`)) as { schemaVersion?: unknown; sourceRegistrySha256?: unknown };
    if (provenance.schemaVersion !== 1 || typeof provenance.sourceRegistrySha256 !== "string") throw new Error("candle shard provenance is invalid");
    return provenance.sourceRegistrySha256;
  }))];
  if (provenanceHashes.length > 1) throw new Error("daily shards use multiple source registries");
  if (!storage.exists("state/collector.json")) throw new Error("collector state is missing");
  const state = JSON.parse(storage.readText("state/collector.json")) as { sourceRegistrySha256?: unknown };
  const hash = provenanceHashes[0] ?? state.sourceRegistrySha256;
  if (typeof hash !== "string") throw new Error("collector state has no source registry hash");
  return readSourceRegistryFact(root, hash, storage);
}

function isExpectedSessionHour(timestampMs: number, source: SourceRegistry["sources"][number]): boolean {
  if (source.calendar === "continuous") return true;
  const session = source.session!;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: session.timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestampMs)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}`;
  return session.weekdays.includes(weekday) && !session.closedDates.includes(date) && localTime >= session.openLocal && localTime < session.closeLocal;
}

export function buildDailyManifest(root: string, day: string, storage = openResearchPersistence(root)): DataManifest {
  const [year, month, date] = dateParts(day);
  const rawFiles = storage.list(`raw/candles/${year}/${month}/${date}`).filter((file) => file.endsWith(".jsonl.gz"));
  const fact = sourceRegistry(root, rawFiles, storage);
  const records = rawFiles.flatMap((file) => readCandlePartition(storage, file));
  const byUnderlying = new Map<string, CandleRecord[]>();
  for (const record of records) byUnderlying.set(record.underlying, [...(byUnderlying.get(record.underlying) ?? []), record]);
  const underlyings: DataManifest["underlyings"] = {};
  for (const source of fact.registry.sources) {
    const candles = [...(byUnderlying.get(source.underlying) ?? [])].sort((a, b) => a.openTimeMs - b.openTimeMs);
    const missingIntervals: number[] = [];
    for (let time = candles[0]?.openTimeMs ?? 0; candles.length && time <= candles[candles.length - 1].openTimeMs; time += 3_600_000) {
      if (isExpectedSessionHour(time, source) && !candles.some((candle) => candle.openTimeMs === time)) missingIntervals.push(time);
    }
    underlyings[source.underlying] = {
      rows: candles.length,
      firstUsableObservationMs: candles[0]?.openTimeMs ?? null,
      lastUsableObservationMs: candles[candles.length - 1]?.openTimeMs ?? null,
      missingIntervals,
    };
  }
  const factPath = `facts/source-registries/${fact.hash}.json`;
  const files = [factPath, ...rawFiles.flatMap((file) => [file, `${file}.provenance.json`])].map((path) => {
    const bytes = storage.read(path);
    return { path, bytes: bytes.length, sha256: sha256(bytes), rows: path.endsWith(".jsonl.gz") ? parseCandleBytes(bytes).length : 1, schemaVersion: 1 as const };
  }).sort((a, b) => bytewise(a.path, b.path));
  const timestamps = records.map((record) => record.retrievedAtMs);
  const manifest: DataManifest = {
    schemaVersion: 1,
    createdAt: new Date(timestamps.length ? Math.max(...timestamps) : 0).toISOString(),
    sourceRegistrySha256: fact.hash,
    sourceRange: { fromMs: records.length ? Math.min(...records.map((record) => record.openTimeMs)) : 0, toMs: records.length ? Math.max(...records.map((record) => record.closeTimeMs)) : 0 },
    underlyings,
    files,
  };
  assertDataManifest(manifest);
  return manifest;
}

export function buildRollingManifest(root: string, sourceRegistrySha256: string, storage = openResearchPersistence(root)): DataManifest {
  const fact = readSourceRegistryFact(root, sourceRegistrySha256, storage);
  const rawFiles = storage.list("raw/candles").filter((file) => file.endsWith(".jsonl.gz") && (() => {
    const provenance = JSON.parse(storage.readText(`${file}.provenance.json`)) as { schemaVersion?: unknown; sourceRegistrySha256?: unknown };
    return provenance.schemaVersion === 1 && provenance.sourceRegistrySha256 === sourceRegistrySha256;
  })());
  const all = rawFiles.flatMap((file) => readCandlePartition(storage, file));
  if (!all.length) throw new Error("rolling manifest requires at least one closed candle");
  const toMs = Math.max(...all.map((record) => record.closeTimeMs));
  const fromMs = Math.max(0, toMs - RESEARCH_LOOKBACK_MS);
  const selectedFiles = rawFiles.filter((file) => readCandlePartition(storage, file).some((record) => record.closeTimeMs >= fromMs && record.closeTimeMs <= toMs));
  const records = selectedFiles.flatMap((file) => readCandlePartition(storage, file)).filter((record) => record.closeTimeMs >= fromMs && record.closeTimeMs <= toMs);
  const underlyings: DataManifest["underlyings"] = {};
  for (const source of fact.registry.sources) {
    const candles = records.filter((record) => record.underlying === source.underlying).sort((a, b) => a.openTimeMs - b.openTimeMs);
    const observed = new Set(candles.map((candle) => candle.openTimeMs));
    const missingIntervals: number[] = [];
    for (let time = Math.ceil(fromMs / HOUR) * HOUR; time <= Math.floor(toMs / HOUR) * HOUR; time += HOUR) {
      if (isExpectedSessionHour(time, source) && !observed.has(time)) missingIntervals.push(time);
    }
    underlyings[source.underlying] = {
      rows: candles.length,
      firstUsableObservationMs: candles[0]?.openTimeMs ?? null,
      lastUsableObservationMs: candles.at(-1)?.openTimeMs ?? null,
      missingIntervals,
    };
  }
  const factPath = `facts/source-registries/${fact.hash}.json`;
  const files = [factPath, ...selectedFiles.flatMap((file) => [file, `${file}.provenance.json`])].map((path) => {
    const bytes = storage.read(path);
    return { path, bytes: bytes.length, sha256: sha256(bytes), rows: path.endsWith(".jsonl.gz") ? parseCandleBytes(bytes).length : 1, schemaVersion: 1 as const };
  }).sort((a, b) => bytewise(a.path, b.path));
  const manifest: DataManifest = {
    schemaVersion: 1,
    createdAt: new Date(Math.max(...records.map((record) => record.retrievedAtMs))).toISOString(),
    sourceRegistrySha256,
    sourceRange: { fromMs, toMs },
    underlyings,
    files,
  };
  assertDataManifest(manifest);
  return manifest;
}

export function publishRollingManifest(root: string, sourceRegistrySha256: string, storage = openResearchPersistence(root)): { manifestPath: string; manifestSha256: string } {
  const manifest = buildRollingManifest(root, sourceRegistrySha256, storage);
  const bytes = canonicalJson(manifest);
  const manifestSha256 = sha256(bytes);
  const relativePath = `manifests/${manifestSha256}.json`;
  if (!storage.writeNew(relativePath, bytes) && storage.readText(relativePath) !== bytes) throw new Error("immutable manifest already exists with different bytes");
  storage.writeAtomic("manifests/current.json", canonicalJson({
    schemaVersion: 1,
    manifestSha256,
    path: relativePath,
    sourceRegistrySha256,
    asOfMs: manifest.sourceRange.toMs,
    lookbackMs: RESEARCH_LOOKBACK_MS,
  }));
  return { manifestPath: resolve(root, relativePath), manifestSha256 };
}

export function readCurrentManifest(root: string, storage = openResearchPersistence(root)): { manifest: DataManifest; manifestPath: string; manifestSha256: string } {
  let raw: string;
  try { raw = storage.readText("manifests/current.json"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("current manifest pointer is missing: manifests/current.json");
    throw error;
  }
  const pointer = JSON.parse(raw) as {
    schemaVersion?: unknown; manifestSha256?: unknown; path?: unknown; sourceRegistrySha256?: unknown; asOfMs?: unknown; lookbackMs?: unknown;
  };
  if (pointer.schemaVersion !== 1 || typeof pointer.manifestSha256 !== "string" || typeof pointer.path !== "string" || typeof pointer.sourceRegistrySha256 !== "string") throw new Error("current manifest pointer is invalid");
  let manifestPath: string;
  try { manifestPath = researchRelativePath(root, pointer.path); } catch { throw new Error("current manifest pointer is invalid"); }
  const manifest = JSON.parse(storage.readText(manifestPath)) as DataManifest;
  if (sha256(canonicalJson(manifest)) !== pointer.manifestSha256) throw new Error("current manifest pointer hash mismatch");
  if (manifest.sourceRegistrySha256 !== pointer.sourceRegistrySha256 || manifest.sourceRange.toMs !== pointer.asOfMs || pointer.lookbackMs !== RESEARCH_LOOKBACK_MS || manifest.sourceRange.fromMs !== Math.max(0, manifest.sourceRange.toMs - RESEARCH_LOOKBACK_MS)) throw new Error("current manifest pointer closure mismatch");
  verifyManifest(root, manifest, storage);
  return { manifest, manifestPath: resolve(root, manifestPath), manifestSha256: pointer.manifestSha256 };
}

export function verifyManifest(root: string, manifest: DataManifest, storage = openResearchPersistence(root)): void {
  assertDataManifest(manifest);
  for (const file of manifest.files) {
    let bytes: Buffer;
    try {
      const path = researchRelativePath(root, file.path);
      bytes = storage.read(path);
    } catch (error) {
      if (error instanceof Error && /symbolic link/.test(error.message)) throw error;
      if (error instanceof Error && ((error as NodeJS.ErrnoException).code === "ENOENT" || /missing/.test(error.message))) throw new Error(`manifest file mismatch: ${file.path}`);
      throw new Error(`manifest file path escapes root: ${file.path}`);
    }
    const rows = file.path.endsWith(".jsonl.gz") ? parseCandleBytes(bytes).length : 1;
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256 || rows !== file.rows || file.schemaVersion !== 1) throw new Error(`manifest file mismatch: ${file.path}`);
  }
  const fact = manifest.files.find((file) => file.path === `facts/source-registries/${manifest.sourceRegistrySha256}.json`);
  if (!fact) throw new Error("manifest omits source registry fact");
  if (fact.sha256 !== manifest.sourceRegistrySha256) throw new Error("source registry fact hash mismatch");
}
