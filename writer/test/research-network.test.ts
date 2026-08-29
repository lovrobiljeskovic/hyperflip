import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bindResearchRootIdentity, loadResearchNetworkProfile, researchRootIdentity } from "../src/research/network.js";
import { openResearchPersistence } from "../src/research/persistence.js";
import { parseCorrelations } from "../src/correlation.js";

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

test("research root marker permits market and baseline rotation while preserving raw history", () => {
  const profileFile = copyProfile();
  const root = dirname(profileFile);
  try {
    const first = loadResearchNetworkProfile(profileFile);
    const storage = openResearchPersistence(root);
    bindResearchRootIdentity(storage, first);
    storage.writeAtomic("raw/history.json", "preserved\n");
    assert.deepEqual(JSON.parse(readFileSync(join(root, "network-profile.json"), "utf8")), {
      schemaVersion: 3,
      network: "testnet",
      profileSha256: first.profileSha256,
      evmChainId: 998,
      deploymentRegistrySha256: first.deploymentRegistrySha256,
    });

    const marketsFile = join(root, "markets.json");
    const markets = JSON.parse(readFileSync(marketsFile, "utf8"));
    markets.markets[0].title = `${markets.markets[0].title} (rotated)`;
    writeFileSync(marketsFile, JSON.stringify(markets));
    const correlations = join(root, "correlations.json");
    const changed = JSON.parse(readFileSync(correlations, "utf8"));
    changed.clusters.crypto.BTC.global = 0.2;
    writeFileSync(correlations, JSON.stringify(changed));
    const second = loadResearchNetworkProfile(profileFile);
    assert.equal(second.profileSha256, first.profileSha256);
    assert.notEqual(second.marketRegistrySha256, first.marketRegistrySha256);
    assert.notEqual(second.baselineCorrelationSha256, first.baselineCorrelationSha256);
    assert.doesNotThrow(() => bindResearchRootIdentity(storage, second));
    assert.equal(storage.readText("raw/history.json"), "preserved\n");
    assert.deepEqual(researchRootIdentity(second), researchRootIdentity(first));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research root rejects deployment registry rotation", () => {
  const profileFile = copyProfile();
  const root = dirname(profileFile);
  try {
    const storage = openResearchPersistence(root);
    bindResearchRootIdentity(storage, loadResearchNetworkProfile(profileFile));
    const deploymentFile = join(root, "deployment.testnet.json");
    const deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));
    deployment.parlayDeployBlock = String(BigInt(deployment.parlayDeployBlock) + 1n);
    writeFileSync(deploymentFile, JSON.stringify(deployment));
    assert.throws(() => bindResearchRootIdentity(storage, loadResearchNetworkProfile(profileFile)), /research root network\/profile marker mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research root rejects profile declaration rotation even when referenced content is unchanged", () => {
  const profileFile = copyProfile();
  const root = dirname(profileFile);
  try {
    const storage = openResearchPersistence(root);
    bindResearchRootIdentity(storage, loadResearchNetworkProfile(profileFile));
    cpSync(join(root, "correlations.json"), join(root, "correlations-rotated.json"));
    const declaration = JSON.parse(readFileSync(profileFile, "utf8"));
    declaration.baselineCorrelationFile = "correlations-rotated.json";
    writeFileSync(profileFile, JSON.stringify(declaration));
    assert.throws(() => bindResearchRootIdentity(storage, loadResearchNetworkProfile(profileFile)), /research root network\/profile marker mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research root refuses unmarked data-bearing storage", () => {
  const profileFile = copyProfile();
  const profileRoot = dirname(profileFile);
  const root = mkdtempSync(join(tmpdir(), "research-unmarked-root-"));
  try {
    mkdirSync(join(root, "facts"));
    writeFileSync(join(root, "facts", "existing.json"), "{}\n");
    assert.throws(() => bindResearchRootIdentity(openResearchPersistence(root), loadResearchNetworkProfile(profileFile)), /research root network\/profile marker is missing/);
    assert.equal(openResearchPersistence(root).exists("network-profile.json"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(profileRoot, { recursive: true, force: true });
  }
});

test("every fallback-eligible testnet source has explicit baseline loadings", () => {
  const loaded = loadResearchNetworkProfile(copyProfile());
  const table = parseCorrelations(loaded.baselineCorrelationRaw);
  assert.deepEqual(
    loaded.sources.sources.filter((source) => source.fallbackEligible && table.underlyings[source.underlying] === undefined).map((source) => source.underlying),
    [],
  );
  assert.deepEqual(table.underlyings.SOL, { global: 0.2954828964376993, cluster: 0.9061475490756113, underlying: 0.2856334665564427 });
  assert.deepEqual(table.underlyings.AAPL, { global: 0.2842853790390953, cluster: 0.7984628679278057, underlying: 0.5211898615716748 });
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

test("testnet profile requires the reviewed bootstrap correlation label", () => {
  const valid = copyProfile();
  const correlations = join(valid, "..", "correlations.json");
  writeFileSync(correlations, JSON.stringify({ ...JSON.parse(readFileSync(correlations, "utf8")), fallbackReason: "operator-reviewed-testnet-bootstrap" }));
  assert.doesNotThrow(() => loadResearchNetworkProfile(valid));

  const missing = copyProfile();
  const missingCorrelations = join(missing, "..", "correlations.json");
  const { fallbackReason: _ignored, ...withoutFallbackReason } = JSON.parse(readFileSync(missingCorrelations, "utf8"));
  writeFileSync(missingCorrelations, JSON.stringify(withoutFallbackReason));
  assert.throws(() => loadResearchNetworkProfile(missing), /fallbackReason must be operator-reviewed-testnet-bootstrap/);

  const wrong = copyProfile();
  const wrongCorrelations = join(wrong, "..", "correlations.json");
  writeFileSync(wrongCorrelations, JSON.stringify({ ...JSON.parse(readFileSync(wrongCorrelations, "utf8")), fallbackReason: "unreviewed" }));
  assert.throws(() => loadResearchNetworkProfile(wrong), /fallbackReason must be operator-reviewed-testnet-bootstrap/);
});

test("testnet profile rejects escaping registry paths", () => {
  const file = copyProfile({ marketRegistryFile: "../markets.json" });
  assert.throws(() => loadResearchNetworkProfile(file), /relative filename/);
});
