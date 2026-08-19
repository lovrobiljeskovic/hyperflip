import { InviteForm } from "./invite-form";

const wordmark = (
  <span className="flex items-center gap-2 font-mono text-sm tracking-tight text-fg">
    <span className="inline-block size-2.5 rounded-[2px] bg-accent" aria-hidden />
    parlay
  </span>
);

function SideChip({ side }: { side: "YES" | "NO" }) {
  const yes = side === "YES";
  return (
    <span
      className={`inline-flex w-10 justify-center rounded-[4px] border px-1 py-0.5 font-mono text-[11px] uppercase ${
        yes ? "border-yes/50 text-yes" : "border-no/50 text-no"
      }`}
    >
      {side}
    </span>
  );
}

/* Live-style preview of the builder ticket. Sample pricing, consistent with
   the worked example in the math section. */
function TicketPreview() {
  const legs = [
    { side: "YES" as const, market: "BTC above 64,000 on Aug 21?", odds: "1.18x" },
    { side: "NO" as const, market: "HYPE above 60 by Friday?", odds: "1.75x" },
    { side: "YES" as const, market: "ETH below 1,850 on Aug 21?", odds: "1.61x" },
  ];
  return (
    <div className="rounded-card border border-line bg-panel p-5 text-[13px] shadow-[0_24px_60px_rgba(4,10,12,0.5)]">
      <div className="flex items-center justify-between">
        <span className="font-medium">Parlay ticket</span>
        <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[11px] text-dim">
          testnet
        </span>
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {legs.map((leg) => (
          <li key={leg.market} className="flex items-center gap-3">
            <SideChip side={leg.side} />
            <span className="flex-1 text-fg">{leg.market}</span>
            <span className="font-mono text-dim">{leg.odds}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 border-t border-line pt-4 flex flex-col gap-2 font-mono">
        <div className="flex justify-between">
          <span className="text-dim">Stake</span>
          <span>100.00 USDC</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">Combined implied</span>
          <span>30.0%</span>
        </div>
        <div className="flex justify-between text-base">
          <span className="text-dim">Max payout</span>
          <span className="text-accent">316.20 USDC</span>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-[3px] overflow-hidden rounded-full bg-raised">
          <div className="ttl-bar h-full bg-accent" />
        </div>
        <p className="mt-2 font-mono text-[11px] text-dim">
          quote refreshes every 30s
        </p>
      </div>

      <div
        className="mt-4 rounded-card bg-accent py-2.5 text-center font-medium text-on-accent"
        aria-hidden
      >
        Mint parlay
      </div>
      <p className="mt-3 text-center font-mono text-[11px] text-dim">
        example pricing
      </p>
    </div>
  );
}

function OutcomeRow({
  side,
  label,
  odds,
  pct,
}: {
  side: "YES" | "NO";
  label: string;
  odds: string;
  pct: string;
}) {
  const yes = side === "YES";
  return (
    <li className="flex items-center gap-3 text-sm">
      <SideChip side={side} />
      <span className="flex-1">{label}</span>
      <span className="font-mono text-dim">{odds}</span>
      <span
        className={`w-14 rounded-[4px] border py-1 text-center font-mono text-xs ${
          yes ? "border-yes/50 text-yes" : "border-no/50 text-no"
        }`}
      >
        {pct}
      </span>
    </li>
  );
}

function MarketCard({
  title,
  volume,
  children,
  className = "",
}: {
  title: string;
  volume: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <article
      className={`flex flex-col rounded-card border border-line bg-panel p-5 ${className}`}
    >
      <h3 className="text-[15px] font-medium">{title}</h3>
      <ul className="mt-4 flex flex-1 flex-col gap-3">{children}</ul>
      <p className="mt-5 border-t border-line pt-3 font-mono text-xs text-dim">
        {volume} 24h volume
      </p>
    </article>
  );
}

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
            <h1 className="rise text-4xl font-semibold tracking-tighter md:text-6xl">
              Three legs. One ticket. One payout.
            </h1>
            <p className="rise mt-6 max-w-[46ch] text-base leading-relaxed text-dim [animation-delay:120ms]">
              Combine YES and NO legs across Hyperliquid outcome markets into
              one parlay, priced live off the Core book.
            </p>
            <div className="rise mt-8 flex flex-wrap gap-3 [animation-delay:240ms]">
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
          </div>
          <div className="rise [animation-delay:180ms]">
            <TicketPreview />
          </div>
        </section>

        {/* 2 · markets: asymmetric card trio */}
        <section id="markets" className="scroll-mt-24 border-t border-line py-24">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Live on testnet
          </h2>
          <p className="mt-3 max-w-[60ch] text-dim">
            Sample markets from the beta registry. Every card is a HyperCore
            outcome market you can put on a ticket.
          </p>
          <div className="mt-10 grid gap-4 lg:grid-cols-[1fr_1fr_1.4fr]">
            <MarketCard title="BTC above 64,000 on Aug 21?" volume="$126,262">
              <OutcomeRow side="YES" label="Yes" odds="1.18x" pct="85%" />
              <OutcomeRow side="NO" label="No" odds="5.88x" pct="17%" />
            </MarketCard>
            <MarketCard title="HYPE above 60 by Friday?" volume="$3,351">
              <OutcomeRow side="YES" label="Yes" odds="2.33x" pct="43%" />
              <OutcomeRow side="NO" label="No" odds="1.75x" pct="57%" />
            </MarketCard>
            <MarketCard
              title="ETH below 1,850 on Aug 21?"
              volume="$8,940"
              className="bg-gradient-to-br from-panel to-raised"
            >
              <OutcomeRow side="YES" label="Yes" odds="1.61x" pct="62%" />
              <OutcomeRow side="NO" label="No" odds="2.63x" pct="38%" />
            </MarketCard>
          </div>
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
