import { resolve } from "node:path";
import { openResearchPersistence } from "./persistence.js";
import { operationError, writeOperationState } from "./store.js";
import { bindResearchRootIdentity, loadResearchNetworkProfile } from "./network.js";

export interface DailyResult { status: number | null; stdout: string; stderr: string }
type DailyStep = "derive" | "calibrate" | "replay" | "join" | "report";

function output(result: DailyResult): Record<string, unknown> {
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("daily command returned no identity output");
  return JSON.parse(line) as Record<string, unknown>;
}

export function runDaily(env: NodeJS.ProcessEnv, run: (step: DailyStep, env: NodeJS.ProcessEnv) => DailyResult, now: () => number = Date.now): number {
  const root = env.RESEARCH_ROOT ? resolve(env.RESEARCH_ROOT) : null;
  const storage = root ? openResearchPersistence(root) : null;
  if (root) {
    if (!env.RESEARCH_NETWORK_PROFILE_FILE) throw new Error("RESEARCH_NETWORK_PROFILE_FILE is required");
    bindResearchRootIdentity(storage!, loadResearchNetworkProfile(resolve(env.RESEARCH_NETWORK_PROFILE_FILE)));
  }
  const started = now();
  const persist = (status: "running" | "succeeded" | "failed", error: string | null, step: DailyStep | null): void => {
    if (!root) return;
    const at = now();
    writeOperationState(root, "daily.json", { schemaVersion: 1, operation: "daily", status, startedAt: new Date(started).toISOString(), endedAt: status === "running" ? null : new Date(at).toISOString(), error, details: { step } }, storage!);
  };
  persist("running", null, null);
  let current = { ...env };
  let active: DailyStep | null = null;
  try {
    for (const step of ["derive", "calibrate", "replay", "join", "report"] as const) {
      active = step;
      const result = run(step, current);
      if (result.status !== 0) {
        const status = result.status ?? 1;
        persist("failed", `${step} exited ${status}`, step);
        return status;
      }
      if (step === "derive") {
        const manifestPath = output(result).manifestPath;
        const dataManifestPath = output(result).dataManifestPath;
        if (typeof manifestPath !== "string" || !manifestPath) throw new Error("daily derive returned no manifestPath");
        if (typeof dataManifestPath !== "string" || !dataManifestPath) throw new Error("daily derive returned no dataManifestPath");
        current = { ...current, RESEARCH_MANIFEST_FILE: dataManifestPath, RESEARCH_DERIVED_MANIFEST_FILE: manifestPath };
      } else if (step === "calibrate") {
        const candidatePath = output(result).candidatePath;
        if (typeof candidatePath !== "string" || !candidatePath) throw new Error("daily calibrate returned no candidatePath");
        current = { ...current, RESEARCH_CANDIDATE_FILE: candidatePath };
      }
    }
    persist("succeeded", null, active);
    return 0;
  } catch (error) {
    persist("failed", operationError(error), active);
    throw error;
  }
}
