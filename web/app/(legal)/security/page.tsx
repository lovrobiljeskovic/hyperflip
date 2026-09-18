import type { Metadata } from "next";
import Link from "next/link";
import { official } from "@/app/site-footer";

export const metadata: Metadata = {
  title: "Security",
  description: "How to report a vulnerability in Hyperflip and what is in scope.",
  alternates: { canonical: "/security" },
};

export default function SecurityPage() {
  return (
    <>
      <p className="mono text-xs uppercase tracking-[.14em] text-accent">Vulnerability disclosure</p>
      <h1>Security</h1>
      <p>Found a bug in our contracts, writer or web app? Tell us before you tell anyone else and we will work with you in good faith.</p>

      <h2>Report</h2>
      <p>Email <a href={`mailto:${official.email}`}>{official.email}</a> with steps to reproduce. Our machine-readable contact is at <a href="/.well-known/security.txt"><code>/.well-known/security.txt</code></a>.</p>

      <h2>In scope</h2>
      <ul>
        <li>ParlayVault and OutcomeVault contracts on HyperEVM testnet.</li>
        <li>The house writer API (quote signing, exposure caps, settlement pokes).</li>
        <li>hyperflip.xyz and app.hyperflip.xyz.</li>
      </ul>

      <h2>Rules</h2>
      <ul>
        <li>Testnet only. Do not test against Hyperliquid mainnet.</li>
        <li>No denial of service, spam or social engineering of the team.</li>
        <li>Give us reasonable time to fix before public disclosure.</li>
      </ul>
      <p>There is no paid bounty programme during beta. We credit reporters who want it.</p>

      <h2>Protect yourself</h2>
      <p>Check the <Link href="/official">official links</Link> page before connecting a wallet. We never DM first, never ask for a seed phrase and never ask you to “verify” a wallet outside the app.</p>
    </>
  );
}
