# Hedge execution policy — input to S9, September 18, 2026

Status: the user agreed to price-capped execution, confirmed partial fills and
continued backing for remaining exposure. The separately approved September 18
testnet spike passed full/partial/no-fill IOC and discarded-response recovery;
see [execution evidence](../../evidence/2026-09-18-ioc-execution/README.md).
The policy below remains an implementation design covering segments 1 through 3,
not a completed MarginVault specification or open-ended authority to trade/deploy.

Segment 2 is underway: the user agreed to the HIP-4 order book as the live
pricing source, the three pause conditions below, and a two-second freshness
limit for strict testnet evaluation. Size-aware ask-depth pricing is also agreed.
The user subsequently approved the explicit testnet demo exception below,
including during live games; production and strict validation retain book rules.
Spread limits of both <= 0.05 USDC and <= 10% of midpoint are agreed for strict
testnet evaluation. Quote lifetimes of 30 seconds for the testnet demo and 10
seconds for strict testnet evaluation are agreed. Hedge sizing remains undecided; freshness
and spread limits are not validated for production.
Then discuss margin accounting. Finalize S9 after
those decisions; retain the roadmap's S10 adversarial review before money-path
implementation, S11 simulation, S12–S15 contract/integration work, S16 live proof.
S8b public host/preview smoke remains a separate pending rollout.

## Kickoff decision

The user has observed orders during live HIP-4 games on OutcomeXYZ. Treat live
order placement as established by user observation; a presumed universal kickoff
halt is not a blocker for S9. Our own kickoff order/cancel trace was not collected.
Preserve that evidence limitation without requiring another dedicated kickoff test.
Exercise in-play execution during the later authorized hedge integration test.
No mainnet probe is needed or authorized.

## First execution policy

1. Start with one selected outcome and one outstanding hedge attempt per maker's
   dedicated Core account. Aggregate the desired position for that outcome and
   subtract already confirmed holdings; do not independently buy the same cover
   for every ticket. Portfolio allocation/target calculation belongs to S9.
