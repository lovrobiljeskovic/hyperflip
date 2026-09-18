# Hedge spike findings (Stage 0) — testnet, 2026-09-16

**September 18 follow-up:** live order placement is established by the user's
OutcomeXYZ observation. Our kickoff trace remains uncollected; that gap does not
block S9 or require another dedicated kickoff test. User agreed to capped hedge
attempts with confirmed partial fills and retained backing for the remainder.
See [execution-policy input to S9](../../docs/superpowers/plans/2026-09-18-hedge-execution-policy.md).
The separately approved bounded IOC/recovery run passed September 18; see the
latest execution result below. App integration and margin relief remain pending.

**Latest September 18:** G1 PASS; S2b item 4 credit/pruning verified with limits,
item 6 unobserved. See the overnight result at the end of this file.

Run order: `script/spike/README-hedge.md`. Question: can a **contract's** Core account trade
an outcome book. Answer: **yes, both ways** (CoreWriter action 1 directly, and an agent key
added by action 9). Gate G0 passes; Stage 3 stays as designed.

Actors (testnet):

| Role | Address |
|---|---|
| House EOA (deployer sub-key, unified account) | `0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D` |
| `HedgeProbe` (contract under test) | `0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E` (deploy tx `0x18ddf7cc…54fb01`) |
| Agent key (throwaway, item 8) | `0x4328154291e79869Ba76017586533A6Bc50Cf273` |
| Market | outcome **19467** (flip, DET@BUF, kickoff 2026-09-18 00:15 UTC), question `0xffffffff` (standalone) |
| Encoded ids | YES `100194670`, NO `100194671`; API coin names `#194670` / `#194671` (= encoded id − 1e8) |

Reads: `forge script … readHold` cannot run — the forked local EVM has no precompiles
("call to non-contract address 0x…801"). Read 0x801 with `cast call` against the node
instead (helper used: abi-encode `(address,uint64)`, decode `(uint64,uint64,uint64)`).

## Setup

| Step | Tx | Result |
|---|---|---|
| EVM→Core 40 USDC, EOA (`approve` + `deposit(4e7, 0xffffffff)` on CoreDepositWallet) | `0x5037a5f8…3ce3`, `0x18c24d78…faf3d` | Core token 0 `1.00000019` → `41.00000019` USDC, zero fee |
| `spotSend(PROBE, 0, 2e9)` from the EOA via CoreWriter | `0xf54581fb…1fc9a` | Probe token 0 total `2000000000`. EOA lost `2.1e9`: **1 USDC account-activation fee charged to the sender** on the first send to a fresh Core address. CoreWriter action 6 works from a unified-account EOA (the API `spotSend` is disabled for unified accounts; CoreWriter is not). |

## Items

