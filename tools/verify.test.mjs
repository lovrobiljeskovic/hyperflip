import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function runRepositoryGate(root) {
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  const webEnvFile = join(root, "web-env.json");
  const webEnv = {
    DEPLOYMENT_FILE: resolve(import.meta.dirname, "fixtures/deployment.json"),
    NEXT_PUBLIC_CHAIN_ID: "998",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_WRITER_URL: "http://127.0.0.1:1",
    NEXT_PUBLIC_INFO_API: "http://127.0.0.1:1",
    NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:1",
    NEXT_PUBLIC_PRIVY_APP_ID: "",
    NEXT_PUBLIC_PARLAY_VAULT: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: "1",
  };
  mkdirSync(bin);
  for (const command of ["forge", "npm", "node"]) {
    const file = join(bin, command);
    writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const directory = require("node:path").basename(process.cwd());
const command = ${JSON.stringify(command)};
const label = command === "npm" ? command + " " + directory : command;
fs.appendFileSync(process.env.ACCEPTANCE_LOG, label + " " + process.argv.slice(2).join(" ") + "\\n");
if (command === "npm" && directory === "web") {
  const keys = ${JSON.stringify(Object.keys(webEnv))};
  fs.writeFileSync(process.env.ACCEPTANCE_ENV, JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));
}
`);
    chmodSync(file, 0o755);
  }
  const repo = resolve(import.meta.dirname, "..");
  const result = spawnSync("bash", ["scripts/verify.sh"], {
    cwd: repo,
    env: {
      ...process.env,
      ...Object.fromEntries(Object.keys(webEnv).map((key) => [key, "inherited-value"])),
      ACCEPTANCE_LOG: log, ACCEPTANCE_ENV: webEnvFile, PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(webEnvFile, "utf8")), webEnv);
  return readFileSync(log, "utf8").trim().split("\n");
}

test("repository gate checks each project with fixture web configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-gate-"));
  try {
    assert.deepEqual(runRepositoryGate(root), [
      "forge fmt --check", "forge build --sizes",
      "node scripts/abis.mjs --check", "node scripts/deployment.mjs --check", "node scripts/check-service-packages.mjs", "forge test",
      "npm keeper run check", "npm writer run check", "npm web run check",
      "node --test scripts/abis.test.mjs tools/house-lib.test.mjs tools/rotate-lib.test.mjs tools/rotate-markets.test.mjs tools/verify.test.mjs",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
