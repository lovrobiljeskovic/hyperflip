import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Exercise the actual CLI with local RPC and broadcast substitutes.
test("sports rotation dry-run is read-only and records landed vaults even if cleanup fails", () => {
  for (const dryRun of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), "hype-rotate-"));
    try {
      mkdirSync(join(root, "tools"));
      mkdirSync(join(root, "registry"));
      for (const name of ["rotate-markets.mjs", "rotate-lib.mjs"]) {
        cpSync(new URL(name, import.meta.url), join(root, "tools", name));
      }
      writeFileSync(join(root, ".env"), "");
      const registryFile = join(root, "registry/markets.json");
      const retired = { vault: "0xold", title: "Past game", coinYes: "#10", expiryMs: 1, category: "sports" };
      const registry = { network: "testnet", markets: [retired], archived: [] };
      writeFileSync(registryFile, JSON.stringify(registry));
      const preload = join(root, "fixture.mjs");
      writeFileSync(preload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
Date.now = () => Date.UTC(2026, 7, 18, 12);
childProcess.execFileSync = (command, args, options) => {
  appendFileSync("commands.log", command + " " + args.join(" ") + "\\n");
  if (command === "uv" && args.at(-1) === "off") throw new Error("fixture cleanup failure");
  if (command === "forge") {
    const dir = "broadcast/Deploy.s.sol/998";
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/run-latest.json", JSON.stringify({ transactions: [{
      contractName: "OutcomeVault", contractAddress: "0xnew", hash: "0x1234",
      arguments: [null, null, null, null, options.env.OUTCOME_ID],
    }] }));
  } else if (command !== "uv") throw new Error("unexpected command");
};
syncBuiltinESMExports();
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body);
  if (request.method === "eth_getTransactionReceipt") return Response.json({ result: { status: "0x1" } });
  if (request.type === "allMids") return Response.json({ "#20": "0.6" });
  if (request.type === "outcomeMeta") return Response.json({ questions: [], outcomes: [{
    outcome: 2, name: "template:sportsContestWinner", quoteToken: "USDC",
    sideSpecs: [{ name: "template:{shortNameA}" }, { name: "template:{shortNameB}" }],
    description: "competition:MLB|sport:baseball|participantA:Twins|participantB:Orioles|scheduledStart:20260820-1200|resolutionDeadline:20260821-1200",
  }] });
  throw new Error("unexpected network request");
};
`);
      const result = spawnSync(process.execPath, ["--import", preload, "tools/rotate-markets.mjs", ...(dryRun ? ["--dry-run"] : [])], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, ROTATE_MODE: "", PRIVATE_KEY: "fixture-key", TESTNET_RPC: "http://localhost:1", KEEPER_ADDRESS: "0xkeeper", DEPLOY_RPCS: "" },
      });
      const updated = JSON.parse(readFileSync(registryFile, "utf8"));
      if (dryRun) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(updated, registry);
        assert.throws(() => readFileSync(join(root, "commands.log")), { code: "ENOENT" });
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /fixture cleanup failure/);
        assert.equal(updated.markets.length, 1);
        assert.equal(updated.markets[0].category, "sports");
        assert.equal(updated.markets[0].vault, "0xnew");
        assert.deepEqual(updated.archived, [retired]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
