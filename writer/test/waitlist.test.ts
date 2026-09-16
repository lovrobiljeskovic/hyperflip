import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isValidEmail, RateLimiter, Waitlist } from "../src/waitlist.js";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "wl-")), "waitlist.json");

test("signup issues a code, dedupes by email, survives reload", () => {
  const f = file();
  const wl = new Waitlist(f, () => 1000);
  const a = wl.signup("Tester@Example.com ");
  assert.ok(a.isNew);
  assert.match(a.code, /^OVR-[0-9A-F]{6}$/);
  assert.ok(wl.has(a.code));

  const again = wl.signup("tester@example.com");
  assert.equal(again.isNew, false);
  assert.equal(again.code, a.code);
  assert.equal(wl.size(), 1);

  const reloaded = new Waitlist(f);
  assert.ok(reloaded.has(a.code));
  assert.equal(reloaded.size(), 1);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8"))[0].email, "tester@example.com");
});

test("email validation", () => {
  assert.ok(isValidEmail("a@b.co"));
  assert.ok(!isValidEmail("not-an-email"));
  assert.ok(!isValidEmail("a b@c.co"));
  assert.ok(!isValidEmail("a@b"));
  assert.ok(!isValidEmail(`${"x".repeat(250)}@b.co`));
});

test("rate limiter slides its window", () => {
  let t = 0;
  const rl = new RateLimiter(2, 100, () => t);
  assert.ok(rl.allow("ip"));
  assert.ok(rl.allow("ip"));
  assert.ok(!rl.allow("ip"));
  assert.ok(rl.allow("other"));
  t = 150;
  assert.ok(rl.allow("ip"));
});
