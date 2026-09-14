"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { appHref } from "@/lib/site";
import { joinWaitlist, WAITLIST_ERRORS } from "@/lib/writer";

export function InviteForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setState("sending");
    const result = await joinWaitlist(email.trim());
    if (result.ok) {
      setState("sent");
    } else {
      setState("idle");
      setError(WAITLIST_ERRORS[result.error] ?? result.error);
    }
  }

  return (
    <div className="rounded-[12px] border border-line bg-panel p-6 text-left">
      {state === "sent" ? (
        <div role="status">
          <p className="mono text-[11px] uppercase tracking-wide text-yes">Invite sent</p>
          <p className="mt-2 text-[15px] leading-relaxed">Check your email for the code, then enter it in the app.</p>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <label htmlFor="waitlist-email" className="mono text-[10px] uppercase tracking-[0.16em] text-dim">
            Join the beta
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <input
              id="waitlist-email"
              name="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "waitlist-error" : undefined}
              className="mono flex-1 rounded-[8px] border border-line bg-raised px-3 py-2.5 text-[15px] text-fg placeholder:text-dim focus:border-accent"
              placeholder="you@example.com"
            />
            <button type="submit" disabled={state === "sending"} className="mono rounded-[8px] bg-accent px-6 py-3 text-[12px] uppercase tracking-wide text-on-accent disabled:cursor-not-allowed disabled:opacity-60">
              {state === "sending" ? "Sending…" : "Get invite"}
            </button>
          </div>
          {error && <p id="waitlist-error" role="alert" className="mt-2 text-sm text-no">{error}</p>}
        </form>
      )}
      <Link href={appHref()} prefetch={false} className="mt-5 inline-block text-sm text-accent underline underline-offset-4">
        Already have a code? Open the app
      </Link>
    </div>
  );
}
