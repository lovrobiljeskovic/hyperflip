import Link from "next/link";

import { fetchMids } from "@/lib/info";
import { fetchMarketBoard, onlySports } from "@/lib/writer";
import { LandingHeader } from "./landing-header";
import { appHref } from "@/lib/site";
import { InviteForm } from "./invite-form";
import { HeroSlip, LiveMarketBoard, LiveMarketRail, type BoardSnapshot } from "./live-markets";
import { PurrCoinToss } from "./purr-coin-toss";
import { ScrollLink } from "./scroll-link";
import { SiteFooter } from "./site-footer";

const steps = [
  { n: "01", title: "Choose your legs", body: "Take a side on 2–10 outcome markets." },
  { n: "02", title: "Get a signed quote", body: "We price your combo from current HIP-4 markets. You see the multiplier, our fee and your maximum payout before you commit." },
  { n: "03", title: "Lock it in", body: "Mint the combo to lock your stake and maximum payout on-chain." },
  { n: "04", title: "Collect", body: "Hit every leg and claim your payout in USDC. Miss one and the combo closes." },
];

const settlement = [
  ["Signed quotes", "Every price is an EIP-712 signed quote, verified on-chain when you mint."],
  ["HyperCore settlement", "Each leg resolves with its HIP-4 market on HyperCore, not an oracle we run."],
  ["Fully collateralized", "The house vault locks your maximum payout when you mint, so a winning combo is always covered."],
  ["Held by the contract", "Your slip sits in a non-custodial vault. Winning combos claim USDC directly from the contract."],
] as const;

const faq = [
  {
    q: "How is a combo priced?",
    a: "We multiply the probability of each leg, using current HIP-4 prices, to get the fair value, then add our fee. Both the fair and quoted multiplier are shown before you mint.",
  },
  {
    q: "What if a market settles before my combo is minted?",
    a: "The transaction reverts and the app fetches a fresh quote. A leg that has already settled can't be added to a new combo.",
  },
  {
    q: "Which markets are available?",
    a: "A curated set of HIP-4 outcome markets on HyperCore testnet, refreshed daily. Sports markets are first; more HIP-4 categories will follow. Legs from the same market or event can't be combined.",
  },
  {
    q: "What does it cost?",
    a: "Our fee is built into every quote, and the app shows it before you commit.",
  },
];

async function boardSnapshot(): Promise<BoardSnapshot> {
  const [markets, mids] = await Promise.all([fetchMarketBoard().catch(() => null), fetchMids(10)]);
  return { markets: markets && onlySports(markets), mids };
}

