import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Waitlist } from "../src/waitlist.js";
import { QuoteJournal } from "../src/journal.js";

test("waitlist rejects damaged state and failed saves never issue an in-memory code", (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "waitlist-failure-"));
  const file = join(directory, "waitlist.json");
  try {
    const waitlist = new Waitlist(file);
    const first = waitlist.signup("first@example.com");
    const original = fs.readFileSync(file, "utf8");
    const fail = t.mock.method(fs, "renameSync", () => { throw new Error("disk failure"); });
    syncBuiltinESMExports();
    assert.throws(() => waitlist.signup("second@example.com"), /disk failure/);
    assert.equal(waitlist.size(), 1);
    assert(waitlist.has(first.code));
    assert.equal(fs.readFileSync(file, "utf8"), original);
    fail.mock.restore(); syncBuiltinESMExports();
    assert.throws(() => waitlist.signup("second@example.com"), /restart/);
    const restarted = new Waitlist(file);
    assert.equal(restarted.signup("first@example.com").code, first.code);
    assert(restarted.signup("second@example.com").isNew);
    const sync = fs.fsyncSync;
    const lateFailure = t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("directory flush failed");
      sync(fd);
    });
    syncBuiltinESMExports();
    assert.throws(() => restarted.signup("third@example.com"), /directory flush/);
    assert.equal(restarted.size(), 2);
    const savedCode = JSON.parse(fs.readFileSync(file, "utf8"))[2].code;
    lateFailure.mock.restore(); syncBuiltinESMExports();
    assert.throws(() => restarted.signup("third@example.com"), /restart/);
    assert.equal(new Waitlist(file).signup("third@example.com").code, savedCode);
    for (const raw of ["{", "null", "{}", '[{"email":"bad"}]', '[{"email":"a@b.co","code":"code","ts":"bad"}]']) {
      fs.writeFileSync(file, raw);
      assert.throws(() => new Waitlist(file), /Invalid waitlist/);
      assert.equal(fs.readFileSync(file, "utf8"), raw);
    }
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("journal preserves old schemas, flushes append, and blocks writes after a partial failure", (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "journal-failure-"));
  const file = join(directory, "quotes.jsonl");
  try {
    new QuoteJournal(file).append({ schemaVersion: 3, quoteId: "old" });
    const old = fs.readFileSync(file, "utf8");
    const journal = new QuoteJournal(file);
    journal.append({ schemaVersion: 1, quoteId: "sports" });
    const saved = fs.readFileSync(file, "utf8");
    assert(saved.startsWith(old));
    assert.doesNotThrow(() => new QuoteJournal(file));
    const append = fs.appendFileSync;
    const fail = t.mock.method(fs, "appendFileSync", (...[path, contents, options]: Parameters<typeof fs.appendFileSync>) => {
      assert.deepEqual(options, { flush: true });
      append(path, String(contents).slice(0, 6));
      throw new Error("disk full");
    });
    syncBuiltinESMExports();
    assert.throws(() => journal.append({ schemaVersion: 1 }), /disk full/);
    fail.mock.restore(); syncBuiltinESMExports();
    const damaged = fs.readFileSync(file, "utf8");
    assert(damaged.startsWith(saved));
    assert.throws(() => journal.append({ schemaVersion: 1 }), /restart/);
    assert.equal(fs.readFileSync(file, "utf8"), damaged);
    assert.throws(() => new QuoteJournal(file), /truncated/);
    for (const raw of ['{"schemaVersion":1}', '{"schemaVersion":1}\nbad\n', 'null\n', '{}\n']) {
      fs.writeFileSync(file, raw);
      assert.throws(() => new QuoteJournal(file), /Invalid or truncated/);
      assert.equal(fs.readFileSync(file, "utf8"), raw);
    }
    const denied = t.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    syncBuiltinESMExports();
    assert.throws(() => new QuoteJournal(file), /denied/);
    assert.throws(() => new Waitlist(file), /denied/);
    denied.mock.restore(); syncBuiltinESMExports();
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
