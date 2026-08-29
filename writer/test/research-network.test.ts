import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadResearchNetworkProfile } from "../src/research/network.js";

const registry = new URL("../../registry/", import.meta.url);

function copyProfile(patch: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "research-network-"));
  for (const name of ["correlation-sources.json", "markets.json", "deployment.testnet.json", "correlations.json"]) {
    cpSync(new URL(name, registry), join(root, name));
  }
  const profile = { ...JSON.parse(readFileSync(new URL("research-network.testnet.json", registry), "utf8")), ...patch };
  const file = join(root, "profile.json");
  writeFileSync(file, JSON.stringify(profile, null, 2));
  return file;
}

test("loads the checked-in testnet profile with canonical registry identities", () => {
  const loaded = loadResearchNetworkProfile(copyProfile());
  assert.equal(loaded.profile.network, "testnet");
  assert.equal(loaded.profile.evmChainId, 998);
  assert.equal(loaded.sources.network, "testnet");
  assert.equal(loaded.deployment.parlayVault, "0x407cdc0b15e8d81f4d122481ecf92dbe07dc0169");

  const pretty = copyProfile();
  writeFileSync(pretty, `\n${readFileSync(pretty, "utf8").replace(/,/g, ",\n  ")}\n`);
  assert.equal(loadResearchNetworkProfile(pretty).profileSha256, loaded.profileSha256);
});

test("only testnet is enabled", () => {
  const file = copyProfile({ network: "mainnet", evmChainId: 999 });
  assert.throws(() => loadResearchNetworkProfile(file), /network mainnet is not enabled/);
});

test("testnet profile rejects the mainnet Info API", () => {
  const file = copyProfile({ infoApiUrl: "https://api.hyperliquid.xyz/info" });
  assert.throws(() => loadResearchNetworkProfile(file), /testnet Info API hostname/);
});

test("testnet profile rejects the wrong chain ID", () => {
  const file = copyProfile({ evmChainId: 999 });
  assert.throws(() => loadResearchNetworkProfile(file), /testnet EVM chain ID/);
});

test("testnet profile rejects a registry on another network", () => {
  const file = copyProfile();
  const sources = join(file, "..", "correlation-sources.json");
  writeFileSync(sources, JSON.stringify({ ...JSON.parse(readFileSync(sources, "utf8")), network: "mainnet" }));
  assert.throws(() => loadResearchNetworkProfile(file), /source registry network must be testnet/);
});

test("testnet profile rejects escaping registry paths", () => {
  const file = copyProfile({ marketRegistryFile: "../markets.json" });
  assert.throws(() => loadResearchNetworkProfile(file), /relative filename/);
});
