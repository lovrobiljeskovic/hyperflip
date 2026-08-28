import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { atomicWrite, atomicWriteNew, buildDailyManifest, canonicalJson, sha256, verifyManifest } from "../src/research/store.js";

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
  const registry = { schemaVersion: 1, sources: [] };
  const registryBytes = canonicalJson(registry);
  const registryHash = sha256(registryBytes);
  const raw = join(root, "raw", "candles", "1970", "01", "01", "BTC", "0-1-0.jsonl.gz");
  const escaped = resolve(root, "raw/../../escaped");
  try {
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "raw", "candles", "1970", "01", "01", "BTC"), { recursive: true });
    writeFileSync(join(root, "facts", "source-registries", `${registryHash}.json`), registryBytes);
    writeFileSync(join(root, "state", "collector.json"), canonicalJson({ schemaVersion: 1, sourceRegistrySha256: registryHash, sources: {} }));
    writeFileSync(raw, gzipSync(""));
    writeFileSync(`${raw}.provenance.json`, canonicalJson({ schemaVersion: 1, sourceRegistrySha256: registryHash }));
    const manifest = buildDailyManifest(root, "1970-01-01");
    assert.throws(() => verifyManifest(root, { ...manifest, files: manifest.files.map((file) => file.path.endsWith(".gz") ? { ...file, rows: 99 } : file) }), /manifest file mismatch/);

    const fakeHash = "a".repeat(64);
    writeFileSync(join(root, "facts", "source-registries", `${fakeHash}.json`), registryBytes);
    assert.throws(() => verifyManifest(root, { ...manifest, sourceRegistrySha256: fakeHash, files: manifest.files.map((file) => file.path.startsWith("facts/") ? { ...file, path: `facts/source-registries/${fakeHash}.json` } : file) }), /source registry/);

    writeFileSync(escaped, "escape");
    assert.throws(() => verifyManifest(root, { ...manifest, files: [...manifest.files, { path: "raw/../../escaped", bytes: statSync(escaped).size, sha256: sha256(readFileSync(escaped)), rows: 1, schemaVersion: 1 }] }), /escapes root/);
  } finally {
    rmSync(escaped, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
