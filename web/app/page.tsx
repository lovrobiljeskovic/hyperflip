import Link from "next/link";

import { AppHeader, Mark } from "./app-header";
import { InviteForm } from "./invite-form";
import { HeroSlip, HeroStats, LiveMarketBoard } from "./live-markets";

/* A real sequence — you cannot quote before you pick, or claim before it
   settles — so these carry numbers. */
const steps = [
  {
    n: "01",
    title: "Pick your legs",
    body: "Take YES or NO on any market on the board. Two legs minimum, five maximum.",
  },
  {
    n: "02",
    title: "Take the quote",
    body: "The house prices the whole combination off the live Core book and signs it. The quote holds for 30 seconds, then reprices.",
  },
  {
    n: "03",
    title: "Mint the slip",
    body: "Minting locks the premium and the maximum payout on-chain. Your slip is an NFT you hold until the last leg settles.",
  },
  {
    n: "04",
    title: "Claim",
    body: "Every leg your way pays the full amount in USDC. One leg against you closes the slip.",
  },
];

const settlement = [
  {
    key: "Signed quotes",
    body: "Every premium is an EIP-712 quote signed by the house writer and checked on-chain at mint. No valid signature, no slip.",
  },
  {
    key: "HyperCore settlement",
    body: "Legs are HIP-4 outcome markets that settle on HyperCore. The vault reads final prices from the book itself, not from an oracle we run.",
  },
  {
    key: "Collateral up front",
    body: "The house vault posts the maximum payout at mint, inside per-market exposure caps. Your ceiling is funded before you sign.",
  },
  {
    key: "Self-custody",
    body: "Legs are held as ERC-20 outcome tokens in a non-custodial vault. Winning slips claim USDC straight from the contract.",
  },
];

const faq = [
  {
    q: "What is the overround?",
    a: "Add up both sides of a market and you get more than 100%. That excess is the book's margin. A parlay multiplies its legs, so it multiplies their overround too — which is why the board prints the margin on every market and the quote shows the fair number beside the quoted one.",
  },
  {
    q: "What happens if a leg settles while I am minting?",
    a: "The mint reverts and the builder pulls a fresh quote. You never mint against a leg that has already resolved.",
  },
  {
    q: "Which markets are on the board?",
    a: "A curated registry of HIP-4 outcome markets on the HyperCore testnet book. The board grows through the beta.",
  },
  {
    q: "What does it cost?",
    a: "No platform fee during the beta. Pricing is the house spread over combined implied odds, and you see the full quote before you sign.",
  },
];

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mono text-[10px] uppercase tracking-[0.16em] text-dim">{children}</p>
  );
}

