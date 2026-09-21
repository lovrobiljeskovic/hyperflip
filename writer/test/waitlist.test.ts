import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleAccess, handleAdmission, handleWaitlist, type QuoteDeps } from "../src/server.js";
import { isValidEmail, RateLimiter, Waitlist } from "../src/waitlist.js";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "wl-")), "waitlist.json");

test("signup queues without access, dedupes by email, survives reload", () => {
  const f = file();
  const wl = new Waitlist(f, () => 1000);
  assert.deepEqual(wl.signup("Tester@Example.com "), { isNew: true });
  assert.deepEqual(wl.signup("tester@example.com"), { isNew: false });
  assert.equal(wl.size(), 1);
  const reloaded = new Waitlist(f);
  assert.equal(reloaded.review().filter(e => !e.admitted).length, 1);
  assert.equal(reloaded.review().filter(e => e.admitted).length, 0);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), [{ email: "tester@example.com", code: null, ts: 1000 }]);
});

test("cohorts admit selected emails, preserve legacy access, and retry only failed emails after reload", async () => {
  const f = file();
  writeFileSync(f, JSON.stringify([
    { email: "legacy@example.com", code: "OLD-CODE", ts: 0 },
    { email: "later@example.com", code: null, ts: 300 },
    { email: "first@example.com", code: null, ts: 100 },
    { email: "second@example.com", code: null, ts: 200 },
  ]));
  const wl = new Waitlist(f, () => 1000);
  assert(wl.has("OLD-CODE"));
  const sent: string[] = [];
  const selected = ["first@example.com", "second@example.com"];
  const result = await wl.admit("beta-1", 2, async (email, code) => {
    assert(wl.has(code));
    assert.match(code, /^OVR-[0-9A-F]{32}$/);
    sent.push(email);
    if (email === "second@example.com") throw new Error("mail unavailable");
  }, selected);
  assert.deepEqual(sent, ["first@example.com", "second@example.com"]);
  assert.deepEqual(result, { cohort: "beta-1", admitted: 2, sent: 1, failed: 1 });
  const reloaded = new Waitlist(f, () => 2000);
  const before = JSON.parse(readFileSync(f, "utf8"));
  await assert.rejects(reloaded.admit("beta-1", 3, async () => {}, selected), /bad-selection/);
  await assert.rejects(reloaded.admit("beta-2", 2, async () => {}, selected), /not-enough-pending/);
  assert.deepEqual(await reloaded.admit("beta-1", 2, async email => { assert.equal(email, "second@example.com"); }, selected),
    { cohort: "beta-1", admitted: 2, sent: 1, failed: 0 });
  assert.deepEqual(await reloaded.admit("beta-1", 2, async () => { assert.fail("must not resend"); }, selected),
    { cohort: "beta-1", admitted: 2, sent: 0, failed: 0 });
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).map((e: { code: string | null }) => e.code), before.map((e: { code: string | null }) => e.code));
  assert.equal(reloaded.review().filter(e => !e.admitted).length, 1);
  assert(reloaded.has("OLD-CODE"));
});

