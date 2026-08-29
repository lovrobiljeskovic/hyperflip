import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createPublicClient, http, isAddress } from "viem";
import { collectSources } from "./candles.js";
import { calibrate } from "./calibration.js";
import { loadReplaySourceRegistry, runReplay } from "./replay.js";
import { deriveReturns } from "./returns.js";
import { openResearchPersistence } from "./persistence.js";
import { readCurrentManifest, researchRelativePath, RESEARCH_LOOKBACK_MS, sha256 } from "./store.js";
import { parseSourceRegistry } from "./types.js";
import type { ReturnRecord } from "./returns.js";
import type { CorrelationArtifact } from "./types.js";
import { parseMarkets } from "../markets.js";
import { promoteCandidate } from "./artifacts.js";
import { joinEvents } from "./journal.js";
import { backupResearch } from "./backup.js";
import { generateReport } from "./report.js";
import { runDaily } from "./daily.js";

const command = process.argv[2];
const commands = ["collect", "derive", "calibrate", "replay", "promote", "join", "report", "daily", "backup", "check"];

if (!commands.includes(command)) {
  console.error(`usage: npm run research -- ${commands.join("|")}`);
  process.exitCode = 2;
} else if (command === "daily") {
  process.exitCode = runDaily(process.env, (step, env) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", step], { cwd: process.cwd(), env, encoding: "utf8" });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  });
} else if (command === "check") {
  const { NODE_TEST_CONTEXT: _, ...checkEnv } = process.env;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern=research end-to-end", "test/research-end-to-end.test.ts"], { cwd: process.cwd(), env: checkEnv, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else if (command === "report") {
  const root = process.env.RESEARCH_ROOT;
  const candidateFile = process.env.RESEARCH_CANDIDATE_FILE;
  if (!root || !candidateFile) {
    console.error("RESEARCH_ROOT and RESEARCH_CANDIDATE_FILE are required");
    process.exitCode = 2;
  } else {
    const output = generateReport(resolve(root), resolve(candidateFile));
    console.log(JSON.stringify({ path: output.path, sha256: sha256(output.bytes) }));
  }
} else if (command === "backup") {
  const root = process.env.RESEARCH_ROOT;
  if (!root) {
    console.error("RESEARCH_ROOT is required");
    process.exitCode = 2;
  } else {
    const config = {
      endpoint: process.env.RESEARCH_BACKUP_ENDPOINT,
      region: process.env.RESEARCH_BACKUP_REGION,
      bucket: process.env.RESEARCH_BACKUP_BUCKET,
      accessKey: process.env.RESEARCH_BACKUP_ACCESS_KEY,
      secret: process.env.RESEARCH_BACKUP_SECRET_KEY,
    };
    if (Object.values(config).some((value) => !value)) console.log(JSON.stringify({ status: "disabled", reason: "backup configuration absent" }));
    else console.log(JSON.stringify(await backupResearch(resolve(root), config as { endpoint: string; region: string; bucket: string; accessKey: string; secret: string })));
  }
} else if (command === "collect") {
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
} else if (command === "derive") {
  const root = process.env.RESEARCH_ROOT;
  const manifestFile = process.env.RESEARCH_MANIFEST_FILE;
  if (!root) {
    console.error("RESEARCH_ROOT is required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const storage = openResearchPersistence(resolvedRoot);
    const current = manifestFile
      ? (() => { const path = researchRelativePath(resolvedRoot, manifestFile); return { manifestPath: resolve(resolvedRoot, path), manifest: JSON.parse(storage.readText(path)) }; })()
      : readCurrentManifest(resolvedRoot, storage);
    const output = deriveReturns(resolvedRoot, current.manifest, { asOfMs: current.manifest.sourceRange.toMs, lookbackMs: RESEARCH_LOOKBACK_MS }, storage);
    console.log(JSON.stringify({ ...output, dataManifestPath: current.manifestPath }));
  }
} else if (command === "calibrate") {
  const root = process.env.RESEARCH_ROOT;
  const manifestFile = process.env.RESEARCH_MANIFEST_FILE;
  const derivedManifestPath = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  if (!root || !manifestFile || !derivedManifestPath) {
    console.error("RESEARCH_ROOT, RESEARCH_MANIFEST_FILE, and RESEARCH_DERIVED_MANIFEST_FILE are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const storage = openResearchPersistence(resolvedRoot);
    const artifact = calibrate({ root: resolvedRoot, manifest: JSON.parse(storage.readText(researchRelativePath(resolvedRoot, manifestFile))), derivedManifestPath: researchRelativePath(resolvedRoot, derivedManifestPath), storage });
    console.log(JSON.stringify({ modelVersion: artifact.modelVersion, dataAsOf: artifact.dataAsOf, candidatePath: resolve(root, "artifacts", "candidates", `${artifact.modelVersion}.json`) }));
  }
} else if (command === "replay") {
  const root = process.env.RESEARCH_ROOT;
  const candidateFile = process.env.RESEARCH_CANDIDATE_FILE;
  const derivedManifestFile = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  const baselineFile = process.env.CORRELATIONS_FILE;
  const seed = process.env.RESEARCH_REPLAY_SEED;
  if (!root || !candidateFile || !derivedManifestFile || !baselineFile || !seed) {
    console.error("RESEARCH_ROOT, RESEARCH_CANDIDATE_FILE, RESEARCH_DERIVED_MANIFEST_FILE, CORRELATIONS_FILE, and RESEARCH_REPLAY_SEED are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const storage = openResearchPersistence(resolvedRoot);
    const candidateBytes = storage.readText(researchRelativePath(resolvedRoot, candidateFile));
    const candidate = JSON.parse(candidateBytes) as CorrelationArtifact;
    const manifestPath = researchRelativePath(resolvedRoot, derivedManifestFile);
    const manifest = JSON.parse(storage.readText(manifestPath)) as { dataManifestSha256: string; sourceRegistrySha256: string; files: { kind: "returns" | "exclusions"; path: string; bytes: number; sha256: string; rows: number; schemaVersion: number }[] };
    if (candidate.dataManifestSha256 !== manifest.dataManifestSha256) throw new Error("candidate and replay return manifest identities differ");
    const rows = manifest.files.flatMap((file) => {
      const path = researchRelativePath(resolvedRoot, file.path);
      const bytes = storage.read(path);
      if (file.schemaVersion !== 1 || (file.kind !== "returns" && file.kind !== "exclusions") || bytes.length !== file.bytes) throw new Error(`replay return file mismatch: ${file.path}`);
      if (sha256(bytes) !== file.sha256) throw new Error(`replay return file mismatch: ${file.path}`);
      const text = gunzipSync(bytes).toString("utf8").trim();
      const parsed = text ? text.split("\n").map((line) => JSON.parse(line)) : [];
      if (parsed.length !== file.rows) throw new Error(`replay return file mismatch: ${file.path}`);
      return file.kind === "returns" ? parsed as ReturnRecord[] : [];
    });
    if (manifest.sourceRegistrySha256 !== candidate.sourceRegistrySha256) throw new Error("replay source registry identity mismatch");
    const sources = loadReplaySourceRegistry(resolvedRoot, manifest.sourceRegistrySha256, storage);
    const report = runReplay({
      root: resolvedRoot, candidate, candidateBytes, inputManifestSha256: manifest.dataManifestSha256,
      baselineFile: resolve(baselineFile), series: { rows, sources, manifestHash: manifest.dataManifestSha256 }, seed, storage,
    });
    console.log(JSON.stringify({ modelVersion: report.modelVersion, decision: report.decision }));
  }
} else if (command === "join") {
  const root = process.env.RESEARCH_ROOT;
  const rpc = process.env.WRITER_RPC;
  const vault = process.env.PARLAY_VAULT_ADDRESS;
  const deployBlock = process.env.PARLAY_DEPLOY_BLOCK;
  if (!root || !rpc || !vault || !isAddress(vault) || !deployBlock || !/^\d+$/.test(deployBlock)) {
    console.error("RESEARCH_ROOT, WRITER_RPC, PARLAY_VAULT_ADDRESS, and PARLAY_DEPLOY_BLOCK are required");
    process.exitCode = 2;
  } else {
    try {
      const summary = await joinEvents(resolve(root), {
        client: createPublicClient({ transport: http(rpc) }), vault, deployBlock: BigInt(deployBlock),
      });
      console.log(JSON.stringify(summary));
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
    }
  }
} else {
  const root = process.env.RESEARCH_ROOT;
  const sourcesFile = process.env.CORRELATION_SOURCES_FILE;
  const marketsFile = process.env.MARKETS_FILE;
  const args = process.argv.slice(3);
  if (!root || !sourcesFile || !marketsFile || args.length !== 2 || args[0] !== "--candidate" || !args[1]) {
    console.error("RESEARCH_ROOT, CORRELATION_SOURCES_FILE, MARKETS_FILE, and --candidate <path> are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const candidate = resolve(resolvedRoot, args[1]);
    const sources = parseSourceRegistry(readFileSync(resolve(sourcesFile), "utf8"));
    const markets = parseMarkets(readFileSync(resolve(marketsFile), "utf8"));
    const receipt = promoteCandidate(resolvedRoot, candidate, sources, markets, Date.now());
    console.log(JSON.stringify({ modelVersion: receipt.modelVersion, dataAgeMs: receipt.dataAgeMs, manifestHash: receipt.dataManifestSha256, validationState: receipt.validationState, championHash: receipt.championSha256 }));
  }
}
