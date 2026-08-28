import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
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

export function writeOperationState(root: string, file: string, state: OperationState): void {
  atomicWrite(join(resolve(root), "state", file), `${canonicalJson(state)}\n`);
}

export function operationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 1_000);
}

function fsyncDirectory(path: string): void {
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function durableMkdir(path: string, mode?: number): void {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    missing.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`durable directory is a symbolic link: ${cursor}`);
  for (const directory of missing) {
    mkdirSync(directory, mode === undefined ? undefined : { mode });
    fsyncDirectory(dirname(directory));
  }
}

function durableWrite(file: string, bytes: string | Uint8Array, flags: "a" | "wx" = "a"): void {
  durableMkdir(dirname(file));
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`durable file is a symbolic link: ${file}`);
  const openFlags = flags === "a"
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(file, openFlags, 0o600);
  try {
    let offset = 0;
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function durableAppend(file: string, line: string): void {
  durableWrite(file, `${line.replace(/\n+$/, "")}\n`);
}

export function atomicWrite(file: string, bytes: string | Uint8Array, hooks?: { beforeRename?: () => void }): void {
  durableMkdir(dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    durableWrite(temporary, bytes, "wx");
    hooks?.beforeRename?.();
    renameSync(temporary, file);
    fsyncDirectory(dirname(file));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function atomicWriteNew(file: string, bytes: string | Uint8Array): boolean {
  durableMkdir(dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    durableWrite(temporary, bytes, "wx");
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fsyncDirectory(dirname(file));
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readCandlePartition(file: string): CandleRecord[] {
  const rows = gunzipSync(readFileSync(file)).toString("utf8").trim();
  if (!rows) return [];
  return rows.split("\n").map((line) => {
    const record = JSON.parse(line) as CandleRecord;
    assertCandleRecord(record);
    return record;
  });
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`research closure contains a symbolic link: ${path}`);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const bytewise = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const HOUR = 3_600_000;
export const RESEARCH_LOOKBACK_MS = 180 * 86_400_000;

export function containedPath(rootInput: string, pathInput: string): string {
  const root = resolve(rootInput);
  const path = resolve(root, pathInput);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("research path escapes root");
  let cursor = path;
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`research path is a symbolic link: ${relative(root, cursor)}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (lstatSync(root).isSymbolicLink()) throw new Error("research root is a symbolic link");
  if (!existsSync(path)) throw new Error(`research path is missing: ${relative(root, path)}`);
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) throw new Error("research path escapes real root");
  return path;
}

function dateParts(day: string): [string, string, string] {
  const parts = day.split("-");
  if (parts.length !== 3 || parts.some((part) => !/^\d{2,4}$/.test(part))) throw new Error("day must be YYYY-MM-DD");
  return parts as [string, string, string];
}

export function readSourceRegistryFact(root: string, hash: string): { registry: SourceRegistry; hash: string; path: string } {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("source registry fact hash is invalid");
  const path = containedPath(root, join("facts", "source-registries", `${hash}.json`));
  const bytes = readFileSync(path, "utf8");
  if (sha256(bytes) !== hash) throw new Error("source registry fact hash mismatch");
  return { registry: parseSourceRegistry(bytes), hash, path };
}

function sourceRegistry(root: string, rawFiles: string[]): { registry: SourceRegistry; hash: string; path: string } {
  const provenanceHashes = [...new Set(rawFiles.map((file) => {
    const provenance = JSON.parse(readFileSync(`${file}.provenance.json`, "utf8")) as { schemaVersion?: unknown; sourceRegistrySha256?: unknown };
    if (provenance.schemaVersion !== 1 || typeof provenance.sourceRegistrySha256 !== "string") throw new Error("candle shard provenance is invalid");
    return provenance.sourceRegistrySha256;
  }))];
  if (provenanceHashes.length > 1) throw new Error("daily shards use multiple source registries");
  const stateFile = join(root, "state", "collector.json");
  if (!existsSync(stateFile)) throw new Error("collector state is missing");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { sourceRegistrySha256?: unknown };
  const hash = provenanceHashes[0] ?? state.sourceRegistrySha256;
  if (typeof hash !== "string") throw new Error("collector state has no source registry hash");
  return readSourceRegistryFact(root, hash);
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

export function buildDailyManifest(root: string, day: string): DataManifest {
  const [year, month, date] = dateParts(day);
  const rawRoot = join(root, "raw", "candles", year, month, date);
  const rawFiles = filesBelow(rawRoot).filter((file) => file.endsWith(".jsonl.gz"));
  const fact = sourceRegistry(root, rawFiles);
  const records = rawFiles.flatMap(readCandlePartition);
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
  const files = [fact.path, ...rawFiles.flatMap((file) => [file, `${file}.provenance.json`])].map((file) => ({
    path: relative(root, file), bytes: statSync(file).size, sha256: sha256(readFileSync(file)), rows: file.endsWith(".jsonl.gz") ? readCandlePartition(file).length : 1, schemaVersion: 1 as const,
  })).sort((a, b) => bytewise(a.path, b.path));
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

export function buildRollingManifest(root: string, sourceRegistrySha256: string): DataManifest {
  const fact = readSourceRegistryFact(root, sourceRegistrySha256);
  const rawFiles = filesBelow(join(root, "raw", "candles")).filter((file) => file.endsWith(".jsonl.gz") && (() => {
    const provenance = JSON.parse(readFileSync(`${file}.provenance.json`, "utf8")) as { schemaVersion?: unknown; sourceRegistrySha256?: unknown };
    return provenance.schemaVersion === 1 && provenance.sourceRegistrySha256 === sourceRegistrySha256;
  })());
  const all = rawFiles.flatMap(readCandlePartition);
  if (!all.length) throw new Error("rolling manifest requires at least one closed candle");
  const toMs = Math.max(...all.map((record) => record.closeTimeMs));
  const fromMs = Math.max(0, toMs - RESEARCH_LOOKBACK_MS);
  const selectedFiles = rawFiles.filter((file) => readCandlePartition(file).some((record) => record.closeTimeMs >= fromMs && record.closeTimeMs <= toMs));
  const records = selectedFiles.flatMap(readCandlePartition).filter((record) => record.closeTimeMs >= fromMs && record.closeTimeMs <= toMs);
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
  const files = [fact.path, ...selectedFiles.flatMap((file) => [file, `${file}.provenance.json`])].map((file) => ({
    path: relative(root, file), bytes: statSync(file).size, sha256: sha256(readFileSync(file)), rows: file.endsWith(".jsonl.gz") ? readCandlePartition(file).length : 1, schemaVersion: 1 as const,
  })).sort((a, b) => bytewise(a.path, b.path));
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

export function publishRollingManifest(root: string, sourceRegistrySha256: string): { manifestPath: string; manifestSha256: string } {
  const manifest = buildRollingManifest(root, sourceRegistrySha256);
  const bytes = canonicalJson(manifest);
  const manifestSha256 = sha256(bytes);
  const manifestPath = join(root, "manifests", `${manifestSha256}.json`);
  if (!atomicWriteNew(manifestPath, bytes) && readFileSync(manifestPath, "utf8") !== bytes) throw new Error("immutable manifest already exists with different bytes");
  atomicWrite(join(root, "manifests", "current.json"), canonicalJson({
    schemaVersion: 1,
    manifestSha256,
    path: relative(root, manifestPath),
    sourceRegistrySha256,
    asOfMs: manifest.sourceRange.toMs,
    lookbackMs: RESEARCH_LOOKBACK_MS,
  }));
  return { manifestPath, manifestSha256 };
}

export function readCurrentManifest(root: string): { manifest: DataManifest; manifestPath: string; manifestSha256: string } {
  const pointerPath = containedPath(root, join("manifests", "current.json"));
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as {
    schemaVersion?: unknown; manifestSha256?: unknown; path?: unknown; sourceRegistrySha256?: unknown; asOfMs?: unknown; lookbackMs?: unknown;
  };
  if (pointer.schemaVersion !== 1 || typeof pointer.manifestSha256 !== "string" || typeof pointer.path !== "string" || typeof pointer.sourceRegistrySha256 !== "string") throw new Error("current manifest pointer is invalid");
  const manifestPath = containedPath(root, pointer.path);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DataManifest;
  if (sha256(canonicalJson(manifest)) !== pointer.manifestSha256) throw new Error("current manifest pointer hash mismatch");
  if (manifest.sourceRegistrySha256 !== pointer.sourceRegistrySha256 || manifest.sourceRange.toMs !== pointer.asOfMs || pointer.lookbackMs !== RESEARCH_LOOKBACK_MS || manifest.sourceRange.fromMs !== Math.max(0, manifest.sourceRange.toMs - RESEARCH_LOOKBACK_MS)) throw new Error("current manifest pointer closure mismatch");
  verifyManifest(root, manifest);
  return { manifest, manifestPath, manifestSha256: pointer.manifestSha256 };
}

export function verifyManifest(root: string, manifest: DataManifest): void {
  assertDataManifest(manifest);
  for (const file of manifest.files) {
    let path: string;
    try {
      path = containedPath(root, file.path);
    } catch (error) {
      if (error instanceof Error && /symbolic link/.test(error.message)) throw error;
      if (error instanceof Error && /path is missing/.test(error.message)) throw new Error(`manifest file mismatch: ${file.path}`);
      throw new Error(`manifest file path escapes root: ${file.path}`);
    }
    const rows = file.path.endsWith(".jsonl.gz") ? readCandlePartition(path).length : 1;
    if (statSync(path).size !== file.bytes || sha256(readFileSync(path)) !== file.sha256 || rows !== file.rows || file.schemaVersion !== 1) throw new Error(`manifest file mismatch: ${file.path}`);
  }
  const fact = manifest.files.find((file) => file.path === `facts/source-registries/${manifest.sourceRegistrySha256}.json`);
  if (!fact) throw new Error("manifest omits source registry fact");
  if (fact.sha256 !== manifest.sourceRegistrySha256) throw new Error("source registry fact hash mismatch");
}
