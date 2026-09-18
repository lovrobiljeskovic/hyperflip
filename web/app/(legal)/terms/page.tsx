import type { Metadata } from "next";
import Link from "next/link";
import { official } from "@/app/site-footer";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "Terms for using the Hyperflip testnet beta.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <>
      <p className="mono text-xs uppercase tracking-[.14em] text-accent">Last updated 17 September 2026</p>
      <h1>Terms of use</h1>
      <p>These terms apply to hyperflip.xyz, app.hyperflip.xyz and the smart contracts they interact with (together, “Hyperflip”). By using Hyperflip you agree to them.</p>

      <h2>1. Testnet beta</h2>
      <p>Hyperflip currently runs on HyperEVM and HyperCore <strong>testnet</strong>. Testnet USDC has no monetary value. Contracts, pricing and the app may change or be reset without notice. Nothing here is a promise of a mainnet launch.</p>

      <h2>2. Who we are</h2>
      <p>Hyperflip is built and operated by an unincorporated team. Contact: <a href={`mailto:${official.email}`}>{official.email}</a>. Our only official domains and accounts are listed on the <Link href="/official">official links</Link> page.</p>

      <h2>3. Eligibility</h2>
      <p>You must be legally allowed to use prediction and outcome markets where you live. Do not use Hyperflip if such use is prohibited in your jurisdiction, or if you are on a sanctions list. You are responsible for complying with your local laws and taxes.</p>

      <h2>4. Non-custodial</h2>
      <p>Hyperflip never holds your keys. You connect your own wallet and sign every transaction yourself. Minted slips live in an on-chain vault; claims are paid by the contract, not by us. We cannot reverse transactions or recover funds sent to the wrong address.</p>

      <h2>5. Quotes and settlement</h2>
      <p>Prices are EIP-712 signed quotes from our house writer, valid until the expiry shown. A quote is only binding once minted on-chain. Legs settle according to their HIP-4 market on HyperCore. See <Link href="/risk">risk and settlement</Link> for how this works and what can go wrong.</p>

      <h2>6. Invite codes</h2>
      <p>Beta access is by invite. Codes are personal, may be revoked and must not be sold.</p>

      <h2>7. Prohibited use</h2>
      <ul>
        <li>Attacking, spamming or attempting to exploit the app, writer or contracts.</li>
        <li>Impersonating Hyperflip or its team.</li>
        <li>Using Hyperflip for money laundering or any unlawful purpose.</li>
      </ul>

      <h2>8. No warranty, limited liability</h2>
      <p>Hyperflip is provided “as is”, without warranties of any kind. Smart contracts can contain bugs; HyperCore markets can settle unexpectedly; the writer can go offline. To the fullest extent permitted by law, we are not liable for any loss arising from your use of Hyperflip.</p>

      <h2>9. Changes</h2>
      <p>We may update these terms. The date at the top shows the current version. Continued use after a change means you accept it.</p>
    </>
  );
}
