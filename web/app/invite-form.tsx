"use client";

import { useEffect, useState, type FormEvent } from "react";
import { joinWaitlist, WAITLIST_ERRORS } from "@/lib/writer";

const KEY = "inviteCode";

export function InviteForm() {
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [email, setEmail] = useState("");
  const [waitState, setWaitState] = useState<"idle" | "sending" | "sent">("idle");
  const [waitError, setWaitError] = useState("");

  useEffect(() => {
    const existing = localStorage.getItem(KEY);
    if (existing) {
      setCode(existing);
      setSaved(true);
    }
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Enter the code from your invite.");
      return;
    }
    localStorage.setItem(KEY, trimmed);
    setError("");
    setSaved(true);
  }

  async function submitWaitlist(e: FormEvent) {
    e.preventDefault();
    setWaitError("");
    setWaitState("sending");
    const res = await joinWaitlist(email.trim());
    if (res.ok) {
      setWaitState("sent");
    } else {
      setWaitState("idle");
      setWaitError(WAITLIST_ERRORS[res.error] ?? res.error);
    }
  }

  if (saved) {
    return (
      <div className="bg-[var(--paper)] p-6 text-left shadow-[6px_8px_0_rgba(36,21,18,0.14)]">
        <p className="mono text-[11px] uppercase tracking-wide text-[var(--hit)]">
          Code saved
        </p>
        <p className="mt-2 text-[15px] leading-relaxed">
          It rides along with every quote you request in the builder.
        </p>
        <button
          type="button"
          onClick={() => setSaved(false)}
          className="mono mt-4 text-[11px] uppercase tracking-wide text-dim underline underline-offset-4 transition-colors hover:text-fg"
        >
          Change code
        </button>
      </div>
    );
  }

  return (
    <div className="bg-[var(--paper)] p-6 text-left shadow-[6px_8px_0_rgba(36,21,18,0.14)]">
      <form onSubmit={submit} noValidate>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="invite"
            className="mono text-[10px] uppercase tracking-[0.16em] text-dim"
          >
            Invite code
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id="invite"
              name="invite"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "invite-error" : "invite-help"}
              className="mono flex-1 border-b-2 border-[var(--hair)] bg-transparent px-1 py-2 text-[15px] text-fg placeholder:text-[color-mix(in_srgb,var(--ink)_30%,transparent)] focus:border-[var(--ink)]"
              placeholder="OVR-XXXXXX"
            />
            <button
              type="submit"
              className="mono bg-[var(--ink)] px-6 py-3 text-[12px] uppercase tracking-wide text-[var(--stock)] transition-transform motion-reduce:transition-none active:scale-[0.98] hover:-translate-y-[1px]"
            >
              Save code
            </button>
          </div>
          {error ? (
            <p id="invite-error" className="text-sm text-no">
              {error}
            </p>
          ) : (
            <p id="invite-help" className="text-[13px] text-dim">
              The house writer checks the code when you request a quote.
            </p>
          )}
        </div>
      </form>

      <div className="mt-6 border-t border-[var(--hair)] pt-5">
        {waitState === "sent" ? (
          <>
            <p className="mono text-[11px] uppercase tracking-wide text-[var(--hit)]">
              Invite sent
            </p>
            <p className="mt-2 text-[15px] leading-relaxed">
              Check your email for the code, then save it above.
            </p>
          </>
        ) : (
          <form onSubmit={submitWaitlist} noValidate>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="waitlist-email"
                className="mono text-[10px] uppercase tracking-[0.16em] text-dim"
              >
                No code? Join the beta
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  id="waitlist-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={waitError ? true : undefined}
                  aria-describedby={waitError ? "waitlist-error" : undefined}
                  className="mono flex-1 border-b-2 border-[var(--hair)] bg-transparent px-1 py-2 text-[15px] text-fg placeholder:text-[color-mix(in_srgb,var(--ink)_30%,transparent)] focus:border-[var(--ink)]"
                  placeholder="you@example.com"
                />
                <button
                  type="submit"
                  disabled={waitState === "sending"}
                  className="mono bg-[var(--ink)] px-6 py-3 text-[12px] uppercase tracking-wide text-[var(--stock)] transition-transform motion-reduce:transition-none active:scale-[0.98] hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {waitState === "sending" ? "Sending…" : "Get invite"}
                </button>
              </div>
              {waitError && (
                <p id="waitlist-error" className="text-sm text-no">
                  {waitError}
                </p>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
