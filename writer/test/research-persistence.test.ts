import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openResearchPersistence } from "../src/research/persistence.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "research-persistence-"));

test("bound persistence preserves atomic, immutable, append, and list behavior", (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = openResearchPersistence(root);

  storage.writeAtomic("state/value.txt", "first");
  storage.writeAtomic("state/value.txt", "second");
  storage.append("journal/events/2026/08/29.jsonl", '{"value":1}\n');
  assert.equal(storage.writeNew("facts/value.txt", "immutable"), true);
  assert.equal(storage.writeNew("facts/value.txt", "replacement"), false);

  assert.equal(storage.readText("state/value.txt"), "second");
  assert.deepEqual(storage.read("facts/value.txt"), Buffer.from("immutable"));
  assert.equal(storage.readText("journal/events/2026/08/29.jsonl"), '{"value":1}\n');
  assert.equal(storage.exists("facts/value.txt"), true);
  assert.equal(storage.exists("facts/missing.txt"), false);
  assert.deepEqual(storage.list("journal"), ["journal/events/2026/08/29.jsonl"]);
});

test("relative paths must be canonical", (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = openResearchPersistence(root);

  for (const path of ["", ".", "..", "../value", "state/../value", "/tmp/value", "state//value", "state/", "state\\value", "state/\0value"]) {
    assert.throws(() => storage.read(path), /canonical relative path/);
  }
});

test("leaf symlinks are rejected without touching their targets", (t) => {
  const root = tempRoot();
  const outside = `${root}-outside`;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "state"));
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "state", "value.txt"));
  const storage = openResearchPersistence(root);

  assert.throws(() => storage.read("state/value.txt"), /symbolic link/);
  assert.throws(() => storage.writeAtomic("state/value.txt", "changed"), /symbolic link/);
  assert.equal(readFileSync(outside, "utf8"), "outside");
});

test("intermediate symlinks are rejected", (t) => {
  const root = tempRoot();
  const outside = `${root}-outside`;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(outside);
  writeFileSync(join(outside, "value.txt"), "outside");
  symlinkSync(outside, join(root, "state"));

  assert.throws(() => openResearchPersistence(root).read("state/value.txt"), /symbolic link/);
});

test("group or world writable directories are rejected", (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "value.txt"), "value");
  chmodSync(join(root, "state"), 0o777);

  assert.throws(() => openResearchPersistence(root).read("state/value.txt"), /group or world writable/);
});

test("wrong-owner directories are rejected where ownership can be changed", (t) => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "value.txt"), "value");
  chownSync(join(root, "state"), 65_534, 65_534);

  assert.throws(() => openResearchPersistence(root).read("state/value.txt"), /current user/);
});

test("a root swapped before the leaf open cannot redirect persistence", (t) => {
  const root = tempRoot();
  const held = `${root}-held`;
  const outside = `${root}-outside`;
  let swapped = false;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(held, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "value.txt"), "inside");
  mkdirSync(join(outside, "state"), { recursive: true });
  writeFileSync(join(outside, "state", "value.txt"), "outside");
  const storage = openResearchPersistence(root, { beforeLeafOpen: () => {
    if (swapped) return;
    swapped = true;
    renameSync(root, held);
    symlinkSync(outside, root);
  } });

  if (process.platform === "linux") assert.equal(storage.readText("state/value.txt"), "inside");
  else assert.throws(() => storage.readText("state/value.txt"), /research root changed|symbolic link/);
});

test("required anchored storage fails closed when unavailable", () => {
  if (process.platform === "linux") return;
  assert.throws(
    () => openResearchPersistence(tempRoot(), { requireAnchored: true }),
    /Linux.*\/proc\/self\/fd/,
  );
});
