# IOC execution test — approved run passed

Prepared September 18, 2026. This validates the existing contract-account hedge
path before the live-quoting discussion; it does not enable MarginVault credit.
The user approved the exact split/orders/caps below. Signed steps completed at
08:59–09:03 UTC; independent Core reads confirmed final balances at 09:07 UTC.
**Full fill, partial fill, empty-book no fill and discarded-response recovery
passed.** See [saved evidence and checks](../../evidence/2026-09-18-ioc-execution/README.md).
The sequence below records the approved experiment; do not rerun it.

## Existing accounts and read-only preflight

- Chain: HyperEVM testnet **998**; all exchange/info calls use the testnet host.
- Existing HedgeProbe: `0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E`.
  Owner: `0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D` (counterparty).
- Existing agent: `0x4328154291e79869Ba76017586533A6Bc50Cf273`. Introduced in
  the September 16 spike through CoreWriter action 9; its local scratch key was
  found and its public address checked without displaying the key. Empty
  `extraAgents` does not prove absence of the unnamed/main agent.
- Probe: **18.986 USDC**, no open orders/holds. Counterparty:
  **20.98870019 USDC**, no open orders/holds. Both have zero YES/NO for this market.
- Market: **19468, SEA/ARI**, scheduled September 20, 20:25 UTC in its metadata.
  Outcome precompile returns active (1). YES asset **100194680**, coin `#194680`;
  NO **100194681**. Both books were empty at 08:38:43–44 UTC. Refresh before each
  action; these snapshots do not guarantee an unchanged book.
- Fee scale 1; both accounts report spot cross/add rates 0.0007/0.0004. Recheck
  before each action; stop on a scale/rate change exceeding the stated allowance.

Saved [preflight evidence](../../evidence/2026-09-18-ioc-preflight/README.md).
No live game is required for execution mechanics; the kickoff question is not
being reopened. This market is distinct from the legs of v2 tickets 1–5.

## Approved sequence executed

Orders are YES only, limit **0.50 USDC/share**, no builder fee, no price chasing.
All client IDs and exact API actions are in
[orders.json](../../evidence/2026-09-18-ioc-preflight/orders.json).

| Step | Actor / action | Expected observation |
| --- | --- | --- |
| 1 `split` | Counterparty splits **15 USDC** into 15 YES + 15 NO on 19468 | Holdings +15 each; debit 15, plus any fee within 0.03 allowance |
| 2 `full-ask` | Counterparty rests **10 YES @ 0.50 GTC** | 10 YES held; ask visible |
| 3 `full-buy` | Probe agent buys **10 YES @ 0.50 IOC**; deliberately discard response | Reconcile from a new process: +10 YES, 5 USDC plus fee debited; no resting remainder or hold |
| 4 `partial-ask` | Counterparty rests remaining **5 YES @ 0.50 GTC** | 5 YES held; ask visible |
| 5 `partial-buy` | Probe agent requests **10 YES @ 0.50 IOC** | Exactly 5 fill, remaining 5 canceled; 2.5 USDC plus fee debited; no resting order/hold |
| 6 `empty-buy` | With ask book empty, probe requests **10 YES @ 0.50 IOC** | Explicit no-match/terminal cancellation, zero fill/debit/hold |

Step 3 also tests lost-response recovery: the intent, client ID, nonce, expiry and
balance baseline are flushed to disk before sending. The returned response is
intentionally not saved. A separate process reads order status, fills and balances;
another submission of that step is refused. This is controlled response-loss
injection, not a claim to have reproduced every transport failure.

## Spend, remaining positions, and abort conditions

- Probe expected purchase cost: **7.50 USDC**. Across all three IOC requests the
  maximum principal is **15 USDC**, plus **0.03 USDC trading-fee allowance**.
  Each order is at most 5 principal + 0.01 fee. Unplanned liquidity can produce
  more fills than expected; that makes the scenario fail/inconclusive, even though
  its price/quantity cap bounds exposure. Never raise size/price or auto-retry.
- Counterparty: **15 USDC split**, with **0.03 split-fee allowance** and **0.02
  seller-fee allowance**. Selling 15 YES returns about 7.50 USDC less fees.
  The split is a new Core share-creation action needing approval, not a parlay
  mint, new deployment, transfer into the accounts, or manual settlement.
