# S10 — adversarial review pack for MarginVault

Prepared 2026-09-18 for the [S9 draft](2026-09-18-margin-vault-design.md).
**Cases prepared; S10 review has not run and no rulings are approved.** The
existing binary and saved IOC verifiers were rerun successfully; their scope
does not cover the lifecycle below. Use existing Python/Foundry tooling later;
this pack adds no runtime implementation or test framework.

## Review procedure and required output

The roadmap calls for 2–3 independent reviewers during S10. Suggested split:
mathematical bound/settlement, custody/asynchronous operations, and claims/
quotes/withdrawals. Preparing this pack does not start that review. Each reviewer
must supply a minimal counterexample or an explicit argument for each assigned
case, including intermediate states, not just the final balance.

Record a ruling as: case ID, exact starting state, action ordering, expected and
observed result, severity, spec section changed, and runnable regression case.
Keep agreed product policies fixed; challenge the proposed mechanism/defaults.
Do not label a risk as solved merely because activity pauses after funds are lost.

S10 exit requires rulings on every row; a bounded enumeration of small portfolios
against the exact oracle; a concrete accepted order/transfer finality mechanism;
and a list of S11 simulation properties. No implementation release while those
gates remain open. S11 must add adversarial async simulation and gas measurements;
it is not satisfied by reproducing the existing binary enumeration.

## 1. Calculation and allocation

Amounts here are USDC; hedge numbers are **net payoff**, not shares or cost.
Unless stated, premiums are already retained separately and cash/spend/buffer
are not part of the terminal-requirement number.

| ID | Portfolio / attack | Expected result |
| --- | --- | --- |
| M01 | One `A & B` ticket owes 80; no hedge / A-YES pays 50 / A-YES pays 80 | Exact and assigned requirement 80 / 30 / 0. |
| M02 | Two identical 80 debts, one A-YES hedge pays 50 | Requirement 110, never 60; one holding credited once. |
| M03 | `A & B` owes 80; A-NO hedge pays 100 | Requirement 80; wrong-side value cannot pay the winning state. |
| M04 | `A & B` owes 80; A-YES and B-YES each pay 50 | Exact 0, best assigned 30. Do not reject the conservative bound for missing an offset. |
| M05 | `A & B` and `A & not-B` owe 80 each; A-YES pays 50 | Exact 30, best assigned 80. No independent per-ticket credit. |
| M06 | Independent events share `question=0xffffffff` or another label | Enumerate simultaneous YES and all-NO; do not collapse them into mutually exclusive outcomes. |
| M07 | Two OutcomeVault aliases bind to one actual outcome | Canonical event grouping combines liabilities and one inventory bucket; duplicate leg/event in a margin ticket rejects. |
| M08 | Repoint a ticket to an unrelated leg, or move before subtracting old assignment | Reject; valid changes replace exactly one assignment atomically. No temporary double credit or omitted liability. |
| M09 | Valid reassignment would increase requirement above backing | Reject; default allows non-increasing reassignment only. Resolution cannot depend on a successful optional reassignment. |
| M10 | A assigned leg wins before B settles; A hedge converts later | Ticket retains 80 assigned liability in a deterministic A branch. With 50 net receivable, requirement 30 until cash replacement; the ticket is not paid. |
| M11 | Article/G3 debt 150, confirmed assigned hedge pays >=150 net | Requirement 150 -> 0 after confirmation; purchase already debited/reserved, buffer remains 150, withdrawal still uses debt 150. Gross 150 shares need not pay 150 net. |
| M12 | Different makers both claim one account's inventory | Reject account/custody mismatch; no cross-maker offset. |

Enumerate at least the existing domain (0–2 tickets, A/B sides, liabilities 40/80,
four hedge buckets with net proceeds 0/40/80) and retain all 13,041 assignments.
Extend to three events, settled deterministic branches, quotes and multiple Won
debts. In each valid model assert `exact <= assigned`; without quote additions
and with nonnegative credits also assert `assigned <= full unpaid liabilities`.
Do not implement the exact oracle by calling the assignment function.

## 2. Fees, units and purchases

