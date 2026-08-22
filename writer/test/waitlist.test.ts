import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleWaitlist, type QuoteDeps } from "../src/server.js";
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

function waitlistDeps(over: Partial<QuoteDeps>): QuoteDeps {
  // handleWaitlist touches only these fields; the quote-path deps stay unused.
  return { now: () => 0, ...over } as QuoteDeps;
}

test("handleWaitlist: signup persists even when the email send fails", async () => {
  const wl = new Waitlist(file());
  const deps = waitlistDeps({
    waitlist: wl,
    sendInvite: async () => {
      throw new Error("resend down");
    },
  });
  const r = await handleWaitlist(deps, { email: "a@b.co" }, "1.2.3.4");
  assert.equal(r.status, 502);
  assert.equal(wl.size(), 1); // retry re-sends the same code

  const sent: string[] = [];
  deps.sendInvite = async (email, code) => void sent.push(`${email}:${code}`);
  const ok = await handleWaitlist(deps, { email: "a@b.co" }, "1.2.3.4");
  assert.equal(ok.status, 200);
  assert.equal(wl.size(), 1);
  assert.equal(sent.length, 1);
});

test("handleWaitlist: bad email, rate limit, unavailable", async () => {
  const wl = new Waitlist(file());
  const limiter = new RateLimiter(1, 1000, () => 0);
  const deps = waitlistDeps({ waitlist: wl, sendInvite: async () => {}, signupLimiter: limiter });

  assert.equal((await handleWaitlist(deps, { email: "nope" }, "ip")).status, 400);
  assert.equal((await handleWaitlist(deps, {}, "ip")).status, 400);
  assert.equal((await handleWaitlist(deps, { email: "a@b.co" }, "ip")).status, 200);
  assert.equal((await handleWaitlist(deps, { email: "c@d.co" }, "ip")).status, 429);

  assert.equal((await handleWaitlist(waitlistDeps({}), { email: "a@b.co" }, "ip")).status, 503);
});
