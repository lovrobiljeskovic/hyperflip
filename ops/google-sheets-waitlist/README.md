# Google Sheets waitlist

Users enter only their email on the site. The writer saves it durably and
immediately exports it to a private Google Sheet. You approve rows in Sheets;
an installed edit trigger calls the writer, which generates and emails codes.
Users enter their code on the app and connect any wallet through Privy.
There is no approval page in the app and no Google login for waitlist users.

## One-time setup in your Google account

1. Create a blank Google Sheet and keep sharing **Restricted**. Share Editor
   access only with people allowed to admit users. Bound-script editors also
   have access to its configuration; treat them as administrators.
2. Open **Extensions → Apps Script** and paste the contents of [Code.gs](Code.gs).
3. In **Project Settings → Script Properties**, add:

   | Property | Value |
   | --- | --- |
   | `SYNC_SECRET` | A random secret of at least 32 characters |
   | `WAITLIST_ADMIN_TOKEN` | The same approval token configured on the writer |
   | `WRITER_URL` | Your public HTTPS writer origin, without a trailing slash |

   Generate separate strong secrets in a password manager. Never put them in
   sheet cells, frontend environment variables, source code, or chat.
4. Run `setupWaitlist` once and approve Google's authorization request. It creates
   the **Waitlist** tab, headers, menu, and edit trigger. Only one administrator
   should install the trigger; it runs for edits made by either partner.
5. Choose **Deploy → New deployment → Web app**, execute as **Me**, and access
   **Anyone**. This makes the script endpoint reachable by the writer, not the
   spreadsheet public. Requests still need `SYNC_SECRET`; there is no read endpoint.
6. Set these server-only values in the writer's root `.env` or hosting secrets:

   ```dotenv
   GOOGLE_SHEETS_WEB_APP_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
   GOOGLE_SHEETS_SYNC_SECRET=<same value as SYNC_SECRET>
   WAITLIST_ADMIN_TOKEN=<same value as the script property>
   RESEND_API_KEY=<your existing email-provider credential>
   ```

   Use the deployed `/exec` URL, not `/dev`. Restart the writer. It exports existing
   signups too, preserving their original signup dates and any existing admissions.
   Preserve `WAITLIST_FILE`; it remains the durable queue and code store.
7. Reload the sheet to see the **Waitlist** menu. For later script changes, update
   the existing web-app deployment to a new version so its URL stays stable.

## Admit users

Enter a **Cohort** name (letters, numbers, hyphens, underscores; at most 64
characters), then check **Approved** for the users you want to admit. Bulk paste
`TRUE` into selected checkbox cells to approve a group. Adding users to an existing
cohort is supported. Only explicit selected emails can be admitted.

The edit trigger starts processing without a polling delay. Normal processing
takes seconds; Google scheduling, network calls, and email delivery aren't
instantaneous or guaranteed. **Invite sent at** means the email provider accepted
the message, not that it reached the inbox.

If **Error** is populated, fix the configuration/error and choose **Waitlist →
Send / retry approved invitations**. Retries reuse the original code and skip
emails the writer already recorded as sent. Each execution processes up to 100
approved rows, stopping after roughly three minutes before Google's runtime limit;
use the menu again for any remaining rows. A busy trigger can also require a retry.
Unchecking a box after admission does not revoke an issued code.

Keep Email, signup date, Status, Invite sent at, and Error as integration-owned
columns. Don't rename/reorder columns, duplicate/delete signup rows, or edit
emails after signup. Use filters to review pending, approved, and admitted users;
group/filter by Cohort for counts. Counts represent email signups, not verified
people or active traders.

Signup export failures leave the signup saved locally and retry once per minute.
Idle retries make no external requests. Google never receives invite codes.
Submitting an existing email again restores a deleted sheet row, preserving the
original signup date, approval and invite code without sending another email.
The private approval endpoint is `POST /integrations/google-sheets/admit`, with
the approval token as a Bearer credential and `{cohort,count,emails}` as JSON.
The app checks codes against the writer, so Google outages don't unlock the app
or invalidate existing admissions. Script-created rows don't fire the edit trigger.

## Verify before launching

Use a test sheet and your own test email with a preview writer. Submit through
the site and confirm a Pending row with an unchecked box and no email/code.
Set a cohort, check Approved, and confirm one admission email and its timestamp.
Enter that code at `/access`, then connect a wallet. Try an invalid code and confirm
the app stays gated. Run the sheet's retry action and confirm no new code/email.

Local checks use fake Google services and email delivery; a successful local test
does not verify your Google deployment, trigger authorization, or real email sender.
Google account deployment and production activation are separate setup steps.
A local preview connected to a test writer saves only test data; use the hosted
site to check the production Google Sheet.

Official references: [web apps](https://developers.google.com/apps-script/guides/web),
[edit triggers](https://developers.google.com/apps-script/guides/triggers/installable),
[quotas](https://developers.google.com/apps-script/guides/services/quotas).