| ID | Setup / ordering | Expected result |
| --- | --- | --- |
| H01 | Debt 80; cap 25; maker cash 105, no buffer for this isolated agreed example | Reserve -> usable cash 80 and requirement 80. Spend 25 -> cash 80; confirm 50 net -> requirement 30. Starting with cash 80 rejects send. |
| H02 | Add proposed buffer 80 to H01 | Cash 185, EVM >=80 required before send; 184.999999 fails additional-buffer admission. No premium counted toward the difference. |
| H03 | Core total before order 105, cap 25; attributable partial debit 10, matching hold 15 | Raw total 95, usable 80. Deduct 15 once, not debit 10 or hold 15 twice. Until finality, keep the unused cap reserved. |
| H04 | Fill 5 of requested 10, status says `filled` | Credit only five custody-confirmed shares at net value. Terminal status and attribution still required to free remainder. |
| H05 | Outer `ok`, per-order no-match; hold zero before action processed | No credit. Zero hold alone does not release reservation or busy state; finality proof is required. |
| H06 | Response lost after fill; restart before journal response write | Recover existing on-chain intent/cloid; no second send. Replayed EVM call cannot emit another Core action. |
| H07 | Unexpected resting remainder; cancellation sent but not processed | Remove no reservation on EVM receipt; no next order. Cancel/reconcile remains callable. |
| H08 | Donation or unrelated settlement matches requested share/cash delta | Do not use delta alone as terminal proof. Attribution must account for all known activity; donated assets cannot authorize a late second debit. |
| H09 | Hedge target exceeded, or two sides tied as worst requirement branch | Buy only if actual clipped candidate lowers portfolio requirement and passes economic screen; no mandate to reach target. |
| H10 | Two intents at 25 exceed rolling submitted-cap 100 or inventory-cost cap 100 | Reject before dispatch. Partial/no-fill does not refund the rolling submission budget; pending cap counts toward inventory cap. |
| H11 | Cost 25, predicted requirement reduction 30 | Reject economic screen: 25 > 0.8*30=24, even though cash is sufficient. This is capital efficiency, not a profitability claim. |
| H12 | 100 gross proceeds, 50-bps bound plus 0.01 fixed allowance | Credit <=99.49. Actual 99.86 replaces that credit once on reconciliation; no gross 100 credit. |
| H13 | 1 outcome raw unit, fractional result, USDC remainder <100 Core raw units | Floor credits and transfers; ceil fees. Dust never rounds up to backing; invalid lots never force larger spend. |
| H14 | Huge uint amounts, price*size product, complementary fraction underflow, asset-ID overflow | Reject before narrowing/encoding; no wrapped cap or outcome identity. |
| H15 | Actual fee regime exceeds bound or charges unsupported token | Disable new credit/trades; retain all full claims and identify any existing shortfall. Pausing is not proof old promises are funded. |
| H16 | Maker/owner/agent tries raw actions, fee approval, transfer, mode change or credited sale | No bypass. Permitted future sale removes credit before send and does not pre-credit proceeds. |

Order-finality attack requiring a ruling: attest terminal/no-fill, observe zero
hold, release 25, spend/withdraw it, then deliver the delayed original order.
Show why the chosen proof mechanism makes that schedule impossible, or document
the accepted verifier trust and retain the reserve when its evidence is absent.
An API query, minimum waiting period or replay-protected cloid is not itself that
proof. Existing KeeperVerifier's mutable delay does not supply a trustless barrier.

## 3. Settlement, refund and claim sequences

Run each sequence with Core credit before/after EVM outcome recording, token
reads unavailable, and keeper downtime. Failure paths must preserve all debts.

| ID | Setup / ordering | Expected result |
| --- | --- | --- |
| S01 | One leg loses, another fractional; both known when resolve runs | Dead; release maker liability only with resolution and send only margin ticket's premium to maker. Legacy full-escrow ticket returns full pot. |
| S02 | Fractional leg first, another unresolved; resolve Void/refund; later other leg loses | Early Void remains final. Refund exactly premium once; never revive Dead or pay fractional max payout. |
| S03 | Fraction known on Core while EVM ticket still Open | No release from raw status alone. Synchronize all affected liabilities and hedge repricing before publishing new capacity. |
| S04 | Fraction 0.25; holding 100 YES/100 NO; multiple assigned tickets | Gross hedge conversion 25/75 separately, less fees, counted once. Resolve ticket loss/void precedence independently of hedge cash. |
| S05 | All legs win, maker liability 80, net hedge receivable 50 not yet cash | Keep full debt 80; deterministic group requirement 30. Available EVM cash can pay only if remaining backing survives. Won does not mean Paid. |
| S06 | S05 credit arrives as 50 Core USDC | Remove receivable credit 50 while recognizing cash 50 in one checkpoint. Requirement rises by at most 50; backing does not duplicate. |
| S07 | Credit already included in Core total but old hedge shares still cached | No hedge-plus-cash double credit or new admissions from a mixed checkpoint. |
| S08 | Two settlements produce one aggregate cash delta; one wrong status-3 fraction | No independent use of full delta per event; recorded history and net attribution required. Wrong fraction cannot manufacture settlement money. |
| S09 | Outcome reads fail/code -32003, status 3, keeper missed recording fraction | Do not interpret failure as zero or reconstruct payout from a price. Freeze disputed capacity, keep entitlements, expose recovery/shortfall status. |
| S10 | Refund transfer fails after Void decision | Atomic rollback or explicit full refund liability backed by retained premium; no burned unpaid entitlement. |
| S11 | Winning claim lacks EVM cash; Core settlement credit exists | Keep NFT/full amount, show funding pending, allow permissionless fixed-destination funding and later full payment. |
| S12 | Claim consumes buffer below target | Allow if remaining solvency holds; stop new issuance/buys until buffer restored. Do not make a buffer floor block its intended payout use. |
| S13 | NFT transferred between Won recording and payment; third party triggers payout | Exactly current holder receives full M; caller cannot redirect. Replay fails after successful payment. |
| S14 | Cash genuinely insufficient, not merely in transit | Explicit backing shortfall; no payout haircut and no invented pending-transfer status. Top-up and safe recovery remain possible. |
| S15 | Two simultaneous wins larger than one-ticket buffer | No promise of instant payment for both. Preserve both debts and prioritize funding; paying one must preserve backing for the other. |
| S16 | Claim auto-resolve hits Dead/Void and whole call reverts as current code can | Separate permissionless resolve remains available; no off-chain release on reverted receipt. |
| S17 | One settled assignment retained vs repointed to another unresolved leg | Both valid assignments, subject to post-action bound. No forced increase/deadlock just because the original leg became known. |

