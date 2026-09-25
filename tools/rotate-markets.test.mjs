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
      // Settled on-chain long before its registry deadline: archived all the same.
      const settled = { vault: "0xDone", title: "Settled game", coinYes: "#12", expiryMs: Date.UTC(2027, 0, 1), category: "sports" };
      // Elysium rows: the ParlayVault reads the leg in `vault`, so a row is done when the LEG is
      // settled. Retiring on the 998 sourceVault dropped the row from the keeper's watch before
      // the relay landed and stranded every ticket on it (ATL@GB, 2026-09-25).
      const relayed = { vault: "0xLegDone", sourceVault: "0xSrcDone", title: "Relayed game", coinYes: "#14", expiryMs: Date.UTC(2027, 0, 1), category: "sports" };
      const unrelayed = { vault: "0xLegOpen", sourceVault: "0xSrcSettled", title: "Settled on 998, leg not relayed yet", coinYes: "#16", expiryMs: Date.UTC(2027, 0, 1), category: "sports" };
      const registry = { network: "testnet", markets: [retired, settled, relayed, unrelayed], archived: [] };
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
  if (command === "forge" && args[1] === "script/DeployLeg.s.sol") {
    const dir = "broadcast/DeployLeg.s.sol/99801";
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/run-latest.json", JSON.stringify({ transactions: [{
      contractName: "OutcomeLeg", contractAddress: "0xnewleg", hash: "0x5678", arguments: [options.env.SOURCE_VAULT, "0xrelay"],
    }] }));
  } else if (command === "forge") {
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
  if (request.method === "eth_call") {
    const to = request.params[0].to;
    const isLeg = to === "0xLegDone" || to === "0xLegOpen";
    if (isLeg && _url !== "http://localhost:2") throw new Error("leg settled() must be read on the Elysium RPC, got " + _url);
    const settledOnChain = to === "0xDone" || to === "0xLegDone" || to === "0xSrcSettled";
    return Response.json({ result: settledOnChain ? "0x" + "1".padStart(64, "0") : "0x" + "0".repeat(64) });
  }
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
        env: { ...process.env, ROTATE_MODE: "", PRIVATE_KEY: "fixture-key", TESTNET_RPC: "http://localhost:1", KEEPER_ADDRESS: "0xkeeper", DEPLOY_RPCS: "", ELYSIUM_RPC: "http://localhost:2", RELAY_ADDRESS: "0xrelay", PARLAY_VAULT_ADDRESS: "0xparlay" },
      });
      const updated = JSON.parse(readFileSync(registryFile, "utf8"));
      if (dryRun) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(updated, registry);
        assert.throws(() => readFileSync(join(root, "commands.log")), { code: "ENOENT" });
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /fixture cleanup failure/);
        assert.deepEqual(updated.markets.map((m) => m.vault), ["0xLegOpen", "0xnewleg"]);
        assert.deepEqual(updated.markets[1], { ...updated.markets[1], category: "sports", vault: "0xnewleg", sourceVault: "0xnew" });
        assert.deepEqual(updated.archived, [retired, settled, relayed]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
