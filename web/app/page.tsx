import { InviteForm } from "./invite-form";
import { HeroStats, HeroTicket, LiveMarketBoard } from "./live-markets";

const wordmark = (
  <span className="flex items-center gap-2 font-mono text-sm tracking-tight text-fg">
    <span className="inline-block size-2.5 rounded-[2px] bg-accent" aria-hidden />
    parlay
  </span>
);

const HEADLINE_WORDS = ["Three", "legs.", "One", "ticket.", "One", "payout."];

const steps = [
  {
    n: "1",
    title: "Pick your legs",
    body: "Choose YES or NO on any listed outcome market. Two to five legs per ticket.",
  },
  {
    n: "2",
    title: "Quote and mint",
    body: "The house writer prices the combination off the live Core book and signs your quote. Minting locks it on-chain.",
  },
  {
    n: "3",
    title: "Settle and claim",
    body: "When every leg resolves your way, claim the full payout in USDC. One losing leg ends the ticket.",
  },
];

const trust = [
  {
    key: "Signed quotes",
    body: "Every premium is an EIP-712 quote signed by the house writer and verified on-chain at mint. No valid signature, no ticket.",
  },
  {
    key: "HyperCore settlement",
    body: "Legs are HIP-4 outcome markets that settle on HyperCore. The vault reads final prices straight from the book, not from an oracle we run.",
  },
  {
    key: "Self-custody",
    body: "Legs are held as ERC-20 outcome tokens in a non-custodial vault. Winning tickets claim USDC directly from the contract.",
  },
];

const faq = [
  {
    q: "What backs the payout?",
    a: "The house vault collateralises every quoted ticket at mint, within per-market exposure caps enforced by the writer. Your max payout is locked before you sign.",
  },
  {
    q: "What happens if a leg settles while I mint?",
    a: "The mint reverts and the builder fetches a fresh quote. You never mint against an already-settled leg.",
  },
  {
    q: "Which markets are listed?",
    a: "A curated registry of HIP-4 outcome markets on the HyperCore testnet book. The list grows through the beta.",
  },
  {
    q: "What does it cost?",
    a: "No platform fee in beta. Pricing includes the house spread over combined implied odds, and you see the full quote before you mint.",
  },
];

