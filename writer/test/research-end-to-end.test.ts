import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calibrate } from "../src/research/calibration.js";
import { collectSources } from "../src/research/candles.js";
import { generateReport } from "../src/research/report.js";
import { runReplay } from "../src/research/replay.js";
import { deriveReturns, type ReturnRecord } from "../src/research/returns.js";
import { loadResearchNetworkProfile } from "../src/research/network.js";
import { canonicalJson, readCurrentManifest, readDerivedDataset } from "../src/research/store.js";
import type { SourceEntry, SourceRegistry } from "../src/research/types.js";

const AS_OF = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const sources: SourceRegistry = {
  schemaVersion: 2,
  network: "testnet",
  sources: ["BTC", "ETH", "SOL"].map((underlying): SourceEntry => ({ schemaVersion: 1, underlying, sourceNetwork: "testnet", sourceCoin: underlying, cluster: "crypto", calendar: "continuous", measurementEnabled: true, fallbackEligible: true })),
};

function candles(coin: string): string {
  const asset = sources.sources.findIndex((source) => source.sourceCoin === coin) + 1;
  const times = [...Array.from({ length: 94 }, (_, index) => AS_OF - (94 - index) * DAY), AS_OF - HOUR];
  return JSON.stringify(times.map((openTimeMs, index) => {
    const close = 100 + asset * 10 + index + Math.sin(index / (2 + asset));
    return { t: openTimeMs, T: openTimeMs + HOUR - 1, s: coin, i: "1h", o: String(close - 0.2), h: String(close + 0.5), l: String(close - 0.5), c: String(close), v: "10", n: 2 };
  }));
}

function profile(root: string) {
  const value = { schemaVersion: 1, network: "testnet", infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "correlations.json" };
  writeFileSync(join(root, "profile.json"), JSON.stringify(value));
  writeFileSync(join(root, "sources.json"), JSON.stringify(sources));
  for (const name of ["markets.json", "deployment.testnet.json", "correlations.json"]) writeFileSync(join(root, name === "deployment.testnet.json" ? "deployment.json" : name), readFileSync(new URL(`../../registry/${name}`, import.meta.url)));
  return loadResearchNetworkProfile(join(root, "profile.json"));
}

async function fixtureFlow(root: string): Promise<{ candidate: Buffer; validation: Buffer; manifest: Buffer; report: Buffer }> {
  const loadedProfile = profile(root);
  const collection = await collectSources({ root, profile: loadedProfile, nowMs: AS_OF, fetch: async (_url, init) => new Response(candles(JSON.parse(String(init?.body)).req.coin)) });
  assert.equal(collection.failures.length, 0);
  const current = readCurrentManifest(root);
  const manifest = current.manifest;
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const manifestHash = current.manifestSha256;
  const derived = deriveReturns(root, manifest, { asOfMs: manifest.sourceRange.toMs, lookbackMs: 180 * DAY });
  const candidate = calibrate({ root, manifest, derivedManifestPath: derived.manifestPath, profile: loadedProfile, now: () => AS_OF });
  const candidatePath = join(root, "artifacts", "candidates", `${candidate.modelVersion}.json`);
  const dataset = readDerivedDataset(root, derived.manifestPath);
  const rows: ReturnRecord[] = dataset.returns;
  runReplay({ root, profile: loadedProfile, candidate, candidateBytes: readFileSync(candidatePath, "utf8"), inputManifestSha256: manifestHash, series: { network: "testnet", rows, exclusions: dataset.exclusions, sources: sources.sources, manifestHash }, seed: "end-to-end" });
  const report = generateReport(root, candidatePath, derived.manifestPath);
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
