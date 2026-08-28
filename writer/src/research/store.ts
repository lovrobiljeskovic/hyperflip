import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { assertCandleRecord, assertDataManifest } from "./types.js";
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

function durableWrite(file: string, bytes: string | Uint8Array, flags: "a" | "wx" = "a"): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, flags);
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
  durableWrite(file, line.endsWith("\n") ? line : `${line}\n`);
}

export function atomicWrite(file: string, bytes: string | Uint8Array, hooks?: { beforeRename?: () => void }): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    durableWrite(temporary, bytes, "wx");
    hooks?.beforeRename?.();
    renameSync(temporary, file);
    const directory = openSync(dirname(file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
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
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function dateParts(day: string): [string, string, string] {
  const parts = day.split("-");
  if (parts.length !== 3 || parts.some((part) => !/^\d{2,4}$/.test(part))) throw new Error("day must be YYYY-MM-DD");
  return parts as [string, string, string];
}

function sourceRegistry(root: string): { registry: SourceRegistry; hash: string; path: string } {
  const stateFile = join(root, "state", "collector.json");
  if (!existsSync(stateFile)) throw new Error("collector state is missing");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { sourceRegistrySha256?: unknown };
  if (typeof state.sourceRegistrySha256 !== "string") throw new Error("collector state has no source registry hash");
  const path = join(root, "facts", "source-registries", `${state.sourceRegistrySha256}.json`);
  const bytes = readFileSync(path, "utf8");
  if (sha256(bytes) !== state.sourceRegistrySha256) throw new Error("source registry fact hash mismatch");
  return { registry: JSON.parse(bytes) as SourceRegistry, hash: state.sourceRegistrySha256, path };
}

export function buildDailyManifest(root: string, day: string): DataManifest {
  const [year, month, date] = dateParts(day);
  const fact = sourceRegistry(root);
  const rawRoot = join(root, "raw", "candles", year, month, date);
  const rawFiles = filesBelow(rawRoot).filter((file) => file.endsWith(".jsonl.gz"));
  const records = rawFiles.flatMap(readCandlePartition);
  const byUnderlying = new Map<string, CandleRecord[]>();
  for (const record of records) byUnderlying.set(record.underlying, [...(byUnderlying.get(record.underlying) ?? []), record]);
  const underlyings: DataManifest["underlyings"] = {};
  for (const source of fact.registry.sources) {
    const candles = [...(byUnderlying.get(source.underlying) ?? [])].sort((a, b) => a.openTimeMs - b.openTimeMs);
    const missingIntervals: number[] = [];
    if (source.calendar === "continuous") {
      for (let time = candles[0]?.openTimeMs ?? 0; candles.length && time <= candles[candles.length - 1].openTimeMs; time += 3_600_000) {
        if (!candles.some((candle) => candle.openTimeMs === time)) missingIntervals.push(time);
      }
    }
    underlyings[source.underlying] = {
      rows: candles.length,
      firstUsableObservationMs: candles[0]?.openTimeMs ?? null,
      lastUsableObservationMs: candles[candles.length - 1]?.openTimeMs ?? null,
      missingIntervals,
    };
  }
  const files = [fact.path, ...rawFiles].map((file) => ({
    path: relative(root, file), bytes: statSync(file).size, sha256: sha256(readFileSync(file)), rows: file.endsWith(".jsonl.gz") ? readCandlePartition(file).length : 1, schemaVersion: 1 as const,
  })).sort((a, b) => a.path.localeCompare(b.path));
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

export function verifyManifest(root: string, manifest: DataManifest): void {
  assertDataManifest(manifest);
  for (const file of manifest.files) {
    if (file.path.startsWith("../") || file.path.startsWith("/")) throw new Error("manifest file path escapes root");
    const path = join(root, file.path);
    if (!existsSync(path) || statSync(path).size !== file.bytes || sha256(readFileSync(path)) !== file.sha256) throw new Error(`manifest file mismatch: ${file.path}`);
  }
  if (!manifest.files.some((file) => file.path === `facts/source-registries/${manifest.sourceRegistrySha256}.json`)) throw new Error("manifest omits source registry fact");
}