| # | Item | Tx | Observation | Verdict |
|---|---|---|---|---|
| 1 | Limit order from the contract (action 1): buy 10 YES @ 0.55 Gtc, cloid 1, `limitPx 55000000`, `sz 1000000000` | `0x04edbea9…62ff` | 0x801 token 0: total `2000000000`, **hold `550000000`**. `openOrders` for the probe: coin `#194670`, B, px 0.55, sz 10.0, oid `60271266560`, cloid `0x…01`. First try, no retry needed. | **VERIFIED** — encoded outcome id in `asset`, 1e8 scaling for both px and sz. |
| 2 | Resting / fill via 0x801. Counter-side: EOA split 10 USDC (`split(19467, 1e6)` tx `0xec7157be…b47d`, fee 0, appears in `userFills` as dir "Split Outcome" px 0.5) then API ask `{"a":100194670,"b":false,"p":"0.55","s":"10"}` → `filled totalSz 10.0 avgPx 0.55 oid 60271685672` | fill hash `0x4609020e…9e7c4` | Probe: token 0 total `2000000000` → `1450000000` (hold → 0), YES total `0` → `1000000`. EOA: +`550000000` − fee `0.0077` USDC. Raw int `a` = encoded id is accepted by the API (no `+<id>` name needed). No partial fill observed (sizes matched). | **VERIFIED** — fill visible on 0x801 for the contract address. |
| 2b | Precompile sweep 0x800–0x814 with the encoded id | read-only | **0x80e (bbo) serves outcome ids**: YES `(bid 55000000, ask 0)`, NO `(bid 0, ask 45000000)` — the NO book mirrors the YES book (complement). 0x808 returned `52500000` / `47500000` before any trade (not last-trade then; mid of bid and 0.5?) and `55000000` / `45000000` after the fills (= last trade, as documented). 0x803, 0x805, 0x814 return zeros; 0x810 `(addr,u64)` → 1 (Core account exists); others revert. No open-order precompile. | info |
| 3 | Cancel by cloid (action 11): rest cloid 2 @ 0.50 (`0x19ee67a5…c80a`, hold `500000000`, oid `60271818540`), cancel `0xa9942642…6370` | as listed | hold → `0`, `openOrders` empty | **VERIFIED** |
| 3 | Cancel by oid (action 10): rest cloid 3 @ 0.50 (`0x88c9f030…0d6e`, hold `500000000`, oid `60271871528`), cancel `0x9914bc4e…85e6d` | as listed | hold → `0`, `openOrders` empty | **VERIFIED** |
| 4 | Hold a fill through settlement | — | Probe holds **10 YES + 10 NO + 9 USDC** on outcome 19467 (status 1 at 2026-09-16 13:47 UTC). Settlement lands via the box `rotate` house sync after DET@BUF goes final (~2026-09-18 04:00 UTC). Read `0x814` + `0x801` for the probe then (every ~1 min from status 2): expect token 0 +`1000000000` (one side pays 1.0). Record delay, and whether 0x801 reverts / balance survives status 3. Cannot be forced early: the 10 flip slots are full and settling a live NFL market with a fake result is off the table. | **VERIFIED with limits — September 18 overnight result below** |
| 5 | Fees | fills above | Buyer (the probe) paid **0.0** both as maker (item 2) and as taker (item 8). Seller (EOA) paid `0.0077` USDC as taker on 5.5 notional (14 bps) and `0.0036` as maker on 4.5 notional (8 bps) = exactly **2× the spot schedule** (`userSpotCrossRate 0.0007`, `userSpotAddRate 0.0004`, both accounts identical tiers). Fee token USDC. Hypothesis: the USDC-receiving side pays; unverified which rule. Core→Core `spotSendVia(PROBE→EOA, 0, 1e8)` tx `0xc895dc73…4582c`: probe −`100000000`, EOA +`100000000`, **no fee** for the contract sender (holds no HYPE). | **VERIFIED** (numbers); builder fee below |
| 5b | Builder fee (action 12): `approveBuilderFee(PROBE, 10, EOA)` | `0x6d876361…2696` | `maxBuilderFee` stayed `0`; agent order carrying `"builder":{"b":EOA,"f":10}` rejected `"Builder fee has not been approved."`. Cause confirmed via the SDK from the EOA: `"Builder has insufficient balance to be approved."` (builder needs a funded perp account; EOA perp value 0). Layout untested. | **INCONCLUSIVE** — tag stays UNVERIFIED |
| 6 | Kickoff halt (DET@BUF 2026-09-18 00:15 UTC) | — | Not reachable today. Procedure unchanged (EOA 1-share order/cancel per minute from T−5 min, note first rejection string, `readHold` for stuck hold). | **PENDING** (resume row S2b) |
| 8 | Agent key (action 9): `addApiWallet(PROBE, AGENT, "")` | `0x1f2db9ab…72bb` | `extraAgents` for the probe lists nothing (empty name = main agent, not listed). Agent-signed order with `ACCOUNT_ADDRESS=PROBE`: `{"a":100194671,"b":true,"p":"0.45","s":"10"}` → `filled 10.0 @ 0.45 oid 60272061771` (hash `0xda5e5953…933e`) against the EOA's NO ask (oid `60271976504`; while resting, EOA NO token showed **hold `1000000`** — asks hold the outcome token). Probe 0x801: token 0 `1450000000` → `1000000000`, NO `0` → `1000000`. | **VERIFIED** — fill on 0x801 for the probe via the agent path. |

## Gate G0

**PASS.** Item 1 and item 8 both landed fills visible on 0x801 for the probe address.
Stage 3 proceeds as designed (S9 spec). Primary hedge path per §13.3 (agent key) and the
fully on-chain path (action 1 + cloid cancel) are both available.

## Inputs to the S9 margin-vault spec

- Sizing units: `limitPx`, `sz` = 1e8 × human. Balances: quote 8-dec, outcome 5-dec.
- Hold semantics: bid holds `px × sz` quote wei; ask holds `sz` outcome wei; both release
  fully on cancel, and fill moves hold to `total` in one step. Solvency = `total − hold`.
- The only on-chain order state is `hold` plus 0x80e bbo; no open-order precompile. A
  contract can cancel only by cloid (action 11) unless an off-chain party feeds it the oid.
- Fees: 2× spot schedule, charged to one side (the seller in both fills here); budget
  14 bps taker / 8 bps maker of notional in USDC. First send to a fresh Core address costs
  the sender 1 USDC. Core→Core spotSend from a HYPE-less contract showed no fee.
