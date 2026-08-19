"use client";

import { useEffect, useState, type FormEvent } from "react";

const KEY = "inviteCode";

export function InviteForm() {
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

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

  if (saved) {
    return (
      <div className="rounded-card border border-line bg-panel p-6 text-left">
        <p className="text-sm">
          <span className="text-accent font-mono">Code saved.</span> It will ride
          along with every quote request once the builder opens.
        </p>
        <button
          type="button"
          onClick={() => setSaved(false)}
          className="mt-4 text-sm text-dim underline underline-offset-4 hover:text-fg transition-colors"
        >
          Change code
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="text-left">
      <div className="flex flex-col gap-2">
        <label htmlFor="invite" className="text-sm text-fg">
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
            className="flex-1 rounded-card border border-line bg-panel px-4 py-3 font-mono text-sm text-fg placeholder:text-dim focus:outline-none focus:border-accent"
            placeholder="beta-xxxx"
          />
          <button
            type="submit"
            className="rounded-card bg-accent px-6 py-3 text-sm font-medium text-on-accent transition-transform active:scale-[0.98] hover:opacity-90"
          >
            Save code
          </button>
        </div>
        {error ? (
          <p id="invite-error" className="text-sm text-no">
            {error}
          </p>
        ) : (
          <p id="invite-help" className="text-sm text-dim">
            Codes are checked by the house writer when you request a quote.
          </p>
        )}
      </div>
    </form>
  );
}
