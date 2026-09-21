"use client";

import Link from "next/link";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { siteHref } from "@/lib/site";
import { InviteForm } from "../invite-form";
import { Providers } from "../providers";

export function AccessForm(props: { nextPath: string; unavailable: boolean }) {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return <main className="mx-auto max-w-lg px-4 py-12"><p className="mb-6">Sign-in is temporarily unavailable. You can still join the waitlist.</p><InviteForm showAppLink={false} /></main>;
  return <Providers><AccountAccess {...props} /></Providers>;
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

  return <main className="mx-auto w-full max-w-lg px-4 py-12 sm:py-20">
    <Link href={siteHref("/")} className="text-sm text-dim underline underline-offset-4">Hyperflip</Link>
    <h1 className="display mt-8 text-5xl">Your access starts here.</h1>
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
  </main>;
}
