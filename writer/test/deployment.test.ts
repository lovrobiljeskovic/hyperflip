import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployment, verifyDeploymentRpc } from "../../registry/deployment.mjs";

test("deployment selection rejects conflicting settings and malformed alternate manifests", () => {
  const main = loadDeployment({});
  assert.equal(main.chainId, 998);
  assert.equal(main.deployBlock, 61906227n);
  assert.equal(loadDeployment({ PARLAY_VAULT_ADDRESS: main.parlayVault.toUpperCase() }).parlayVault, main.parlayVault);
  for (const env of [
    { PARLAY_VAULT_ADDRESS: `0x${"1".repeat(40)}` }, { PARLAY_DEPLOY_BLOCK: "61907400" }, { EVM_CHAIN_ID: "999" },
  ]) assert.throws(() => loadDeployment(env), /disagrees/);
  for (const env of [{ NEXT_PUBLIC_CHAIN_ID: "999" }, { NEXT_PUBLIC_PARLAY_VAULT: "invalid" }, { NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: "1" }]) {
    assert.throws(() => loadDeployment(env, true), /disagrees/);
  }
  assert.throws(() => loadDeployment({ DEPLOYMENT_FILE: "relative.json" }), /absolute/);
  const directory = mkdtempSync(join(tmpdir(), "deployment-"));
  const env = { DEPLOYMENT_FILE: join(directory, "test.json") };
  const alternate = { schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: `0x${"1".repeat(40)}`, parlayDeployBlock: "1" };
  try {
    assert.throws(() => loadDeployment(env), /Cannot read/);
    writeFileSync(env.DEPLOYMENT_FILE, JSON.stringify(alternate));
    assert.equal(loadDeployment(env).deployBlock, 1n);
    assert.deepEqual(loadDeployment(env, true), loadDeployment(env));
    for (const change of [{ schemaVersion: 2 }, { network: "mainnet" }, { evmChainId: 999 }, { parlayVault: "invalid" }, { parlayVault: `0x${"0".repeat(40)}` }, { parlayDeployBlock: "0" }, { parlayDeployBlock: 1 }]) {
      writeFileSync(env.DEPLOYMENT_FILE, JSON.stringify({ ...alternate, ...change }));
      assert.throws(() => loadDeployment(env), /Deployment manifest/);
    }
    writeFileSync(env.DEPLOYMENT_FILE, "{");
    assert.throws(() => loadDeployment(env), /Cannot read/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("RPC verification rejects chain, address, block and unavailable history before startup", async () => {
  const deployment = loadDeployment({});
  const client = {
    getChainId: async () => 998,
    getCode: async ({ blockNumber }: { blockNumber?: bigint }): Promise<`0x${string}` | undefined> => blockNumber === deployment.deployBlock - 1n ? undefined : "0x1234",
  };
  await verifyDeploymentRpc(client, deployment);
  await assert.rejects(verifyDeploymentRpc({ ...client, getChainId: async () => 999 }, deployment), /RPC chain disagrees/);
  for (const code of ["0x", "0x1234"] as const) {
    await assert.rejects(verifyDeploymentRpc({ ...client, getCode: async () => code }, deployment), /address\/block/);
  }
  await assert.rejects(verifyDeploymentRpc({ ...client, getCode: async () => { throw new Error("private RPC URL"); } }, deployment), /archive-capable/);
});