- Expected end holdings: probe **15 YES**, counterparty **15 NO**. These remain
  directional positions in the respective accounts until natural settlement or
  a separately authorized unwind. Future settlement fees are additional; the
  overnight 14-bps observation is not a guaranteed fee schedule.
- Price and size are encoded bounds; fee allowances depend on refreshed venue
  rates and post-action reconciliation, not an API max-fee field. Stop on any
  discrepancy. No additional funds are needed at the observed balances.
- If a supplied ask fills unexpectedly, a buy is rejected, an outcome disappears,
  state is uncertain, or another order/hold appears: stop. Reconcile; never repeat
  a signed step just because its output was missing. A minimum-notional rejection
  does not pass the empty-book test; do not increase the budget to bypass it.
- Cleanup authority granted: cancel only this experiment's two counterparty
  asks by their client IDs if they remain open. Verify their terminal status and
  released holds; no account-wide cancel. Unexpected fills remain held and logged.
- These trades change this public **testnet** book/last-trade price and may be
  observed by existing quote services. A controlled counterparty proves mechanics,
  not organic liquidity. No production deployment/configuration or v1 unit changes.

## Runnable preparation and execution

Runner: [tools/hedge-ioc-spike.py](../../../tools/hedge-ioc-spike.py). It uses the
same already-cached SDK dependencies/signing approach as `tools/hip4.py`; no new
library dependency. State defaults to `/private/tmp/hype-ioc-20260918`; preserve
it across retries/restarts. Never change state directories to bypass an existing
intent. This is a bounded operator-driven spike, not a production hedge worker.

Safe checks (no network/signing for these two):

```bash
python3 tools/hedge-ioc-spike.py selftest
python3 tools/hedge-ioc-spike.py plan
```

The agent ran each step separately and checked its evidence before the next.
For reference, the command shape used was:

```bash
uv run --offline tools/hedge-ioc-spike.py send STEP --execute --key-file LOCAL_KEY_FILE
uv run --offline tools/hedge-ioc-spike.py reconcile STEP
```

Counterparty steps read the existing root `.env`; probe steps read the recovered
private local scratch file. No key contents go on the command line or into logs.
For `full-buy` only, add `--discard-response`. `reconcile` sends **no** signed
requests. A pending result means another read/inspection, never another send.
For abort cleanup, `cancel full-ask` or `cancel partial-ask` accepts the same
explicit execution/key flags, then `snapshot STEP` verifies status/holds. A
recorded cancel attempt prevents later order submission in that state directory.
No service process is killed or restarted for the process-recovery test.

The runner checks Core state through the info API. Independent post-run `0x801`
reads through the configured testnet RPC matched both accounts' holdings/holds.
Probe spent 7.50 USDC, fee zero; counterparty split 15, split fee zero, and paid
0.006 USDC seller fees. Final probe: 11.486 USDC + 15 YES. Final counterparty:
13.48270019 USDC + 15 NO. Both supplied asks filled; no open orders or holds,
so no cancellation was required. Positions remain for natural settlement or a
separately authorized unwind. Native Core shares were created/traded, not ERC-20
wrappers or v2 parlay tokens.

The partial IOC reports `status=filled`, `origSz=10`, `sz=5`; fills and balance
delta prove only 5 bought. The empty IOC reports `iocCancelRejected` and a
per-order no-match error inside outer `status=ok`. Neither status shortcut is
sufficient to calculate hedge credit. Full-buy response was discarded; a fresh
process recovered the fill and another send invocation was refused before any
key read/network call. This does not reproduce every real crash/transport fault.

## Validation performed

```text
python3 tools/hedge-ioc-spike.py selftest: PASS
uv run --offline tools/hedge-ioc-spike.py selftest: PASS (cached SDK environment)
Fresh-process duplicate-send refusal: PASS
Unsigned invocation cannot submit or create an intent: PASS
Read-only chain/owner/outcome/balance checks: PASS
```

Live run and saved-evidence verifier also passed all six steps, recovery, no
remaining orders/holds, independent balances and fee accounting. Actual output
is in the linked evidence's `verification.txt`. Local frontend connectivity is separate: at the
check, port 3000 served HTML with 28 missing script assets, no relay listened on
8787/8788, and laptop makers were off. This spike exercises HedgeProbe, not the
v2 UI, and does not repair or start the local stack.
