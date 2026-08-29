import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runDaily, type DailyResult } from "../src/research/daily.js";
import { finishOperation, startOperation, terminalOperationHistory, writeOperationRecord } from "../src/research/operations.js";
import { openResearchPersistence } from "../src/research/persistence.js";
import { operationError } from "../src/research/store.js";
import { bindResearchRootIdentity, loadResearchNetworkProfile } from "../src/research/network.js";

const cwd = resolve(import.meta.dirname, "..");
const profileFile = new URL("../../registry/research-network.testnet.json", import.meta.url).pathname;
const cli = (command: string, env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", command], { cwd, env, encoding: "utf8" });

test("research backup exits successfully with an explicit disabled status when configuration is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-backup-disabled-"));
  try {
    const result = cli("backup", { ...process.env, RESEARCH_ROOT: root, RESEARCH_NETWORK_PROFILE_FILE: profileFile, RESEARCH_BACKUP_ENDPOINT: "", RESEARCH_BACKUP_REGION: "", RESEARCH_BACKUP_BUCKET: "", RESEARCH_BACKUP_ACCESS_KEY: "", RESEARCH_BACKUP_SECRET_KEY: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"disabled"/);
    assert.match(result.stdout, /backup configuration absent/);
    assert.deepEqual(terminalOperationHistory(openResearchPersistence(root), "testnet").map((record) => [record.operation, record.status]), [["backup", "success"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operation records reject secrets and control characters", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-operation-record-"));
  try {
    const storage = openResearchPersistence(root);
    const record = {
      schemaVersion: 1 as const, network: "testnet" as const, runId: "20260829T000000000Z-00000000-0000-4000-8000-000000000001", operation: "collect" as const,
      phase: "terminal" as const, startedAt: "2026-08-29T00:00:00.000Z", endedAt: "2026-08-29T00:01:00.000Z", status: "failure" as const,
    };
    assert.throws(() => writeOperationRecord(storage, { ...record, error: "token=secret" }), /secret/i);
    assert.throws(() => writeOperationRecord(storage, { ...record, detail: { accepted: "safe\nunsafe" } }), /control/i);
    assert.throws(() => writeOperationRecord(storage, { ...record, network: "mainnet", error: "failed" }), /not enabled/);
    const start = startOperation(storage, "testnet", "collect", Date.parse("2026-08-29T00:00:00.000Z"));
    const terminal = finishOperation(storage, start, { status: "failure", error: operationError(new Error("TOKEN=abc\tAWS_SECRET=value\u0081")) });
    assert.equal(terminal.status, "failure");
    assert.doesNotMatch(terminal.error!, /abc|value|[\u0000-\u001f\u007f-\u009f]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daily preserves a failure terminal when its mutable state pointer is unsafe", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-daily-state-link-"));
  try {
    bindResearchRootIdentity(openResearchPersistence(root), loadResearchNetworkProfile(profileFile));
    mkdirSync(join(root, "state"));
    const target = join(root, "state-target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(root, "state", "daily.json"));
    assert.equal(runDaily({ RESEARCH_ROOT: root, RESEARCH_NETWORK_PROFILE_FILE: profileFile }, () => ({ status: 0, stdout: "{}\n", stderr: "" }), () => 1_725_000_000_000), 1);
    assert.deepEqual(terminalOperationHistory(openResearchPersistence(root), "testnet").map((record) => [record.operation, record.status, record.stage]), [["daily", "failure", "state"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research daily derives immutable inputs from the collector pointer without manual window pins", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-daily-"));
  try {
    const result = cli("daily", { ...process.env, RESEARCH_ROOT: root, RESEARCH_NETWORK_PROFILE_FILE: profileFile, RESEARCH_MANIFEST_FILE: "", RESEARCH_AS_OF_MS: "", RESEARCH_LOOKBACK_MS: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /current manifest pointer|manifests.*current/i);
    assert.doesNotMatch(result.stderr, /RESEARCH_MANIFEST_FILE.*RESEARCH_AS_OF_MS.*RESEARCH_LOOKBACK_MS/);
    assert.doesNotMatch(result.stderr, /RESEARCH_DERIVED_MANIFEST_FILE/);
    assert.equal(JSON.parse(readFileSync(join(root, "state", "daily.json"), "utf8")).status, "failed");
    assert.deepEqual(terminalOperationHistory(openResearchPersistence(root), "testnet").map((record) => [record.operation, record.status, record.stage]), [["daily", "failure", "derive"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research daily reports the candidate produced by the same derivation and calibration", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-daily-state-"));
  const staleDerived = join(root, "derived/stale.manifest.json");
  const staleCandidate = join(root, "artifacts/candidates/stale.json");
  const freshManifest = join(root, "manifests/fresh.json");
  const freshDerived = join(root, "derived/fresh.manifest.json");
  const freshCandidate = join(root, "artifacts/candidates/fresh.json");
  const seen: { step: string; manifest?: string; derived?: string; candidate?: string }[] = [];
  const outputs: Record<string, DailyResult> = {
    derive: { status: 0, stdout: `${JSON.stringify({ dataManifestPath: freshManifest, manifestPath: freshDerived })}\n`, stderr: "" },
    calibrate: { status: 0, stdout: `${JSON.stringify({ modelVersion: "fresh", candidatePath: freshCandidate })}\n`, stderr: "" },
    replay: { status: 0, stdout: `${JSON.stringify({ modelVersion: "fresh", decision: "Supported" })}\n`, stderr: "" },
    join: { status: 0, stdout: "{}\n", stderr: "" },
    report: { status: 0, stdout: `${JSON.stringify({ path: join(root, "reports/fresh.html") })}\n`, stderr: "" },
  };
  try {
    const result = runDaily({ RESEARCH_ROOT: root, RESEARCH_NETWORK_PROFILE_FILE: profileFile, RESEARCH_DERIVED_MANIFEST_FILE: staleDerived, RESEARCH_CANDIDATE_FILE: staleCandidate }, (step, env) => {
      seen.push({ step, manifest: env.RESEARCH_MANIFEST_FILE, derived: env.RESEARCH_DERIVED_MANIFEST_FILE, candidate: env.RESEARCH_CANDIDATE_FILE });
      return outputs[step];
    }, () => 1_725_000_000_000);
    assert.equal(result, 0);
    assert.deepEqual(seen, [
      { step: "derive", manifest: undefined, derived: staleDerived, candidate: staleCandidate },
      { step: "calibrate", manifest: freshManifest, derived: freshDerived, candidate: staleCandidate },
      { step: "replay", manifest: freshManifest, derived: freshDerived, candidate: freshCandidate },
      { step: "join", manifest: freshManifest, derived: freshDerived, candidate: freshCandidate },
      { step: "report", manifest: freshManifest, derived: freshDerived, candidate: freshCandidate },
    ]);
    assert.equal(JSON.parse(readFileSync(join(root, "state", "daily.json"), "utf8")).status, "succeeded");
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("deployment rsync never excludes the writer research implementation", () => {
  const deploy = readFileSync(resolve(cwd, "..", "DEPLOY.md"), "utf8");
  assert.doesNotMatch(deploy, /--exclude(?:=|\s+)['\"]?research(?:['\"]?|\/)(?:\s|\\|$)/);
});
