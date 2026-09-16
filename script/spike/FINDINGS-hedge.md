# Hedge spike findings (Stage 0) — testnet, 2026-09-16

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
| 4 | Hold a fill through settlement | — | Probe holds **10 YES + 10 NO + 9 USDC** on outcome 19467 (status 1 at 2026-09-16 13:47 UTC). Settlement lands via the box `rotate` house sync after DET@BUF goes final (~2026-09-18 04:00 UTC). Read `0x814` + `0x801` for the probe then (every ~1 min from status 2): expect token 0 +`1000000000` (one side pays 1.0). Record delay, and whether 0x801 reverts / balance survives status 3. Cannot be forced early: the 10 flip slots are full and settling a live NFL market with a fake result is off the table. | **PENDING** (resume row S2b) |
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

Item 4 readings for `0x614992bb…FA6E` on 19467, item 6 halt observation, then patch
`docs/mainnet-hardening-facts.md` (settlement credit delay / pruning) and close this file.
