import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { calibrate } from "../src/research/calibration.js";
import { collectSources } from "../src/research/candles.js";
import { generateReport } from "../src/research/report.js";
import { runReplay } from "../src/research/replay.js";
import { deriveReturns, type ReturnRecord } from "../src/research/returns.js";
import { canonicalJson, readCurrentManifest } from "../src/research/store.js";
import type { SourceEntry, SourceRegistry } from "../src/research/types.js";

const AS_OF = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const sources: SourceRegistry = {
  schemaVersion: 1,
  sources: ["BTC", "ETH", "SOL"].map((underlying): SourceEntry => ({ schemaVersion: 1, underlying, sourceNetwork: "mainnet", sourceCoin: underlying, cluster: "crypto", calendar: "continuous", eligible: true, fallbackEligible: true })),
};

function candles(coin: string): string {
  const asset = sources.sources.findIndex((source) => source.sourceCoin === coin) + 1;
  const times = [...Array.from({ length: 94 }, (_, index) => AS_OF - (94 - index) * DAY), AS_OF - HOUR];
  return JSON.stringify(times.map((openTimeMs, index) => {
    const close = 100 + asset * 10 + index + Math.sin(index / (2 + asset));
    return { t: openTimeMs, T: openTimeMs + HOUR - 1, s: coin, i: "1h", o: String(close - 0.2), h: String(close + 0.5), l: String(close - 0.5), c: String(close), v: "10", n: 2 };
  }));
}

async function fixtureFlow(root: string): Promise<{ candidate: Buffer; validation: Buffer; manifest: Buffer; report: Buffer }> {
  const collection = await collectSources({ root, registry: sources, nowMs: AS_OF, fetch: async (_url, init) => new Response(candles(JSON.parse(String(init?.body)).req.coin)) });
  assert.equal(collection.failures.length, 0);
  const current = readCurrentManifest(root);
  const manifest = current.manifest;
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const manifestHash = current.manifestSha256;
  const derived = deriveReturns(root, manifest, { asOfMs: manifest.sourceRange.toMs, lookbackMs: 180 * DAY });
  const candidate = calibrate({ root, manifest, derivedManifestPath: derived.manifestPath, now: () => AS_OF });
  const candidatePath = join(root, "artifacts", "candidates", `${candidate.modelVersion}.json`);
  const derivedManifest = JSON.parse(readFileSync(derived.manifestPath, "utf8")) as { files: { path: string }[] };
  const text = gunzipSync(readFileSync(join(root, derivedManifest.files[0].path))).toString("utf8").trim();
  const rows = text ? text.split("\n").map((line) => JSON.parse(line) as ReturnRecord) : [];
  const baseline = { clusters: { crypto: Object.fromEntries(sources.sources.map((source) => [source.underlying, { global: 0.1, cluster: 0.2, underlying: 0.3 }])) } };
  const baselineFile = join(root, "baseline.json");
  writeFileSync(baselineFile, canonicalJson(baseline));
  runReplay({ root, candidate, candidateBytes: readFileSync(candidatePath, "utf8"), inputManifestSha256: manifestHash, baselineFile, series: { rows, sources: sources.sources, manifestHash }, seed: "end-to-end" });
  const report = generateReport(root, candidatePath);
  return {
    candidate: readFileSync(candidatePath),
    validation: readFileSync(join(root, "artifacts", "candidates", `${candidate.modelVersion}.validation.json`)),
    manifest: manifestBytes,
    report: Buffer.from(report.bytes),
  };
}

test("research end-to-end fixture produces identical candidate, validation, manifest, and report bytes twice", async () => {
  const roots = [mkdtempSync(join(tmpdir(), "hype-e2e-a-")), mkdtempSync(join(tmpdir(), "hype-e2e-b-"))];
  try {
    const first = await fixtureFlow(roots[0]);
    const second = await fixtureFlow(roots[1]);
    assert.deepEqual(second, first);
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});
