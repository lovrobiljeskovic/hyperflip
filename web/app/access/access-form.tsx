"use client";

import Link from "next/link";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { siteHref } from "@/lib/site";
import { HyperflipBrand } from "../brand";
import { InviteForm } from "../invite-form";
import { Providers } from "../providers";

export function AccessForm(props: { nextPath: string; unavailable: boolean }) {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return <AccessShell><p className="mb-6">Sign-in is temporarily unavailable. You can still join the waitlist.</p><InviteForm showAppLink={false} /></AccessShell>;
  return <Providers><AccountAccess {...props} /></Providers>;
}

function AccessShell({ children }: { children: React.ReactNode }) {
  const home = siteHref("/");
  return <main className="relative isolate mx-auto w-full max-w-xl px-4 py-8 sm:py-14">
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <img src="/brand/purr-lines.png" alt="" width="600" height="600" className="absolute bottom-[-6%] right-[-12%] w-[min(85vw,640px)] opacity-[.12] sm:right-[-4%] lg:right-[6%]" />
    </div>
    <div className="flex items-center gap-3">
      <Link href={home} prefetch={false} aria-label="Back to Hyperflip" className="flex h-9 w-9 items-center justify-center rounded-card border border-line text-dim transition-colors hover:text-fg">
        <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </Link>
      <HyperflipBrand href={home} />
    </div>
    <div className="mt-10">{children}</div>
  </main>;
}

function AccountAccess({ nextPath, unavailable }: { nextPath: string; unavailable: boolean }) {
  const { ready, authenticated, user, login, linkEmail, logout, getAccessToken } = usePrivy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(unavailable ? "We couldn’t check your access. Please try again shortly." : "");

  async function enter() {
    setBusy(true);
    setError("");
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) { setError("Please sign in again."); return; }
      const response = await fetch("/api/access", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        setError(response.status === 403 ? "This account does not have access yet. Verify the email you used for the waitlist, then wait for approval. If you already claimed access, use your original account." : "We couldn’t check your access. Please try again shortly.");
        return;
      }
      localStorage.removeItem("inviteCode");
      window.location.assign(nextPath);
    } catch { setError("Unable to open the app. Please try again."); }
    finally { setBusy(false); }
  }

  return <AccessShell>
    <h1 className="display text-5xl">Your access starts here.</h1>
    <p className="mt-5 leading-relaxed text-dim">Sign in with the email you used for the waitlist. Once approved, connect and verify your existing wallet in the app.</p>
    <div className="my-8 space-y-3">
      {authenticated && user?.email && <p className="text-sm text-dim">Signed in as {user.email.address}</p>}
      {error && <p role="alert" className="text-sm text-no">{error}</p>}
      <button disabled={!ready || busy} onClick={() => !authenticated ? login({ loginMethods: ["email"] }) : !user?.email ? linkEmail() : void enter()}
        className="w-full rounded-control bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50">
        {!ready ? "Loading sign-in…" : busy ? "Checking access…" : !authenticated ? "Sign in with email" : !user?.email ? "Verify your waitlist email" : "Enter app"}
      </button>
      {authenticated && <button className="text-sm text-dim underline" onClick={() => { setError(""); void fetch("/api/access", { method: "DELETE" }).catch(() => {}).then(() => logout()); }}>Use another account</button>}
    </div>
    <p className="mb-4 text-sm text-dim">Waiting for approval? Join the waitlist. We’ll email you when your cohort is admitted.</p>
    <InviteForm showAppLink={false} />
  </AccessShell>;
}
