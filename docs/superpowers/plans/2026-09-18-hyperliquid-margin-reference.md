# Hyperliquid portfolio margin cross-reference — September 18, 2026

Documentation research only. No chain queries, account-mode changes, trading or
deployment. This compares published rules, not an audited implementation of
HyperCore's risk engine. User requested this before deciding hedge allocation.
Subsequent decision: after the [calculation comparison](../../evidence/2026-09-18-margin-calculation/README.md),
the user accepted the conservative one-leg bound for the first version. The
research and provisional recommendations below describe the preceding review.

## Published mechanism

Hyperliquid combines spot/perp account equity, oracle-valued collateral, LTV
limits, automatic borrowing, interest and maintenance/liquidation checks. Its
current PM page gives HYPE/BTC LTVs of 65%/50% and a liquidation trigger above a
0.95 portfolio margin ratio. Borrowing capacity depends on collateral quantity,
oracle price and LTV, subject to caps. These are venue parameters, not proposed
Hyperflip parameters. [Portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin).

The FAQ distinguishes borrowing/trading capacity from funds that can leave the
account; borrowed buying power cannot be withdrawn. It also warns that exhausted
lending supply can prevent withdrawal of supplied assets.
[PM FAQ](https://hyperliquid.gitbook.io/hyperliquid-docs/support/faq/portfolio-margin).

General perp rules permit unrealized-PnL withdrawals subject to both initial
margin and a notional-based transfer requirement. Therefore our ban on withdrawals
created solely by unsettled hedge credit is deliberately stricter, not a copy of
a universal Hyperliquid restriction.
[Margining](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining).

Published PM eligibility lists HYPE, BTC, USDC and USDT. Standard mode keeps
balances separated and is recommended in the docs for automated makers/builders.
[Account modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes).
Unified/PM balances and holds are reported in spot clearinghouse state; avoid
summing those with per-DEX views as though they were separate assets.
[Spot API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot).

HIP-4 describes fully collateralized bounded outcomes, automatic fractional
settlement and composition with PM. It does not specify a margin offset for
custom EVM parlays. Absence from the eligibility list is not a claim that outcome
trading and PM cannot coexist.
[HIP-4](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-4-outcome-markets).

## Application to our design — analysis and recommendations

| Principle to reuse | Hyperflip treatment |
| --- | --- |
| Account-wide risk | Aggregate each maker's ticket obligations and confirmed hedges; never reuse one holding independently for several tickets. |
| Conservative asset eligibility | Require vault custody and verified net payoff; no price-only or agent-policy-only collateral credit. |
| Separate capacity measures | Keep trade capacity, pending spend, claim-ready EVM cash and withdrawable cash distinct. |
| Action-specific checks | Evaluate mint, hedge submission, hedge disposal, withdrawal and payout against their appropriate post-action and intermediate states. |
| Operational limits | Make position/exposure limits and liquidity buffers explicit; numbers require our own evidence. |

Do not transplant native auto-borrowing, volatile collateral LTVs, or liquidation
thresholds into the first MarginVault. Our accepted design aims to preserve
coverage without relying on selling assets into a potentially empty event book.
Native PM cannot be assumed to recognize the ParlayVault's externally created
obligations. Enabling an account mode would not prove our tickets are backed.

The central calculation must remain specific to our payoff rules. As a conceptual
terminal-state reference, cash required is the nonnegative maximum across allowed
outcomes of total maker liabilities minus confirmed conservative net hedge
proceeds. This is not the complete operational invariant: pending actions,
unexpired signed quotes, void transitions, transfer timing and claim liquidity
also matter. An efficient on-chain bound must be proved no smaller than that
reference over the states it models.

Our binary illustration remains 80 maker liability minus 50 net hedge payoff =
30 uncovered cash when both legs win. The hedge's market value can change without
changing that conditional terminal coverage. Purchase cost still reduces cash;
coverage is conditional, and fees/custody/settlement assumptions must hold.

One assigned leg per ticket is our proposed conservative computational shortcut,
not a rule derived from Hyperliquid PM. Reconsider allocation against enumerated
small portfolios before committing to a bound. Do not infer correlation offsets
or mutually exclusive outcomes from names alone.

For S9, prefer an explicitly controlled account mode with no auto-borrowing or
automatic lending of claim funds; standard mode is the candidate. Verify its
compatibility with the guarded CoreWriter path later. This is a recommendation,
not approval to switch any existing account. Preserve the existing HedgeProbe.

## Evidence limits and next work

Directly opened official pages differ from stale search snippets. Official pages
also disagree: PM overview lists a $25M account-value ceiling, FAQ lists $5M;
their descriptions of liquidation execution differ. Do not copy those operational
parameters into implementation without reconciling them. The reviewed pages do
not expose the complete engine algorithm for pending-order reservations or prove
an asynchronous EVM/Core spend invariant for our vault.

Retain the accepted policies. Next specify a small-portfolio reference calculation,
compare the proposed assignment bound, and settle remaining sizing/account-mode
and buffer choices before S9/S10. Runtime implementation remains deferred by the
user. No new protocol dependency or native PM enablement is needed for this review.