Particularly attack the settlement-receivable assumption: prove an authenticated
fraction and net-fee bound establish the lower payoff before credit, and define
what happens if conversion is delayed, pruned or short. Test the **whole** set of
affected tickets, not one while sibling debts retain stale branches. Any proposed
batched sync must block capacity until all entries are coherent.

## 4. Transfers and withdrawals

| ID | Setup / ordering | Expected result |
| --- | --- | --- |
| T01 | Settled Core 80, EVM 20, unpaid liability 80; sweep 80 with separately funded fee | Existing coverage may pass through T while cash moves. No requirement to double-fund transfer principal; no new risk/withdrawal using T. Claim waits for actual EVM money. |
| T02 | Source still shows 80 after dispatch; T records 80 | Source reservation removes 80 from cash. It is not counted as Core cash plus T. |
| T03 | Source debit visible, destination not yet credited | Source reservation retires against actual debit, T stays once. Fee already reserved; no spontaneous capacity. |
| T04 | Destination credited before source read reflects debit | Credit destination once and keep source debit reservation until reconciled; no two-account double count. |
| T05 | Donation 80 arrives before the expected sweep; actual sweep arrives later | Donation can fund real claims, but remaining in-flight principal/source debit must be reconciled once. No early clearing creates extra backing. |
| T06 | Exact-balance send, fee-on-top shortage, dust amount or silent drop | Cap/rounding rejects before send where detectable; otherwise pending state survives until authenticated failure. No blind resend or admin erasure. |
| T07 | Sweep while quote hold >0, order unresolved or other transfer active | Reject; serialize account operations. Funding failure cannot be papered over by another overlapping send. |
| T08 | Only unsettled hedge reduces R: cash80, F80, hedge50 | No withdrawal even without buffer; with B80 also no withdrawal. New capacity is not withdrawable cash. |
| T09 | EVM110, Core50, F80, B80, no pending/unpaid claims | Withdrawable zero: total cash exactly F+B. EVM balance alone does not permit 30 out. |
| T10 | EVM130, Core50, F80, B80, no pending/unpaid claims | Maximum 20 by retained-cash rule, despite EVM-minus-buffer being 50. One raw unit more rejects. |
| T11 | Same money as T10 but unpaid Won/refund or unsettled accounting | Withdrawals paused; safe funded claims/recovery permitted. |
| T12 | All tickets/reservations/operations clear | B becomes zero; only reconciled actual EVM surplus is withdrawable. No perpetual dust/empty-portfolio buffer lock. |

Compare against OutcomeVault reuse explicitly: `clearOutbound`, 99% payout
tolerance and pro-rata redemption are forbidden for full parlay entitlements.
Demonstrate a credible delivery/failure proof for transfers; a send receipt or
owner resetting counters cannot erase a possible late debit/delivery.

## 5. Quotes, limits and availability

