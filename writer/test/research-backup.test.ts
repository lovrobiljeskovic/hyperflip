import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupResearch } from "../src/research/backup.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import type { CorrelationArtifact, DataManifest, SourceRegistry } from "../src/research/types.js";

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string): Buffer => createHmac("sha256", key).update(value).digest();

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("research backup signs, skips verified objects, and restores the immutable closure without leaking credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "hype-backup-"));
  const accessKey = `test-access-${randomUUID()}`;
  const secret = `test-secret-${randomUUID()}`;
  const objects = new Map<string, { bytes: Buffer; checksum: string }>();
  const attempts = new Map<string, number>();
  let puts = 0;
  const server = createServer(async (request, response) => {
    const bytes = await body(request);
    const authorization = String(request.headers.authorization);
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
    assert.ok(match);
    assert.equal(match[1], accessKey);
    assert.equal(match[3], "fixture-1");
    const signedHeaders = match[4].split(";");
    const canonicalHeaders = signedHeaders.map((name) => `${name}:${String(request.headers[name]).trim().replace(/\s+/g, " ")}\n`).join("");
    const parsedUrl = new URL(request.url!, "http://fixture");
    assert.deepEqual([...parsedUrl.searchParams], [["z", "last"], ["a", "two"], ["a", "one"], ["bang", "!"], ["A", "z"], ["encoded/key", "*"], ["mix", "a"], ["mix", "A"], ["mix", "/"]]);
    const canonicalQuery = "A=z&a=one&a=two&bang=%21&encoded%2Fkey=%2A&mix=%2F&mix=A&mix=a&z=last";
    const canonicalRequest = [request.method, parsedUrl.pathname, canonicalQuery, canonicalHeaders, match[4], request.headers["x-amz-content-sha256"]].join("\n");
    const scope = `${match[2]}/${match[3]}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", request.headers["x-amz-date"], scope, digest(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, match[2]), match[3]), "s3"), "aws4_request");
    assert.equal(match[5], createHmac("sha256", signingKey).update(stringToSign).digest("hex"));
    const key = decodeURIComponent(parsedUrl.pathname.replace(/^\/api%20root\/fixture-bucket\//, ""));
    if (key === "reports/fixture !'()*.html") {
      assert.equal(parsedUrl.pathname, "/api%20root/fixture-bucket/reports/fixture%20%21%27%28%29%2A.html");
      assert.equal(canonicalQuery, "A=z&a=one&a=two&bang=%21&encoded%2Fkey=%2A&mix=%2F&mix=A&mix=a&z=last");
    }
    const attemptKey = `${request.method}:${key}`;
    const attempt = (attempts.get(attemptKey) ?? 0) + 1;
    attempts.set(attemptKey, attempt);
    if (request.method === "HEAD" && key === "reports/fixture !'()*.html" && attempt < 3) {
      response.statusCode = attempt === 1 ? 408 : 429;
      response.end();
      return;
    }
    if (request.method === "HEAD") {
      const found = objects.get(key);
      response.statusCode = found ? 200 : 404;
      if (found) response.setHeader("x-amz-meta-sha256", found.checksum);
      response.end();
      return;
    }
    assert.equal(request.method, "PUT");
    assert.equal(digest(bytes), request.headers["x-amz-content-sha256"]);
    assert.equal(request.headers["x-amz-meta-sha256"], digest(bytes));
    objects.set(key, { bytes, checksum: digest(bytes) });
    puts++;
    response.statusCode = 200;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const sources: SourceRegistry = { schemaVersion: 1, sources: [] };
    const sourceBytes = canonicalJson(sources);
    const sourceHash = sha256(sourceBytes);
    const sourcePath = `facts/source-registries/${sourceHash}.json`;
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    writeFileSync(join(root, sourcePath), sourceBytes);
    const manifest: DataManifest = { schemaVersion: 1, createdAt: "2026-08-27T00:00:00.000Z", sourceRegistrySha256: sourceHash, sourceRange: { fromMs: 0, toMs: 0 }, underlyings: {}, files: [{ path: sourcePath, bytes: Buffer.byteLength(sourceBytes), sha256: sourceHash, rows: 1, schemaVersion: 1 }] };
    const manifestHash = sha256(canonicalJson(manifest));
    mkdirSync(join(root, "manifests"), { recursive: true });
    writeFileSync(join(root, "manifests", `${manifestHash}.json`), canonicalJson(manifest));
    const artifact = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8")) as CorrelationArtifact;
    artifact.modelVersion = "backup-fixture";
    artifact.dataManifestSha256 = manifestHash;
    artifact.sourceRegistrySha256 = sourceHash;
    const candidateBytes = `${canonicalJson(artifact)}\n`;
    mkdirSync(join(root, "artifacts", "candidates"), { recursive: true });
    writeFileSync(join(root, "artifacts", "candidates", "backup-fixture.json"), candidateBytes);
    const baselineBytes = canonicalJson({ fixture: true });
    const baselineHash = sha256(baselineBytes);
    const baselinePath = `facts/baselines/${baselineHash}.json`;
    mkdirSync(join(root, "facts", "baselines"), { recursive: true });
    writeFileSync(join(root, baselinePath), baselineBytes);
    const validation = { schemaVersion: 1, modelVersion: artifact.modelVersion, candidateSha256: sha256(candidateBytes), inputManifestSha256: manifestHash, baselineSha256: baselineHash, baselineSnapshotPath: baselinePath };
    const candidatePath = join(root, "artifacts", "candidates", "backup-fixture.json");
    const validationRelative = "artifacts/candidates/backup-fixture.validation.json";
    const validationPath = join(root, validationRelative);
    writeFileSync(validationPath, `${canonicalJson(validation)}\n`);
    mkdirSync(join(root, "reports"), { recursive: true });
    const reportRelative = "reports/fixture !'()*.html";
    writeFileSync(join(root, reportRelative), "fixture report");
    mkdirSync(join(root, "journal"), { recursive: true });
    writeFileSync(join(root, "journal", "fixture.jsonl"), "{}\n");
    mkdirSync(join(root, "quarantine"), { recursive: true });
    writeFileSync(join(root, "quarantine", "fixture.jsonl"), '{"reason":"fixture"}\n');

    const config = { endpoint: `http://127.0.0.1:${address.port}/api%20root?z=last&a=two&a=one&bang=!&A=%7A&encoded%2Fkey=%2A&mix=a&mix=A&mix=%2F`, region: "fixture-1", bucket: "fixture-bucket", accessKey, secret };
    writeFileSync(validationPath, `${canonicalJson({ ...validation, modelVersion: "../escape" })}\n`);
    await assert.rejects(backupResearch(root, config), /safe artifact filename/);
    writeFileSync(validationPath, `${canonicalJson({ ...validation, modelVersion: 7 })}\n`);
    await assert.rejects(backupResearch(root, config), /safe artifact filename/);
    writeFileSync(validationPath, `${canonicalJson(validation)}\n`);
    const corrupt = { ...artifact, dataManifestSha256: "f".repeat(64) };
    const corruptBytes = `${canonicalJson(corrupt)}\n`;
    writeFileSync(join(root, "artifacts", "candidates", "backup-fixture.json"), corruptBytes);
    writeFileSync(validationPath, `${canonicalJson({ ...validation, candidateSha256: sha256(corruptBytes) })}\n`);
    await assert.rejects(backupResearch(root, config), /candidate manifest mismatch/);
    writeFileSync(join(root, "artifacts", "candidates", "backup-fixture.json"), candidateBytes);
    writeFileSync(validationPath, `${canonicalJson(validation)}\n`);
    const first = await backupResearch(root, config);
    const firstPuts = puts;
    const second = await backupResearch(root, config);
    assert.ok(first.uploaded > 0);
    assert.equal(second.uploaded, 1); // backup.json changed after the first completed run
    assert.equal(second.skipped, firstPuts);
    assert.ok(objects.has("quarantine/fixture.jsonl"));
    assert.equal(attempts.get(`HEAD:${reportRelative}`)! >= 3, true);

    const persisted = [JSON.stringify(first), JSON.stringify(second), readFileSync(join(root, "state", "backup.json"), "utf8")].join("\n");
    assert.equal(persisted.includes(accessKey), false);
    assert.equal(persisted.includes(secret), false);

    const manifestRelative = `manifests/${manifestHash}.json`;
    const candidateRelative = "artifacts/candidates/backup-fixture.json";
    const restore = [sourcePath, baselinePath, manifestRelative, candidateRelative, validationRelative, reportRelative];
    const expectedHashes = Object.fromEntries(restore.map((path) => [path, sha256(readFileSync(join(root, path)))]));
    for (const path of restore) rmSync(join(root, path), { force: true });
    for (const path of restore) {
      const stored = objects.get(path);
      assert.ok(stored);
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), stored.bytes);
      assert.equal(sha256(readFileSync(join(root, path))), expectedHashes[path]);
    }
    assert.equal(sha256(readFileSync(join(root, sourcePath))), sourceHash);
    assert.equal(sha256(readFileSync(join(root, baselinePath))), baselineHash);
    const restoredValidation = JSON.parse(readFileSync(validationPath, "utf8")) as typeof validation;
    assert.equal(sha256(readFileSync(candidatePath)), restoredValidation.candidateSha256);
    assert.equal(sha256(canonicalJson(JSON.parse(readFileSync(join(root, manifestRelative), "utf8")))), restoredValidation.inputManifestSha256);
    assert.equal(sha256(readFileSync(join(root, restoredValidation.baselineSnapshotPath))), restoredValidation.baselineSha256);
    assert.equal(sha256(readFileSync(join(root, reportRelative))), sha256("fixture report"));
    assert.equal(existsSync(join(root, "registry")), false);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("research backup total deadline starts before synchronous closure traversal", async () => {
  const root = mkdtempSync(join(tmpdir(), "hype-backup-deadline-"));
  let clockReads = 0;
  let fetches = 0;
  try {
    await assert.rejects(backupResearch(root, { endpoint: "http://127.0.0.1:1", region: "fixture-1", bucket: "fixture", accessKey: "unused", secret: "unused" }, {
      now: () => clockReads++ === 0 ? 0 : 7_200_001,
      fetch: async () => { fetches++; throw new Error("must not fetch"); },
    }), /backup total timeout/);
    assert.equal(fetches, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