- Builder fees need a builder with a funded perp account; not usable from the house EOA as
  configured.
- `forge script` read steps against precompiles must go through `cast call`/a deployed
  reader, never the local simulation.

## Documentation review — 2026-09-16

S2b confirms our integration and measures timing; automatic settlement itself is
already documented. These are distinct from the verified on-chain observations above:

- [HIP-4 mechanics](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-4-outcome-markets)
  specify automatic conversion: YES pays `f` quote tokens per share, NO pays
  `1-f`. With 10 of each, the expected gross credit is 10 USDC even for a
  fractional result. No additional probe trades are needed for item 4.
- [Read precompiles](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)
  reflect Core state when the EVM block is constructed. Item 4 still needs our
  actual balance/status observations, credit timing, and post-pruning behavior.
- [Deployer actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-4-deployer-actions)
  require settlement consistent with the market metadata. The testnet
  `outcomeTemplates` response reviewed this session requires a real single
  scheduled sports contest for `sportsContestWinner` (template 7). A fabricated
  sports fixture is not a suitable shortcut to early settlement.
- No generic kickoff trading halt was found in the reviewed documentation or
  sports template. Item 6 must record acceptance/cancellation or rejection;
  it must not assume a halt will occur. Code review clarification: `writer/src/index.ts`
  disables house priors at `startMs` but permits book/spot-price fallback;
  `writer/src/maker.ts` applies its lockout against `expiryMs`. Neither establishes
  a blanket kickoff halt on Core. One fixture's result is not a universal guarantee
  of future hedge availability or liquidity.

User also reported seeing tradable live games on OutcomeXYZ on September 16.
This supports in-play availability; no post-kickoff fill receipt was inspected
for that report. S2b need not rediscover a presumed universal kickoff halt: focus
on order/cancel behavior for our fixture and settlement credit/pruning.

The template source is the testnet info API:
`POST https://api.hyperliquid-testnet.xyz/info` with `{"type":"outcomeTemplates"}`.
Recheck the template and active market metadata before any future deployment.
No new market was deployed for this review. G0 remains passed; S2b remains pending.

## Pending (row S2b, kickoff observation and later settlement)

### Resume observation — 2026-09-17 17:50 UTC

Fresh testnet `outcomeMeta` still identifies 19467 as DET@BUF, scheduled start
`20260918-0015`, resolution deadline `20260921-0015`.
[ESPN week 2 scoreboard](https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=2&seasontype=2&dates=2026)
returned event `401872932`, `Detroit Lions at Buffalo Bills`, date
`2026-09-18T00:15Z`, `STATUS_SCHEDULED`, `completed=false`.

Direct dRPC reads on chain 998 returned:

```text
0x814 outcome 19467: status=1 settledValue=0 question=4294967295
0x801 probe token 0:         total=900000000 hold=0 entryNtl=0
0x801 probe token 100194670: total=1000000   hold=0 entryNtl=550000000
0x801 probe token 100194671: total=1000000   hold=0 entryNtl=450000000
```

Thus the settlement baseline remains 9 USDC + 10 YES + 10 NO, expected gross
credit 10 USDC. Credit, its delay, and pruning remain unobserved. Observation
window remains September 18 **00:10–00:25 UTC / 02:10–02:25 Europe/Zagreb**.
Keep settlement polling running through final, status 2, and pruning; 04:00 UTC
is only an earlier estimate, not a verified final/settlement time. No poller was
started by this read-only check. Existing poller `REVERT` labels still require
corroboration because it suppresses RPC errors. No universal kickoff halt is
assumed; item 6 records actual acceptance, fills, cancellation, or rejection.

S8a tickets 3/4 already hold opposite DET@BUF selections with CAR YES as their
shared other leg. After a normal binary settlement, one can provide G1 Dead
evidence once the existing OutcomeVault settlement is recorded and A resolves
the losing ticket. The required receipt must show payout to its stored maker;
these pre-settlement observations do not pass G1.

Item 4 readings for `0x614992bb…FA6E` on 19467, item 6 halt observation, then patch
`docs/mainnet-hardening-facts.md` (settlement credit delay / pruning) and close this file.

### Timing/state recheck — 2026-09-17 21:26 UTC

Fresh ESPN week-2 scoreboard and testnet `outcomeMeta` still agree on DET@BUF
kickoff September 18 at 00:15 UTC / **02:15 Europe/Zagreb**. ESPN event 401872932
remains `STATUS_SCHEDULED`, not completed. Outcome metadata retains resolution
deadline September 21 at 00:15 UTC; that deadline is not an exact settlement time.
The kickoff observation window remains 00:10–00:25 UTC / 02:10–02:25 Zagreb.

