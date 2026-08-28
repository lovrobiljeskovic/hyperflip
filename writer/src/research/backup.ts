import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { atomicWrite, canonicalJson, sha256, verifyManifest } from "./store.js";
import type { DataManifest } from "./types.js";

export interface S3Config { endpoint: string; region: string; bucket: string; accessKey: string; secret: string }
export interface BackupSummary { uploaded: number; skipped: number; verified: number; completedAt: string; lastVerifiedObjectHash: string | null }

const EMPTY_HASH = createHash("sha256").update("").digest("hex");
const filesBelow = (path: string): string[] => existsSync(path) ? readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesBelow(join(path, entry.name)) : [join(path, entry.name)]) : [];
const hmac = (key: string | Buffer, value: string): Buffer => createHmac("sha256", key).update(value).digest();
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

function inside(root: string, path: string): boolean { return path === root || path.startsWith(`${root}${sep}`); }

function closure(root: string): string[] {
  const selected = new Set<string>();
  const add = (path: string): void => {
    const resolved = resolve(root, path);
    if (!inside(root, resolved) || !existsSync(resolved)) throw new Error(`backup reference mismatch: ${path}`);
    selected.add(resolved);
  };
  for (const directory of ["artifacts", "journal", "quarantine", "reports", "state"]) for (const file of filesBelow(join(root, directory))) selected.add(file);
  for (const file of filesBelow(join(root, "manifests")).filter((path) => path.endsWith(".json"))) {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as DataManifest;
    const expected = file.slice(file.lastIndexOf(sep) + 1, -5);
    if (sha256(canonicalJson(manifest)) !== expected) throw new Error(`manifest identity mismatch: ${relative(root, file)}`);
    verifyManifest(root, manifest);
    add(relative(root, file));
    for (const entry of manifest.files) add(entry.path);
  }
  for (const file of filesBelow(join(root, "artifacts", "candidates")).filter((path) => path.endsWith(".validation.json"))) {
    const validation = JSON.parse(readFileSync(file, "utf8")) as { modelVersion: string; candidateSha256: string; inputManifestSha256: string; baselineSha256: string; baselineSnapshotPath: string };
    const candidate = join(root, "artifacts", "candidates", `${validation.modelVersion}.json`);
    const candidateBytes = readFileSync(candidate);
    if (sha256(candidateBytes) !== validation.candidateSha256) throw new Error(`validation candidate mismatch: ${relative(root, file)}`);
    const artifact = JSON.parse(candidateBytes.toString("utf8")) as { dataManifestSha256?: unknown; sourceRegistrySha256?: unknown };
    if (artifact.dataManifestSha256 !== validation.inputManifestSha256) throw new Error(`validation candidate manifest mismatch: ${relative(root, file)}`);
    const manifest = join(root, "manifests", `${validation.inputManifestSha256}.json`);
    if (!existsSync(manifest)) throw new Error(`validation manifest missing: ${validation.inputManifestSha256}`);
    const manifestValue = JSON.parse(readFileSync(manifest, "utf8")) as DataManifest;
    if (artifact.sourceRegistrySha256 !== manifestValue.sourceRegistrySha256) throw new Error(`validation candidate source registry mismatch: ${relative(root, file)}`);
    const baseline = resolve(root, validation.baselineSnapshotPath);
    if (!inside(root, baseline) || sha256(readFileSync(baseline)) !== validation.baselineSha256) throw new Error(`validation baseline mismatch: ${relative(root, file)}`);
    add(relative(root, candidate)); add(relative(root, manifest)); add(validation.baselineSnapshotPath); add(relative(root, file));
  }
  return [...selected].sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function signature(config: S3Config, method: "HEAD" | "PUT", url: URL, checksum: string, now: Date): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = method === "PUT" ? checksum : EMPTY_HASH;
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (method === "PUT") headers["x-amz-meta-sha256"] = checksum;
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name]}\n`).join("");
  const canonicalRequest = [method, url.pathname, url.searchParams.toString(), canonicalHeaders, signedHeaders.join(";"), payloadHash].join("\n");
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${config.secret}`, date), config.region), "s3"), "aws4_request");
  const signed = createHmac("sha256", key).update(stringToSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signed}` };
}

async function request(config: S3Config, method: "HEAD" | "PUT", path: string, checksum: string, body?: Buffer, deadline = Date.now() + 7_200_000): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("backup total timeout");
    const url = new URL(`${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}/${encodePath(path)}`);
    try {
      const response = await fetch(url, { method, headers: signature(config, method, url, checksum, new Date()), body, signal: AbortSignal.timeout(Math.min(60_000, remaining)) });
      if (response.status < 500) return response;
      last = new Error(`backup HTTP ${response.status}`);
    } catch (error) { last = error; }
  }
  throw new Error(`backup request failed after 3 attempts: ${last instanceof Error ? last.message : String(last)}`);
}

export async function backupResearch(rootInput: string, config: S3Config): Promise<BackupSummary> {
  const root = resolve(rootInput);
  const files = closure(root);
  const deadline = Date.now() + 7_200_000;
  let uploaded = 0;
  let skipped = 0;
  let lastVerifiedObjectHash: string | null = null;
  for (const file of files) {
    const path = relative(root, file).split(sep).join("/");
    const bytes = readFileSync(file);
    const checksum = sha256(bytes);
    const existing = await request(config, "HEAD", path, checksum, undefined, deadline);
    if (existing.ok && existing.headers.get("x-amz-meta-sha256") === checksum) skipped++;
    else {
      const uploadedResponse = await request(config, "PUT", path, checksum, bytes, deadline);
      if (!uploadedResponse.ok) throw new Error(`backup PUT failed: ${path} (${uploadedResponse.status})`);
      uploaded++;
    }
    const verified = await request(config, "HEAD", path, checksum, undefined, deadline);
    if (!verified.ok || verified.headers.get("x-amz-meta-sha256") !== checksum) throw new Error(`backup checksum verification failed: ${path}`);
    lastVerifiedObjectHash = checksum;
  }
  const summary: BackupSummary = { uploaded, skipped, verified: files.length, completedAt: new Date().toISOString(), lastVerifiedObjectHash };
  atomicWrite(join(root, "state", "backup.json"), `${canonicalJson({ schemaVersion: 1, successAt: summary.completedAt, lastVerifiedObjectHash })}\n`);
  return summary;
}
