import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { appendQuoteDecision, redactQuoteDecision } from "../src/research/journal.js";
import { canonicalJson } from "../src/research/store.js";
import type { QuoteDecision } from "../src/research/types.js";

const fs: typeof import("node:fs") = createRequire(import.meta.url)("node:fs");

const decision: QuoteDecision = {
  schemaVersion: 1, recordedAtMs: 1_725_000_000_000, quoteId: "0x01", quoteDigest: "0x02", chainId: 31337,
  parlayVault: "0x1111111111111111111111111111111111111111", taker: "0x2222222222222222222222222222222222222222",
  legs: [{ vault: "0x3333333333333333333333333333333333333333", isYes: true, underlying: "BTC", cluster: "crypto", direction: "up", outcomeCoin: "+1" }],
  bookInputs: [{ priceWad: "500000000000000000", source: "l2Book", observedAtMs: 1_725_000_000_000, depthWad: "50000000000000000000", vwapWad: "500000000000000000", freshnessMs: null }],
  modelVersion: "fixture", dataAsOf: "2024-08-09T00:00:00.000Z", dataManifestSha256: "a".repeat(64), sourceRegistrySha256: "b".repeat(64),
  bestEstimateJointProbWad: "250000000000000000", riskAdjustedJointProbWad: "240000000000000000", rhoBandPct: 0.2,
  edge: { baseBps: "500", legBps: "300", totalBps: "800" }, premium: "1000000", maxPayout: "4000000", deadline: "1725000030", signatureHash: "c".repeat(64),
};

test("journal: durable append writes canonical daily JSONL with private modes", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-journal-"));
  appendQuoteDecision(root, decision);
  const file = join(root, "journal", "quotes", "2024", "08", "30.jsonl");
  assert.equal(readFileSync(file, "utf8"), `${canonicalJson(decision)}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
});

test("journal: fsyncs the daily directory after appending a new file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hype-journal-fsync-"));
  const opened = new Map<number, string>();
  const fsynced: string[] = [];
  const open = fs.openSync;
  const fsync = fs.fsyncSync;
  t.mock.method(fs, "openSync", ((path: Parameters<typeof fs.openSync>[0], flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) => {
    const fd = open(path, flags, mode);
    opened.set(fd, String(path));
    return fd;
  }) as typeof fs.openSync);
  t.mock.method(fs, "fsyncSync", ((fd: number) => {
    const path = opened.get(fd);
    if (path) fsynced.push(path);
    fsync(fd);
  }) as typeof fs.fsyncSync);
  syncBuiltinESMExports();
  const journal = await import(`../src/research/journal.js?daily-directory-fsync=${Date.now()}`);
  journal.appendQuoteDecision(root, decision);
  const file = join(root, "journal", "quotes", "2024", "08", "30.jsonl");
  assert.deepEqual([
    root,
    join(root, "journal"),
    join(root, "journal", "quotes"),
    join(root, "journal", "quotes", "2024"),
    dirname(file),
  ].filter((path) => !fsynced.includes(path)), []);
});

test("journal: rejects a symlinked daily file without touching its target", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-journal-symlink-"));
  const target = join(root, "outside.jsonl");
  const file = join(root, "journal", "quotes", "2024", "08", "30.jsonl");
  fs.writeFileSync(target, "sentinel\n", { mode: 0o644 });
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.symlinkSync(target, file);
  assert.throws(() => appendQuoteDecision(root, decision), /symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "sentinel\n");
  assert.equal(statSync(target).mode & 0o777, 0o644);
});

test("journal: redaction needs a salt and delays hashes and research inputs until all legs final", () => {
  assert.throws(() => redactQuoteDecision(decision, { status: "won", allLegsFinal: false }, ""), /salt/);
  const pending = redactQuoteDecision(decision, { status: "won", allLegsFinal: false }, "salt");
  assert.equal(pending.quoteDigest, undefined);
  assert.equal(pending.signatureHash, undefined);
  assert.equal(pending.bookInputs, undefined);
  const final = redactQuoteDecision(decision, { status: "dead", allLegsFinal: true }, "salt");
  assert.equal(final.quoteDigest, decision.quoteDigest);
  assert.equal(final.signatureHash, decision.signatureHash);
  assert.deepEqual(final.bookInputs, decision.bookInputs);
  assert.notEqual(final.taker, decision.taker);
});
