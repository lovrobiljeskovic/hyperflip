import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadFractionCache, saveFraction } from "../src/cache.js";

const vault = `0x${"a".repeat(40)}`;

test("settlement cache preserves observations across restart and failed replacement", (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "settlement-cache-"));
  const file = join(directory, "cache.json");
  try {
    const cache = loadFractionCache(file);
    assert.equal(cache.size, 0);
    saveFraction(cache, file, vault, 123n);
    assert.equal(loadFractionCache(file).get(vault), 123n);
    const before = fs.readFileSync(file, "utf8");
    const fail = t.mock.method(fs, "renameSync", () => { throw new Error("disk failure"); });
    syncBuiltinESMExports();
    assert.throws(() => saveFraction(cache, file, vault, 456n), /disk failure/);
    assert.equal(cache.get(vault), 456n);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(directory), ["cache.json"]);
    fail.mock.restore(); syncBuiltinESMExports();
    saveFraction(cache, file, vault, 456n);
    assert.equal(loadFractionCache(file).get(vault), 456n);
    fs.writeFileSync(file, "{");
    assert.throws(() => loadFractionCache(file), /Invalid settlement cache/);
    const denied = t.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    syncBuiltinESMExports();
    assert.throws(() => loadFractionCache(file), /denied/);
    denied.mock.restore(); syncBuiltinESMExports();
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
