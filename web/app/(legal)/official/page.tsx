import type { Metadata } from "next";
import { official } from "@/app/site-footer";

export const metadata: Metadata = {
  title: "Official links",
  description: "The only domains, accounts and channels that belong to Hyperflip.",
  alternates: { canonical: "/official" },
};

export default function OfficialPage() {
  return (
    <>
      <p className="mono text-xs uppercase tracking-[.14em] text-accent">Verify before you connect</p>
      <h1>Official links</h1>
      <p>Anything not on this list is not us. Bookmark this page and check it if a link looks off.</p>

      <h2>Domains</h2>
      <ul>
        {official.domains.map((d) => <li key={d}><a href={`https://${d}`}><code>{d}</code></a></li>)}
      </ul>

      <h2>Accounts</h2>
      <ul>
        <li>X: <a href={official.x} target="_blank" rel="noreferrer"><code>@hyperflip_xyz</code></a></li>
        <li>Discord: <a href={official.discord} target="_blank" rel="noreferrer"><code>{official.discord}</code></a></li>
        <li>Email: <a href={`mailto:${official.email}`}><code>{official.email}</code></a></li>
      </ul>

      <h2>Related</h2>
      <ul>
        <li>Hyperliquid: <a href={official.hyperliquid} target="_blank" rel="noreferrer"><code>hyperliquid.xyz</code></a></li>
        <li>HyperCore docs: <a href={official.docs} target="_blank" rel="noreferrer"><code>hyperliquid.gitbook.io</code></a></li>
      </ul>

      <h2>We will never</h2>
      <ul>
        <li>DM you first, on any platform.</li>
        <li>Ask for your seed phrase or private key.</li>
        <li>Ask you to “verify”, “sync” or “validate” your wallet outside the app.</li>
        <li>Ask you to send funds to an address to receive a payout. Claims come from the contract.</li>
      </ul>
      <p>Operated by the Hyperflip team (unincorporated). Vulnerability reports: <a href="/security">/security</a>.</p>
    </>
  );
}
