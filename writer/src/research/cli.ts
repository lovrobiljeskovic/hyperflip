import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { collectSources } from "./candles.js";
import { calibrate } from "./calibration.js";
import { runReplay } from "./replay.js";
import { deriveReturns } from "./returns.js";
import { openResearchPersistence } from "./persistence.js";
import { operationError, readCurrentManifest, researchRelativePath, RESEARCH_LOOKBACK_MS, sha256 } from "./store.js";
import type { CorrelationArtifact } from "./types.js";
import { parseMarkets } from "../markets.js";
import { promoteCandidate } from "./artifacts.js";
import { joinEvents } from "./journal.js";
import { backupResearch } from "./backup.js";
import { generateReport } from "./report.js";
import { runDaily } from "./daily.js";
import { bindResearchRootIdentity, loadResearchNetworkProfile, type LoadedResearchNetworkProfile } from "./network.js";
import { finishOperation, startOperation } from "./operations.js";
import type { ResearchOperation } from "./types.js";

const command = process.argv[2];
const commands = ["collect", "derive", "calibrate", "replay", "promote", "join", "report", "daily", "backup", "check"];
let loadedProfile: LoadedResearchNetworkProfile | undefined;
const profile = (): LoadedResearchNetworkProfile => loadedProfile ??= loadResearchNetworkProfile(resolve(process.env.RESEARCH_NETWORK_PROFILE_FILE!));
const boundStorage = (root: string) => {
  const storage = openResearchPersistence(root);
  bindResearchRootIdentity(storage, profile());
  return storage;
};

type PublicDetail = Record<string, string | number | boolean | null>;

async function recorded<T>(root: string, operation: Exclude<ResearchOperation, "daily">, action: () => Promise<T> | T, failure?: (value: T) => string | null, details?: (value: T) => PublicDetail): Promise<T> {
  const storage = boundStorage(root);
  const start = startOperation(storage, profile().profile.network, operation);
  try {
    const value = await action();
    const error = failure?.(value) ?? null;
    finishOperation(storage, start, error ? { status: "failure", stage: operation, error, detail: details?.(value) } : { status: "success", stage: operation, detail: details?.(value) });
    return value;
  } catch (error) {
    finishOperation(storage, start, { status: "failure", stage: operation, error: operationError(error) });
    throw error;
  }
}

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
    const output = await recorded(resolve(root), "report", () => generateReport(resolve(root), resolve(candidateFile), resolve(derivedManifestFile)), undefined, (value) => ({ path: researchRelativePath(resolve(root), value.path), sha256: sha256(value.bytes) }));
    console.log(JSON.stringify({ path: output.path, sha256: sha256(output.bytes) }));
  }
} else if (command === "backup") {
  const root = process.env.RESEARCH_ROOT;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE) {
    console.error("RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE_FILE are required");
    process.exitCode = 2;
  } else {
    const config = {
      endpoint: process.env.RESEARCH_BACKUP_ENDPOINT,
      region: process.env.RESEARCH_BACKUP_REGION,
      bucket: process.env.RESEARCH_BACKUP_BUCKET,
      accessKey: process.env.RESEARCH_BACKUP_ACCESS_KEY,
      secret: process.env.RESEARCH_BACKUP_SECRET_KEY,
    };
    if (Object.values(config).some((value) => !value)) {
      await recorded(resolve(root), "backup", () => undefined);
      console.log(JSON.stringify({ status: "disabled", reason: "backup configuration absent" }));
    } else console.log(JSON.stringify(await recorded(resolve(root), "backup", () => backupResearch(resolve(root), config as { endpoint: string; region: string; bucket: string; accessKey: string; secret: string }), undefined, (value) => ({ uploaded: value.uploaded, skipped: value.skipped, verified: value.verified, lastVerifiedObjectHash: value.lastVerifiedObjectHash }))));
  }
} else if (command === "collect") {
  const root = process.env.RESEARCH_ROOT;
  if (!root || !process.env.RESEARCH_NETWORK_PROFILE_FILE) {
    console.error("RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE_FILE are required");
    process.exitCode = 2;
  } else {
    const summary = await recorded(resolve(root), "collect", () => collectSources({
      root: resolve(root),
      profile: profile(),
    }), (value) => value.failures.length ? `${value.failures.length} collection failures` : null, (value) => ({ accepted: value.accepted, conflicts: value.conflicts, failures: value.failures.length }));
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
    const artifact = await recorded(resolvedRoot, "calibrate", () => {
      const storage = boundStorage(resolvedRoot);
      return calibrate({ root: resolvedRoot, manifest: JSON.parse(storage.readText(researchRelativePath(resolvedRoot, manifestFile))), derivedManifestPath: researchRelativePath(resolvedRoot, derivedManifestPath), profile: profile(), storage });
    }, undefined, (value) => ({ modelVersion: value.modelVersion, dataManifestSha256: value.dataManifestSha256, candidatePath: `artifacts/candidates/${value.modelVersion}.json` }));
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
    const report = await recorded(resolvedRoot, "replay", () => {
      const storage = boundStorage(resolvedRoot);
      const candidateBytes = storage.readText(researchRelativePath(resolvedRoot, candidateFile));
      const candidate = JSON.parse(candidateBytes) as CorrelationArtifact;
      return runReplay({
        root: resolvedRoot, candidate, candidateBytes, inputManifestSha256: candidate.dataManifestSha256,
        derivedManifestPath: researchRelativePath(resolvedRoot, derivedManifestFile), profile: profile(), seed, storage,
      });
    }, undefined, (value) => ({ modelVersion: value.modelVersion, decision: value.decision, validationPath: `artifacts/candidates/${value.modelVersion}.validation.json` }));
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
      const summary = await recorded(resolve(root), "join", () => joinEvents(resolve(root), {
        client: createPublicClient({ transport: http(rpc) }), vault: selected.deployment.parlayVault, deployBlock: BigInt(selected.deployment.parlayDeployBlock), profile: selected,
      }), undefined, (value) => ({ appended: value.appended, resolutions: Object.keys(value.resolutions).length, nextBlock: value.nextBlock }));
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
    const receipt = await recorded(resolvedRoot, "promote", () => {
      const candidate = resolve(resolvedRoot, args[1]);
      const selected = profile();
      return promoteCandidate(resolvedRoot, candidate, selected, parseMarkets(selected.marketRegistryRaw), Date.now());
    }, undefined, (value) => ({ modelVersion: value.modelVersion, dataAgeMs: value.dataAgeMs, dataManifestSha256: value.dataManifestSha256, validationState: value.validationState, championSha256: value.championSha256 }));
    console.log(JSON.stringify({ modelVersion: receipt.modelVersion, dataAgeMs: receipt.dataAgeMs, manifestHash: receipt.dataManifestSha256, validationState: receipt.validationState, championHash: receipt.championSha256 }));
  }
}
