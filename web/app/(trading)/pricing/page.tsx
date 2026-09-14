import type { Metadata } from "next";
import Link from "next/link";
import { appCanonical, appHref } from "@/lib/site";
import { currentPricing, fetchLimits } from "@/lib/writer";

export const metadata: Metadata = {
  title: "Current pricing",
  description: "Inspect Hyperflip’s current beta pricing and how it affects your quoted odds.",
  alternates: { canonical: appCanonical("/pricing") },
  openGraph: { url: appCanonical("/pricing"), title: "Current pricing | Hyperflip" },
};

export default async function PricingPage() {
  const pricing = currentPricing(await fetchLimits());
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-20">
      <p className="mono text-xs uppercase tracking-[.14em] text-accent">Beta pricing</p>
      <h1 className="display mt-4 text-5xl">Know your quote.</h1>
      <p className="mt-6 text-lg leading-relaxed text-dim">See your stake, quoted odds, and maximum payout before you sign. Hyperflip’s house margin is included in the quoted odds.</p>
      <section aria-labelledby="current-pricing" className="mt-8 rounded-card border border-line bg-panel p-6">
        <h2 id="current-pricing" className="text-xl font-semibold">Current house margin</h2>
        {pricing ? (
          <>
            <dl className="mt-5 space-y-4">
              <div className="flex items-baseline justify-between gap-4"><dt>Base margin</dt><dd className="mono text-xl text-accent">{pricing.base}%</dd></div>
              <div className="flex items-baseline justify-between gap-4"><dt>Each leg after the first</dt><dd className="mono text-xl text-accent">+{pricing.perLeg}%</dd></div>
            </dl>
            <p className="mt-5 text-sm leading-relaxed text-dim">The base and additional-leg margins are added together and applied to the combined probability to calculate quoted odds. This reduces the payout relative to fair odds; it is not a separate charge on top of your stake.</p>
          </>
        ) : (
          <p role="status" className="mt-4 text-dim">Current pricing is temporarily unavailable. Please reload to try again. No estimated fee is shown; inspect a fresh quote in the builder before you mint.</p>
        )}
      </section>
      <div className="mt-8 space-y-5 leading-relaxed text-dim">
        <p>Your quote shows the actual pricing adjustments, any payout cap, and the final payout. Network transaction fees are separate.</p>
        <p>Pricing may change during beta. We’ll announce changes in the app with their effective date and an explanation. Changes apply to new quotes; minted slips retain their locked terms.</p>
      </div>
      <Link href={appHref()} className="mt-8 inline-flex rounded-card bg-accent px-5 py-3 font-semibold text-on-accent">Build a slip</Link>
    </main>
  );
}
