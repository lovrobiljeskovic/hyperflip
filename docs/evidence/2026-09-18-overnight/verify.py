"""Offline checks for the preserved S8a/S2b evidence; performs no network calls."""
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def load(name):
    return json.loads((ROOT / name).read_text())

def date(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))

chain, server, public = load('chain.json'), load('server.json'), load('public-api.json')
tickets = {int(p['id']): p for p in chain['tickets']}
p = tickets[3]
vault = '0x075b4c6a7ce42890d839f774abfe8206f3c18a76'
assert chain['chainId'] == 998 and chain['nextId'] == '5'
assert {i: p['status'] for i, p in tickets.items()} == {1: 0, 2: 0, 3: 2, 4: 0, 5: 0}
assert chain['receipt']['status'] == 'success'
assert chain['receipt']['transactionHash'] == chain['transaction']['hash']
assert chain['receipt']['blockHash'] == chain['resolutionBlock']['hash']
assert chain['transaction']['to'].lower() == vault
assert chain['transaction']['from'].lower() == p['writer'].lower()
assert chain['call'] == {'functionName': 'resolveParlay', 'args': ['3']}
assert any(x['address'].lower() == vault and x.get('eventName') == 'ParlayResolved'
           and x['args'] == {'id': '3', 'status': 2} for x in chain['decodedLogs'])
payments = [x for x in chain['decodedLogs'] if x['address'].lower() == chain['usdc'].lower()
            and x.get('eventName') == 'Transfer' and x['args']['from'].lower() == vault
            and x['args']['to'].lower() == p['writer'].lower()]
assert len(payments) == 1 and payments[0]['args']['value'] == p['maxPayout'] == '959514'
assert any(chain['legs'][l['vault']]['settled'] and l['isYes']
           and chain['legs'][l['vault']]['settleFractionWad'] == '0' for l in p['legs'])
a_events = server['journals']['maker-v2@a']['events']
assert any(e['event'] == 'parlay-resolution-receipt' and e['id'] == '3'
           and e['hash'] == chain['receipt']['transactionHash'] for e in a_events)
assert not server['journals']['maker-v2@b']['events']
keeper = load('keeper-receipt.json')
assert keeper['receipt']['status'] == 'success' and keeper['settledAtResolution']
assert keeper['fractionAtResolution'] == '0'
assert keeper['transaction']['from'].lower() == keeper['storedKeeper'].lower()
assert keeper['call'] == {'functionName': 'settle', 'args': ['0']}
assert int(keeper['receipt']['blockNumber']) < int(chain['receipt']['blockNumber'])
print('PASS G1: successful Dead(3) receipt; maker A sender; full 959514 USDC units paid to stored A')
print('PASS losing leg: keeper settlement succeeded before resolution; fraction 0 at resolution block')
print('PASS tickets: 1/2/4/5 Open, 3 Dead; retained B journal contains no poke/receipt/failure attempt')

rows = [json.loads(x) for x in (ROOT / 'settlement-19467.jsonl').read_text().splitlines()]
obs = [x for x in rows if x['event'] == 'settlement-observation']
assert len(obs) == 612 and len(rows) == 614
assert all(x['chainId'] == 998 and x['outcome'] == 19467 for x in rows)
assert all(len(x['reads']) == 4 for x in obs)
by_name = {n: [next(r for r in x['reads'] if r['name'] == n) for x in obs]
           for n in ['outcome', '0', '100194670', '100194671']}