Live chain reads: outcome 19467 status=1, settledValue=0, question=4294967295;
DET/BUF OutcomeVault `settled=false`; S8a tickets 3 and 4 both Open under A.
Probe balances unchanged: token 0 total 900000000, YES 100194670 total 1000000,
NO 100194671 total 1000000; all holds zero, YES/NO entry 550000000/450000000.
No settlement credit or pruning has occurred in these observations.

An early-morning game finish around 05:30–06:30 Zagreb is only a planning
estimate; actual testnet outcome settlement and EVM recording may occur later.
Maker A is still unreachable locally and must be restored for its automatic
Dead-ticket poker. G1 requires the real resolution receipt, not a game-final
timestamp or the Core balance change alone. This recheck did not start a poller.

The same fresh ESPN response lists CIN@HOU (401872934) and GB@NYJ (401872936)
for September 20 at 17:00 UTC / 19:00 Zagreb, both scheduled. Tickets using
those games do not provide tonight's earliest G1 opportunity; tickets 3/4 do.

### Server observation started — 2026-09-17 21:55 UTC

With explicit user approval, `observe-settlement-v2.service` now runs the
read-only `writer/src/observe-settlement.ts` on `root@91.99.94.25`. Persistent
JSONL: `/opt/hype-v2/state/settlement-19467.jsonl`. Samples run approximately
every 60 seconds with individual read timestamps; explicit EVM execution reverts
are separate from transport/RPC failures. It has no signing key and keeps
sampling after pruning to capture delayed credit. Restart at 22:01 UTC retained
the previous samples. The original shell poller remains unchanged.

First sample 21:55:05 UTC; seventh/latest sample checked 22:01:08 UTC: outcome
19467 status 1, settledValue 0; token 0 total 900000000; tokens 100194670 and
100194671 total 1000000 each, holds 0, entryNtl 550000000/450000000. Settlement
credit, conversion timing, and pruning are still pending. Observation timestamps
bound transitions to sampling intervals; they are not exact settlement times.

V2 A/B now run independently of the laptop (four/one open tickets respectively).
Existing v1 keeper remains running unchanged to record OutcomeVault results.
G1 still needs the actual Dead receipt and stored-maker escrow transfer. The
observer performs no order submission and does not establish whether trading
continues around kickoff; item 6 remains open, without a universal-halt assumption.
See [server handoff](../../docs/s8b-server.md) for operation and verification.

### Overnight result — 2026-09-18, 08:05–08:14 UTC / 10:05–10:14 Zagreb

