import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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

test("research check runs exactly one complete deterministic end-to-end fixture", () => {
  const result = cli("check", process.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# pass 1\b/);
});

test("research operations definitions are isolated, bounded, and scheduled independently", () => {
  const unit = (name: string): string => readFileSync(resolve(cwd, "..", "ops", "systemd", name), "utf8");
  const collector = unit("hype-research-collector.service");
  const daily = unit("hype-research-daily.service");
  const backup = unit("hype-research-backup.service");
  for (const service of [collector, daily, backup]) {
    assert.match(service, /Type=oneshot/);
    assert.match(service, /User=hype/);
    assert.match(service, /IOSchedulingClass=idle/);
    assert.doesNotMatch(service, /Requires=keeper\.service|PartOf=keeper\.service|restart/);
  }
  assert.match(collector, /ExecStart=\/usr\/bin\/flock -w 300 \/opt\/hype\/research\/state\/job\.lock \/usr\/bin\/npm run research -- collect/);
  assert.match(collector, /Nice=10[\s\S]*CPUQuota=25%[\s\S]*MemoryMax=512M[\s\S]*TimeoutStartSec=15m/);
  assert.match(daily, /After=hype-research-collector\.service/);
  assert.match(daily, /ExecStart=\/usr\/bin\/flock -w 900 \/opt\/hype\/research\/state\/job\.lock \/usr\/bin\/npm run research -- daily/);
  assert.match(daily, /Nice=15[\s\S]*CPUQuota=50%[\s\S]*MemoryMax=1G[\s\S]*TimeoutStartSec=2h/);
  assert.match(backup, /ConditionPathExists=\/opt\/hype\/research-backup\.env/);
  assert.match(backup, /After=hype-research-daily\.service/);
  assert.match(backup, /EnvironmentFile=\/opt\/hype\/research\.env[\s\S]*EnvironmentFile=\/opt\/hype\/research-backup\.env/);
  assert.match(backup, /ExecStart=\/usr\/bin\/flock -w 7200 \/opt\/hype\/research\/state\/job\.lock \/usr\/bin\/npm run research -- backup/);
  assert.match(backup, /Nice=15[\s\S]*CPUQuota=25%[\s\S]*MemoryMax=512M[\s\S]*TimeoutStartSec=4h/);
  assert.match(unit("hype-research-collector.timer"), /OnCalendar=hourly[\s\S]*Persistent=true/);
  assert.match(unit("hype-research-daily.timer"), /OnCalendar=\*-\*-\* 01:15:00 UTC[\s\S]*Persistent=true/);
  assert.match(unit("hype-research-backup.timer"), /OnCalendar=\*-\*-\* 03:30:00 UTC[\s\S]*Persistent=true/);
});