outcomes, balances = by_name['outcome'], by_name['0']
assert {r['status'] for r in outcomes if r['ok']} == {1, 2, 3}
assert {r['total'] for r in balances if r['ok']} == {'900000000', '1898600000'}
settlements = [f for f in public['userFills'] if f['dir'] == 'Settlement']
assert len(settlements) == 2 and {f['coin'] for f in settlements} == {'#194670', '#194671'}
gross = sum(Decimal(f['px']) * Decimal(f['sz']) for f in settlements)
fees = sum(Decimal(f['fee']) for f in settlements)
assert gross == 10 and fees == Decimal('0.014')
assert int((gross - fees) * 10**8) == 1898600000 - 900000000
assert all(f['feeToken'] == 'USDC' and f['time'] == 1789704605427 for f in settlements)
assert not [f for f in public['userFills'] if f['dir'] != 'Settlement' and f['time'] >= 1789682100000]
assert not [x for x in public['userNonFundingLedgerUpdates'] if x['time'] >= 1789682100000]
assert next(b for b in public['spotClearinghouseState']['balances'] if b.get('token') == 0)['total'] == '18.986'
for provider in ['configured']:
    fresh = load('precompile-recheck.json')['providers'][provider]
    assert int(fresh[0]['result'][2:66], 16) == 3
    assert int(fresh[1]['result'][2:66], 16) == 1898600000
print('PASS S2b item 4: gross 10 - fee 0.014 = net 9.986 USDC; final 18.986; fresh status 3')

summary = {'rows': len(rows), 'observations': len(obs), 'first': obs[0]['at'], 'last': obs[-1]['at'],
           'maxSampleStartGapSeconds': max((date(b['reads'][0]['startedAt']) - date(a['reads'][0]['startedAt'])).total_seconds() for a, b in zip(obs, obs[1:])),
           'transitions': {}, 'errors': {n: sum(not r['ok'] for r in rs) for n, rs in by_name.items()}}
for label, rs, predicate in [('settled', outcomes, lambda r: r.get('status') == 2),
                              ('credited', balances, lambda r: r.get('total') == '1898600000'),
                              ('pruned', outcomes, lambda r: r.get('status') == 3),
                              ('yesReadFailure', by_name['100194670'], lambda r: r['startedAt'] > '2026-09-18T04:10' and not r['ok']),
                              ('noReadFailure', by_name['100194671'], lambda r: r['startedAt'] > '2026-09-18T04:10' and not r['ok'])]:
    i = next(i for i, r in enumerate(rs) if predicate(r))
    summary['transitions'][label] = {'lastPre': rs[i-1], 'firstPost': rs[i]}
a, b = summary['transitions']['settled'], summary['transitions']['pruned']
summary['settledToPrunedSecondsBounds'] = [(date(b['lastPre']['startedAt']) - date(a['firstPost']['observedAt'])).total_seconds(),
                                         (date(b['firstPost']['observedAt']) - date(a['lastPre']['startedAt'])).total_seconds()]
(ROOT / 'timeline-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print('PASS observer: 612 samples, two starts; max start gap %.3fs; errors %s' % (summary['maxSampleStartGapSeconds'], summary['errors']))
print('GAP: token reads fail with rpc-error; no zero-balance/revert proof or kickoff order/cancel observations')

final = load('health-final.json')
units = [dict(line.split('=', 1) for line in block.splitlines()) for block in final['units'].strip().split('\n\n')]
assert len(units) == 7 and all(u['ActiveState'] == 'active' and u['SubState'] == 'running' for u in units)
for name in ['a', 'b']:
    assert final[name]['http'] == 200 and final[name]['ok'] and final[name]['seeded']
    assert int(final['indexes'][name]['scannedTo']) > int(server['indexes'][name]['scannedTo'])
    assert {x[0] for x in final['indexes'][name]['parlays']} == {'1', '2', '3', '4', '5'}
assert final['a']['openParlays'] == 3 and final['b']['openParlays'] == 1
assert final['relay']['http'] == 200 and final['relay']['ok']
assert final['caddyV1Health']['curlExit'] == 0 and final['caddyV1Health']['ok']
assert all(not v['listening'] for v in load('checkout.json')['laptopMakers'].values())
event = load('event-status.json')['header']['competitions'][0]
assert event['status']['type']['completed'] and event['status']['type']['name'] == 'STATUS_FINAL'
assert {c['team']['abbreviation']: c['score'] for c in event['competitors']} == {'BUF': '41', 'DET': '31'}
print('PASS current health: A/B/relay HTTP 200; indexes advancing with all five IDs; v1 via Caddy healthy; laptop makers off')
print('PASS event: ESPN final BUF 41, DET 31')