**Item 4 VERIFIED with sampling/read-semantics limits. Item 6 UNOBSERVED;
S2b overall remains partial. G1 PASS on ticket 3.** This supersedes the pending
item-4 snapshots above. Full [review and receipt evidence](../../docs/s8a-testnet-evidence.md#overnight-review--2026-09-18-08050814-utc--10051014-zagreb),
[sanitized files and runnable verifier](../../docs/evidence/2026-09-18-overnight/README.md).

ESPN event 401872932 is final, **BUF 41–DET 31**; outcome 19467 settled at value
0. The full observer snapshot spans September 17 21:55:05.777 to September 18
08:06:33.603 UTC: 612 samples, two starts, maximum sample-start gap 62.885 seconds.

**Credit is net of a settlement fee:** probe token-0 total moved from
900000000 to **1898600000**, a **998600000 = 9.986 USDC** increase.
Testnet `userFills` records conversion of 10 YES at 0 and 10 NO at 1 at
**04:10:05.427 UTC / 06:10:05.427 Zagreb**, with **0.014 USDC** fee on NO,
zero on YES. Settlement hash:
`0xbcd71a3402122bf8be50042992d30601030032199d154aca609fc586c11605e3`.
The observed reconciliation is **10 gross − 0.014 fee = 9.986 net**, not 10 net.
No other observation-window activity appears in the returned fills/ledger.
Do not generalize this account's 14-bps settlement fee into a universal schedule.

Transition bounds, UTC (Zagreb = UTC + 2 hours):

| Measurement | Last before, read start–end | First after, read start–end |
| --- | --- | --- |
| Status 1 → 2 | 04:09:23.704–23.842 | 04:10:23.750–23.885 |
| USDC credit | 04:09:23.842–23.961 | 04:10:23.885–24.003 |
| YES read → failure | 04:09:23.961–24.074 | 04:10:24.003–24.142 |
| NO read → failure | 04:09:24.074–24.185 | 04:10:24.142–24.294 |
| Status 2 → 3 | 05:59:27.853–27.995 | 06:00:27.866–28.002 |

Sequential reads in one sample cannot establish exact ordering or zero credit
delay. The fill timestamp is 18.576 seconds before first observed credit, an
observation lag. There are 110 status-2 samples and 127 status-3 samples;
settlement-to-pruning is bounded to roughly **109m04s–111m04s**, not the earlier
ten-minute fixture's behavior. USDC remains 18.986 after pruning. Fresh configured
RPC reads at 08:08 and 08:10 UTC corroborate status 3 and the same balance;
info API confirms 18.986 USDC, no old YES/NO balances, and metadata omits 19467.

Both token reads fail throughout those 237 post-settlement samples. They are
`rpc-error`, not `revert`; fresh raw calls return code −32003 without explicit
`execution reverted`. Conversion is corroborated by settlement fills and later
balance absence; failure alone does not prove removal, zero balance, or an EVM
revert. Exact token-removal time and precompile failure semantics remain gaps.
The official RPC corroboration attempt returned HTTP 502. One earlier complete
sample failed at 00:17 UTC, with unchanged successful readings on either side.

**Item 6:** no kickoff/in-play orders, fills, cancels or rejections were tested.
Post-kickoff active status does not establish tradability or a halt. No universal
kickoff halt is inferred. A future trading observation requires its own authorized
window; it cannot retroactively fill this night's gap.

The existing keeper recorded fraction 0 at block 64569560, **04:12:35 UTC**,
transaction `0x25c52a9132908a35df917e165f659c8f6b0fe6de0598a3997c414f497d6636a8`.
A's poker then resolved ticket 3 in block 64569579, **04:12:54 UTC / 06:12:54
Zagreb**, transaction
`0x4a4712a6e7ca86f72d8acbad4d8c4848750e2c6a15aed972daab86e560567232`:
success, `ParlayResolved(3,2)`, actual USDC transfer of **959514 raw** from v2
to stored A, exactly full escrow. Retained B journal has no poke attempt.
Tickets 1/2/4/5 remain Open; A/B exposure is three/one tickets. All v2 services
are active and indexes advance; overnight RPC errors occurred. V1 remains live
with rotation-aligned writer/keeper restarts; no review action restarted anything.
Laptop makers remain off. No redeploy/funding/mint/manual settlement occurred.

### IOC mechanics — 2026-09-18, 08:59–09:07 UTC

User approved the [exact capped test](../../docs/superpowers/plans/2026-09-18-ioc-execution-test.md)
before signing. **PASS: full fill, partial fill, no fill and discarded-response
recovery** on existing HedgeProbe, testnet SEA/ARI outcome **19468**, YES asset
**100194680**. [Saved public records and verifier](../../docs/evidence/2026-09-18-ioc-execution/README.md).

Counterparty split 15 existing Core USDC into 15 YES + 15 NO (zero split fee),
then supplied asks of 10 and 5 YES at 0.50. Probe requested 10 YES at 0.50 IOC
three times in separate reconciled steps: **10 filled, 5 filled, 0 filled**.
Buyer cost 7.50 USDC, fee zero; seller fees 0.004 + 0.002 = 0.006 USDC.
These are native Core shares; no ERC-20 wrapper or v2 parlay was minted.

Important API observations:

- Partial order **60422048731** returns `status=filled`, `origSz=10`, `sz=5`.
  Actual fills and +5 YES establish the hedge quantity; terminal status alone
  cannot mean the entire requested size executed. No open remainder or hold.
- Empty order **60422101087** returns outer `status=ok`, per-order no-match,
  and lookup status `iocCancelRejected`. Zero fill/debit/holds verified.
- Full order **60421939998** filled 10 despite its response being deliberately
  discarded. A fresh process used persisted intent/client ID, status, fills and
  balances to reconcile. A second send invocation was refused before key/network
  use. This tests controlled response loss, not every transport fault or a live
  service crash. No blind resend occurred.

Independent `0x801` reads on chain 998 at 09:07:11 UTC matched info API:
probe **11.486 USDC + 15 YES**, counterparty **13.48270019 USDC + 15 NO**, all
holds zero. Both supplied asks fully filled, both accounts have no open orders,
and no cleanup cancel was needed. Positions remain until natural settlement or
a separately authorized unwind; future settlement fees are additional.

Runner self-check and saved-evidence verifier passed; actual output and hashes
are preserved. This was controlled liquidity before kickoff, not organic depth
or an in-play trace. No deployment, funding, manual settlement, v1/v2 service
change or laptop maker startup. The localhost UI was not used. Next: live quote
policy, then contract-enforced custody/spend and margin accounting before relief.