2. Use a buy limit with **IOC** (immediate or cancel), an explicit quantity and
   maximum price. IOC permits partial execution and cancels the unmatched part.
   This avoids a normal resting-order/repricing loop. Keep maximum total spend
   including trading fees bounded; skip uneconomic/below-minimum orders instead
   of increasing the budget to force execution. Respect asset size/tick rules.
   [Documented order semantics](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#place-an-order).
3. Persist the intent and unique client order ID before sending: maker account,
   asset/side, quantity, limit price, spend cap, signing nonce/deadline, and baseline
   holdings/cash/holds with read times. Reuse the existing journal/persistence
   patterns. No key or private RPC URL belongs in the journal.
4. Reconcile the order response, fills and actual Core holdings before granting
   hedge credit. Inspect per-order errors even when the outer API status is `ok`.
   Successful signing/submission/EVM receipt does not establish a fill. The spike's
   partial IOC reported `filled` despite buying only 5/10: use actual fills and
   balance deltas for quantity, not the status label. For IOC,
   require terminal order status and consistent holdings/holds before declaring
   the attempt complete; an unexpected resting order needs cancellation and
   reconciliation. The documented API can query status using a client order ID.
   [Status lookup](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid).
5. Full fill: recognize verified holdings. Partial fill: recognize only the
   confirmed portion. Rejection/no fill: no added hedge credit. Timeout, missing
   order, inconsistent reads or restart: leave the attempt unresolved and block
   another attempt from that maker account until reconciled. A zero hold alone
   does not prove no fill or no delayed execution. A client order ID is a lookup
   handle, not assumed idempotency; never blindly resend an uncertain order.
6. No automatic repricing or repeated attempts in the first version. Once an
   attempt is reconciled, a later explicit decision can use fresh prices and the
   remaining quantity. Persist pending state across restarts. Reconcile any
   settlement during the attempt against net USDC credit rather than treating
   failed/pruned token reads as zero holdings.

One outstanding attempt per account intentionally limits throughput and makes
balance attribution manageable. Revisit concurrency only after measured need.
It still requires excluding unrelated trading/transfers from that account during
an attempt and handling asynchronous settlement explicitly.

## What we reuse and what is not yet verified

- `tools/hip4.py` and the existing Python SDK demonstrated the contract-agent
  path. Reuse the signing approach; do not build another signer or introduce an
  execution vendor. The helper's outer-status exit code is not sufficient order
  validation. A durable worker should not inherit that shortcut.
- `src/CoreConstants.sol` already has order/cancel encoders and `TIF_IOC=3`.
  Direct CoreWriter buys/cancels and agent fills were tested. The September 18
  spike additionally demonstrated full/partial/no-fill IOC and fresh-process
  recovery by client ID after intentionally discarding the full-fill response.
  Its bounded runner is not a production worker or a contract-enforced spend cap.
- `writer/src/infoApi.ts` walks book depth for quote pricing. Reuse its parsing
  approach, but a fixed quote-depth threshold is not proof that the whole hedge
  can execute under its price cap. Do not use a last-trade fallback as executable
  liquidity. A book snapshot estimates execution; only actual fills establish it.
- `keeper/src/core814.ts`, the OutcomeVault two-phase flow and existing journal
  utilities provide read/recovery patterns. Current `ExposureBook` is a quote
  reservation/risk-cap mechanism, not a margin ledger.

## Required boundary with segment 3

**Backing must remain sufficient while the order is pending.** Sending a buy
can spend cash before shares are confirmed. Reserve its maximum possible spend
before submission and exclude holds/pending spend from free cash without
double-counting the same reservation. With no provisional hedge credit, the
first version needs sufficient spare funds for that interval; otherwise skip.
The S9 invariant must verify every partial-fill/spend state, not only completion.

API-agent access is an execution mechanism, not proof of contract-enforced spend
limits. The user chose guarded CoreWriter execution from each maker's MarginVault
for collateral-bearing accounts, as detailed below. S9 must constrain spending
and subsequent disposal of credited holdings. Do not grant on-chain relief on
the strength of an off-chain agent policy alone.

Credit uses conservative **net** scenario payoff. Overnight outcome 19467 paid
10 gross minus 0.014 USDC settlement fee. Do not count 100 winning shares as a
guaranteed 100 USDC net or hardcode that account's observed fee as universal.
Trading fees consume the spend budget; settlement fees affect eventual hedge
payoff. Pending cash, holdings and settlement credit must never be counted twice.
See [overnight evidence](../../s8a-testnet-evidence.md).

## Acceptance checks for the eventual implementation

Use the existing test tooling; no new framework. Cover: full fill, partial fill
with unmatched remainder canceled, empty book, price/budget cap, per-order
rejection inside outer `ok`, rounding/minimum size, timeout after execution,
restart before response, stale/missing status, and settlement while unresolved.
Assert no duplicate attempt, no excess spend, no optimistic credit, and retained
backing in every intermediate state. A caller must not bypass these restrictions.

After S9/S10 and simulation pass, run one separately authorized bounded testnet
integration through the selected execution path. A supplied counterparty proves
mechanics only; record organic available depth separately. No new deployment,
funding or service change was required for the separate approved September 18
spike; it split existing Core USDC into shares and placed five bounded orders.
That controlled spike does not replace the eventual vault integration proof.

## Live pricing source — agreed September 18

For production and strict execution/risk validation, use the HIP-4 order book
as the live pricing reference. No pregame house-price or `spotPx` fallback during
live games in those paths. The user accepts temporary unavailability
of new quotes containing a leg whose book cannot support trustworthy pricing.
Existing accepted tickets retain their agreed payouts. This is a policy decision;
no runtime/configuration change has been made to enforce it yet.

### Testnet demo exception — subsequently agreed September 18

Keep the testnet app usable despite unreliable or empty books. Prefer a usable
HIP-4 book; when unavailable, permit a valid `spotPx` or an explicitly configured
demo price, including during live games. A pregame prior may supply that demo
price, but it must not be presented as tracking the live game. Invalid reads or
known placeholder values must not silently become valid fallback prices.

Identify fallback quotes visibly as **Testnet fallback pricing** and retain
their actual source in quote evidence. This is a testnet-only exception for app
flows such as quoting, minting and settlement; it does not count as proof of live
market pricing, available hedge liquidity, or passing strict book checks.

Strict testnet execution/risk validation still exercises freshness, depth and
spread checks with actual books, using controlled liquidity when authorized.
Production live pricing retains the strict policy. The demo exception relaxes
price-source availability only: settlement checks, signing deadlines, exposure
limits and required backing still apply. Fallback prices grant no hedge credit;
if no hedge fills, exposure retains its required backing. Actual execution still
requires liquidity and confirmed fills, with partial fills reconciled as before.

This supersedes the earlier blanket prohibition on live testnet fallbacks.
Implementation remains pending; approval of this policy did not change services,
configuration, or authorize new trading/deployment actions.

Size-aware depth pricing and testnet freshness are agreed below; hedge sizing,
production spread tolerance and production quote lifetime remain open. A recently received book can
still contain stale economic prices; its timestamp alone does
not prove that participants have repriced after the latest play. A book snapshot
also does not guarantee the later hedge will fill.

## Live quote pause conditions — agreed September 18

In the strict pricing path, pause new quotes containing an affected leg when its book data is missing or
too old, or the feed is disconnected; when depth is insufficient to support the
pricing; or when the spread is too wide to provide a reliable price. Unaffected
selections remain eligible under the other checks. Resume when the affected
book passes the checks again. Hedge sizing and production thresholds remain
open; the agreed testnet freshness, depth and spread rules follow.

Pausing issuance does not revoke an already signed, unexpired quote. Existing
accepted tickets retain their payout; outstanding signed quotes remain a
separate exposure to address through quote lifetime and contract rules.

Freshness agreed by the user: start with a two-second maximum book age for
strict testnet evaluation, checking both venue timestamp
and local receipt age immediately before signing, for every leg. A heartbeat
alone must not refresh a book. After a disconnect, require a fresh valid snapshot
before resuming. Account for invalid timestamps and clock skew; measure actual
delivery latency before deciding a production threshold. Hyperliquid documents
timestamped `l2Book` snapshots in its
[subscription formats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions).
Fresh data delivery does not establish that orders reflect the latest play.
This threshold is not implemented or empirically validated yet.

## Size-aware depth pricing — agreed September 18

For book-based pricing, price the required quantity using the quantity-weighted average of available
asks, consuming only the needed portion of the last level. Count only liquidity
within the permitted execution price. A small cheap ask must not price an
arbitrarily large quote. Include applicable fees separately in the spend budget.

If visible eligible depth is insufficient, refuse the requested size. Offer a
smaller stake only after recalculating and validating its quote. For example,
10 shares at 0.50 plus 90 at 0.52 cost 51.80 before fees for 100 shares, averaging
0.518. The execution limit must permit the levels used; the average is not the
limit price. A snapshot is an estimate, not a reservation or guaranteed fill.

The planned hedge quantity and portfolio allocation remain for the margin
discussion; this decision does not prescribe a hedge ratio or require buying
every leg for every ticket. Final pricing must connect that sizing to the quote.
An aggregate depth check alone does not establish a fair probability or safe
margin credit. No runtime change has been made for this policy.

## Spread limits — agreed for strict testnet evaluation

Require bids and asks for the selected outcome side. The best ask minus best bid
must be both <= 0.05 USDC and <= 10% of their midpoint. Missing sides or a wider
spread pause the affected strict quote. This is a screening rule in addition to
freshness and size-aware ask depth, not proof of reliable liquidity or a fair
probability. Use the midpoint only for the spread calculation; price the required
quantity from ask depth. Reject malformed/crossed books rather than letting a
negative spread pass. Production suitability remains unmeasured. The testnet
demo exception can use labelled fallback pricing when the book is unusable.

## Quote lifetime — agreed for testnet

Agreed: 30 seconds for testnet demo usability and 10 seconds for strict
testnet live-quote evaluation, with production lifetime chosen after measuring
wallet, relay and inclusion delays. Neither setting guarantees safety against
in-play price changes. The lifetime ends at the signed deadline checked on-chain;
a click or wallet submission before expiry does not guarantee inclusion in time.

Current source defaults to 30 seconds, relay requires at least 8 seconds left,
and the mint helper refreshes below 10 seconds. A shorter window requires these
checks and frontend confirmation to be aligned; it is not just a config change.
Complete any needed USDC approval before requesting the final actionable quote.
If a refresh changes the payout, show the new terms and require user acceptance;
do not silently substitute worse terms. Keep accepted ticket payouts fixed.
These are agreed implementation requirements, not verified current behavior.

## Margin accounting: stake convention — agreed September 18

Keep the user's stake (premium) in the ParlayVault pot. The maker's obligation
per winning ticket is total promised payout minus that stake (`M - premium`).
Do not also credit the retained premium to maker cash, spendable balance, or
withdrawable collateral. For a 20-USDC stake and 100-USDC total winning payout,
the maker backs 80 USDC and the pot retains the user's 20 USDC.

The future MarginVault may change how the maker backs that 80 using eligible
confirmed hedges; it does not make the user's retained stake maker capital.
Quoted probability alone never reduces the winning obligation. Confirmed hedge
credit is agreed below; intermediate-state backing, withdrawals and claim
liquidity still need their explicit accounting rules. This decision preserves the existing
premium convention; no contract or runtime change was made.

## Margin accounting: scenario-based hedge credit — agreed September 18

Recognize only confirmed hedges controlled by the vault, valued at conservative
net payout in the scenarios where ticket obligations arise. Submitted orders,
personal-wallet holdings and current market prices do not establish that credit.
Count purchase costs as cash already spent and allow for settlement fees.

Illustration for ordinary binary resolution: stake 20, total payout 100 for
`A wins AND B wins`, maker liability 80. A confirmed hedge paying at least 50 net
when A wins leaves a worst uncovered maker obligation of 30: both win means
80 owed minus 50 hedge proceeds; either losing result means no winning-ticket
obligation. The retained 20 stake is separate from the maker's backing.

Calculate coverage across the maker portfolio, without crediting the same hedge
independently against multiple tickets. Use the worst uncovered obligation as
the cash requirement, or a proved conservative upper bound. Because hedge payoff
has already reduced that requirement, do not also add the same hedge payoff to
cash on the other side of the solvency comparison. Scenario credit is a design
principle, not yet a specified/verified on-chain calculation or withdrawal rule.
Void/fractional results, won-unclaimed obligations, settlement fees and timing
remain explicit design cases; the binary illustration does not resolve them.
Contract-enforced custody and restrictions on disposal remain prerequisites.

## Margin accounting: pending hedge spend — agreed September 18

Before submission, reserve the maximum purchase spend including fees. Exclude
that reservation from usable backing and grant no new hedge credit until the
fill is confirmed. Do not deduct the same amount again merely because it also
appears as a Core hold or a reconciled cash debit; reconcile these representations
of the same spend explicitly. Maintain the backing invariant throughout.

For an existing cash requirement of 80 and a new order capped at 25 including
fees, the maker needs 105 eligible cash before submission, separate from the
user's stake. Reserving 25 leaves 80 usable backing. If all 25 is spent and a
confirmed hedge provides 50 net scenario coverage, cash is 80 and the uncovered
requirement becomes 30. With only 80 initially, skip the order: confirmation
cannot retroactively repair an under-backed interval.

For partial fills, reconcile actual spending and credit only confirmed coverage.
Release unused reservation only after the remaining order exposure is resolved.
An uncertain response keeps unresolved spend reserved and blocks another hedge
attempt until reconciliation. Newly available account capacity is not itself
withdrawal authorization; the stricter withdrawal rule follows.

## Margin accounting: maker withdrawals — agreed September 18

Unsettled hedge credit may support additional activity inside the maker account,
subject to portfolio and pending-spend checks, but cannot by itself unlock cash
withdrawals. After withdrawal, remaining eligible cash must cover obligations
without relying on unsettled hedge proceeds, plus pending reservations and the
claim-liquidity buffer. Count reservations only once. Only available EVM USDC
can be withdrawn; Core balances or transfers in transit are not withdrawable.

Continuing the single-ticket illustration: after spending 25 on a confirmed
hedge, maker cash is 80, net cash requirement is 30, and spare account capacity
is 50. Withdrawal capacity created solely by that unsettled hedge is zero.
Additional ticket capacity requires a fresh portfolio calculation; further
hedge spending still needs sufficient backing during confirmation.

After settlement, recognize actual net proceeds once, retiring the corresponding
hedge credit. Once proceeds arrive on EVM they may contribute to withdrawable
surplus only after remaining obligations and reservations are covered. This
implements the roadmap's intent that unsettled relief stays inside the account;
subtracting the hedge-reduced requirement alone from EVM cash would not enforce
that intent. The exact bound and claim buffer remain to be specified and tested.
No withdrawal mechanism or deployed configuration was changed.

## Margin accounting: winning claims and funding delays — agreed September 18

Pay the promised winning payout in full. Hedge fees or transfer delays never
reduce the holder's entitlement. Won-but-unpaid tickets remain obligations until
payment, with retained premium and maker liability accounted separately under
the agreed stake convention. Do not release backing merely on a Won status.

Use available EVM funds if payment preserves backing for the remaining portfolio.
If funding has not arrived, retain the claim and show a visible
`Won — payout funding pending` state; do not burn the ticket or mark it paid.
Enable the holder to claim after funding. Automate settlement-fund transfers
and provide a permissionless recovery path so keeper downtime does not create
an exclusive dependency. Outstanding payouts take priority over new exposure
and maker withdrawals. Claims still require adequate EVM liquidity and valid
accounting; permissionless triggering does not imply permission to redirect funds.

Maintain an EVM liquidity buffer, sized later from expected claims and measured
transfer delays. The discussed tens-of-seconds to roughly 1–2-minute interval
after net settlement credit on Core is an engineering estimate for a healthy
automated flow, not a measured usual duration or promised SLA. It excludes time
from game end to venue settlement and operational failures. Overnight samples
confirmed settlement credit but did not measure the complete Core-to-EVM-to-user
path. Validate that path before publishing payout estimates. An actual solvency
shortfall must not be described as an ordinary transfer still pending.

No claim/transfer implementation or service configuration has been changed.

## Margin accounting: void and fractional results — agreed September 18

Retain current ParlayVault settlement semantics for the first MarginVault
version. At resolution, any already confirmed losing selected leg makes the
ticket Dead. Otherwise, a fractional selected-leg result makes the whole ticket
Void and refunds its original premium to the holder; it does not pay a fraction
of the advertised winning payout. All selected legs winning makes it Won.

Preserve early-void timing: a fractional result may void the ticket while other
legs remain unresolved. Loss takes precedence only if known when resolution
runs; a later loss does not reopen a refunded/burned ticket. Keep the obligation
recorded until resolution is confirmed, then release the winning liability for
Dead/Void while preserving any unpaid refund. The retained premium funds a Void
refund under the agreed escrow convention.

Account for the hedge separately. Fractional hedge settlement contributes only
conservative net proceeds, never its former full winning payoff. Confirmed
settlement cash replaces, rather than supplements, the same hedge credit.
S9/S10 must cover the transition between leg settlement and ticket resolution,
including asynchronous reads, to avoid temporarily releasing or double-counting
backing. This preserves product semantics; the MarginVault transitions still
need specification, proof checks and implementation.

## Margin accounting: custody and trading authority — agreed September 18

Use one MarginVault and dedicated Core account per maker, keeping funds, hedges
and obligations attributable. Submit collateral-account hedge orders through
guarded vault functions. The maker chooses the trade; the contract checks asset
eligibility, maximum spend, pending operations and remaining backing. Do not
authorize unrestricted API-agent trading on that account to bypass these checks.

Block disposal of credited hedges unless remaining backing is sufficient. If a
sale is permitted, remove affected credit before execution and do not recognize
anticipated proceeds as cash. Transfers require equivalent protection. No
arbitrary-action or administrative path may drain backing or bypass guards.
Pausing new activity must preserve safe reconciliation and payout paths.

Keep HedgeProbe's existing agent separate as an experimental tool; this policy
does not revoke/change its key or deploy a MarginVault. Direct contract orders
were observed in the earlier spike, while September 18 IOC/recovery evidence
used the API-agent path. Guarded CoreWriter IOC, asynchronous confirmation and
recovery require their own implementation and integration proof before relief.
Users still request quotes and mint through the app; custody restrictions govern
the maker's backing rather than adding a user-facing trading step.

## Hyperliquid portfolio-margin cross-reference

At the user's request, reviewed official PM, margining, account-mode, balance and
HIP-4 documentation. See [comparison and sources](2026-09-18-hyperliquid-margin-reference.md).
Account-wide accounting and separate trading/withdrawal capacity are useful
patterns; native borrowing/LTV/liquidation formulas do not establish backing for
our external parlay obligations. The user subsequently accepted the conservative
one-assigned-leg calculation after reviewing the examples below; it is not a
Hyperliquid requirement. Standard mode without borrowing/lending is a recommendation to
evaluate, not approval to change existing accounts.

## Calculation follow-up — one-leg bound agreed for the first version

At the user's request, compared the binary terminal-state reference with one
assigned leg per ticket. [Runnable calculation and results](../../evidence/2026-09-18-margin-calculation/README.md)
show `exact <= assignment bound <= full liabilities` for all 3,645 tested
portfolios / 13,041 assignments in the stated bounded domain. The 80-liability /
50-net-hedge example requires 30 under both methods. Split hedges and opposite-leg
tickets expose 30–50 extra cash required by the shortcut in the examples, even
with the best assignment. This confirms conservatism in the binary model, not
the full asynchronous/void/withdrawal invariant. The user accepted the conservative
one-leg bound for the first version, with the exact calculation as a test oracle.
The saved evidence's provisional recommendation predates this acceptance.
Credit each confirmed hedge once within its event group, not separately per
ticket. Formal transition rules, assignment selection, hedge purchase targets,
portfolio limits and liquidity buffer still need S9/S10 specification.

## Remaining specification items

The main product policies are agreed. Remaining concrete parameters and proofs:

- EVM claim buffer and throttle: how much cash to retain locally, and when to
  pause new exposure to preserve payout readiness. No instant-payout guarantee.
- Hedge execution economics: selection of the assigned leg, target coverage,
  spending/price budgets and trigger policy within the agreed single-attempt,
  no-blind-retry constraints. Do not confuse the accounting bound with a mandate
  to buy a full hedge for every ticket.
- Net-credit assumptions: conservative fee bounds, unit conversion/rounding,
  settlement reconciliation and the states in which credit is unavailable.
- Exact lifecycle invariant: signed-but-unexpired quotes, pending operations,
  partial/fractional settlement, early void, won-unpaid claims, assignment changes,
  withdrawals and transit funds; preserve the user-premium convention throughout.
- Account mode and limits: propose explicit no-borrow/no-lend custody settings
  and bounded supported portfolio sizes; verify compatibility before deployment.

Resolve routine engineering choices in the S9 draft with explicit assumptions
and checks. Surface material availability/capital tradeoffs for review, rather
than treating each implementation detail as another product-policy question.
Follow with S10 adversarial review before money-path implementation. Production
timing/market-data thresholds need measurements beyond the approved testnet values.

## Next discussion

Segment 2: distinguish an executable hedge price from a fair live parlay quote.
The live-price source, pause conditions, testnet freshness limit and size-aware
depth pricing and strict testnet spread limits are agreed, with the testnet demo
exception above. Testnet lifetimes and refreshed-term acceptance are also agreed.
Segment 3 has agreed the stake-in-escrow convention and confirmed net scenario
hedge credit, reserve-before-send accounting, the stricter withdrawal policy and
full winning claims with visible pending-funding states. Existing void/fractional
semantics, including early void, are agreed. Custody uses guarded CoreWriter
execution from a dedicated vault/account per maker. The conservative one-leg
accounting bound is agreed for the first version. Next consolidate S9 with the
remaining parameters and lifecycle checks listed above, then perform S10 review.
The user chose to start that S9 drafting in a **new session**. Write the draft
locally under `docs/superpowers/specs/`; propose remaining defaults and material
tradeoffs inside that draft rather than extending the abstract approval rounds.
The [handoff prompt](../../s8a-handoff.md#prompt-for-the-next-session) carries scope
and preservation constraints. No S9 specification has been written in this session.
Production thresholds still require measurements. The user explicitly chose to
finish the margin-accounting discussion before implementing local quoting
changes. Keep runtime code/configuration unchanged during this discussion.
Do not implement the hedge bot ahead of those decisions.
