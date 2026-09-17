import type { Metadata } from "next";
import { official } from "@/app/site-footer";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Hyperflip collects, what it doesn’t, and who it shares data with.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <p className="mono text-xs uppercase tracking-[.14em] text-accent">Last updated 17 September 2026</p>
      <h1>Privacy policy</h1>
      <p>Short version: we don’t run accounts, we don’t track you across sites, and we never see your private keys.</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Wallet address and on-chain activity.</strong> Public by nature. Our writer sees the address you request quotes for and the slips you mint, to enforce exposure caps and price parlays.</li>
        <li><strong>Invite requests.</strong> The email address you submit on the landing page, used only to send you a beta code.</li>
        <li><strong>Wallet login.</strong> Sign-in is handled by Privy. Privy may process your email or wallet under its own <a href="https://www.privy.io/privacy-policy" target="_blank" rel="noreferrer">privacy policy</a>.</li>
        <li><strong>Server logs.</strong> IP address, user agent and request path, kept briefly for abuse prevention and debugging.</li>
      </ul>

      <h2>What we don’t collect</h2>
      <ul>
        <li>Seed phrases or private keys. We never ask for them, anywhere.</li>
        <li>Third-party advertising or cross-site tracking cookies.</li>
        <li>Identity documents. There is no KYC on the testnet beta.</li>
      </ul>

      <h2>Who sees it</h2>
      <p>Vercel hosts the site and app. Our writer service runs on a server we operate. Privy handles wallet sign-in. Hyperliquid RPC and HyperCore nodes receive the transactions you sign. We do not sell data.</p>

      <h2>Retention and your rights</h2>
      <p>Invite emails are deleted once the beta ends or on request. On-chain data is permanent and outside our control. To ask what we hold about you or to have it deleted, email <a href={`mailto:${official.email}`}>{official.email}</a>.</p>

      <h2>Changes</h2>
      <p>We will update this page and its date when our practices change.</p>
    </>
  );
}
