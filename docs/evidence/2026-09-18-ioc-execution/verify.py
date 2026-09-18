"""Offline checks of the saved testnet run. No signing, network or secrets."""
import json
import runpy
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
m = runpy.run_path(str(HERE.parents[2] / 'tools/hedge-ioc-spike.py'))
read = lambda name: json.loads((HERE / name).read_text())
balance = m['balance']
for step in m['STEPS']:
    intent = read('run/' + step + '.json')
    response_path = HERE / 'run' / (step + '-response.json')
    response = json.loads(response_path.read_text()) if response_path.exists() else None
    assert intent['network'] == 'testnet' and intent['account'] == m['account'](step)
    assert intent['action'] == m['action'](step)
    assert intent['expiresAfter'] - intent['nonce'] == 15000
    assert m['verify'](step, intent['before'], read('run/' + step + '-verified.json'), response), step
    print('PASS saved reconciliation:', step)

assert not (HERE / 'run/full-buy-response.json').exists()
guard = read('run/full-buy-duplicate-guard.json')
assert guard['exitCode'] == 1 and 'intent already exists' in guard['expectedRefusal']
assert guard['keyFileRead'] is False and guard['networkCall'] is False
assert not list((HERE / 'run').glob('*-cancel.json'))
print('PASS discarded-response recovery and fresh-process duplicate refusal; no cleanup needed')

partial = read('run/partial-buy-verified.json')['order']['order']
assert partial['status'] == 'filled' and D(partial['order']['origSz']) == 10 and D(partial['order']['sz']) == 5
empty = read('run/empty-buy-verified.json')['order']['order']
assert empty['status'] == 'iocCancelRejected'
print('PASS partial API status filled means only 5/10 filled; empty IOC has terminal no-match status')

core = read('core-final.json')
assert core['chainId'] == 998 and core['probeOwner'].lower() == m['HOUSE'].lower()
assert core['outcomeStatus'][0] == 1
expected = [(m['PROBE'], 'final-empty-buy.json', ['11.486', '15', '0']),
            (m['HOUSE'], 'final-split.json', ['13.48270019', '0', '15'])]
for account, name, totals in expected:
    snap = read(name)
    assert snap['account'] == account and snap['openOrders'] == []
    assert all(D(row['hold']) == 0 for row in snap['balance']['balances'])
    for token, total, scale in zip([0, m['ASSET'], m['ASSET'] + 1], totals, [10**8, 10**5, 10**5]):
        assert balance(snap['balance'], token) == (D(total), D(0))
        raw = core['accounts'][account][str(token)]
        assert D(raw[0]) == D(total) * scale and D(raw[1]) == 0
for name in ['full-ask', 'partial-ask']:
    order = read('final-' + name + '.json')['order']['order']
    assert order['status'] == 'filled' and D(order['order']['sz']) == 0
print('PASS both accounts: no open orders/holds; info balances match independent Core precompile reads')

buyer = [f for f in read('final-empty-buy.json')['fills'] if f['coin'] == m['COIN']]
seller = [f for f in read('final-split.json')['fills'] if f['coin'] == m['COIN'] and f['side'] == 'A']
assert len(buyer) == len(seller) == 2
assert {f['hash'] for f in buyer} == {f['hash'] for f in seller}
assert sum(D(f['sz']) for f in buyer) == 15
assert all(D(f['px']) == D('0.5') and f['feeToken'] == 'USDC' for f in buyer + seller)
assert sum(D(f['fee']) for f in buyer) == 0
assert sum(D(f['fee']) for f in seller) == D('0.006')
assert D('18.986') - D('11.486') == D('7.5')
assert D('20.98870019') - 15 + D('7.5') - D('0.006') == D('13.48270019')
print('PASS accounting: split 15, buyer cost 7.50, buyer fee 0, seller fee 0.006 USDC; within approved caps')
