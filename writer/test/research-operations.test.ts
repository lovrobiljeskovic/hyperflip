import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runDaily, type DailyResult } from "../src/research/daily.js";

const cwd = resolve(import.meta.dirname, "..");
const cli = (command: string, env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", command], { cwd, env, encoding: "utf8" });

test("research backup exits successfully with an explicit disabled status when configuration is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-backup-disabled-"));
  try {
    const result = cli("backup", { ...process.env, RESEARCH_ROOT: root, RESEARCH_BACKUP_ENDPOINT: "", RESEARCH_BACKUP_REGION: "", RESEARCH_BACKUP_BUCKET: "", RESEARCH_BACKUP_ACCESS_KEY: "", RESEARCH_BACKUP_SECRET_KEY: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"disabled"/);
    assert.match(result.stdout, /backup configuration absent/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research daily stops at the first failed bounded command", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-daily-"));
  try {
    const result = cli("daily", { ...process.env, RESEARCH_ROOT: root, RESEARCH_MANIFEST_FILE: "", RESEARCH_AS_OF_MS: "", RESEARCH_LOOKBACK_MS: "" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /RESEARCH_MANIFEST_FILE.*RESEARCH_AS_OF_MS.*RESEARCH_LOOKBACK_MS/);
    assert.doesNotMatch(result.stderr, /RESEARCH_DERIVED_MANIFEST_FILE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research daily reports the candidate produced by the same derivation and calibration", () => {
  const staleDerived = "/research/derived/stale.manifest.json";
  const staleCandidate = "/research/artifacts/candidates/stale.json";
  const freshDerived = "/research/derived/fresh.manifest.json";
  const freshCandidate = "/research/artifacts/candidates/fresh.json";
  const seen: { step: string; derived?: string; candidate?: string }[] = [];
  const outputs: Record<string, DailyResult> = {
    derive: { status: 0, stdout: `${JSON.stringify({ manifestPath: freshDerived })}\n`, stderr: "" },
    calibrate: { status: 0, stdout: `${JSON.stringify({ modelVersion: "fresh", candidatePath: freshCandidate })}\n`, stderr: "" },
    replay: { status: 0, stdout: `${JSON.stringify({ modelVersion: "fresh", decision: "Supported" })}\n`, stderr: "" },
    join: { status: 0, stdout: "{}\n", stderr: "" },
    report: { status: 0, stdout: `${JSON.stringify({ path: "/research/reports/fresh.html" })}\n`, stderr: "" },
  };
  const result = runDaily({ RESEARCH_ROOT: "/research", RESEARCH_DERIVED_MANIFEST_FILE: staleDerived, RESEARCH_CANDIDATE_FILE: staleCandidate }, (step, env) => {
    seen.push({ step, derived: env.RESEARCH_DERIVED_MANIFEST_FILE, candidate: env.RESEARCH_CANDIDATE_FILE });
    return outputs[step];
  });
  assert.equal(result, 0);
  assert.deepEqual(seen, [
    { step: "derive", derived: staleDerived, candidate: staleCandidate },
    { step: "calibrate", derived: freshDerived, candidate: staleCandidate },
    { step: "replay", derived: freshDerived, candidate: freshCandidate },
    { step: "join", derived: freshDerived, candidate: freshCandidate },
    { step: "report", derived: freshDerived, candidate: freshCandidate },
  ]);
});

test("research check runs exactly one complete deterministic end-to-end fixture", () => {
  const result = cli("check", process.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# pass 1\b/);
});

test("research operations definitions are isolated, bounded, and scheduled independently", () => {
  const unit = (name: string): string => readFileSync(resolve(cwd, "..", "ops", "systemd", name), "utf8");
  const parse = (name: string): Record<string, Record<string, string[]>> => {
    const sections: Record<string, Record<string, string[]>> = {};
    let section = "";
    for (const line of unit(name).split("\n").map((value) => value.trim()).filter(Boolean)) {
      if (line.startsWith("[") && line.endsWith("]")) { section = line.slice(1, -1); sections[section] = {}; continue; }
      const split = line.indexOf("=");
      if (split > 0) (sections[section][line.slice(0, split)] ??= []).push(line.slice(split + 1));
    }
    return sections;
  };
  const assertService = (name: string, expected: Record<string, string[]>): void => {
    const text = unit(name);
    const parsed = parse(name);
    for (const [key, values] of Object.entries(expected)) assert.deepEqual(parsed.Service[key], values, `${name} ${key}`);
    assert.doesNotMatch(text, /Requires=keeper\.service|PartOf=keeper\.service|restart/i);
  };
  assertService("hype-research-collector.service", {
    Type: ["oneshot"], User: ["hype"], WorkingDirectory: ["/opt/hype/writer"], EnvironmentFile: ["/opt/hype/research.env"],
    ExecStart: ["/usr/bin/flock -w 300 /opt/hype/research/state/job.lock /usr/bin/npm run research -- collect"], Nice: ["10"], IOSchedulingClass: ["idle"], CPUQuota: ["25%"], MemoryMax: ["512M"], TimeoutStartSec: ["15m"],
  });
  assertService("hype-research-daily.service", {
    Type: ["oneshot"], User: ["hype"], WorkingDirectory: ["/opt/hype/writer"], EnvironmentFile: ["/opt/hype/research.env"],
    ExecStart: ["/usr/bin/flock -w 900 /opt/hype/research/state/job.lock /usr/bin/npm run research -- daily"], Nice: ["15"], IOSchedulingClass: ["idle"], CPUQuota: ["50%"], MemoryMax: ["1G"], TimeoutStartSec: ["2h"],
  });
  assert.deepEqual(parse("hype-research-daily.service").Unit.After, ["network-online.target", "hype-research-collector.service"]);
  assertService("hype-research-backup.service", {
    Type: ["oneshot"], User: ["hype"], WorkingDirectory: ["/opt/hype/writer"], EnvironmentFile: ["/opt/hype/research.env", "/opt/hype/research-backup.env"],
    ExecStart: ["/usr/bin/flock -w 7200 /opt/hype/research/state/job.lock /usr/bin/npm run research -- backup"], Nice: ["15"], IOSchedulingClass: ["idle"], CPUQuota: ["25%"], MemoryMax: ["512M"], TimeoutStartSec: ["4h"],
  });
  assert.deepEqual(parse("hype-research-backup.service").Unit.ConditionPathExists, ["/opt/hype/research-backup.env"]);
  assert.deepEqual(parse("hype-research-backup.service").Unit.After, ["network-online.target", "hype-research-daily.service"]);
  for (const [name, calendar, service] of [
    ["hype-research-collector.timer", "hourly", "hype-research-collector.service"],
    ["hype-research-daily.timer", "*-*-* 01:15:00 UTC", "hype-research-daily.service"],
    ["hype-research-backup.timer", "*-*-* 03:30:00 UTC", "hype-research-backup.service"],
  ]) {
    const timer = parse(name);
    assert.deepEqual(timer.Timer.OnCalendar, [calendar]);
    assert.deepEqual(timer.Timer.Persistent, ["true"]);
    assert.deepEqual(timer.Timer.Unit, [service]);
    assert.deepEqual(timer.Install.WantedBy, ["timers.target"]);
  }
});
