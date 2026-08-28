import "dotenv/config";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { collectSources } from "./candles.js";
import { calibrate } from "./calibration.js";
import { runReplay } from "./replay.js";
import { deriveReturns } from "./returns.js";
import { sha256 } from "./store.js";
import { parseSourceRegistry } from "./types.js";
import type { ReturnRecord } from "./returns.js";
import type { CorrelationArtifact } from "./types.js";

if (process.argv[2] !== "collect" && process.argv[2] !== "derive" && process.argv[2] !== "calibrate" && process.argv[2] !== "replay") {
  console.error("usage: npm run research -- collect|derive|calibrate|replay");
  process.exitCode = 2;
} else if (process.argv[2] === "collect") {
  const root = process.env.RESEARCH_ROOT;
  const registryFile = process.env.CORRELATION_SOURCES_FILE;
  if (!root || !registryFile) {
    console.error("RESEARCH_ROOT and CORRELATION_SOURCES_FILE are required");
    process.exitCode = 2;
  } else {
    const summary = await collectSources({
      root: resolve(root),
      registry: parseSourceRegistry(readFileSync(resolve(registryFile), "utf8")),
      apiUrl: process.env.RESEARCH_INFO_API_URL,
    });
    console.log(JSON.stringify(summary));
    if (summary.failures.length) process.exitCode = 1;
  }
} else if (process.argv[2] === "derive") {
  const root = process.env.RESEARCH_ROOT;
  const manifestFile = process.env.RESEARCH_MANIFEST_FILE;
  const asOfMs = Number(process.env.RESEARCH_AS_OF_MS);
  const lookbackMs = Number(process.env.RESEARCH_LOOKBACK_MS);
  if (!root || !manifestFile || !Number.isSafeInteger(asOfMs) || !Number.isSafeInteger(lookbackMs) || lookbackMs < 0) {
    console.error("RESEARCH_ROOT, RESEARCH_MANIFEST_FILE, RESEARCH_AS_OF_MS, and RESEARCH_LOOKBACK_MS are required");
    process.exitCode = 2;
  } else {
    const output = deriveReturns(resolve(root), JSON.parse(readFileSync(resolve(manifestFile), "utf8")), { asOfMs, lookbackMs });
    console.log(JSON.stringify(output));
  }
} else if (process.argv[2] === "calibrate") {
  const root = process.env.RESEARCH_ROOT;
  const manifestFile = process.env.RESEARCH_MANIFEST_FILE;
  const derivedManifestPath = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  if (!root || !manifestFile || !derivedManifestPath) {
    console.error("RESEARCH_ROOT, RESEARCH_MANIFEST_FILE, and RESEARCH_DERIVED_MANIFEST_FILE are required");
    process.exitCode = 2;
  } else {
    const artifact = calibrate({ root: resolve(root), manifest: JSON.parse(readFileSync(resolve(manifestFile), "utf8")), derivedManifestPath });
    console.log(JSON.stringify({ modelVersion: artifact.modelVersion, dataAsOf: artifact.dataAsOf }));
  }
} else {
  const root = process.env.RESEARCH_ROOT;
  const candidateFile = process.env.RESEARCH_CANDIDATE_FILE;
  const derivedManifestFile = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  const sourcesFile = process.env.CORRELATION_SOURCES_FILE;
  const baselineFile = process.env.CORRELATIONS_FILE;
  const seed = process.env.RESEARCH_REPLAY_SEED;
  const draws = process.env.RESEARCH_REPLAY_DRAWS === undefined ? 20_000 : Number(process.env.RESEARCH_REPLAY_DRAWS);
  if (!root || !candidateFile || !derivedManifestFile || !sourcesFile || !baselineFile || !seed || !Number.isSafeInteger(draws) || draws <= 0) {
    console.error("RESEARCH_ROOT, RESEARCH_CANDIDATE_FILE, RESEARCH_DERIVED_MANIFEST_FILE, CORRELATION_SOURCES_FILE, CORRELATIONS_FILE, and RESEARCH_REPLAY_SEED are required; RESEARCH_REPLAY_DRAWS must be a positive integer when set");
    process.exitCode = 2;
  } else {
    const candidateBytes = readFileSync(resolve(candidateFile), "utf8");
    const candidate = JSON.parse(candidateBytes) as CorrelationArtifact;
    const manifestPath = resolve(derivedManifestFile);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dataManifestSha256: string; sourceRegistrySha256: string; files: { path: string; bytes: number; sha256: string; rows: number; schemaVersion: number }[] };
    if (candidate.dataManifestSha256 !== manifest.dataManifestSha256) throw new Error("candidate and replay return manifest identities differ");
    const rows = manifest.files.flatMap((file) => {
      const path = resolve(root, file.path);
      if (path !== resolve(root) && !path.startsWith(`${resolve(root)}/`)) throw new Error("replay return path escapes root");
      if (!existsSync(path) || file.schemaVersion !== 1 || statSync(path).size !== file.bytes) throw new Error(`replay return file mismatch: ${file.path}`);
      const bytes = readFileSync(path);
      if (sha256(bytes) !== file.sha256) throw new Error(`replay return file mismatch: ${file.path}`);
      const text = gunzipSync(bytes).toString("utf8").trim();
      const parsed = text ? text.split("\n").map((line) => JSON.parse(line) as ReturnRecord) : [];
      if (parsed.length !== file.rows) throw new Error(`replay return file mismatch: ${file.path}`);
      return parsed;
    });
    const sourceBytes = readFileSync(resolve(sourcesFile));
    if (sha256(sourceBytes) !== manifest.sourceRegistrySha256 || manifest.sourceRegistrySha256 !== candidate.sourceRegistrySha256) throw new Error("replay source registry identity mismatch");
    const sources = parseSourceRegistry(sourceBytes.toString("utf8")).sources;
    const report = runReplay({
      root: resolve(root), candidate, candidateBytes, inputManifestSha256: manifest.dataManifestSha256,
      baselineFile: resolve(baselineFile), series: { rows, sources, manifestHash: manifest.dataManifestSha256 }, seed, draws,
    });
    console.log(JSON.stringify({ modelVersion: report.modelVersion, decision: report.decision }));
  }
}