export default function Home() {
  return (
    <div className="paper flex min-h-full flex-col">
      <AppHeader ground="paper" />

      <main className="mx-auto w-full max-w-6xl px-6">
        {/* 1 · hero — the slip prints itself */}
        <section className="grid items-center gap-14 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-[72px]">
          <div>
            <HeroStats />
            <h1 className="display mt-[22px] text-[clamp(2.6rem,7vw,4.75rem)] leading-[0.9] tracking-[-0.04em]">
              Two to five legs.
              <br />
              One slip.
              <br />
              One payout.
            </h1>
            <p className="mt-6 max-w-[44ch] text-[17px] leading-[1.6] text-[#4A2B23]">
              Take YES or NO across Hyperliquid outcome markets and put them on
              a single ticket. The house prices the combination off the live
              Core book, signs it, and posts the payout before you mint.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="#counter"
                className="mono bg-[var(--ink)] px-[26px] py-[14px] text-[11px] uppercase tracking-[0.1em] text-[var(--stock)] transition-transform active:scale-[0.98] hover:-translate-y-[1px]"
              >
                Get an invite code
              </a>
              <a
                href="#writing"
                className="mono border border-[var(--ink)] px-[26px] py-[14px] text-[11px] uppercase tracking-[0.1em] transition-colors hover:bg-[color-mix(in_srgb,var(--ink)_8%,transparent)]"
              >
                How a slip settles
              </a>
            </div>
          </div>
          <HeroSlip />
        </section>

        <div className="perf" />

        {/* 2 · the board */}
        <section id="board" className="scroll-mt-20 py-20">
          <FieldLabel>Selections</FieldLabel>
          <h2 className="display mt-3 text-[clamp(1.9rem,4vw,2.75rem)]">
            The board
          </h2>
          <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-dim">
            Every market you can put on a slip, priced off the live HyperCore
            book. <span className="text-fg">Book</span> is the overround: how
            far both sides sum past 100%, which is what the market charges to
            take the other side of you. The testnet book quotes both sides
            flat, so it prints 0.0% until real makers show up.
          </p>
          <LiveMarketBoard />
        </section>

        <div className="perf" />

        {/* 3 · writing a slip — genuine sequence, hence the numbering */}
        <section id="writing" className="scroll-mt-20 py-20">
          <FieldLabel>Procedure</FieldLabel>
          <h2 className="display mt-3 text-[clamp(1.9rem,4vw,2.75rem)]">
            Writing a slip
          </h2>
          <ol className="mt-10 grid gap-px bg-[var(--hair)] sm:grid-cols-2">
            {steps.map((step) => (
              <li key={step.n} className="bg-[var(--stock)] p-6">
                <span className="mono text-[11px] tracking-widest text-dim">
                  {step.n}
                </span>
                <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 max-w-[42ch] text-[15px] leading-relaxed text-dim">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <div className="perf" />

        {/* 4 · the book — the margin, printed */}
        <section id="book" className="scroll-mt-20 py-20">
          <FieldLabel>Stake and return</FieldLabel>
          <h2 className="display mt-3 text-[clamp(1.9rem,4vw,2.75rem)]">
            The book, printed
          </h2>
          <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-dim">
            A three-leg slip at 100 USDC, priced end to end. Fair odds are what
            the legs multiply out to. Quoted is what the house pays. The gap
            between them is the whole business.
          </p>
          <dl className="mono mt-12 grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-dim">Legs</dt>
              <dd className="mt-2 text-[clamp(2rem,5vw,3.25rem)] leading-none">3</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-dim">
                Combined implied
              </dt>
              <dd className="mt-2 text-[clamp(2rem,5vw,3.25rem)] leading-none">30.0%</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-dim">Fair</dt>
              <dd className="mt-2 text-[clamp(2rem,5vw,3.25rem)] leading-none text-dim">
                3.33x
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-dim">Quoted</dt>
              <dd className="mt-2 text-[clamp(2rem,5vw,3.25rem)] leading-none">3.16x</dd>
            </div>
          </dl>
          <div className="mt-12 max-w-[62ch] border-l-[3px] border-[var(--stamp)] pl-5">
            <p className="text-[15px] leading-relaxed">
              On a 100 USDC stake that is{" "}
              <span className="mono">316.20</span> against a fair{" "}
              <span className="mono">333.00</span>. The house keeps{" "}
              <span className="mono font-semibold">16.80</span>, and every
              quote shows you both numbers before you sign.
            </p>
          </div>
        </section>

        <div className="perf" />

        {/* 5 · settlement */}
        <section className="py-20">
          <FieldLabel>Settlement</FieldLabel>
          <h2 className="display mt-3 text-[clamp(1.9rem,4vw,2.75rem)]">
            Where the money sits
          </h2>
          <div className="mt-10 flex flex-col">
            {settlement.map((row) => (
              <div
                key={row.key}
                className="grid gap-2 border-t border-line py-7 md:grid-cols-[260px_1fr]"
              >
                <h3 className="mono text-[12px] uppercase tracking-wide">{row.key}</h3>
                <p className="max-w-[62ch] text-[15px] leading-relaxed text-dim">
                  {row.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <div className="perf" />

        {/* 6 · the stub — positions preview */}
        <section className="py-20">
          <FieldLabel>Your stubs</FieldLabel>
          <h2 className="display mt-3 text-[clamp(1.9rem,4vw,2.75rem)]">
            Every slip, tracked
          </h2>
          <p className="mt-4 max-w-[58ch] text-[15px] leading-relaxed text-dim">
            Positions reads straight from chain events — which legs landed,
            which one closed the slip, what is claimable. Sample rows shown.
          </p>
          <div className="mt-8 overflow-x-auto bg-[var(--paper)] shadow-[6px_8px_0_rgba(36,21,18,0.14)]">
            <table className="w-full min-w-[560px] text-left">
              <thead className="mono text-[10px] uppercase tracking-wide text-dim">
                <tr className="border-b border-line">
                  <th className="px-5 py-3 font-normal">Slip</th>
                  <th className="px-5 py-3 font-normal">Legs</th>
                  <th className="px-5 py-3 font-normal">Stake</th>
                  <th className="px-5 py-3 font-normal">Status</th>
                  <th className="px-5 py-3 text-right font-normal">Payout</th>
                </tr>
              </thead>
              <tbody className="mono text-[13px]">
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
                  <td className="px-5 py-4 text-no">Closed</td>
                  <td className="px-5 py-4 text-right text-dim">0.00</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div className="perf" />

        {/* 7 · the counter — invite */}
        <section id="counter" className="scroll-mt-20 py-20">
          <div className="mx-auto max-w-xl">
            <FieldLabel>The counter</FieldLabel>
            <h2 className="display mt-3 text-[clamp(1.9rem,4vw,2.75rem)]">
              Closed beta, testnet only
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-dim">
              Quoting is invite-gated. Save your code once and it rides along
              with every quote you request.
            </p>
            <div className="mt-8">
              <InviteForm />
            </div>
          </div>
        </section>

        <div className="perf" />

        {/* 8 · faq */}
        <section className="py-20">
          <FieldLabel>Small print</FieldLabel>
          <h2 className="display mt-3 text-[clamp(1.9rem,4vw,2.75rem)]">
            Questions
          </h2>
          <div className="mt-8 flex max-w-3xl flex-col divide-y divide-line border-y border-line">
            {faq.map((item) => (
              <details key={item.q} className="group py-5">
                <summary className="flex items-center justify-between gap-4 text-[16px] font-semibold">
                  {item.q}
                </summary>
                <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-dim">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="mt-auto">
        <div className="perf" />
        <div className="mono mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-[11px] uppercase tracking-wide text-dim">
          <Link href="/" className="flex items-center gap-[10px] normal-case">
            <Mark className="h-[15px] w-[26px]" />
            <span className="display text-[16px] [font-variation-settings:'wght'_700] tracking-[-0.035em]">
              overround
            </span>
          </Link>
          <p>HyperEVM testnet beta · not investment advice</p>
          <div className="flex gap-5">
            <a href="https://hyperliquid.xyz" className="transition-colors hover:text-fg">
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
    </div>
  );
}
