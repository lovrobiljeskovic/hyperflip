import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWrite, canonicalJson, sha256 } from "../src/research/store.js";

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
