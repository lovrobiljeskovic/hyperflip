# Margin calculation comparison — September 18, 2026

Offline design calculation, authorized during the margin discussion. No runtime
code/configuration edits, network calls, dependencies or transactions. The checker
uses integer USDC for illustrations. Hedge amounts are conservative **net terminal
proceeds**, not share quantities, purchase costs or a universal assumed fee rate.
Maker liability excludes user premiums retained separately in parlay escrow.

## Reference calculation

For every allowed binary outcome combination `s`:

```text
uncovered(s) = total winning-ticket maker liabilities(s)
               - total confirmed net hedge proceeds(s)
R_exact = max(0, maximum uncovered(s))
```

Each hedge is counted once across the portfolio. Current cash is compared with
the requirement separately, after purchase costs and applicable reservations.
This is a terminal-state reference under the model's assumptions, not a complete
on-chain solvency invariant or a claim that cash is immediately withdrawable.

## Proposed one-leg bound

Assign each ticket to one of its own legs. For each distinct binary event `e`,
calculate assigned liabilities and hedge proceeds in its YES and NO states:

```text
R_e = max(0, assignedLiability(e, YES) - netHedge(e, YES),
             assignedLiability(e, NO)  - netHedge(e, NO))
R_assigned = sum R_e
```

A winning parlay necessarily has a winning assigned leg. Therefore its actual
liability indicator is no greater than that leg's indicator. Sum those liability
bounds, subtract each hedge once, and bound each event's contribution by its
maximum. This gives `R_exact <= R_assigned` in this binary model for every valid
assignment, not merely the best one. Nonnegative liabilities and hedge proceeds
also give `R_assigned <= sum of full maker liabilities`.

This checker groups by the actual event identity. It does not collapse independent
outcomes sharing a sentinel question ID, infer partitions from labels, or assume
that different outcomes are mutually exclusive.

## Actual results

| Portfolio | Exact | Best assignment bound | Extra cash |
| --- | ---: | ---: | ---: |
| A&B ticket owes 80; no hedge | 80 | 80 | 0 |
| Same ticket; A-YES hedge pays 50 net | 30 | 30 | 0 |
| A&B owes 80 and A&C owes 40; A-YES hedge pays 50 | 70 | 70 | 0 |
| A&B owes 80; A-YES and B-YES hedges each pay 50 | 0 | 30 | 30 |
| A&B and A&not-B each owe 80; A-YES hedge pays 50 | 30 | 80 | 50 |
| A&B owes 80; A-YES hedge pays 80 net | 0 | 0 | 0 |
| A already won; B is unresolved; B-YES hedge pays 50 | 30 | 30 | 0 |

The assigned method can lose useful offsets even after trying every assignment.
For the opposite-B tickets, at most one wins. Exact coverage recognizes that plus
the common A hedge; the assignment shortcut cannot fully express both together.
For split A/B hedges, exact coverage sees both proceeds when the parlay wins;
one assigned leg recognizes only its own group's contribution to that ticket.

Independent unsafe-shortcut checks: two identical 80-liability tickets with one
50 hedge need **110**, not 60; a 100-payoff A-NO hedge gives no relief against an
A-YES & B-YES ticket. Confirmed inventory must not be credited per ticket twice
or merely valued at its current market price.

The checker exhaustively covered **3,645 portfolios and 13,041 assignments**:
zero to two tickets, each using A/B YES/NO combinations and liability 40 or 80;
each of four hedge buckets pays 0, 40 or 80 net. All satisfy
`exact <= assigned <= full liabilities`. Three-event sharing and partial-resolution
illustrations are additional named checks, not part of that exhaustive domain.

## Reproduce and scope

```bash
python3 docs/evidence/2026-09-18-margin-calculation/verify.py
```

Actual output is in `verification.txt`; `SHA256SUMS` covers the saved files.
The initial run had a misspelled stdlib import, corrected before the successful
checks. No assertion failure in the mathematical examples was encountered.

Not covered: fractional/early-void transition ordering, Core execution/settlement
delays, pending orders or signed quotes, borrow/lend state, fees varying beyond
the assumed net bound, custody enforcement, won-unpaid transitions, cash sweeps,
rounding in production units, EVM buffer size, gas cost or withdrawal safety.
An exact reference scales exponentially with event count; this small enumeration
is a test oracle, not a proposed unrestricted on-chain loop.

Recommendation remains provisional: use the assignment bound for a simple first
implementation if its capital cost is acceptable, with this exact reference as
an adversarial check. Formalize the omitted states in S9 and review in S10 before
money-path implementation. The user authorized calculation, not deployment or
automatic acceptance of the assignment architecture.
