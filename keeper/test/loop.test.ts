import assert from "node:assert/strict";
import test from "node:test";
import { every, isStalled } from "../../services/loop.mjs";

test("every keeps rescheduling after fn throws and hands the error to onError", async () => {
  const errors: unknown[] = [];
  let runs = 0;
  await new Promise<void>((done) => {
    every(1, async () => {
      runs++;
      // Park the 4th run on a promise that never settles: no further timer, so nothing leaks.
      if (runs > 3) return new Promise(() => {});
      throw new Error(`boom ${runs}`);
    }, (err) => {
      errors.push(err);
      if (errors.length === 3) done();
    });
  });
  assert.equal(runs, 3);
  assert.deepEqual(errors.map((e) => (e as Error).message), ["boom 1", "boom 2", "boom 3"]);
});

test("isStalled: false within threshold, true once elapsed exceeds it", () => {
  const lastTickAt = 1_000_000;
  assert.equal(isStalled(lastTickAt, lastTickAt + 120_000, 120_000), false); // exactly at bound: not yet stalled
  assert.equal(isStalled(lastTickAt, lastTickAt + 120_001, 120_000), true);
  assert.equal(isStalled(lastTickAt, lastTickAt, 120_000), false); // no time elapsed
});
