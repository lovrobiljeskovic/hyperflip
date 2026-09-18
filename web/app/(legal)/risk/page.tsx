import type { Metadata } from "next";
import Link from "next/link";
import { appHref } from "@/lib/site";

export const metadata: Metadata = {
  title: "Risk and settlement",
  description: "How Hyperflip combos are priced, minted, settled and paid, and what can go wrong.",
  alternates: { canonical: "/risk" },
};

export default function RiskPage() {
  return (
    <>
      <p className="mono text-xs uppercase tracking-[.14em] text-accent">Risk disclosure</p>
      <h1>How settlement works</h1>
      <p>A Hyperflip combo bundles 2 to 10 HIP-4 outcome markets into one on-chain slip. You win only if every leg wins. This page explains each step and where the risk sits.</p>

      <h2>1. Quote</h2>
      <p>Our house writer reads current HIP-4 prices on HyperCore, multiplies the leg probabilities into a fair value, then applies the house margin shown on the <Link href={appHref("/pricing")}>pricing</Link> page. The result is an EIP-712 signed quote with a stake, a maximum payout and an expiry. You can inspect fair vs. quoted odds before you commit.</p>

      <h2>2. Mint</h2>
      <p>Minting sends the quote and your USDC to the ParlayVault contract. The contract verifies the writer’s signature, checks that no leg has already settled, pulls your stake and locks the house’s side of the maximum payout. If any check fails the transaction reverts and nothing moves. Once minted, the terms cannot change.</p>

      <h2>3. Settlement</h2>
      <p>Each leg resolves with its HIP-4 market on HyperCore. Hyperflip does not run an oracle and cannot decide outcomes. When a leg settles NO, the combo is dead and the locked payout returns to the house. When every leg settles YES, the slip becomes claimable.</p>

      <h2>4. Claim</h2>
      <p>You claim from the contract with your own wallet. Payout comes from collateral locked at mint, so a winning combo is always covered. Slips are non-custodial: we cannot pay out early, cancel, or reverse a slip.</p>

      <h2>What can go wrong</h2>
      <ul>
        <li><strong>You lose your stake.</strong> One losing leg loses the whole combo. Combos are high-variance by design.</li>
        <li><strong>Market resolution.</strong> HIP-4 markets resolve under Hyperliquid’s rules. A void, delayed or disputed market is handled by HyperCore, not by us.</li>
        <li><strong>Smart-contract risk.</strong> Contracts are unaudited during beta. Bugs could lock or lose funds.</li>
        <li><strong>Writer downtime.</strong> If our writer is offline you cannot get new quotes. Minted slips are unaffected because settlement and claims are on-chain.</li>
        <li><strong>Testnet.</strong> Everything currently runs on testnet with valueless USDC and may be reset.</li>
      </ul>

      <h2>Phishing</h2>
      <p>The only places to mint are listed on our <Link href="/official">official links</Link> page. We never DM first, never ask for a seed phrase and never ask you to “verify” a wallet outside the app.</p>
    </>
  );
}
