"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { siteHref } from "@/lib/site";
import { InviteForm } from "../invite-form";

export function AccessForm({ nextPath, unavailable }: { nextPath: string; unavailable: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(unavailable ? "We couldn’t check your access. Please try again shortly." : "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode: code.trim() }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        setError(response.status === 403 ? "That code does not have access. Use the code from your admission email." : "We couldn’t check your access. Please try again shortly.");
        return;
      }
      localStorage.setItem("inviteCode", code.trim());
      window.location.assign(nextPath);
    } catch { setError("Unable to open the app. Please try again."); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto w-full max-w-lg px-4 py-12 sm:py-20">
    <Link href={siteHref("/")} className="text-sm text-dim underline underline-offset-4">Hyperflip</Link>
    <h1 className="display mt-8 text-5xl">Your access starts here.</h1>
    <p className="mt-5 leading-relaxed text-dim">The app is open to admitted waitlist members. Enter the invite code from your admission email to continue.</p>
    <form onSubmit={submit} className="my-8 space-y-3">
      <label htmlFor="access-code" className="block text-sm">Invite code</label>
      <input id="access-code" value={code} onChange={e => setCode(e.target.value)} required maxLength={256}
        autoComplete="off" spellCheck={false} aria-invalid={!!error} aria-describedby={error ? "access-error" : undefined}
        className="mono w-full rounded-control border border-line bg-panel px-3 py-3 text-sm" />
      {error && <p id="access-error" role="alert" className="text-sm text-no">{error}</p>}
      <button disabled={busy} className="w-full rounded-control bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50">{busy ? "Checking access…" : "Enter app"}</button>
    </form>
    <p className="mb-4 text-sm text-dim">Waiting for an invitation? Join the waitlist. We’ll email you when your cohort is admitted.</p>
    <InviteForm showAppLink={false} />
  </main>;
}