export default function Home() {
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-line bg-ink/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          {wordmark}
          <nav className="flex items-center gap-6 text-sm">
            <a href="#markets" className="hidden text-dim transition-colors hover:text-fg sm:block">
              Markets
            </a>
            <a href="#how" className="hidden text-dim transition-colors hover:text-fg sm:block">
              How it works
            </a>
            <a href="#faq" className="hidden text-dim transition-colors hover:text-fg sm:block">
              FAQ
            </a>
            <a href="/build" className="hidden text-dim transition-colors hover:text-fg sm:block">
              Build
            </a>
            <a href="/positions" className="hidden text-dim transition-colors hover:text-fg sm:block">
              Positions
            </a>
            <a
              href="#access"
              className="rounded-card bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-transform active:scale-[0.98] hover:opacity-90"
            >
              Get access
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6">
        {/* 1 · hero: split text + live ticket */}
        <section className="grid items-center gap-14 pb-24 pt-16 md:pt-20 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <h1 className="text-4xl font-semibold tracking-tighter md:text-6xl">
              {HEADLINE_WORDS.map((word, i) => (
                <span key={word + i}>
                  <span
                    className="word-in"
                    style={{ animationDelay: `${i * 80}ms` }}
                  >
                    {word}
                  </span>
                  {i < HEADLINE_WORDS.length - 1 ? " " : null}
                </span>
              ))}
            </h1>
            <p className="rise mt-6 max-w-[46ch] text-base leading-relaxed text-dim [animation-delay:360ms]">
              Combine YES and NO legs across Hyperliquid outcome markets into
              one parlay, priced live off the Core book.
            </p>
            <div className="rise mt-8 flex flex-wrap gap-3 [animation-delay:480ms]">
              <a
                href="#access"
                className="rounded-card bg-accent px-6 py-3 text-sm font-medium text-on-accent transition-transform active:scale-[0.98] hover:opacity-90"
              >
                Get access
              </a>
              <a
                href="#how"
                className="rounded-card border border-line px-6 py-3 text-sm text-fg transition-colors hover:border-dim"
              >
                How it works
              </a>
            </div>
            <div className="rise mt-10 border-t border-line pt-4 [animation-delay:600ms]">
              <HeroStats />
            </div>
          </div>
          <div className="rise [animation-delay:240ms]">
            <HeroTicket />
          </div>
        </section>

        {/* 2 · markets: asymmetric card trio */}
        <section id="markets" className="scroll-mt-24 border-t border-line py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Live on testnet
          </h2>
          <p className="mt-3 max-w-[60ch] text-dim">
            The beta registry, priced off the live HyperCore book. Every card
            is an outcome market you can put on a ticket.
          </p>
          <LiveMarketBoard />
        </section>

        {/* 3 · how it works: numbered vertical steps */}
        <section id="how" className="scroll-mt-24 border-t border-line py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            How it works
          </h2>
          <ol className="mt-10 flex flex-col">
            {steps.map((step) => (
              <li
                key={step.n}
                className="grid gap-4 border-t border-line py-8 first:border-t-0 md:grid-cols-[80px_1fr_2fr] md:items-baseline"
              >
                <span className="font-mono text-3xl text-accent">{step.n}</span>
                <h3 className="text-lg font-medium">{step.title}</h3>
                <p className="max-w-[55ch] text-dim">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* 4 · the math: full-width stat strip */}
        <section id="math" className="scroll-mt-24 border-t border-line py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            The math, upfront
          </h2>
          <p className="mt-3 max-w-[60ch] text-dim">
            The worked example from the ticket above. Fair combined odds are
            3.33x; the quote includes the house spread.
          </p>
          <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-10 font-mono md:grid-cols-5">
            <div>
              <dt className="text-xs text-dim">Legs</dt>
              <dd className="mt-2 text-3xl md:text-4xl">3</dd>
            </div>
            <div>
              <dt className="text-xs text-dim">Combined implied</dt>
              <dd className="mt-2 text-3xl md:text-4xl">30.0%</dd>
            </div>
            <div>
              <dt className="text-xs text-dim">Quoted multiplier</dt>
              <dd className="mt-2 text-3xl md:text-4xl">3.16x</dd>
            </div>
            <div>
              <dt className="text-xs text-dim">Stake</dt>
              <dd className="mt-2 text-3xl md:text-4xl">100.00</dd>
            </div>
            <div>
              <dt className="text-xs text-dim">Max payout</dt>
              <dd className="mt-2 text-3xl text-accent md:text-4xl">316.20</dd>
            </div>
          </dl>
        </section>

        {/* 5 · trust: keyed definition rows */}
        <section className="border-t border-line py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            On-chain where it counts
          </h2>
          <div className="mt-10 flex flex-col gap-8 md:gap-10">
            {trust.map((row) => (
              <div key={row.key} className="grid gap-2 md:grid-cols-[240px_1fr]">
                <h3 className="font-medium text-accent">{row.key}</h3>
                <p className="max-w-[65ch] text-dim">{row.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 6 · positions preview: table idiom */}
        <section className="border-t border-line py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Every ticket, tracked
          </h2>
          <p className="mt-3 max-w-[60ch] text-dim">
            Your positions page reads straight from chain events. Sample data
            shown.
          </p>
          <div className="mt-10 overflow-x-auto rounded-card border border-line bg-panel">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="font-mono text-xs text-dim">
                <tr className="border-b border-line">
                  <th className="px-5 py-3 font-normal">Ticket</th>
                  <th className="px-5 py-3 font-normal">Legs</th>
                  <th className="px-5 py-3 font-normal">Stake</th>
                  <th className="px-5 py-3 font-normal">Status</th>
                  <th className="px-5 py-3 text-right font-normal">Payout</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                <tr className="border-b border-line">
                  <td className="px-5 py-4">#0012</td>
                  <td className="px-5 py-4">3</td>
                  <td className="px-5 py-4">100.00</td>
                  <td className="px-5 py-4 text-dim">2 of 3 settled</td>
                  <td className="px-5 py-4 text-right">316.20</td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-5 py-4">#0009</td>
                  <td className="px-5 py-4">4</td>
                  <td className="px-5 py-4">50.00</td>
                  <td className="px-5 py-4 text-yes">Won</td>
                  <td className="px-5 py-4 text-right text-yes">812.40</td>
                </tr>
                <tr>
                  <td className="px-5 py-4">#0007</td>
                  <td className="px-5 py-4">2</td>
                  <td className="px-5 py-4">25.00</td>
                  <td className="px-5 py-4 text-no">Lost</td>
                  <td className="px-5 py-4 text-right text-dim">0.00</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* 7 · access: centered form */}
        <section id="access" className="scroll-mt-24 border-t border-line py-24">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Closed beta on HyperEVM testnet
            </h2>
            <p className="mt-3 text-dim">
              Quoting is invite-gated. Save your code once and it rides along
              with every quote request.
            </p>
            <div className="mt-8">
              <InviteForm />
            </div>
          </div>
        </section>

        {/* 8 · faq: accordion */}
        <section id="faq" className="scroll-mt-24 border-t border-line py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            FAQ
          </h2>
          <div className="mt-8 flex max-w-3xl flex-col divide-y divide-line border-y border-line">
            {faq.map((item) => (
              <details key={item.q} className="group py-5">
                <summary className="flex items-center justify-between gap-4 text-base font-medium">
                  {item.q}
                </summary>
                <p className="mt-3 max-w-[65ch] text-dim">{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-dim">
          {wordmark}
          <p>HyperEVM testnet beta. Not investment advice.</p>
          <div className="flex gap-5">
            <a
              href="https://hyperliquid.xyz"
              className="transition-colors hover:text-fg"
            >
              Hyperliquid
            </a>
            <a
              href="https://hyperliquid.gitbook.io/hyperliquid-docs"
              className="transition-colors hover:text-fg"
            >
              HyperCore docs
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