test("signups during admission survive, concurrent admissions cannot expand a cohort", async () => {
  const f = file();
  const wl = new Waitlist(f);
  wl.signup("a@b.co");
  await wl.admit("first", 1, async () => {
    wl.signup("new@b.co");
    await assert.rejects(wl.admit("second", 1, async () => {}, ["new@b.co"]), /admission-in-progress/);
  }, ["a@b.co"]);
  assert.equal(new Waitlist(f).review().filter(e => !e.admitted).length, 1);
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

test("handleWaitlist never sends or returns an invite, even for admitted emails", async () => {
  const wl = new Waitlist(file());
  const deps = waitlistDeps({ waitlist: wl, sendInvite: async () => { assert.fail("signup must not send email"); } });
  const expected = { status: 200, json: { ok: true } };
  assert.deepEqual(await handleWaitlist(deps, { email: "a@b.co" }, "ip"), expected);
  await wl.admit("beta", 1, async () => {}, ["a@b.co"]);
  assert.deepEqual(await handleWaitlist(deps, { email: "a@b.co" }, "ip"), expected);
  deps.sendInvite = undefined;
  assert.deepEqual(await handleWaitlist(deps, { email: "new@b.co" }, "ip"), expected);
  assert.equal(wl.review().filter(e => !e.admitted).length, 1);
});

test("admission validates input and requires email configuration before changing access", async () => {
  const wl = new Waitlist(file());
  wl.signup("a@b.co");
  const deps = waitlistDeps({ waitlist: wl });
  assert.equal((await handleAdmission(deps, { cohort: "beta", count: 1 })).status, 503);
  assert.equal(wl.review().filter(e => !e.admitted).length, 1);
  deps.sendInvite = async () => {};
  for (const body of [null, {}, { cohort: "bad name", count: 1 }, { cohort: "beta", count: 0 },
    { cohort: "beta", count: 101 }, { cohort: "beta", count: 1.5 }, { cohort: "beta", count: "1" }]) {
    assert.equal((await handleAdmission(deps, body)).status, 400);
  }
  assert.equal((await handleAdmission(deps, { cohort: "beta", count: 1 })).status, 400);
  assert.equal((await handleAdmission(deps, { cohort: "beta", count: 2, emails: ["a@b.co", "missing@b.co"] })).status, 409);
  deps.sendInvite = async () => { throw new Error("mail down"); };
  assert.equal((await handleAdmission(deps, { cohort: "beta", count: 1, emails: ["a@b.co"] })).status, 502);
  deps.sendInvite = async () => {};
  assert.equal((await handleAdmission(deps, { cohort: "beta", count: 1, emails: ["a@b.co"] })).status, 200);
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


test("selected admission admits only reviewed users and rejects stale or altered selections", async () => {
  const wl = new Waitlist(file());
  for (const email of ["old@b.co", "selected@b.co", "last@b.co"]) wl.signup(email);
  const deps = waitlistDeps({ waitlist: wl, sendInvite: async email => { assert.equal(email, "selected@b.co"); } });
  for (const emails of [null, "selected@b.co", ["unknown@b.co"], ["SELECTED@b.co"], ["selected@b.co", "selected@b.co"]]) {
    const r = await handleAdmission(deps, { cohort: "chosen", count: Array.isArray(emails) ? emails.length : 1, emails });
    assert.ok(r.status === 400 || r.status === 409);
    assert.equal(wl.review().filter(e => e.admitted).length, 0);
  }
  assert.equal((await handleAdmission(deps, { cohort: "chosen", count: 1, emails: ["selected@b.co"] })).status, 200);
  assert.deepEqual(wl.review().filter(e => !e.admitted).map(e => e.email), ["old@b.co", "last@b.co"]);
  assert.equal((await handleAdmission(deps, { cohort: "new", count: 1, emails: ["selected@b.co"] })).status, 409);
  assert.equal(wl.review().filter(e => e.admitted).length, 1);
  assert(wl.review().every(e => !("code" in e)));
});


test("app access requires an admitted record and cannot use an environment-only invite", async () => {
  const waitlist = new Waitlist(file());
  const deps = waitlistDeps({ waitlist, cfg: { inviteCodes: new Set(["environment-only"]) } as QuoteDeps["cfg"], badInviteLimiter: new RateLimiter(2, 1000, () => 0) });
  waitlist.signup("pending@example.com");
  assert.equal(handleAccess(deps, { inviteCode: "environment-only" }, "ip").status, 403);
  assert.equal(handleAccess(deps, { inviteCode: "pending@example.com" }, "ip").status, 403);
  assert.equal(handleAccess(deps, { inviteCode: "wrong" }, "ip").status, 429);
  assert.equal(handleAccess(deps, null, "other-ip").status, 403);
  let issued = "";
  await waitlist.admit("beta", 1, async (_email, code) => { issued = code; }, ["pending@example.com"]);
  assert.equal(handleAccess(deps, { inviteCode: issued }, "ip").status, 200);
  assert.equal(handleAccess(waitlistDeps({}), { inviteCode: issued }, "ip").status, 503);
});
