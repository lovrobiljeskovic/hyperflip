import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { atomicWrite, atomicWriteNew, buildDailyManifest, buildRollingManifest, canonicalJson, sha256, verifyManifest } from "../src/research/store.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "hype-research-store-"));
}

test("canonical JSON and manifest hashes do not depend on object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256(canonicalJson({ a: 1, b: 2 })));
});

test("canonical JSON rejects values JSON would silently lose", () => {
  assert.throws(() => canonicalJson({ value: undefined }), /undefined/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite/);
  assert.throws(() => canonicalJson({ value: 1n }), /bigint/);
});

test("a failed atomic replacement leaves the prior champion bytes intact", () => {
  const root = scratch();
  const champion = join(root, "state.json");
  try {
    writeFileSync(champion, "old");
    assert.throws(() => atomicWrite(champion, "new", { beforeRename: () => { throw new Error("boom"); } }));
    assert.equal(readFileSync(champion, "utf8"), "old");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed shard promotion never replaces a champion", () => {
  const root = scratch();
  const champion = join(root, "sealed.gz");
  try {
    writeFileSync(champion, "old");
    assert.equal(atomicWriteNew(champion, "new"), false);
    assert.equal(readFileSync(champion, "utf8"), "old");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest verification rederives metadata, registry content, and contained paths", () => {
  const root = scratch();
  const profileSha256 = "b".repeat(64);
  const registry = { schemaVersion: 2, network: "testnet", sources: [] };
  const registryBytes = canonicalJson(registry);
  const registryHash = sha256(registryBytes);
  const raw = join(root, "raw", "candles", "1970", "01", "01", "BTC", "0-1-0.jsonl.gz");
  const escaped = resolve(root, "raw/../../escaped");
  const outside = join(root, "..", `${root.split("/").at(-1)}-outside`);
  try {
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "raw", "candles", "1970", "01", "01", "BTC"), { recursive: true });
    writeFileSync(join(root, "facts", "source-registries", `${registryHash}.json`), registryBytes);
    writeFileSync(join(root, "network-profile.json"), canonicalJson({ schemaVersion: 3, network: "testnet", profileSha256, evmChainId: 998, deploymentRegistrySha256: "c".repeat(64) }));
    writeFileSync(join(root, "state", "collector.json"), canonicalJson({ schemaVersion: 2, sourceRegistrySha256: registryHash, network: "testnet", profileSha256, sources: {} }));
    writeFileSync(raw, gzipSync(""));
    writeFileSync(`${raw}.provenance.json`, canonicalJson({ schemaVersion: 2, sourceRegistrySha256: registryHash, network: "testnet", profileSha256, startTimeMs: 0, endTimeMs: 0, ignoredBefore: 0, ignoredAfter: 0 }));
    const manifest = buildDailyManifest(root, "1970-01-01");
    assert.throws(() => verifyManifest(root, { ...manifest, files: manifest.files.map((file) => file.path.endsWith(".gz") ? { ...file, rows: 99 } : file) }), /manifest file mismatch/);

    const fakeHash = "a".repeat(64);
    writeFileSync(join(root, "facts", "source-registries", `${fakeHash}.json`), registryBytes);
    assert.throws(() => verifyManifest(root, { ...manifest, sourceRegistrySha256: fakeHash, files: manifest.files.map((file) => file.path.startsWith("facts/") ? { ...file, path: `facts/source-registries/${fakeHash}.json` } : file) }), /source registry/);

    writeFileSync(escaped, "escape");
    assert.throws(() => verifyManifest(root, { ...manifest, files: [...manifest.files, { path: "raw/../../escaped", bytes: statSync(escaped).size, sha256: sha256(readFileSync(escaped)), rows: 1, schemaVersion: 1 }] }), /escapes root/);

    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "linked"));
    assert.throws(() => verifyManifest(root, { ...manifest, files: [...manifest.files, { path: "linked", bytes: 7, sha256: sha256("outside"), rows: 1, schemaVersion: 1 }] }), /symbolic link/);
  } finally {
    rmSync(escaped, { force: true });
    rmSync(outside, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("daily, rolling, and verification reject a foreign candle under testnet provenance", () => {
  const root = scratch();
  const profileSha256 = "a".repeat(64);
  const deploymentRegistrySha256 = "b".repeat(64);
  const registry = {
    schemaVersion: 2, network: "testnet", sources: [{
      schemaVersion: 1, underlying: "BTC", sourceNetwork: "testnet", sourceCoin: "BTC", cluster: "crypto", calendar: "continuous", measurementEnabled: true, fallbackEligible: true,
    }],
  };
  const registryBytes = canonicalJson(registry);
  const registryHash = sha256(registryBytes);
  const relative = "raw/candles/1970/01/01/BTC/fixture.jsonl.gz";
  const candle = {
    schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "mainnet", underlying: "BTC", sourceCoin: "BTC", interval: "1h",
    openTimeMs: 0, closeTimeMs: 3_599_999, open: "100", high: "100", low: "100", close: "100", volume: "1", tradeCount: 1, retrievedAtMs: 3_600_000,
  };
  try {
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    mkdirSync(join(root, "raw", "candles", "1970", "01", "01", "BTC"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "facts", "source-registries", `${registryHash}.json`), registryBytes);
    writeFileSync(join(root, "network-profile.json"), canonicalJson({ schemaVersion: 3, network: "testnet", profileSha256, evmChainId: 998, deploymentRegistrySha256 }));
    const rawBytes = gzipSync(`${canonicalJson(candle)}\n`);
    writeFileSync(join(root, relative), rawBytes);
    const provenance = canonicalJson({ schemaVersion: 2, sourceRegistrySha256: registryHash, network: "testnet", profileSha256, startTimeMs: 0, endTimeMs: 3_599_999, ignoredBefore: 0, ignoredAfter: 0 });
    writeFileSync(join(root, `${relative}.provenance.json`), provenance);
    writeFileSync(join(root, "state", "collector.json"), canonicalJson({ schemaVersion: 2, sourceRegistrySha256: registryHash, network: "testnet", profileSha256, sources: {} }));

    assert.throws(() => buildDailyManifest(root, "1970-01-01"), /candle record.*network|network.*candle record/i);
    assert.throws(() => buildRollingManifest(root, registryHash), /candle record.*network|network.*candle record/i);
    const manifest = {
      schemaVersion: 2, network: "testnet", profileSha256, createdAt: "1970-01-01T01:00:00.000Z", sourceRegistrySha256: registryHash,
      sourceRange: { fromMs: 0, toMs: 3_599_999 }, underlyings: { BTC: { rows: 1, firstUsableObservationMs: 0, lastUsableObservationMs: 0, missingIntervals: [] } },
      files: [
        { path: `facts/source-registries/${registryHash}.json`, bytes: Buffer.byteLength(registryBytes), sha256: registryHash, rows: 1, schemaVersion: 1 },
        { path: relative, bytes: rawBytes.length, sha256: sha256(rawBytes), rows: 1, schemaVersion: 1 },
        { path: `${relative}.provenance.json`, bytes: Buffer.byteLength(provenance), sha256: sha256(provenance), rows: 1, schemaVersion: 1 },
      ],
    } as never;
    assert.throws(() => verifyManifest(root, manifest), /candle record.*network|network.*candle record/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
