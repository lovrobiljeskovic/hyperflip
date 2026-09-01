import Link from "next/link";

import { fetchMids } from "@/lib/info";
import { fetchMarketBoard } from "@/lib/writer";
import { AppHeader } from "./app-header";
import { HyperflipBrand } from "./brand";
import { InviteForm } from "./invite-form";
import { HeroSlip, LiveMarketBoard, LiveMarketRail, type BoardSnapshot } from "./live-markets";
import { PurrCoinToss } from "./purr-coin-toss";

const steps = [
  { n: "01", title: "Pick the markets", body: "Take YES or NO on two to ten live outcome markets." },
  { n: "02", title: "Read the quote", body: "Hyperflip prices the combination from the live Core book." },
  { n: "03", title: "Mint the slip", body: "Your premium and maximum payout lock on-chain." },
  { n: "04", title: "Claim the result", body: "Every leg your way pays USDC. One miss closes the slip." },
];

const settlement = [
  ["Signed quotes", "Every premium is an EIP-712 quote checked on-chain at mint."],
  ["HyperCore settlement", "HIP-4 outcome markets settle from the Core book, not an oracle we run."],
  ["Collateral up front", "The house vault posts the maximum payout before you sign."],
  ["Self-custody", "Outcome tokens stay in a non-custodial vault. Winning slips claim USDC from the contract."],
] as const;

const faq = [
  {
    q: "How does pricing work?",
    a: "The live market probabilities are combined, adjusted for correlation, then priced with the house margin. Fair and quoted returns are both shown before you mint.",
  },
  {
    q: "What if a leg settles while I mint?",
    a: "The mint reverts and the builder requests a fresh quote. A settled leg cannot enter a new slip.",
  },
  {
    q: "Which markets are available?",
    a: "A curated registry of HIP-4 outcome markets on the HyperCore testnet book. The board grows through the beta.",
  },
  {
    q: "What does it cost?",
    a: "There is no platform fee during beta. The signed quote shows the full house spread before you mint.",
  },
];

async function boardSnapshot(): Promise<BoardSnapshot> {
  const [markets, mids] = await Promise.all([fetchMarketBoard().catch(() => null), fetchMids(10)]);
  return { markets, mids };
}

export default async function Home() {
  const board = await boardSnapshot();

  return (
    <div className="flex min-h-full flex-col">
      <AppHeader />

      <main>
        <section className="mx-auto grid min-h-[calc(100dvh-4rem)] w-full max-w-[1280px] items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.08fr_.92fr] lg:gap-16 lg:py-14">
          <div className="hero-enter">
            <PurrCoinToss />
            <h1 className="display max-w-[9ch] text-[clamp(3.25rem,7vw,6.6rem)] leading-[.86] tracking-[-.06em]">
              Flip markets. Stack outcomes.
            </h1>
            <p className="mt-6 max-w-[38ch] text-[17px] leading-relaxed text-dim">
              Combine live HyperCore outcomes into one on-chain slip with one locked payout.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/build"
                className="rounded-[8px] bg-accent px-6 py-3.5 font-semibold text-on-accent transition-transform active:scale-[.98] motion-reduce:transition-none"
              >
                Start building
              </Link>
              <a
                href="#board"
                className="rounded-[8px] border border-line px-6 py-3.5 font-medium text-fg transition-colors hover:border-dim"
              >
                View markets
              </a>
            </div>
          </div>
          <div className="hero-enter hero-enter-late min-w-0">
            <HeroSlip board={board} />
          </div>
        </section>

        <LiveMarketRail board={board} />

        <section id="board" className="section-reveal mx-auto w-full max-w-[1280px] scroll-mt-20 px-4 py-20 sm:px-6 lg:py-28">
          <h2 className="display max-w-[12ch] text-[clamp(2.5rem,5vw,4.6rem)]">Markets, moving now.</h2>
          <p className="mt-5 max-w-[54ch] text-base leading-relaxed text-dim">
            Live decimal odds and implied probability from HyperCore. The board carries no house spread.
          </p>
          <LiveMarketBoard board={board} />
        </section>

        <section id="writing" className="section-reveal border-y border-line bg-panel/55 scroll-mt-20">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-20 sm:px-6 lg:py-28">
            <h2 className="display max-w-[10ch] text-[clamp(2.5rem,5vw,4.6rem)]">Four moves. One ticket.</h2>
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
              Every quote separates market probability, correlation, and house margin before your wallet opens.
            </p>
          </div>
          <dl className="grid content-start gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2">
            <div className="bg-panel p-7 sm:col-span-2">
              <dt className="mono text-[10px] uppercase tracking-[.14em] text-dim">Beta platform fee</dt>
              <dd className="display mt-5 text-5xl text-accent">None</dd>
            </div>
            <div className="bg-raised p-7">
              <dt className="mono text-[10px] uppercase tracking-[.14em] text-dim">Before mint</dt>
              <dd className="mt-5 text-xl font-semibold">Fair vs. quoted</dd>
              <p className="mt-2 text-sm leading-relaxed text-dim">See the adjustment and final return side by side.</p>
            </div>
            <div className="bg-panel p-7">
              <dt className="mono text-[10px] uppercase tracking-[.14em] text-dim">Price protection</dt>
              <dd className="mt-5 text-xl font-semibold">Signed and fixed</dd>
              <p className="mt-2 text-sm leading-relaxed text-dim">A quote holds for 30 seconds, then refreshes.</p>
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

        <section id="counter" className="section-reveal mx-auto grid w-full max-w-[1280px] scroll-mt-20 gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[.85fr_1.15fr] lg:py-28">
          <div>
            <h2 className="display max-w-[10ch] text-[clamp(2.5rem,5vw,4.6rem)]">Invite access. Testnet stakes.</h2>
            <p className="mt-5 max-w-[40ch] leading-relaxed text-dim">
              Building is open to explore. A saved invite code is checked when you request a quote.
            </p>
          </div>
          <InviteForm />
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

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-5 px-4 py-8 sm:px-6">
          <HyperflipBrand />
          <p className="mono text-[10px] uppercase tracking-[.12em] text-dim">HyperEVM testnet beta</p>
          <div className="mono flex gap-5 text-[10px] uppercase tracking-[.1em] text-dim">
            <a href="https://hyperliquid.xyz" className="transition-colors hover:text-fg">Hyperliquid</a>
            <a href="https://hyperliquid.gitbook.io/hyperliquid-docs" className="transition-colors hover:text-fg">Core docs</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
