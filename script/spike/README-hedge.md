# Hedge spike (Stage 0) — run order

**Resume note (2026-09-16):** Setup and G0 are complete. The initial items below
record the exploratory procedure; consult `FINDINGS-hedge.md` for corrected,
verified behavior (including BBO support and direct RPC precompile reads).
For pending work, use the S2b section and its documentation-review link.

Question: can a **contract's** Core account trade an outcome book? Roadmap
`2026-09-15-bedlam-parlays-hip4-roadmap.md` §4 Stage 0 + §13.3. Testnet only.
Item 7 (mainnet depth probe) is dropped — no mainnet work.

Output: `script/spike/FINDINGS-hedge.md`, one row per item with tx hashes and a
verdict; each `UNVERIFIED` tag in `src/CoreConstants.sol` (actions 1/9/10/11/12,
`spotBalanceWithHold`, `outcomeAssetId`) flips to VERIFIED or FAILED.

## Setup

```bash
source .env            # TESTNET_RPC, PRIVATE_KEY (house EOA). Never print the key.
S="forge script script/spike/Spike.s.sol --rpc-url $TESTNET_RPC"
W="$S --private-key $PRIVATE_KEY --broadcast"
```

- Market: use our own `flip` market (house deployer, `tools/hip4.py`) so we control
  settlement timing. Refetch ids at start (`outcomeMeta` curl in `HANDOVER.md`).
  `O` = outcome id. Encoded asset ids: `--sig "outcomeIndexYes(uint32)" $O` (YES), +1 (NO).
- Amounts: quote wei 8-dec (1 USDC = 1e8), outcome wei 5-dec (1 share = 1e5).
  CoreWriter `limitPx`/`sz` are documented as 1e8 × human value — **unverified for
  outcome coins**; if the first order silently drops, retry `sz` at 1e5 scale.
- Every write is async on Core: wait ~5 s, then read back. Silent drop = no error
  anywhere (FINDINGS.md step 5 model).

```bash
$W --sig "deployProbe()"                                   # → PROBE address
# fund PROBE Core-internally: ≥ 1 USDC activation + trade size, wei multiple of 100
$W --sig "spotSend(address,uint64,uint64)" $PROBE 0 2000000000     # 20 USDC
$S --sig "readHold(address,uint32)" $PROBE $O               # token 0 total = 2e9
```

If the spotSend never credits, the probe cannot be funded this way — record it,
try `CORE_DEPOSIT_WALLET` approve+deposit from the probe (needs a probe method;
mainnet gate M1 says it may not credit either), then stop.

## Items

**1. Limit order from the contract (action 1).** Book empty on purpose.
```bash
$W --sig "limitOrder(address,uint32,bool,bool,uint64,uint64,uint8,uint128)" \
   $PROBE $O true true 55000000 1000000000 2 1     # buy 10 YES @ 0.55 Gtc, cloid 1
$S --sig "readHold(address,uint32)" $PROBE $O
```
Verdict: token 0 `hold` = 5.5e8 → action 1 accepted with the encoded id and 1e8
scaling. `hold` 0 → silently dropped: retry (a) `sz` 1e6 (5-dec), (b) NO side,
(c) tif 1 (Alo). All drop → FAILED, Stage 3 becomes 3-alt unless item 8 lands.

**2. Observe resting / fill via 0x801.** `hold` above is the resting proof. No
open-order or bbo precompile exists for outcome ids — confirm by calling 0x800–0x814
with the encoded id via `cast call` and note which revert. Fill: house EOA rests the
ask, then re-read.
```bash
# counter-side from the EOA (asset = encoded YES id; if the API rejects the int, use
# the SDK coin name "+<id>" via exchange.order instead — note which worked)
uv run tools/hip4.py '{"type":"order","orders":[{"a":'$YES',"b":false,"p":"0.55","s":"10","r":false,"t":{"limit":{"tif":"Gtc"}}}],"grouping":"na"}'
$S --sig "readHold(address,uint32)" $PROBE $O   # YES total +1e6 (10 shares), token 0 total −5.5e8, hold 0
```
Record the partial-fill shape if the ask is smaller than the bid (hold shrinks?).

