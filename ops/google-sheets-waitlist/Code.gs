// Bound to the private Google Sheet. Secrets belong in Script Properties, never cells.
const HEADERS = ["Email", "Signed up at", "Cohort", "Approved", "Status", "Invite sent at", "Error"];

function sheet_() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!id) throw new Error("Run setupWaitlist first");
  const sheet = SpreadsheetApp.openById(id).getSheetByName("Waitlist");
  if (!sheet || JSON.stringify(sheet.getRange(1, 1, 1, 7).getValues()[0]) !== JSON.stringify(HEADERS)) {
    throw new Error("Restore the Waitlist column names and order");
  }
  return sheet;
}

function setupWaitlist() {
  const properties = PropertiesService.getScriptProperties();
  if ((properties.getProperty("SYNC_SECRET") || "").length < 32 || !properties.getProperty("WAITLIST_ADMIN_TOKEN") ||
      !/^https:\/\/[^/?#]+$/.test(properties.getProperty("WRITER_URL") || "")) {
    throw new Error("Set SYNC_SECRET, WAITLIST_ADMIN_TOKEN, and the HTTPS WRITER_URL in Script Properties first");
  }
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Waitlist") || spreadsheet.insertSheet("Waitlist");
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, 7).setValues([HEADERS]);
  properties.setProperty("SPREADSHEET_ID", spreadsheet.getId());
  SpreadsheetApp.flush();
  sheet_();
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 7).setFontWeight("bold");
  sheet.autoResizeColumns(1, 7);
  if (!sheet.getFilter()) sheet.getRange(1, 1, sheet.getMaxRows(), 7).createFilter();
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === "approveOnEdit")) {
    ScriptApp.newTrigger("approveOnEdit").forSpreadsheet(spreadsheet).onEdit().create();
  }
  onOpen();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Waitlist").addItem("Send / retry approved invitations", "sendApproved").addToUi();
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(event) {
  let lock;
  try {
    const body = JSON.parse(event.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty("SYNC_SECRET");
    if (!secret || body.secret !== secret) return json_({ ok: false });
    if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 100 || body.entries.some(e =>
      !e || typeof e.email !== "string" || e.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email) ||
      e.email !== e.email.trim().toLowerCase() || !Number.isSafeInteger(e.ts) || e.ts < 0 ||
      !Number.isFinite(new Date(e.ts).getTime()) || typeof e.admitted !== "boolean" ||
      (e.cohort !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(e.cohort)) ||
      (e.emailedAt !== undefined && (!Number.isSafeInteger(e.emailedAt) || e.emailedAt < e.ts)))) return json_({ ok: false });
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return json_({ ok: false });
    const sheet = sheet_();
    // ponytail: a linear scan suits an early waitlist; use a database if sheet size slows writes.
    const known = new Set(sheet.getDataRange().getValues().slice(1).map(row => row[0]));
    const added = [];
    for (const entry of body.entries) {
      if (known.has(entry.email)) continue;
      // Literal text prevents an email beginning with '=' from becoming a formula.
      added.push(["'" + entry.email, new Date(entry.ts), entry.cohort || "", false,
        entry.admitted ? "Admitted" : "Pending", entry.emailedAt === undefined ? "" : new Date(entry.emailedAt), ""]);
      known.add(entry.email);
    }
    if (added.length) {
      const start = sheet.getLastRow() + 1;
      if (start + added.length - 1 > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), added.length);
      sheet.getRange(start, 1, added.length, 7).setValues(added);
      sheet.getRange(start, 4, added.length, 1).insertCheckboxes();
    }
    SpreadsheetApp.flush();
    return json_({ ok: true });
  } catch { return json_({ ok: false }); }
  finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}

function approveOnEdit(event) {
  if (!event || event.range.getSheet().getName() !== "Waitlist" || event.range.getLastRow() < 2 ||
      event.range.getColumn() > 4 || event.range.getLastColumn() < 3) return;
  sendApproved();
}

function updateDelivery_(sheet, email, values) {
  // Script locks don't prevent a person from sorting the sheet during an HTTP call.
  const matches = sheet.getDataRange().getValues().map((row, i) => row[0] === email ? i + 1 : 0).filter(Boolean);
  if (matches.length !== 1) throw new Error("Email changed or duplicated during admission; restore it and retry");
  sheet.getRange(matches[0], 5, 1, 3).setValues([values]);
}

function sendApproved() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error("Waitlist is busy; use the Waitlist retry menu");
  try {
    const sheet = sheet_();
    const properties = PropertiesService.getScriptProperties();
    const writer = properties.getProperty("WRITER_URL");
    const token = properties.getProperty("WAITLIST_ADMIN_TOKEN");
    if (!/^https:\/\/[^/?#]+$/.test(writer || "") || !token) throw new Error("Configure WRITER_URL and WAITLIST_ADMIN_TOKEN");
    const groups = new Map();
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [email, , cohort, approved, , sentAt] = rows[i];
      if (approved !== true || sentAt) continue;
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(cohort)) {
        sheet.getRange(i + 1, 7).setValue("Enter a valid email and cohort before approving");
        continue;
      }
      const group = groups.get(cohort) || [];
      group.push(email);
      groups.set(cohort, group);
    }
    // Limit one execution so Google's six-minute runtime cannot swallow a large cohort.
    let remaining = 100;
    const deadline = Date.now() + 180000;
    for (const [cohort, group] of groups) {
      for (let i = 0; i < group.length && remaining > 0 && Date.now() < deadline; i += 5) {
        const batch = group.slice(i, i + Math.min(5, remaining));
        remaining -= batch.length;
        let result;
        try {
          const response = UrlFetchApp.fetch(writer + "/integrations/google-sheets/admit", {
            method: "post", contentType: "application/json", headers: { Authorization: "Bearer " + token },
            payload: JSON.stringify({ cohort, count: batch.length, emails: batch }),
            muteHttpExceptions: true, followRedirects: false,
          });
          const status = response.getResponseCode();
          result = JSON.parse(response.getContentText());
          if ((status !== 200 && status !== 502) || !Array.isArray(result.entries)) throw new Error();
        } catch {
          for (const email of batch) updateDelivery_(sheet, email,
            ["Check admission", "", "Admission failed; check backend configuration and use Waitlist > Send / retry"]);
          continue;
        }
        for (const email of batch) {
          const state = result.entries.find(e => e.email === email);
          const sent = state && Number.isSafeInteger(state.emailedAt);
          updateDelivery_(sheet, email, [
            state && state.admitted ? "Admitted" : "Pending", sent ? new Date(state.emailedAt) : "",
            sent ? "" : "Email pending; use Waitlist > Send / retry",
          ]);
        }
      }
    }
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}
