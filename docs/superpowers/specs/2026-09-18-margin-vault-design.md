# S9 — MarginVault design draft

Date: 2026-09-18. **Draft for S10 review; not implementation approval.**
Prepared against `new-design` at `30a614c061afd03d4d225f8d538cd75633fd0709`
with existing dirty writer/web/docs work. No deployed behavior is described as
changed. All numeric defaults marked **proposed** below are testnet parameters,
not measured production limits or additional agreed policies.

## 1. Authority, scope and evidence

The [September 18 policy decisions](../plans/2026-09-18-hedge-execution-policy.md)
and [handoff](../../s8a-handoff.md#prompt-for-the-next-session) govern this draft.
The [PM comparison](../plans/2026-09-18-hyperliquid-margin-reference.md) supplies
context, not a native risk engine for EVM parlays. Earlier roadmap formulas that
add hedge payoff to cash after subtracting it from requirements, allow withdrawals
against hedge-reduced requirements, or group standalone outcomes by sentinel
question ID are superseded here. The missing kickoff trace is not an S9 blocker.

Agreed: premium stays in ParlayVault; maker owes payout minus premium; conservative
one-leg portfolio bound; guarded per-maker custody; reserve before sending;
credit confirmed fills only; retain uncertain reservations; full winning claims;
current loss/fractional/early-void semantics; stricter cash-only withdrawal test;
book-based strict pricing and the labelled testnet demo exception.

Recorded evidence, not fresh network observations:

- [Binary calculation](../../evidence/2026-09-18-margin-calculation/README.md):
  3,645 portfolios / 13,041 assignments satisfy the terminal bound. Split hedges
  and opposite-leg examples lose 30–50 USDC of offsets under one-leg accounting.
- [IOC evidence](../../evidence/2026-09-18-ioc-execution/README.md): full, partial,
  empty and discarded-response recovery passed through the probe's agent path.
  Partial `filled` means 5/10 in that test. This is not guarded-vault integration.
- [Latest hedge findings](../../../script/spike/FINDINGS-hedge.md): direct
  CoreWriter orders worked; 10 gross settled to 9.986 net in one observation;
  failed token reads did not establish zero balances or an explicit EVM revert.
  No on-chain order-status reader has been established by these local findings.

S10 cases are in [the review pack](2026-09-18-margin-vault-s10-review.md).
S10 rulings and S11 simulation precede money-path implementation. This session
adds design only: no runtime changes, dependencies, deployment, transactions,
account changes, services, commits, or modifications to private configuration.

## 2. Ownership and the escrow boundary

One MarginVault contract and its dedicated Core account belong to one maker.
Use that vault address as the margin maker identity; its separately registered
signer signs quotes. Never pool collateral across makers. Propose standard
account mode, USDC only, no borrowing, lending, perps, builder fees, unrestricted
API agents, arbitrary calls, or discretionary collateral transfers. Verify mode
and guarded CoreWriter compatibility before enabling a future deployment.
HedgeProbe and its experimental agent remain separate and unchanged.

Only whitelisted ParlayVault can create/release ticket obligations or request
claim funding. Pin the source address and accounting mode **on each ticket**;
later registry changes cannot redirect claims or switch old escrow modes. A
future margin-capable deployment preserves the EOA full-escrow path and existing
anchors. This does not retrofit existing deployed v2 tickets.

The proposed `IEscrowSource` seam has these responsibilities, not a finalized ABI:

| Operation | Required atomic behavior |
| --- | --- |
| Reserve quote | Bind exact quote digest, maker, taker, expiry, liability, legs and source; lock capacity before publishing signature. |
| Lock on mint | Consume that reservation and install the ticket obligation; move only premium into ParlayVault. |
| Resolve | Read canonical ticket/leg state, update margin obligation and premium entitlement together. |
| Fund winning claim | Transfer exactly maker liability to ParlayVault, combine with that ticket's premium, pay current NFT holder once. |
| Release on Dead/Void | Remove maker liability once; settle premium according to the table below. |

The current EOA path escrows the whole payout at mint. The new margin path must
not pretend `lock(id, amount)` transferred that amount: it also needs the ticket
legs, quote reservation and callbacks for resolution/payment. No untrusted
escrow implementation may self-report sufficient backing. No emergency withdrawal,
upgrade, verifier replacement or owner reset may erase outstanding encumbrances.
Prefer fixed custody/escrow wiring for this first version; a maker can pause new
activity, but cannot pause safe recovery, resolution or full funded claims.

## 3. Ledger, units and asset eligibility

All risk amounts below use integer EVM USDC units, `1 USDC = 10^6`. For ticket
`t`, `pi[t]` is premium, `M[t]` total promised payout and `L[t] = M[t] - pi[t]`.
Premium is never maker cash, hedge funding or withdrawable collateral before a
confirmed Dead resolution. ParlayVault separately covers the sum of premiums
for Open, Won-unpaid and Void-refund-unpaid tickets. Full-escrow maker funds for
legacy tickets remain segregated from margin liquidity.

| Symbol | Meaning |
| --- | --- |
| `E` | Actual unencumbered maker EVM USDC; excludes pot premiums, staged claim funds and unrecognized arrivals. |
| `C` | Conservatively reconciled Core USDC, less reservations/holds described below; no unsettled proceeds. |
| `Q` | Sum of full `L` for all live quote reservations, including quotes not selected by a relay. No hedge relief for these. |
| `F` | Sum of full unpaid minted `L` plus `Q`, regardless of correlation or hedges. |
| `H[e,s]` | Conservative net payoff of unique confirmed, custody-controlled inventory in event state `s`; includes explicitly tracked settlement receivables until cash replacement. |
| `T` | Recognized transfer principal in flight, owned by this vault, counted once; not cash or spending/withdrawal capacity. |
| `B` | Additional EVM payout-buffer target, calculated in §6. |

Reserve maximum order spend **before** CoreWriter submission. If cap is `P` and
an attributable debit `d` has already reduced Core total, the outstanding reserve
is `P-d`. Deduct the union of that reserve and its matching hold, not their sum.
For a coherent read with one matching order hold `h`, use
`C = floor(CoreTotal/100) - max(P-d, ceil(h/100)) - otherEncumbrances`.
Compute the underlying reserve in 8-decimal units before conservative conversion.
The formula assumes attributable debits/holds; mismatches freeze new activity,
not a guessed `d`. A debit includes purchase fees. Unrelated holds are additional
encumbrances and an account-policy violation. Negative cash is a shortfall, never
saturated away into apparent solvency. At terminal reconciliation release only
the proven unused cap. See §8 for the order-finality gate.

Units verified by the saved spike: Core USDC balances have 8 decimals; outcome
balances 5 decimals; CoreWriter price and size fields both use 8 decimals.
One outcome raw unit maps to 1,000 order-size units. Use wide intermediates;
reject overflow before narrowing to `uint64`/`uint96`. Floor cash, net credit and
fractional payouts; ceil spending, required quantities and fees. A payout need
not be a multiple of an outcome lot. Snap requested size down to a valid lot
when constrained by a budget, then recalculate coverage. Never round the budget up
or silently raise the limit. Validate actual asset tick/lot/minimum rules before
an order; their current values are not assumed in this document.

**Proposed fee envelope:** 50 bps of gross settlement proceeds plus 0.01 USDC
per event-side conversion; 50 bps of order notional plus 0.01 USDC per IOC;
0.01 USDC reserved separately per transfer. These exceed the particular saved
observations, but are **not demonstrated protocol maxima**. For `q5` raw shares
and fraction `fWad`, gross EVM payout is `floor(q5 * 10 * fWad / 10^18)`.
Credit is `max(0, gross - ceil(gross*50/10000) - 10000)` per eligible bucket.
Zero inventory gives zero credit and incurs no fictional fee. Trading fees
reduce cash; settlement fees reduce payoff; neither is the other fee.

Activation gate: establish that these bounds cover the eligible account/assets,
including minimum/rounding fees, or increase the bounds and re-run S10/S11. Until
then credit is zero and execution with an unbounded possible debit is disabled.
Unknown fee tokens, fee regimes or changing parameters fail closed for new risk.
Higher fees after admission are an explicit external risk; pausing cannot repair
a pre-existing shortfall. Report one and require capital, never haircut a ticket.
Do not copy the old probe's zero buy fee or 14-bps settlement fee as universal.

## 4. One-leg requirement and assignment

Group by immutable `(chain, outcome ID)` with both complementary YES/NO sides.
Validate OutcomeVault-to-event binding and settlement source on admission; alias
vaults for one event share one hedge bucket. Distinct outcomes remain independent
even if their question IDs match or equal `0xffffffff`. This version does not
use multi-outcome partitions or name-based exclusivity. Consequently simultaneous
YES and all-NO combinations across different outcomes are included. A later
partition model would need an independently proved allowed-state set.

Assign every unpaid minted ticket to exactly one of **its own** selected legs.
For an active event, `L[e,s]` sums the full `L[t]` of tickets assigned to the side
that wins in state `s`. Deduct each hedge bucket once:

```text
R_e = max(0, L[e,YES] - H[e,YES], L[e,NO] - H[e,NO])
R   = Q + sum_e R_e
R_cash = F
```

No hedge value is then added to cash. Winning every ticket leg implies winning
its assigned leg, so the assignment is an upper bound on its binary liability.
Taking independent nonnegative group maxima gives the agreed conservative bound.
`R_cash = F` deliberately forgoes even unhedged correlation offsets on withdrawal.
An 80 liability with 50 net assigned-side credit needs 30, not 80 minus the hedge
purchase price. Two identical 80 liabilities share that same credit: requirement
110, not 60. Credit on the wrong side gives no relief.

For a settled event, replace its two branches with **one deterministic branch**
only as part of the reconciled resolution transition in §9. Assigned tickets
still Open after an assigned winning leg carry full `L`; Won-unpaid tickets also
carry full `L`. Their assigned leg may remain the now-known winning leg until
payment. Thus settled hedges can cover those debts while awaiting conversion,
but a Won status never deletes the liability. This deliberately replaces the
old roadmap's requirement to always point to an unresolved leg.

For that deterministic branch, `H` is the lower net settlement receivable for
recorded shares, based on an authenticated fraction and the fee envelope. It is
not spendable cash. On actual credit, retire the corresponding `H` and add only
actual net USDC to `C` in the same reconciliation. Never recognize both. Unknown
fractions, missing pre-pruning records or conflicting reads do not invent a
receivable: retain an unresolved checkpoint and block risk-increasing actions;
value disputed assets at zero for reported stress coverage. S10 must review this
settlement bridge; the binary checker does not prove it.

**Proposed assignment rule:** at mint, try each eligible leg and choose the one
with the smallest post-mint `R`; ties use canonical outcome ID then side. Only
confirmed inventory participates. This is bounded by four legs in the proposed
margin profile. Never assign to a fictional/duplicated leg. Reassignment is an
atomic remove/add followed by all backing checks; permit it only when `R` does
not increase by default. No periodic global optimizer. Keeping an already won
assigned leg is valid but may waste offsets; explicit safe reassignment may help.
An event remains in the ledger while any liability, hedge or operation refers
to it, even after token pruning.

## 5. Lifecycle invariants and operation checks

The intended invariant is conditional on authentic outcomes, bounded fees,
enforced custody and reconciled transfer finality. For each coherent checkpoint:

1. Every enforceable quote/ticket obligation occurs exactly once in `Q` or the
   assigned ledger, and premiums cover their separate pot liabilities.
2. Each asset unit is in exactly one of EVM cash, Core cash, pending spend,
   confirmed hedge/settlement receivable, or transfer-in-flight state. No double
   credit; no disposal path bypasses the guards.
3. `E + C + T >= R`. `T` is coverage during an owned transfer, not new risk
   capacity. Quote admission, purchases and withdrawals require no unresolved
   transfer/settlement transition and evaluate actual cash without `T`.
4. External asynchronous settlement is represented by branch restriction plus
   asset replacement, not a fresh profit estimate. A stale checkpoint is never
   advertised as current available capacity. Uncertainty closes risk paths while
   deposits, reconciliation and safe claims remain possible.

Admission is stricter than solvency: after reserving a quote or sending a new
hedge, require `E + C >= R + B` and `E >= B`. The buffer is additional cash over
the hedge-reduced requirement, deliberately costing capital. For pending orders,
these checks hold with the full spend cap deducted and no new hedge credit.
As spend becomes confirmed, cash debit replaces its reserve; confirmed net
coverage can only improve the bound under the stated assumptions. Check each
partial fill, not just the terminal result.

Claims may consume the buffer. For payment of maker portion `L[t]`, require
actual EVM liquidity and `E_after + C_after + T_after >= R_after` for all other
debts and reservations. Do not require restoration of `B` before paying a claim.
Never use another ticket's premium. If payment is unsafe/illiquid, retain the
full claim; do not burn or reduce it. Resolve-only remains callable so a failed
claim does not hide a win behind a reverted auto-resolve.

Withdrawal of `w` requires **all** of:

```text
no unpaid Won claim or unpaid Void refund; no unresolved accounting operation
w <= E - B
E + C - w >= F + B       # no unsettled hedge or transit credit
```

Here `C` already excludes all reservations/holds and `F` includes pending signed
quotes; do not subtract them twice. Only `E` leaves the account. Settled actual
Core cash can back retained obligations; it becomes withdrawable only after its
own EVM arrival/reconciliation. At `E+C=80`, `F=80`, and net hedge credit 50,
the requirement may be 30 but withdrawable surplus is zero (even before `B`).
Lowering a limit or pausing quotes cannot cancel outstanding commitments.

## 6. Proposed testnet capital and portfolio limits

These are initial review choices, not calibrated safety/latency guarantees.
USDC values are human units; round percentages upward to one EVM USDC raw unit.

| Parameter | Proposed default | Tradeoff |
| --- | --- | --- |
| EVM buffer `B` with any exposure | `max(20 USDC, largest L among tickets/reservations, ceil(10% * F))`; zero after all obligations/operations clear | Holds one largest maker claim locally, plus aggregate floor; expensive for large tickets, does not promise a burst of claims. Premium stays separately in the pot. |
| New-exposure throttle | Stop new quote reservations and hedge buys if `E < B`, spare backing below `B`, any Won/refund unpaid, or reconciliation pending | Prioritizes payouts; one unclaimed winner can stop issuance until paid. Permissionless payout-to-holder can clear it. Existing reserved quotes remain exercisable. |
| Minted unpaid tickets | 32 per maker, including Won; separately retain unpaid refund records | Bounds state scans; terminal paid/Dead/paid-Void history is not an active slot. |
| Live reserved quotes | 16, **and minted-active plus reserved slots <= 32** | Prevents simultaneous mints bypassing active-slot limits; losing relay quotes consume slots until expiry. |
| Distinct referenced events | 8, counted across tickets, reservations, inventory and pending operations | Bounded scans; settled but unreconciled events keep their slot. |
| Legs per margin ticket | 1–4 distinct events | Smaller gas/proof surface; legacy EOA contract maximum of 10 stays unchanged. |
| Premium / total payout / maker liability | At most 50 / 200 / 150 USDC per ticket or reservation | Allows the roadmap's 150-liability G3 example; values are limits, not recommended bet sizes. Existing minimum-premium rule still applies. |
| Gross exposure `F` | At most 600 USDC per maker | Hedges do not raise this gross cap. |
| Per-event concentration | At most 300 USDC sum of full `L` for **every** ticket/quote containing that event, either side | Assignment changes cannot hide concentration; counts conservative opposite-side exposure too. |
| Outstanding Core operation | One order or transfer per account; no new hedge until reconciled | Simpler debit attribution; settlement can still happen asynchronously and must be handled. |
| Cash/asset reads | Same EVM block context for contract checks; off-chain views labelled by block | Avoid mixed reads; age alone cannot prove cross-chain finality. |

Example: one ticket `pi=20`, `M=100`, `L=80` gives `B=80`. With no hedge,
admission needs 160 maker USDC, of which at least 80 is EVM cash, plus the
separate 20 premium. A 25-USDC hedge cap needs 185 before send to keep the same
buffer while reserving 25. If 25 is spent and confirmed net coverage is 50,
cash is 160, `R=30`, and `B=80`; withdrawal is still tested against `F=80`,
so the hedge alone created no withdrawal headroom. These examples include the
proposed buffer; the agreed 105-for-80-plus-25 example intentionally did not.

At maximum `F=600`, one ticket of `L=150` makes `B=150`. This high cash cost is
intentional for first testnet validation. A smaller buffer improves utilization
but increases funding-pending claims; only measured burst sizes and transfer
delays justify changing it. Gas feasibility of 32 tickets / 8 events must be
measured in S11; lower admission caps if needed, never truncate existing debts.

## 7. Signed quotes, pricing and mint admission

**Proposed enforceable reservation design:** reserve the exact digest on-chain
before releasing an actionable signature. Only the registered maker signer (or
maker through its authenticated path) may reserve; public callers cannot exhaust
slots. A local journal alone cannot protect firm quotes against withdrawals,
another signer process or concurrent mints. Reservation confirms before signing;
set deadline after allowing for reservation inclusion, then check market data
again immediately before signing. If terms/data fail, do not sign, let the
reservation expire. This adds a transaction/latency cost; S10 must judge it,
not silently replace it with best-effort off-chain capacity.

Reserve full `L` in `Q`, event concentration, event/ticket slots and buffer sizing.
No stake is credited before mint. Key by maker plus quote ID and exact digest;
no reuse with different terms. Mint consumes this record once and inserts its
assigned obligation atomically. It can use the zero-hedge bound if credit is
temporarily unavailable. Converting `Q=L` to an assigned liability cannot raise
the requirement with a consistent ledger. Claims/withdrawals must preserve the
reservation. Reject settled legs at mint as today; an existing quote remains
subject to its original on-chain validity rules, not guaranteed inclusion.

Release a reservation only after `block.timestamp > deadline` (mint currently
allows equality), or successful consumption. Relay rejection, a newer quote,
feed pause, disconnect, local timeout or signer restart does not release it.
Refreshing terms creates another reservation until the old one expires; do not
assume the user discarded the old signature. Persist exact digest and reconcile
reorgs before declaring expiry/consumption final off-chain. A pause prevents new
reservations/signatures; it must not retroactively revoke existing quotes.
Registering a reservation does not require changing the quote typehash. If later
ABI work changes signed fields, bump the domain and both parity vectors.

Pricing retains the agreed rules:

- Strict testnet: both venue and receipt age <=2 seconds for every leg immediately
  before signing; reject malformed/future/skewed timestamps, disconnects and
  crossed books; reconnect needs a fresh snapshot, not a heartbeat. Require bid
  and ask, spread <=0.05 USDC **and** <=10% midpoint.
- Walk asks for required quantity, using only levels inside the execution price
  cap; volume-weight the last partial level. The average is the quote reference;
  the highest consumed ask is the execution limit. Insufficient depth rejects
  that size; smaller stake requires a recalculated quote and acceptance.
- Proposed reference quantity **for each selected leg**: shares giving 50% of
  that ticket's `L` in net winning payoff under §3, rounded up to a valid lot,
  minimum one share. Use this even if inventory already covers the ticket; do
  not reduce pricing depth to zero. Actual hedge buying aggregates inventory
  under §8. This connects stake size to depth without buying every leg.
- Testnet demo: prefer usable books, otherwise valid `spotPx` or explicitly
  configured demo prices, including pregame priors during live games; visibly
  label **Testnet fallback pricing** and record each actual source. Invalid or
  placeholder reads are not prices. Fallbacks give no hedge credit, liquidity
  proof or strict-validation pass. Production has no such fallback.
- Agreed TTLs: demo 30 seconds, strict 10 seconds; complete approval before final
  actionable quote. Align relay/frontend timing before testing. Changed payout
  on refresh requires user acceptance. Production timing thresholds remain open.

## 8. Hedge selection, spending and confirmation

**Proposed target:** 50% conservative net coverage of each assigned event-side
liability, with no hedge buying for unsigned/unminted reservations. Aggregate
required coverage and subtract that bucket's already confirmed net coverage.
Existing excess inventory is not an instruction to sell or hedge another leg.
Only consider eligible unresolved assigned sides with fresh executable books.

For each candidate, size the incremental quantity toward the target using §3's
fee/lot rules, then clip downward to all caps and re-evaluate:

| Control | Proposed default |
| --- | --- |
| Spend per IOC | <=25 USDC all-in **and** available cash headroom after `R+B`, with sufficient free Core USDC |
| Cumulative submitted caps | <=100 USDC in the preceding 24 hours, including failed/no-fill attempts; do not refund this rate budget |
| Active inventory acquisition spend | <=100 USDC across unsettled hedge buckets, including pending cap; actual cost retires only on settled reconciliation/disposal |
| Limit price | <=0.80 USDC/share, or a lower explicit maker limit; no automatic price escalation |
| Economic screen | All-in spend <=80% of the predicted reduction in `R` from a confirmed fill |
| Execution | One IOC, no resting/repricing loop, no automatic retries |
| Selection | Largest predicted `delta R - spend`; tie by lower spend, then canonical event/side |
| Trigger | Maker explicitly authorizes each intent; worker may propose after mint/reassignment/reconciliation, never resend an uncertain intent |

These caps limit experimental spend and favor capital efficiency; the screen
is **not expected trading profit**. Expensive near-certain hedges, tiny orders,
wrong-side hedges and fills that do not lower the worst group branch may be
skipped. No hedge is required to mint a fully backed ticket. Raising the target
or price cap buys more protection but ties up more cash during confirmation.

Persist immutable on-chain intent before emitting CoreWriter action: operation
ID, unique nonzero cloid, asset/side, size, limit, max spend/fees, validity bound,
and baseline cash/hold/holdings. Mirror it in the existing durable journal before
worker submission. The EVM transaction must be idempotent by intent ID; retrying
a mined EVM transaction cannot queue another Core action. A cloid alone is a
lookup handle, not assumed venue idempotency. Expiry only prevents a new send;
it never proves an already emitted Core action cannot execute later.

Guarded functions encode buy IOC themselves. No caller-supplied raw actions,
alternative destinations, API-agent approvals, orders above caps, or bypass
through an admin. One intent remains busy across restart, delayed response,
unexpected hold, partial fill, inconsistent balances and settlement mid-order.
Cancellation is permitted as risk reduction but not assumed final on receipt.

**On-chain finality gate requiring S10 ruling:** the saved API status/fill proof
is not a contract-readable proof. The existing `IExecutionVerifier` trusts a
keeper, and an owner can change its delay; it cannot be silently promoted to
trustless order finality. Zero holds or several elapsed blocks do not suffice.
The safe default here keeps the unused reservation and busy state until an
authenticated terminal proof is available. Full/partial quantities may receive
credit only when direct custody reads and attribution establish them; their
unproven remainder remains reserved. No amount of waiting authorizes another buy.

Before money-path implementation, S10 must choose and document a concrete
terminal-proof mechanism: a verified Core ordering/finality barrier if available,
or an explicitly accepted, narrowly bound verifier trust model. A verifier must
bind this vault/chain/intent/cap and terminal status; it cannot create holdings,
increase spend caps or clear custody guards. A dishonest terminal verdict could
permit a late debit after reserve release, so even balance corroboration does
not eliminate that trust. **No unrestricted agent or owner-reset fallback.**
Absent a reviewed proof mechanism, guarded recovery remains a release blocker;
the conservative locked state is safe but operationally incomplete.

Disposal is disabled in the initial automated policy. A future guarded sale must
remove the entire offered quantity's credit before sending, reserve fees and
pass backing without anticipated sale proceeds; keep removal until terminal
reconciliation. No transfer of credited shares around this rule. Safe deposits
may add cash, but unexplained donations cannot prove order completion. Settlement
during an intent requires joint cash/holding/settlement attribution, not subtraction
of two API snapshots or treating a pruned balance as zero.

## 9. Resolution, payment and transfers

| Transition | Maker obligation | Premium and holder behavior |
| --- | --- | --- |
| Open; some selected legs win | Full `L` remains assigned, possibly to its known winning leg | Premium remains in pot; payouts unchanged. |
| Open -> Dead | Release `L` only with confirmed resolution | Transfer that ticket's premium to stored maker; do not transfer an imaginary full escrow. EOA path still returns full pot. |
| Open -> Void | Release winning `L` only with confirmed resolution | Refund full premium, never fraction of `M`. Burn only with refund payment; if payout cannot complete, preserve refund entitlement. |
| Open -> Won | Keep full unpaid `L`, including after NFT transfer | Premium stays reserved; no payment or burn merely because status changed. |
| Won -> Paid | Remove `L` atomically with full payment | Transfer `M` to current holder once; burn/paid guard and transfers all revert together on failure. |

Resolve with the existing precedence: any **already known** losing selected leg
wins over fractional results; otherwise any fractional leg causes early whole
ticket Void even with unresolved other legs; all selected legs winning means
Won. A later loss cannot reopen a paid early Void. Outcome fraction and its
complement must be validated against the bound event. No keeper-supplied status-3
fraction can manufacture monetary credit without authenticated history and
net-cash reconciliation. The existing OutcomeVault fallback trust must be
explicit in S10; do not claim the MarginVault removes that oracle trust.

Settlement synchronization must visit every affected active ticket (bounded by
the portfolio cap) before publishing new capacity. Update confirmed leg results,
resolutions, branch restrictions, hedge receivables and actual cash replacement
as one coherent accounting transition. If refund transfer fails, retain its
premium obligation. Never zero a hedge first and leave a stale winning liability,
or free liability first while leaving a reusable obsolete hedge credit. A Core
settlement that occurs before EVM synchronization blocks new risk, not recovery.
Insufficient gas must not truncate the affected set; batched synchronization, if
needed, keeps the account closed until the complete checkpoint is committed.

Credit settlement cash once, net of fees. Retire each corresponding share/claim
bucket, record authenticated fractions before pruning, and distinguish status/read
errors. For simultaneous settlements, use a joint reconciled set; do not assign
the same USDC delta to each event. Unknown or short net credit is explicit pending
reconciliation/shortfall, not an invented zero balance or profit. A reconciled
shortfall keeps all holder entitlements and halts risk/withdrawals; do not block
deposits or valid liability-reducing resolutions behind a solvency revert.

**Funding:** use available EVM cash first under §5. Otherwise expose
`Won — payout funding pending`, retain the NFT and debt, automate funding, and
allow anyone to trigger reconciliation and transfers to fixed vault destinations.
A permissionless funded payout may send only to the current holder; caller
cannot redirect it. Distinguish `accounting unresolved` and `backing shortfall`
from an ordinary transfer delay. No partial winner payout or fee pass-through.
No payout latency SLA: prior seconds-to-minutes estimates were not measured
Core-to-EVM-to-holder timings.

**Transfer ledger proposal:** one transfer at a time, no order/hold outstanding.
For Core->EVM, reserve principal plus fee before send; remove principal from
eligible Core cash even if its debit has not appeared, and record it once as
`T`. As the debit lands, release the matching source reservation, not `T`;
as destination funds arrive, retire `T` and recognize actual EVM cash once.
For EVM->Core use the same ownership stages, but permit dispatch only with the
buffer and backing preserved and no payout backlog. `T` supports continuity of
existing backing, never fresh admission/spending/withdrawals. A claim using
other actual EVM cash must still preserve backing for all remaining claims.

Core->EVM amount must be a multiple of 100 Core USDC units, fee funded **on top**.
Transfer funds only between this vault's fixed accounts/ParlayVault payout seam;
exclude activation fees from backing and establish account existence separately.
Proposed 0.01 fee headroom is an activation assumption, not a proven upper bound.
If dispatch is silently dropped, retain the locked source representation until
failure is authenticated; no timeout refund or resend. Missing delivery, actual
loss or unsupported finality is a recovery/shortfall state, not usable `T`.

Reuse OutcomeVault's outbound principal/destination accounting concepts and
encoders, but **not** its `clearOutbound` admin erasure, 99% payout tolerance,
pro-rata redemption or automatic full-balance sweep. Those conflict with full
ticket claims and guarded custody. A donation may supply real payout cash; it
must not also cause the delayed transfer to count a second time or erase a Core
debit reservation. Authenticated failure/delivery proof is an S10 gate alongside
order finality. Once every obligation/reservation is gone and operations reconcile,
`B=0` and remaining EVM USDC can be withdrawn under the cash rule.

## 10. Review gates and verification record

This draft resolves proposed allocation, size/budget, limits, buffer, accounting
and lifecycle choices; it does not certify their safety. S10 must rule on:

1. Bound conservatism across resolution/void/payment interleavings, including
   the deterministic settled-assignment/receivable bridge and fee assumptions.
2. Contract-enforceable terminal order and transfer proof, including any accepted
   verifier trust. Locked indefinite recovery is not sufficient for release.
3. Capital/availability costs of full signed-quote reservation, buffer and caps;
   gas-bounded complete accounting; exact cash-only withdrawals.

After S10: S11 extends existing simulation; S12–S15 implement only under a new
authorized plan. A separately authorized guarded-vault IOC/recovery/claim-after-
sweep test is required before relief. Preserve the G3 requirement-150-to-zero
example using **net** hedge credit and purchase-spend reservations; zero `R`
still does not remove `B`, gross limits or the withdrawal rule.

Session checks run locally on 2026-09-18:

```text
$ python3 docs/evidence/2026-09-18-margin-calculation/verify.py
PASS all 3645 binary portfolios / 13041 assignments:
  exact <= assignment bound <= full maker liabilities
LIMIT: terminal binary model only; not a full solvency/withdrawal/claim proof.

$ python3 docs/evidence/2026-09-18-ioc-execution/verify.py
PASS saved reconciliation: split, full-ask, full-buy, partial-ask,
  partial-buy, empty-buy [individual output lines condensed]
PASS discarded-response recovery and fresh-process duplicate refusal; no cleanup needed
PASS partial API status filled means only 5/10 filled; empty IOC has terminal no-match status
PASS both accounts: no open orders/holds; info balances match independent Core precompile reads
PASS accounting: split 15, buyer cost 7.50, buyer fee 0, seller fee 0.006 USDC; within approved caps
```

Both commands exited 0. These reproduce saved evidence, not new trading or a
full S9 proof. No application build or runtime test is claimed for this design.