**3. Cancel (actions 11, then 10).** Rest a fresh order (cloid 2) with no counter-side.
```bash
$W --sig "cancelByCloid(address,uint32,bool,uint128)" $PROBE $O true 2
$S --sig "readHold(address,uint32)" $PROBE $O   # hold back to 0
```
Then the same with `cancelByOid` (oid from `openOrders` info API for $PROBE) — the
API-known path. Verdict per action.

**4. Hold a fill through settlement.** After item 2 the probe holds 10 YES. Settle
the flip market (house deployer op), then:
```bash
cast call 0x...0814 $(cast abi-encode "f(uint32)" $O) --rpc-url $TESTNET_RPC   # status 2 → note time
$S --sig "readHold(address,uint32)" $PROBE $O   # every ~1 min: token 0 total +1e9 when auto-credit lands
```
Record: delay from status 2 to quote credit; whether the read reverts once status
3 (pruned); whether the quote balance survives pruning. Do not read 0x801 for the
outcome id after status 3 without expecting a revert.

**5. Fees.** From items 2 and 4: quote delta vs 0.55 × 10 = taker fee (contract as
taker), EOA side = maker fee; currency (USDC vs HYPE). Builder fee:
```bash
$W --sig "approveBuilderFee(address,uint64,address)" $PROBE 10 $EOA   # 1 bp max
```
then one API order (item 8 path) carrying `"builder":{"b":"$EOA","f":10}`; verdict
= does the builder fee appear. Sweep back and record spotSend fee-on-top +
multiple-of-100 rule for the contract sender:
```bash
$W --sig "spotSendVia(address,address,uint64,uint64)" $PROBE $EOA 0 100000000
```

**6. Kickoff halt.** One live NFL fixture. From ~5 min before kickoff, every minute:
EOA places and cancels a 1-share order via `tools/hip4.py` and reads the response;
note the first rejection/lock and its error string; `readHold` on the EOA to confirm
no stuck hold. Decides whether staggered-resolution hedging has a window at all.

**8. Agent key path (action 9 from the contract).** Fresh key `AGENT` (never the
house key).
```bash
$W --sig "addApiWallet(address,address,string)" $PROBE $AGENT ""
# then trade PROBE's account with the agent key through the exchange API:
PRIVATE_KEY=$AGENT_KEY ACCOUNT_ADDRESS=$PROBE uv run tools/hip4.py '{"type":"order",...}'
$S --sig "readHold(address,uint32)" $PROBE $O   # fill lands on the PROBE account
```
Verdict: action 9 accepted from a contract + fill visible on 0x801 → the primary
hedge path (§13.3) works even if item 1 failed.

## Gate G0

Item 1 or item 8 shows a fill on `0x801` for the probe address → Stage 3 as
designed. Neither → Stage 3-alt, re-plan S9 onward.

## Findings → patch sites

| Finding | Patch |
|---|---|
| action 1 field/scale | `CoreConstants.encodeLimitOrder` docs, `ACTION_LIMIT_ORDER` tag |
| asset field wants spot index, not encoded id | `CoreConstants.outcomeAssetId` |
| hold semantics | `CoreConstants.spotBalanceWithHold` tag |
| cancel path | `encodeCancelByCloid` / `encodeCancelByOid` tags |
| action 9 / 12 | `encodeAddApiWallet` / `encodeApproveBuilderFee` tags |
| settlement credit delay / pruning | `docs/mainnet-hardening-facts.md` precompile section |
| fees, halts | `FINDINGS-hedge.md` only (inputs to the S9 margin-vault spec) |

## S2b runbook — items 4 and 6 (after 2026-09-16 run, see FINDINGS-hedge.md)

