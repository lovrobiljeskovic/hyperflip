import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateAbis } from "./abis.mjs";

test("ABI generation preserves interfaces and rejects drift or invalid compiler output", () => {
  const root = mkdtempSync(join(tmpdir(), "hyperflip-abis-"));
  try {
    const abi = [{ type: "function", name: "settled", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }];
    for (const name of ["ParlayVault", "OutcomeVault", "KeeperVerifier"]) {
      mkdirSync(join(root, "out", `${name}.sol`), { recursive: true });
      writeFileSync(join(root, "out", `${name}.sol`, `${name}.json`), JSON.stringify({ abi }));
    }
    generateAbis(root);
    generateAbis(root, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "writer/abi/ParlayVault.json"))), abi);
    writeFileSync(join(root, "writer/abi/ParlayVault.json"), "[]\n");
    assert.throws(() => generateAbis(root, true), /ABI drift/);
    generateAbis(root);
    writeFileSync(join(root, "out/ParlayVault.sol/ParlayVault.json"), '{"abi":[]}');
    assert.throws(() => generateAbis(root), /Missing ABI/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
