import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { googleSheetsConfig, GoogleSheetsWaitlist } from "../src/googleSheets.js";
import { handleAccess, handleAdmission, handleWaitlist } from "../src/server.js";
import { testDeps } from "./testDeps.js";
import { Waitlist } from "../src/waitlist.js";

const config = { url: "https://script.google.com/macros/s/test-deployment/exec", secret: "test-only-secret-32-characters-long" };

test("Sheets configuration is optional, rejects partial config and unsafe destinations", () => {
  assert.equal(googleSheetsConfig({}), undefined);
  assert.deepEqual(googleSheetsConfig({ GOOGLE_SHEETS_WEB_APP_URL: config.url, GOOGLE_SHEETS_SYNC_SECRET: config.secret }), config);
  for (const env of [{ GOOGLE_SHEETS_SYNC_SECRET: config.secret },
    { GOOGLE_SHEETS_WEB_APP_URL: config.url, GOOGLE_SHEETS_SYNC_SECRET: "short" },
    { GOOGLE_SHEETS_WEB_APP_URL: "https://evil.test/exec", GOOGLE_SHEETS_SYNC_SECRET: config.secret }]) {
    assert.throws(() => googleSheetsConfig(env), /GOOGLE_SHEETS/);
  }
});

test("site signup exports immediately without codes; outages and lost acknowledgements retry safely after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sheets-export-"));
  const file = join(directory, "waitlist.json");
  try {
    let waitlist = new Waitlist(file);
    let fail = true;
    let calls = 0;
    const sheet = new Map<string, unknown>();
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, config.url);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.secret, config.secret);
      for (const row of body.entries) {
        assert.equal("code" in row, false);
        assert.equal(row.admitted, false);
        sheet.set(row.email, row);
      }
      if (fail) throw new Error("lost response after the sheet saved the signup");
      if (!waitlist.review().some(e => e.email === "during@example.com")) waitlist.signup("during@example.com");
      return Response.json({ ok: true });
    };
    let bridge = new GoogleSheetsWaitlist(config, waitlist, fetcher);
    let immediate: Promise<void> | undefined;
    const deps = testDeps({ waitlist, syncWaitlist: () => immediate = bridge.sync(), now: Date.now });
    assert.equal((await handleWaitlist(deps, { email: "FIRST@example.com" }, "ip")).status, 200);
    await assert.rejects(immediate!, /remain queued/);
    assert.equal(calls, 1);
    assert.equal(waitlist.review().filter(e => e.admitted).length, 0);
    assert.equal(waitlist.review()[0].sheetSyncedTo, undefined);
    fail = false;
    waitlist = new Waitlist(file);
    bridge = new GoogleSheetsWaitlist(config, waitlist, fetcher);
    await Promise.all([bridge.sync(), bridge.sync()]);
    assert.equal(sheet.size, 2);
    assert.equal(calls, 3); // initial lost response, retry, signup arriving mid-export
    assert(waitlist.review().every(e => e.sheetSyncedTo === config.url));
    await new GoogleSheetsWaitlist(config, new Waitlist(file), fetcher).sync();
    assert.equal(calls, 3); // no polling traffic when there are no pending exports
    assert(JSON.parse(readFileSync(file, "utf8")).every((e: { code: unknown }) => e.code === null));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("sheet edits admit only explicit emails, can grow cohorts, and retries preserve approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sheets-admit-"));
  try {
    const file = join(directory, "waitlist.json");
    const waitlist = new Waitlist(file);
    for (const email of ["first@example.com", "second@example.com", "pending@example.com"]) waitlist.signup(email);
    const sent: string[] = [];
    let fail = true;
    const deps = testDeps({ now: Date.now, waitlist, authenticate: async (token: string) => ({ userId: `did:privy:${token}`, emails: [`${token}@example.com`], wallets: [] }), sendInvite: async (email: string) => {
      sent.push(email);
      if (fail) throw new Error("email unavailable");
    } });
    for (const body of [{ cohort: "beta", count: 1 }, { cohort: "beta", count: 1, emails: ["unknown@example.com"] },
      { cohort: "beta", count: 2, emails: ["first@example.com", "first@example.com"] }]) {
      assert((await handleAdmission(deps, body)).status >= 400);
      assert.equal(waitlist.review().filter(e => e.admitted).length, 0);
    }
    const first = { cohort: "beta", count: 1, emails: ["first@example.com"] };
    assert.equal((await handleAdmission(deps, first)).status, 502);
    fail = false;
    deps.waitlist = new Waitlist(file);
    const retry = await handleAdmission(deps, first);
    assert.equal(retry.status, 200);
    assert.equal("code" in (retry.json as { entries: object[] }).entries[0], false);
    const sentBefore = sent.length;
    assert.equal((await handleAdmission(deps, first)).status, 200);
    assert.equal(sent.length, sentBefore);
    assert.equal((await handleAdmission(deps, { ...first, emails: ["second@example.com"] })).status, 200);
    assert.equal(deps.waitlist.review().filter(e => e.cohort === "beta").length, 2);
    assert.equal(deps.waitlist.review().filter(e => !e.admitted).length, 1);
    assert.equal((await handleAdmission(deps, { ...first, cohort: "other" })).status, 409);
    assert.equal((await handleAccess(deps, "Bearer pending", "ip")).status, 403);
    assert.equal((await handleAccess(deps, "Bearer first", "ip")).status, 200);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("repeat signup restores deleted sheet rows without changing approval, codes or sending another email", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sheets-restore-"));
  const file = join(directory, "waitlist.json");
  try {
    let waitlist = new Waitlist(file);
    const emails = ["pending@example.com", "admitted@example.com"];
    for (const email of emails) waitlist.signup(email);
    await waitlist.admit("beta", 1, async () => {}, [emails[1]]);
    const sheet = new Map<string, { email: string; admitted: boolean; emailedAt?: number }>();
    const fetcher: typeof fetch = async (_url, init) => {
      for (const row of JSON.parse(String(init?.body)).entries) {
        assert.equal("code" in row, false);
        if (!sheet.has(row.email)) sheet.set(row.email, row);
      }
      return Response.json({ ok: true });
    };
    await new GoogleSheetsWaitlist(config, waitlist, fetcher).sync();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    waitlist = new Waitlist(file);
    const bridge = new GoogleSheetsWaitlist(config, waitlist, fetcher);
    let exported: Promise<void> | undefined;
    const deps = testDeps({ waitlist, now: Date.now, syncWaitlist: () => exported = bridge.sync(),
      sendInvite: async (): Promise<void> => { assert.fail("repeat signup must not send an email"); },
    });
    for (const email of emails) {
      const expected = sheet.get(email);
      sheet.delete(email);
      assert.equal((await handleWaitlist(deps, { email: email.toUpperCase() }, "ip")).status, 200);
      await exported;
      assert.deepEqual(sheet.get(email), expected);
      assert.equal(waitlist.size(), 2);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), saved);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
