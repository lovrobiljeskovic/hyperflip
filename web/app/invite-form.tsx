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
      <div className="rounded-[12px] border border-yes/30 bg-panel p-6 text-left">
        <p className="mono text-[11px] uppercase tracking-wide text-yes">
          Code saved. Checked on your first quote
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
    <div className="rounded-[12px] border border-line bg-panel p-6 text-left">
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
              className="mono flex-1 rounded-[8px] border border-line bg-raised px-3 py-2.5 text-[15px] text-fg placeholder:text-dim focus:border-accent"
              placeholder="YOUR-CODE"
            />
            <button
              type="submit"
              className="mono rounded-[8px] bg-accent px-6 py-3 text-[12px] uppercase tracking-wide text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98]"
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

      <div className="mt-6 border-t border-line pt-5">
        {waitState === "sent" ? (
          <>
            <p className="mono text-[11px] uppercase tracking-wide text-yes">
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
                  className="mono flex-1 rounded-[8px] border border-line bg-raised px-3 py-2.5 text-[15px] text-fg placeholder:text-dim focus:border-accent"
                  placeholder="you@example.com"
                />
                <button
                  type="submit"
                  disabled={waitState === "sending"}
                  className="mono rounded-[8px] bg-accent px-6 py-3 text-[12px] uppercase tracking-wide text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
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
