"""Small binary terminal-state model; no network, signing or application imports.

Amounts are integer USDC for illustration. Hedges specify conservative NET
terminal proceeds, not quantities, market values or assumed fee schedules.
Ticket liability already excludes the separately escrowed user premium.
"""
from itertools import combinations_with_replacement, product


def scenarios(tickets, hedges):
    events = sorted({e for _, legs in tickets for e, _ in legs} | {e for e, _ in hedges})
    return [dict(zip(events, values)) for values in product((0, 1), repeat=len(events))]


def exact_requirement(tickets, hedges):
    needs = []
    for state in scenarios(tickets, hedges):
        liability = sum(amount for amount, legs in tickets if all(state[e] == side for e, side in legs))
        proceeds = sum(amount for (e, side), amount in hedges.items() if state[e] == side)
        needs.append(liability - proceeds)
    return max(0, *needs)


def assigned_requirement(tickets, hedges, assignment):
    """Each ticket is assigned to one of its own legs; hedge deducted once/group."""
    assert len(assignment) == len(tickets)
    assert all(leg in ticket[1] for leg, ticket in zip(assignment, tickets))
    events = {e for e, _ in assignment} | {e for e, _ in hedges}
    return sum(max(0, *(sum(amount for (amount, _), leg in zip(tickets, assignment)
                               if leg == (event, side)) - hedges.get((event, side), 0)
                       for side in (0, 1))) for event in events)


def best_assignment(tickets, hedges):
    return min((assigned_requirement(tickets, hedges, assignment), assignment)
               for assignment in product(*(legs for _, legs in tickets)))


def run():
    ay, an, by, bn, cy = ('A', 1), ('A', 0), ('B', 1), ('B', 0), ('C', 1)
    ab = (80, (ay, by))
    cases = [
        ('One ticket; no hedge', [ab], {}, 80, 80),
        ('One ticket; A YES pays 50 net', [ab], {ay: 50}, 30, 30),
        ('Two tickets share A; liabilities 80+40; A hedge 50',
         [ab, (40, (ay, cy))], {ay: 50}, 70, 70),
        ('One ticket; A and B hedges each pay 50', [ab], {ay: 50, by: 50}, 0, 30),
        ('A&B and A&not-B; liabilities 80 each; A hedge 50',
         [ab, (80, (ay, bn))], {ay: 50}, 30, 80),
        ('One ticket; A YES pays 80 net', [ab], {ay: 80}, 0, 0),
        ('A already won; only B unresolved; B hedge 50',
         [(80, (by,))], {by: 50}, 30, 30),
    ]
    print('All figures: USDC; current cash and purchase costs are separate.')
    print('Example | exact terminal requirement | best one-leg bound | extra cash')
    for name, tickets, hedges, expected_exact, expected_bound in cases:
        exact = exact_requirement(tickets, hedges)
        bound, _ = best_assignment(tickets, hedges)
        assert (exact, bound) == (expected_exact, expected_bound), name
        print(f'{name} | {exact} | {bound} | {bound - exact}')

    # Independently known counterexamples to unsafe credit shortcuts.
    assert exact_requirement([ab, ab], {ay: 50}) == 110
    naive_per_ticket_credit = 2 * max(0, 80 - 50)
    assert naive_per_ticket_credit == 60 < 110
    assert assigned_requirement([ab, ab], {ay: 50}, (ay, ay)) == 110
    print('PASS duplicate-credit counterexample: two 80 liabilities need 110, not 60, with one 50 hedge')
    # A NO hedge never pays when A&B wins, regardless of its current price.
    assert exact_requirement([ab], {an: 100}) == 80
    assert best_assignment([ab], {an: 100})[0] == 80
    print('PASS wrong-side hedge: 100 A-NO payoff provides zero relief for A-YES & B-YES')

    # Exhaustive bounded domain: 0..2 tickets, A/B YES/NO combinations,
    # liabilities 40 or 80; four distinct hedge buckets with net payouts 0/40/80.
    templates = [(amount, (('A', a), ('B', b)))
                 for amount, a, b in product((40, 80), (0, 1), (0, 1))]
    hedge_legs = (an, ay, bn, by)
    portfolios = assignments_checked = 0
    for count in range(3):
        for tickets in combinations_with_replacement(templates, count):
            for amounts in product((0, 40, 80), repeat=4):
                hedges = dict(zip(hedge_legs, amounts))
                exact = exact_requirement(tickets, hedges)
                for assignment in product(*(legs for _, legs in tickets)):
                    bound = assigned_requirement(tickets, hedges, assignment)
                    assert exact <= bound <= sum(amount for amount, _ in tickets)
                    assignments_checked += 1
                portfolios += 1
    assert portfolios == 3645 and assignments_checked == 13041
    print(f'PASS all {portfolios} binary portfolios / {assignments_checked} assignments: '
          'exact <= assignment bound <= full maker liabilities')
    print('LIMIT: terminal binary model only; not a full solvency/withdrawal/claim proof.')


if __name__ == '__main__':
    run()
