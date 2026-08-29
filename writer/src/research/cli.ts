import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, isAddress } from "viem";
import { collectSources } from "./candles.js";
import { calibrate } from "./calibration.js";
import { loadReplaySourceRegistry, runReplay } from "./replay.js";
import { deriveReturns } from "./returns.js";
import { openResearchPersistence } from "./persistence.js";
import { canonicalJson, readCurrentManifest, readDerivedDataset, researchRelativePath, RESEARCH_LOOKBACK_MS, sha256 } from "./store.js";
import { parseSourceRegistry } from "./types.js";
import type { CorrelationArtifact } from "./types.js";
import { parseMarkets } from "../markets.js";
import { promoteCandidate } from "./artifacts.js";
import { joinEvents } from "./journal.js";
import { backupResearch } from "./backup.js";
import { generateReport } from "./report.js";
import { runDaily } from "./daily.js";
import { loadResearchNetworkProfile } from "./network.js";

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
  const derivedManifestFile = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  if (!root || !candidateFile || !derivedManifestFile) {
    console.error("RESEARCH_ROOT, RESEARCH_CANDIDATE_FILE, and RESEARCH_DERIVED_MANIFEST_FILE are required");
    process.exitCode = 2;
  } else {
    const output = generateReport(resolve(root), resolve(candidateFile), resolve(derivedManifestFile));
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
  const profileFile = process.env.RESEARCH_NETWORK_PROFILE;
  if (!root || !profileFile) {
    console.error("RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE are required");
    process.exitCode = 2;
  } else {
    const summary = await collectSources({
      root: resolve(root),
      profile: loadResearchNetworkProfile(resolve(profileFile)),
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
  const profileFile = process.env.RESEARCH_NETWORK_PROFILE;
  const manifestFile = process.env.RESEARCH_MANIFEST_FILE;
  const derivedManifestPath = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  if (!root || !profileFile || !manifestFile || !derivedManifestPath) {
    console.error("RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE, RESEARCH_MANIFEST_FILE, and RESEARCH_DERIVED_MANIFEST_FILE are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const storage = openResearchPersistence(resolvedRoot);
    const artifact = calibrate({ root: resolvedRoot, manifest: JSON.parse(storage.readText(researchRelativePath(resolvedRoot, manifestFile))), derivedManifestPath: researchRelativePath(resolvedRoot, derivedManifestPath), profile: loadResearchNetworkProfile(resolve(profileFile)), storage });
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
    const derived = readDerivedDataset(resolvedRoot, derivedManifestFile, storage);
    const manifest = derived.manifest;
    if (candidate.dataManifestSha256 !== manifest.dataManifestSha256) throw new Error("candidate and replay return manifest identities differ");
    if (manifest.sourceRegistrySha256 !== candidate.sourceRegistrySha256) throw new Error("replay source registry identity mismatch");
    const sources = loadReplaySourceRegistry(resolvedRoot, manifest.sourceRegistrySha256, storage);
    if (sources.some((source) => source.sourceNetwork !== manifest.network)) throw new Error("replay network identity mismatch");
    const report = runReplay({
      root: resolvedRoot, candidate, candidateBytes, inputManifestSha256: manifest.dataManifestSha256,
      baselineFile: resolve(baselineFile), series: { rows: derived.returns, sources, manifestHash: manifest.dataManifestSha256 }, seed, storage,
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
  const profileFile = process.env.RESEARCH_NETWORK_PROFILE;
  const sourcesFile = process.env.CORRELATION_SOURCES_FILE;
  const marketsFile = process.env.MARKETS_FILE;
  const args = process.argv.slice(3);
  if (!root || !profileFile || !sourcesFile || !marketsFile || args.length !== 2 || args[0] !== "--candidate" || !args[1]) {
    console.error("RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE, CORRELATION_SOURCES_FILE, MARKETS_FILE, and --candidate <path> are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const candidate = resolve(resolvedRoot, args[1]);
    const profile = loadResearchNetworkProfile(resolve(profileFile));
    const sources = parseSourceRegistry(readFileSync(resolve(sourcesFile), "utf8"));
    if (sha256(canonicalJson(sources)) !== profile.sourceRegistrySha256) throw new Error("promotion source registry differs from profile");
    const markets = parseMarkets(readFileSync(resolve(marketsFile), "utf8"));
    const receipt = promoteCandidate(resolvedRoot, candidate, profile, markets, Date.now());
    console.log(JSON.stringify({ modelVersion: receipt.modelVersion, dataAgeMs: receipt.dataAgeMs, manifestHash: receipt.dataManifestSha256, validationState: receipt.validationState, championHash: receipt.championSha256 }));
  }
}