export default async function Home() {
  const board = await boardSnapshot();

  return (
    <div className="flex min-h-full flex-col">
      <LandingHeader />

      <main>
        <LiveMarketRail board={board} />

        <section className="relative isolate mx-auto grid min-h-[calc(100dvh-4rem-42px)] w-full max-w-[1280px] items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.08fr_.92fr] lg:gap-16 lg:py-14">
          <PurrCoinToss />
          <div className="hero-enter">
            <h1 className="display max-w-[9ch] text-[clamp(3.25rem,7vw,6.6rem)] leading-[.86] tracking-[-.06em]">
              Stack your picks. Multiply the payout.
            </h1>
            <p className="mt-6 max-w-[38ch] text-[17px] leading-relaxed text-dim">
              Bundle HIP-4 outcome markets into one combo. Each one you add multiplies what you can win. Lock in your payout upfront, then hit them all to collect.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={appHref()}
                prefetch={false}
                className="rounded-[8px] bg-accent px-6 py-3.5 font-semibold text-on-accent transition-transform active:scale-[.98] motion-reduce:transition-none"
              >
                Launch app
              </Link>
              <ScrollLink
                to="counter"
                className="rounded-[8px] border border-line px-6 py-3.5 font-medium text-fg transition-colors hover:border-dim"
              >
                Request an invite
              </ScrollLink>
            </div>
          </div>
          <div className="hero-enter hero-enter-late min-w-0">
            <HeroSlip board={board} />
          </div>
        </section>

        <section id="board" className="section-reveal mx-auto w-full max-w-[1280px] scroll-mt-20 px-4 py-20 sm:px-6 lg:py-28">
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="display max-w-[12ch] text-[clamp(2.5rem,5vw,4.6rem)]">Open markets.</h2>
            <span className="mono rounded-[4px] border border-accent/40 px-2 py-1 text-[10px] uppercase tracking-[.14em] text-accent">Testnet beta</span>
          </div>
          <p className="mt-5 max-w-[54ch] text-base leading-relaxed text-dim">
            A preview of markets available to trade. Open the app to see all markets, pick your legs and get a signed quote.
          </p>
          <LiveMarketBoard board={board} />
        </section>

        <section id="counter" className="section-reveal mx-auto grid w-full max-w-[1280px] scroll-mt-20 gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[.85fr_1.15fr] lg:py-28">
          <div>
            <h2 className="display max-w-[10ch] text-[clamp(2.5rem,5vw,4.6rem)]">Get early access.</h2>
            <p className="mt-5 max-w-[40ch] leading-relaxed text-dim">
              Hyperflip is in invite-only testnet beta. Browse markets now without connecting a wallet. Request an invite and we’ll email you a code to get quotes and mint combos.
            </p>
          </div>
          <InviteForm />
        </section>

        <section id="writing" className="section-reveal border-y border-line bg-panel/55 scroll-mt-20">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-20 sm:px-6 lg:py-28">
            <h2 className="display max-w-[10ch] text-[clamp(2.5rem,5vw,4.6rem)]">Four moves. One combo.</h2>
            <ol className="mt-12 grid gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step) => (
                <li key={step.n} className="min-h-52 bg-ink p-6 lg:p-7">
                  <span className="mono text-[11px] text-accent">{step.n}</span>
                  <h3 className="mt-16 text-xl font-semibold">{step.title}</h3>
                  <p className="mt-3 leading-relaxed text-dim">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="book" className="section-reveal mx-auto grid w-full max-w-[1280px] scroll-mt-20 gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[.8fr_1.2fr] lg:py-28">
          <div>
            <h2 className="display max-w-[9ch] text-[clamp(2.5rem,5vw,4.6rem)]">Pricing you can inspect.</h2>
            <p className="mt-5 max-w-[42ch] text-base leading-relaxed text-dim">
              Every quote shows the fair value, our fee and your maximum payout before you commit.
            </p>
          </div>
          <dl className="grid content-start gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2">
            <div className="bg-panel p-7 sm:col-span-2">
              <dt className="mono text-[10px] uppercase tracking-[.14em] text-dim">How pricing works</dt>
              <dd className="display mt-5 text-5xl text-accent">Know your quote.</dd>
              <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-dim">
                Each leg is priced from its HIP-4 market. We combine them into a fair value, then add our fee. Pricing may change during beta.
              </p>
              <Link href={appHref("/pricing")} prefetch={false} className="mt-4 inline-block text-sm text-accent underline underline-offset-4">See current pricing</Link>
            </div>
            <div className="bg-raised p-7">
              <dt className="mono text-[10px] uppercase tracking-[.14em] text-dim">Before mint</dt>
              <dd className="mt-5 text-xl font-semibold">Fair vs. quoted</dd>
              <p className="mt-2 text-sm leading-relaxed text-dim">See the adjustment and final return side by side.</p>
            </div>
            <div className="bg-panel p-7">
              <dt className="mono text-[10px] uppercase tracking-[.14em] text-dim">Price protection</dt>
              <dd className="mt-5 text-xl font-semibold">Locked once you’re in</dd>
              <p className="mt-2 text-sm leading-relaxed text-dim">Each quote shows when it expires. Once your combo is minted, its terms don’t change.</p>
            </div>
          </dl>
        </section>

        <section className="section-reveal border-y border-line">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-20 sm:px-6 lg:py-28">
            <h2 className="display max-w-[12ch] text-[clamp(2.5rem,5vw,4.6rem)]">Settlement without a black box.</h2>
            <div className="mt-12 grid overflow-hidden rounded-[12px] border border-line lg:grid-cols-2">
              {settlement.map(([title, body], index) => (
                <article key={title} className={`${index === 0 || index === 3 ? "bg-raised" : "bg-panel"} p-7 lg:p-9`}>
                  <h3 className="text-xl font-semibold">{title}</h3>
                  <p className="mt-3 max-w-[46ch] leading-relaxed text-dim">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section-reveal border-t border-line bg-panel/45">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-20 sm:px-6 lg:py-28">
            <h2 className="display text-[clamp(2.5rem,5vw,4.6rem)]">Questions, answered.</h2>
            <div className="mt-10 max-w-4xl divide-y divide-line border-y border-line">
              {faq.map((item) => (
                <details key={item.q} className="group py-6">
                  <summary className="flex items-center justify-between gap-6 text-lg font-semibold">{item.q}</summary>
                  <p className="mt-4 max-w-[64ch] leading-relaxed text-dim">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
