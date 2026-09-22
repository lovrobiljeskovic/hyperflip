"use client";

import Link from "next/link";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { siteHref } from "@/lib/site";
import { HyperflipBrand } from "../brand";
import { Providers } from "../providers";

export function AccessForm(props: { nextPath: string; unavailable: boolean }) {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) return <AccessShell><p className="mb-6">Sign-in is temporarily unavailable. Please try again shortly.</p></AccessShell>;
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
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
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
        setError(response.status === 403 ? "This wallet does not have access right now." : "We couldn’t check your access. Please try again shortly.");
        return;
      }
      localStorage.removeItem("inviteCode");
      window.location.assign(nextPath);
    } catch { setError("Unable to open the app. Please try again."); }
    finally { setBusy(false); }
  }

  return <AccessShell>
    <h1 className="display text-5xl">Connect and play.</h1>
    <p className="mt-5 leading-relaxed text-dim">Sign in with your wallet, one signature, no email. Testnet beta: the house bankroll is capped, so stakes and exposure are limited per market and per wallet.</p>
    <div className="my-8 space-y-3">
      {authenticated && user?.wallet && <p className="mono text-sm text-dim">Signed in as {user.wallet.address.slice(0, 6)}…{user.wallet.address.slice(-4)}</p>}
      {error && <p role="alert" className="text-sm text-no">{error}</p>}
      <button disabled={!ready || busy} onClick={() => !authenticated ? login({ loginMethods: ["wallet"] }) : void enter()}
        className="w-full rounded-control bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50">
        {!ready ? "Loading sign-in…" : busy ? "Checking access…" : !authenticated ? "Connect wallet" : "Enter app"}
      </button>
      {authenticated && <button className="text-sm text-dim underline" onClick={() => { setError(""); void fetch("/api/access", { method: "DELETE" }).catch(() => {}).then(() => logout()); }}>Use another wallet</button>}
    </div>
  </AccessShell>;
}
