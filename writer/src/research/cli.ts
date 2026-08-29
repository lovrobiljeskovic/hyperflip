import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { collectSources } from "./candles.js";
import { calibrate } from "./calibration.js";
import { runReplay } from "./replay.js";
import { deriveReturns } from "./returns.js";
import { openResearchPersistence } from "./persistence.js";
import { readCurrentManifest, researchRelativePath, RESEARCH_LOOKBACK_MS, sha256 } from "./store.js";
import type { CorrelationArtifact } from "./types.js";
import { parseMarkets } from "../markets.js";
import { promoteCandidate } from "./artifacts.js";
import { joinEvents } from "./journal.js";
import { backupResearch } from "./backup.js";
import { generateReport } from "./report.js";
import { runDaily } from "./daily.js";
import { bindResearchRootIdentity, loadResearchNetworkProfile, type LoadedResearchNetworkProfile } from "./network.js";

const command = process.argv[2];
const commands = ["collect", "derive", "calibrate", "replay", "promote", "join", "report", "daily", "backup", "check"];
let loadedProfile: LoadedResearchNetworkProfile | undefined;
const profile = (): LoadedResearchNetworkProfile => loadedProfile ??= loadResearchNetworkProfile(resolve(process.env.RESEARCH_NETWORK_PROFILE_FILE!));
const boundStorage = (root: string) => {
  const storage = openResearchPersistence(root);
  bindResearchRootIdentity(storage, profile());
  return storage;
};

if (!commands.includes(command)) {
  console.error(`usage: npm run research -- ${commands.join("|")}`);
  process.exitCode = 2;
} else if (command === "daily") {
  const root = process.env.RESEARCH_ROOT;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE) {
    console.error("RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE_FILE are required");
    process.exitCode = 2;
  } else {
    process.exitCode = runDaily(process.env, (step, env) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", step], { cwd: process.cwd(), env, encoding: "utf8" });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    });
  }
} else if (command === "check") {
  const { NODE_TEST_CONTEXT: _, ...checkEnv } = process.env;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern=research end-to-end", "test/research-end-to-end.test.ts"], { cwd: process.cwd(), env: checkEnv, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else if (command === "report") {
  const root = process.env.RESEARCH_ROOT;
  const candidateFile = process.env.RESEARCH_CANDIDATE_FILE;
  const derivedManifestFile = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE || !candidateFile || !derivedManifestFile) {
    console.error("RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE_FILE, RESEARCH_CANDIDATE_FILE, and RESEARCH_DERIVED_MANIFEST_FILE are required");
    process.exitCode = 2;
  } else {
    boundStorage(resolve(root));
    const output = generateReport(resolve(root), resolve(candidateFile), resolve(derivedManifestFile));
    console.log(JSON.stringify({ path: output.path, sha256: sha256(output.bytes) }));
  }
} else if (command === "backup") {
  const root = process.env.RESEARCH_ROOT;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE) {
    console.error("RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE_FILE are required");
    process.exitCode = 2;
  } else {
    boundStorage(resolve(root));
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
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE) {
    console.error("RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE_FILE are required");
    process.exitCode = 2;
  } else {
    const summary = await collectSources({
      root: resolve(root),
      profile: profile(),
    });
    console.log(JSON.stringify(summary));
    if (summary.failures.length) process.exitCode = 1;
  }
} else if (command === "derive") {
  const root = process.env.RESEARCH_ROOT;
  const manifestFile = process.env.RESEARCH_MANIFEST_FILE;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE) {
    console.error("RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE_FILE are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const storage = boundStorage(resolvedRoot);
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
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE || !manifestFile || !derivedManifestPath) {
    console.error("RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE_FILE, RESEARCH_MANIFEST_FILE, and RESEARCH_DERIVED_MANIFEST_FILE are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const storage = boundStorage(resolvedRoot);
    const artifact = calibrate({ root: resolvedRoot, manifest: JSON.parse(storage.readText(researchRelativePath(resolvedRoot, manifestFile))), derivedManifestPath: researchRelativePath(resolvedRoot, derivedManifestPath), profile: profile(), storage });
    console.log(JSON.stringify({ modelVersion: artifact.modelVersion, dataAsOf: artifact.dataAsOf, candidatePath: resolve(root, "artifacts", "candidates", `${artifact.modelVersion}.json`) }));
  }
} else if (command === "replay") {
  const root = process.env.RESEARCH_ROOT;
  const candidateFile = process.env.RESEARCH_CANDIDATE_FILE;
  const derivedManifestFile = process.env.RESEARCH_DERIVED_MANIFEST_FILE;
  const seed = process.env.RESEARCH_REPLAY_SEED;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE || !candidateFile || !derivedManifestFile || !seed) {
    console.error("RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE_FILE, RESEARCH_CANDIDATE_FILE, RESEARCH_DERIVED_MANIFEST_FILE, and RESEARCH_REPLAY_SEED are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const storage = boundStorage(resolvedRoot);
    const candidateBytes = storage.readText(researchRelativePath(resolvedRoot, candidateFile));
    const candidate = JSON.parse(candidateBytes) as CorrelationArtifact;
    const report = runReplay({
      root: resolvedRoot, candidate, candidateBytes, inputManifestSha256: candidate.dataManifestSha256,
      derivedManifestPath: researchRelativePath(resolvedRoot, derivedManifestFile), profile: profile(), seed, storage,
    });
    console.log(JSON.stringify({ modelVersion: report.modelVersion, decision: report.decision }));
  }
} else if (command === "join") {
  const root = process.env.RESEARCH_ROOT;
  const rpc = process.env.WRITER_RPC;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE || !rpc) {
    console.error("RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE_FILE, and WRITER_RPC are required");
    process.exitCode = 2;
  } else {
    try {
      const selected = profile();
      const summary = await joinEvents(resolve(root), {
        client: createPublicClient({ transport: http(rpc) }), vault: selected.deployment.parlayVault, deployBlock: BigInt(selected.deployment.parlayDeployBlock), profile: selected,
      });
      console.log(JSON.stringify(summary));
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
    }
  }
} else {
  const root = process.env.RESEARCH_ROOT;
  const args = process.argv.slice(3);
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE || args.length !== 2 || args[0] !== "--candidate" || !args[1]) {
    console.error("RESEARCH_ROOT, RESEARCH_NETWORK_PROFILE_FILE, and --candidate <path> are required");
    process.exitCode = 2;
  } else {
    const resolvedRoot = resolve(root);
    const candidate = resolve(resolvedRoot, args[1]);
    const selected = profile();
    const markets = parseMarkets(selected.marketRegistryRaw);
    const receipt = promoteCandidate(resolvedRoot, candidate, selected, markets, Date.now());
    console.log(JSON.stringify({ modelVersion: receipt.modelVersion, dataAgeMs: receipt.dataAgeMs, manifestHash: receipt.dataManifestSha256, validationState: receipt.validationState, championHash: receipt.championSha256 }));
  }
}
