import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

test("setup flushes new headers before reopening the sheet and preserves existing data on reruns", () => {
  let rows: unknown[][] = [];
  let pending: unknown[][] | undefined;
  let triggers = 0;
  let writes = 0;
  const properties = new Map([
    ["SYNC_SECRET", "test-only-sync-secret-at-least-32-characters"],
    ["WAITLIST_ADMIN_TOKEN", "test-only-admin-token"], ["WRITER_URL", "https://writer.example.com"],
  ]);
  const sheet = {
    getLastRow: () => rows.length,
    getRange: () => ({
      setValues: (values: unknown[][]) => { pending = structuredClone(values); writes++; },
      getValues: () => rows.length ? [rows[0]] : [Array(7).fill("")],
      setFontWeight: () => {}, createFilter: () => {},
    }),
    setFrozenRows: () => {}, autoResizeColumns: () => {}, getFilter: () => true,
  };
  const spreadsheet = { getSheetByName: () => sheet, getId: () => "test-sheet" };
  const menu = { addItem: () => menu, addToUi: () => {} };
  const trigger = { forSpreadsheet: () => trigger, onEdit: () => trigger, create: () => { triggers++; } };
  const script = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key: string) => properties.get(key), setProperty: (key: string, value: string) => properties.set(key, value),
    }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet, openById: () => spreadsheet,
      flush: () => { if (pending) { rows = pending; pending = undefined; } },
      getUi: () => ({ createMenu: () => menu }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers ? [{ getHandlerFunction: () => "approveOnEdit" }] : [],
      newTrigger: () => trigger,
    },
  });
  vm.runInContext(readFileSync(new URL("../../ops/google-sheets-waitlist/Code.gs", import.meta.url), "utf8"), script);
  script.setupWaitlist();
  assert.equal(rows[0].join("|"), "Email|Signed up at|Cohort|Approved|Status|Invite sent at|Error");
  rows.push(["existing@example.com", 1000, "", false, "Pending", "", ""]);
  const saved = JSON.stringify(rows);
  script.setupWaitlist();
  assert.equal(JSON.stringify(rows), saved);
  assert.equal(writes, 1);
  assert.equal(triggers, 1);
  rows[0][0] = "Different column";
  const mismatched = JSON.stringify(rows);
  assert.throws(() => script.setupWaitlist(), /Restore the Waitlist column names/);
  assert.equal(JSON.stringify(rows), mismatched);
});

test("actual Apps Script accepts authenticated signups, dedupes, and sends only checked rows with safe retries", () => {
  const rows: unknown[][] = [["Email", "Signed up at", "Cohort", "Approved", "Status", "Invite sent at", "Error"]];
  const secret = "test-only-sync-secret-at-least-32-characters";
  let calls = 0;
  let fail = true;
  let locked = false;
  const range = (row: number, col: number, height = 1, width = 1) => ({
    getValues: () => rows.slice(row - 1, row - 1 + height).map(r => r.slice(col - 1, col - 1 + width)),
    setValues: (values: unknown[][]) => values.forEach((value, i) => {
      rows[row - 1 + i] ??= [];
      value.forEach((cell, j) => rows[row - 1 + i][col - 1 + j] =
        typeof cell === "string" && cell.startsWith("'") ? cell.slice(1) : cell);
    }),
    setValue: (value: unknown) => { rows[row - 1][col - 1] = value; },
    insertCheckboxes: () => {},
  });
  const sheet = {
    getName: () => "Waitlist", getRange: range,
    getDataRange: () => range(1, 1, rows.length, 7), getLastRow: () => rows.length, getMaxRows: () => 1000,
  };
  const script = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key: string) => ({
      SPREADSHEET_ID: "test-sheet", SYNC_SECRET: secret, WRITER_URL: "https://writer.example.com", WAITLIST_ADMIN_TOKEN: "test-admin-token",
    }[key]) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { locked = true; return true; }, hasLock: () => locked, releaseLock: () => { locked = false; } }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush: () => {} },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (value: string) => ({ setMimeType: () => JSON.parse(value) }) },
    UrlFetchApp: { fetch: (url: string, options: { payload: string; headers: { Authorization: string } }) => {
      calls++;
      assert.equal(url, "https://writer.example.com/integrations/google-sheets/admit");
      assert.equal(options.headers.Authorization, "Bearer test-admin-token");
      const body = JSON.parse(options.payload);
      assert.deepEqual(body.emails, ["approved@example.com"]);
      // Simulate a human sorting during the request: status must follow the email.
      [rows[1], rows[2]] = [rows[2], rows[1]];
      return { getResponseCode: () => fail ? 502 : 200, getContentText: () => JSON.stringify({
        entries: [{ email: "approved@example.com", admitted: true, ...(fail ? {} : { emailedAt: 2000 }) }],
      }) };
    } },
  });
  vm.runInContext(readFileSync(new URL("../../ops/google-sheets-waitlist/Code.gs", import.meta.url), "utf8"), script);
  const post = (body: unknown) => script.doPost({ postData: { contents: JSON.stringify(body) } });
  const entries = [{ email: "approved@example.com", ts: 1000, admitted: false }, { email: "pending@example.com", ts: 1000, admitted: false }];
  assert.equal(post({ secret: "wrong", entries }).ok, false);
  assert.equal(rows.length, 1);
  assert.equal(post({ secret, entries }).ok, true);
  assert.equal(post({ secret, entries }).ok, true);
  assert.equal(rows.length, 3);
  assert.equal(calls, 0);
  assert.equal(rows[1][3], false);
  script.sendApproved();
  assert.equal(calls, 0);
  rows[1][2] = "beta-1";
  rows[1][3] = true;
  script.approveOnEdit({ range: { getSheet: () => sheet, getLastRow: () => 2, getColumn: () => 4, getLastColumn: () => 4 } });
  assert.equal(calls, 1);
  assert.equal(rows.find(r => r[0] === "approved@example.com")![4], "Admitted");
  assert.equal(rows.find(r => r[0] === "pending@example.com")![4], "Pending");
  fail = false;
  script.sendApproved();
  assert.equal(calls, 2);
  assert.equal(Number(rows.find(r => r[0] === "approved@example.com")![5]), 2000);
  script.sendApproved();
  assert.equal(calls, 2);
  assert.equal(locked, false);
});
