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
    <form
      onSubmit={submit}
      noValidate
      className="bg-[var(--paper)] p-6 text-left shadow-[6px_8px_0_rgba(36,21,18,0.14)]"
    >
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
            placeholder="beta-xxxx"
          />
          <button
            type="submit"
            className="mono bg-[var(--ink)] px-6 py-3 text-[12px] uppercase tracking-wide text-[var(--stock)] transition-transform active:scale-[0.98] hover:-translate-y-[1px]"
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
  );
}
