import Link from "next/link";

import { fetchMids } from "@/lib/info";
import { fetchMarketBoard, onlySports } from "@/lib/writer";
import { LandingHeader } from "./landing-header";
import { appHref } from "@/lib/site";
import { HyperflipBrand } from "./brand";
import { InviteForm } from "./invite-form";
import { HeroSlip, LiveMarketBoard, LiveMarketRail, type BoardSnapshot } from "./live-markets";
import { PurrCoinToss } from "./purr-coin-toss";
import { ScrollLink } from "./scroll-link";

const steps = [
  { n: "01", title: "Pick the markets", body: "Take a side on two to ten live sports markets." },
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
    a: "The live market probabilities are multiplied together, then the house edge is applied. Fair and quoted returns are both shown before you mint.",
  },
  {
    q: "What if a leg settles while I mint?",
    a: "The mint reverts and the builder requests a fresh quote. A settled leg cannot enter a new slip.",
  },
  {
    q: "Which markets are available?",
    a: "A curated registry of HIP-4 sports markets on the HyperCore testnet book, rotated nightly. Legs from the same game cannot share a slip.",
  },
  {
    q: "What does it cost?",
    a: "Hyperflip includes a house margin in quoted odds. Pricing may change during beta; the app shows the breakdown before you mint.",
  },
];

const discordIcon = "M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z";

const telegramIcon = "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z";
const xIcon = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

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
              Flip markets. Stack outcomes.
            </h1>
            <p className="mt-6 max-w-[38ch] text-[17px] leading-relaxed text-dim">
              Combine live HyperCore outcomes into one on-chain slip with one locked payout.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={appHref()}
                prefetch={false}
                className="rounded-[8px] bg-accent px-6 py-3.5 font-semibold text-on-accent transition-transform active:scale-[.98] motion-reduce:transition-none"
              >
                Start building
              </Link>
              <ScrollLink
                to="board"
                className="rounded-[8px] border border-line px-6 py-3.5 font-medium text-fg transition-colors hover:border-dim"
              >
                View markets
              </ScrollLink>
            </div>
          </div>
          <div className="hero-enter hero-enter-late min-w-0">
            <HeroSlip board={board} />
          </div>
        </section>

        <section id="board" className="section-reveal mx-auto w-full max-w-[1280px] scroll-mt-20 px-4 py-20 sm:px-6 lg:py-28">
          <h2 className="display max-w-[12ch] text-[clamp(2.5rem,5vw,4.6rem)]">Markets, moving now.</h2>
          <p className="mt-5 max-w-[54ch] text-base leading-relaxed text-dim">
            Market odds before Hyperflip’s margin. Preview the busiest priced sports markets, then open the app for a signed quote.
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
              See your stake, quoted odds, and maximum payout before you sign.
            </p>
          </div>
          <dl className="grid content-start gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-2">
            <div className="bg-panel p-7 sm:col-span-2">
              <dt className="mono text-[10px] uppercase tracking-[.14em] text-dim">How pricing works</dt>
              <dd className="display mt-5 text-5xl text-accent">Know your quote.</dd>
              <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-dim">
                Our house margin is included in the quoted odds. Inspect the adjustment and your final payout in the app. Pricing may change during beta.
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
              <dd className="mt-5 text-xl font-semibold">Signed and fixed</dd>
              <p className="mt-2 text-sm leading-relaxed text-dim">Each quote shows its expiry. Minted slips retain their locked terms.</p>
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
              Explore the app without connecting a wallet. Get an invite by email, then enter your code in the app when you request a quote.
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
          <div className="mono flex flex-wrap items-center gap-5 text-[10px] uppercase tracking-[.1em] text-dim">
            <a href="mailto:contact@hyperflip.xyz" className="normal-case transition-colors hover:text-fg">contact@hyperflip.xyz</a>
            <a href="https://hyperliquid.xyz" className="transition-colors hover:text-fg">Hyperliquid</a>
            <a href="https://hyperliquid.gitbook.io/hyperliquid-docs" className="transition-colors hover:text-fg">Core docs</a>
            <span className="h-4 w-px bg-line" aria-hidden />
            <a href="https://discord.gg/wMgeAcqXz" aria-label="Discord" title="Join our Discord" className="transition-colors hover:text-fg">
              <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden="true"><path d={discordIcon} /></svg>
            </a>
            <span role="img" aria-label="Telegram (coming soon)" title="Telegram · soon" className="transition-colors hover:text-fg">
              <svg viewBox="0 0 24 24" className="size-4 fill-current"><path d={telegramIcon} /></svg>
            </span>
            <a href="https://x.com/hyperflip_xyz" aria-label="Hyperflip on X (Twitter)" title="Follow Hyperflip on X" className="transition-colors hover:text-fg">
              <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden="true"><path d={xIcon} /></svg>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