Read the [documentation review](FINDINGS-hedge.md#documentation-review--2026-09-16)
first: automatic conversion is documented; settlement timing/pruning and trading
availability on this fixture still need observations. Kickoff does not imply a
documented protocol halt. The times below are the recorded schedule, not a fresh
schedule check or a guarantee of settlement time; recheck before resuming.

State left on testnet: probe `0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E` holds 10 YES +
10 NO + 9 USDC on outcome **19467** (DET@BUF, kickoff 2026-09-18 00:15 UTC, box `rotate`
settles from the ESPN final on the next hourly run, ~04:00 UTC). EOA
`0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D` holds ~21 USDC Core spot. Encoded ids YES
`100194670` / NO `100194671`; API coin `#194670`. `readHold` in `Spike.s.sol` does not
work (forge simulation has no precompiles): read with `cast call` as in `poll-settle.sh`.

### Item 6 — trading around kickoff (2026-09-18 00:10 → ~00:25 UTC, user present)

Once a minute from T−5 min, from the EOA (`source .env`):
```bash
# 1-share YES bid at 0.01: can fill if a matching order arrives; inspect the response
uv run tools/hip4.py '{"type":"order","orders":[{"a":100194670,"b":true,"p":"0.01","s":"1","r":false,"t":{"limit":{"tif":"Gtc"}}}],"grouping":"na"}'
# cancel it by the oid the response printed
uv run tools/hip4.py '{"type":"cancel","cancels":[{"a":100194670,"o":<OID>}]}'
# EOA token 0 hold must be back to 0 (1e6 while resting)
cast call 0x0000000000000000000000000000000000000801 $(cast abi-encode "f(address,uint64)" 0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D 0) --rpc-url https://rpcs.chain.link/hyperevm/testnet | xargs cast abi-decode "f()(uint64,uint64,uint64)"
```
Record per minute: acceptance or rejection and its exact error string, fills,
cancellation success, and any remaining hold. Also note `0x80e` bbo for `100194670`
before and after kickoff. If a halt occurs, record when and whether cancellation
still works. If none occurs, record that observation without extrapolating it to
every market. This informs the S9 hedge policy; liquidity remains a separate constraint.

### Item 4 — hold through settlement (start the poller before the game ends, ~03:00 UTC)

```bash
nohup script/spike/poll-settle.sh > script/spike/settle-19467.log 2>&1 &
```
The log gives, per minute: 0x814 `status settledValue question` and probe 0x801
`total/hold/entryNtl` for USDC, YES, NO. Read off:
1. time status 1 → 2, and `settledValue` (1e8 = YES won);
2. time probe token 0 goes `900000000` → `1900000000` (10 YES + 10 NO pay 10 USDC
   in total, including a fractional result) — delay from status 2 = auto-credit delay;
3. time status 2 → 3, whether the outcome-token reads REVERT after 3, and whether the
   token 0 balance survives (it must).
Then sweep back and refund the EVM bank (fees taken out of the spike's 40 USDC):
```bash
S="forge script script/spike/Spike.s.sol --tc Spike --rpc-url https://rpcs.chain.link/hyperevm/testnet"
$S --private-key $PRIVATE_KEY --broadcast --sig "spotSendVia(address,address,uint64,uint64)" \
   0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E 0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D 0 1900000000
PRIVATE_KEY=$PRIVATE_KEY uv run tools/core-to-evm.py 39     # EOA Core spot → EVM, adjust to balance
```

### Close-out
- Fill the item 4 and item 6 rows in `FINDINGS-hedge.md` (replace the PENDING rows, drop
  the "Pending" section), commit `settle-19467.log` next to it.
- `docs/mainnet-hardening-facts.md` precompile section: settlement auto-credit delay and
  what 0x801 does for outcome ids after status 3.
- No `CoreConstants` tag changes expected (item 4/6 are semantics, not encodings).
- Tracker: S2b → DONE with one-line finding.
