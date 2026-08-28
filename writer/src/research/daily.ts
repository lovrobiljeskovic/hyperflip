export interface DailyResult { status: number | null; stdout: string; stderr: string }
type DailyStep = "derive" | "calibrate" | "replay" | "join" | "report";

function output(result: DailyResult): Record<string, unknown> {
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("daily command returned no identity output");
  return JSON.parse(line) as Record<string, unknown>;
}

export function runDaily(env: NodeJS.ProcessEnv, run: (step: DailyStep, env: NodeJS.ProcessEnv) => DailyResult): number {
  let current = { ...env };
  for (const step of ["derive", "calibrate", "replay", "join", "report"] as const) {
    const result = run(step, current);
    if (result.status !== 0) return result.status ?? 1;
    if (step === "derive") {
      const manifestPath = output(result).manifestPath;
      if (typeof manifestPath !== "string" || !manifestPath) throw new Error("daily derive returned no manifestPath");
      current = { ...current, RESEARCH_DERIVED_MANIFEST_FILE: manifestPath };
    } else if (step === "calibrate") {
      const candidatePath = output(result).candidatePath;
      if (typeof candidatePath !== "string" || !candidatePath) throw new Error("daily calibrate returned no candidatePath");
      current = { ...current, RESEARCH_CANDIDATE_FILE: candidatePath };
    }
  }
  return 0;
}