| ID | Setup / ordering | Expected result |
| --- | --- | --- |
| Q01 | Two maker processes sign concurrent commitments against the same cash | On-chain reservations serialize full L, buffer and slots before signatures escape; over-cap reservation rejects. |
| Q02 | Relay selects another maker, user retains losing quote | Reservation remains until consumed/chain-expired; selection is not revocation. |
| Q03 | Signed old quote, then refreshed quote with different payout | Both reserve capacity while live; new terms require explicit user acceptance. No silent substitution. |
| Q04 | Deadline equality, stale local wall clock, late inclusion | Equality can mint as current contract allows; only strictly later chain timestamp releases reservation. Submission before expiry does not guarantee success. |
| Q05 | Feed disconnect after signing, before mint | Stop issuance, retain old reservation. Mint still checks original signature/deadline/unsettled-leg rules; pause is not cancellation. |
| Q06 | Claim pays or maker withdraws while quotes remain live | Q/slot/buffer constraints retained; all still-valid reserved mints remain accounted for. |
| Q07 | Maker fills all 32 tickets while 16 other quotes are reserved | Reject at combined active-plus-reserved limit, not only at mint. Reserve event slots/concentration too. |
| Q08 | Repoint to reduce assigned concentration while all tickets still contain event A | Per-event 300 cap counts all full liabilities containing A, regardless of assignment or side. |
| Q09 | Margin limits reduced below existing exposure; registry source/signer changed | Stop new risk as appropriate; retain old obligations and stored source. No retroactive liquidation, erased debt or redirected payouts. |
| Q10 | One cheap ask, large required quantity, ample expensive depth outside cap | Reject requested size; VWAP cannot include unavailable/out-of-cap shares. Smaller size gets new terms/acceptance. |
| Q11 | Spread exactly 0.05 but >10% midpoint, missing side, crossed book | Strict quote rejects; both thresholds and valid sides required. |
| Q12 | Heartbeats fresh but snapshot older than 2s; future venue time; reconnect cached book | Strict quote rejects until fresh valid per-leg snapshot. |
| Q13 | Testnet demo book unavailable during live game; valid explicit prior | Label fallback and actual source, enforce TTL/collateral/limits, award no hedge credit. Does not pass strict pricing validation. |
| Q14 | Production or strict-validation path receives demo fallback | Reject fallback in that path; no implicit exception. |
| Q15 | Strict 10s quote vs relay 8s remaining/UI refresh<10s | Timing must be aligned and tested; approval precedes final quote; reserve inclusion must not force silent refresh loops. |
| Q16 | Crash after reservation before signing, before mint index catches up, or expiry reorg | Recover from chain-bound digest/reservation; never release solely from local journal state. |

## 6. S11 property-test handoff

Build the smallest existing-tooling model that generates interleavings of
reserve/sign/mint, partial debit/fill, settlement/resolve, transfer debit/arrival,
claim, donation, withdrawal and restart. Include raw-unit boundary values and
fee maxima. Keep oracle logic independent from the candidate implementation.

Required properties:

1. Every claim stays at full promised amount until full payment; every premium
   has one owner/purpose; no paid or refunded ticket pays twice.
2. Every inventory/USDC unit has at most one backing representation; a malicious
   caller cannot change an operation's cap, destination, identity or expiry.
3. Bound >= exact outstanding scenario requirement at coherent checkpoints;
   accepted voluntary transitions preserve backing throughout, including spend
   before fill. An unresolved observation cannot authorize a risky transition.
4. Pending signed quotes, holds, unspent order caps and source transfer reserves
   are neither omitted nor deducted twice. Expiry, failure and replay ordering
   cannot create available money.
5. Withdrawal never depends on unsettled hedge/receivable/transit credit; every
   successful claim leaves remaining obligations backed, even below target B.
6. Honest terminal execution/delivery evidence eventually unlocks safe recovery;
   absence of a keeper does not prevent a permissionless caller from using
   already available authentic evidence. If a verifier is required to create
   that evidence, document that liveness dependency rather than hiding it.
7. Worst-cap portfolio scans fit the target chain transaction gas constraints;
   failures do not partially delete obligations. No anchor edits or deployments
   are needed to establish simulation behavior.

## Rulings ledger

| Area | Status | Required resolution |
| --- | --- | --- |
| M01–M12 calculation / assignment | Pending | Bound plus deterministic-settlement extension; preserve known conservative gaps. |
| H01–H16 custody / fills / fees | Pending | Concrete terminal proof and enforceable fee envelope; no agent/admin bypass. |
| S01–S17 resolution / claims | Pending | Full entitlements and safe asynchronous receivable-to-cash replacement. |
| T01–T12 transfers / withdrawals | Pending | Single ownership representation and authenticated delivery/failure recovery. |
| Q01–Q16 reservations / limits / pricing | Pending | Firm-quote capacity, gas bounds and explicit testnet/strict separation. |

Next-session prompt: read S9 and this pack, run the two existing evidence
verifiers, then perform the roadmap's S10 adversarial review with 2–3 independent
reviewers and write concrete rulings/counterexamples here and into S9. Design and
offline checks only; preserve current dirty work/private configuration, v1,
deployed v2, production and server state. No implementation, transactions,
deployment, account changes, service restarts or automatic commit/push.
