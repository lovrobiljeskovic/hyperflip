# Writer service testnet e2e — 2026-08-18 (chain 998)

Full live round trip of the parlay stack: real book pricing → EIP-712 signed
quote → on-chain mint with escrow → keeper settle → dead-parlay poke →
bankroll returned. **Gate passed.**

## Deployed

| Contract | Address |
|---|---|
| ParlayVault | `0x407CDc0B15E8d81f4D122481Ecf92Dbe07DC0169` (minPremiumBps 100, writer = signer = deployer `0x1710…576D`) |
| Leg vault | existing vault1 `0xc04eff29106a4b4fafa129820b03161ff2066211` |

Deploy tx needed **big blocks** (ParlayVault ~2.7M gas > small-block limit);
toggled via `evmUserModify {usingBigBlocks:true}` (hyperliquid-python-sdk
`Exchange.use_big_blocks`), toggled back off after.

## Timeline (UTC)

| Time | Event |
|---|---|
| 18:26:32 | writer started, chainId 998, event sync from block 61906280 |
| 18:27 | POST /quote — leg vault1-YES priced off live l2Book `#130690`, stake 0.5 USDC → premium 500000, maxPayout 2112177, TTL 30s |
| 18:27:43 | `mint()` tx `0x2b2018a7…99e1` — sig verified on-chain, premium 0.5 + writer escrow 1.612177 pulled, parlay #1 (ERC-721) minted |
| 18:28:03 | poker tick: `parlay-minted` — reservation → open exposure |
| 18:28:41 | vault1 `settle(0)` via keeper key `0x51Ae…6eD1` (outcome 12695 pruned on Core, status 3 relay path) — YES leg lost |
| 18:28:50 | poker: `poking-dead-parlay id=1` (resolveParlay sent from poker wallet) |
| 18:29:07 | poker: `parlay-resolved id=1` — event synced, exposure released |

## Final state (verified on-chain)

- parlay(1).status = **2 (Dead)**; writer snapshot, premium, maxPayout all correct
- ParlayVault USDC balance **0** — full pot (2.112177) returned to writer wallet
- deployer USDC back to starting 65.335456 (taker == writer, net zero)
- allowance **7.887823 = 10 − 2.112177** — confirms the runbook rule: DEAD
  resolve returns funds but does NOT restore allowance; recycling capacity
  needs re-approve
- /health `openParlays: 0`; /metrics `{quoted: 2, minted: 1, rejected: {}}`

## Findings / ops facts discovered

- **F1: outcome-coin naming is `#<outcome*10>` (YES) / `#<outcome*10+1>` (NO)**
  — the `+126950`-style prefix in the 8/16 notes is stale; allMids and l2Book
  use `#`. `{"type":"outcomeMeta"}` on the info API lists all outcome markets
  (382 on testnet) with name/description/quoteToken.
- **F2: dotenv comment hazard** — a `#` inside an unquoted env value
  (`MARKETS=[…"#130690"…]`) is truncated as a comment; MARKETS must be
  single-quoted in `.env`.
- **F3: big blocks required for ParlayVault deploy too**, not just
  OutcomeVault (both > small-block limit). `evmUserModify` toggle is the
  deploy-runbook step; remember to toggle back off or every later tx crawls at
  ~60s big-block cadence.
- **F4: both 8/16 vaults' underlying outcomes are now pruned on Core**
  (12695, 12568) and their books gone. vault1 was settled at fraction 0
  during this e2e (keeper relay) and is now spent. Testnet outcome markets
  churn fast — most live books are empty; only a handful have asks at any
  moment.

## Round 2 — real 2-leg parlay (same day, 18:35–19:15 UTC)

Re-ran with a genuine multi-leg ticket after round 1's single-leg scope cut.

- Deployed two fresh leg vaults (big blocks again): vaultA
  `0x2695562df7D7056E7262CC5D2CD7b5916ce463aF` (outcome 12568) and vaultB
  `0x79B4b1a83aBf8619711ea3f6DAA096584313B0Ef` (outcome 12695), keeper =
  deployer, shared verifier reused.
- MARKETS: vaultA → `#130690/#130691` (outcome 13069), vaultB →
  `#130710/#130711` (outcome 13071); `MIN_LEGS=2`.
- 2-leg quote (both YES) priced off both live books: stake 0.5 USDC →
  premium 500000, maxPayout **7400592** (~14.8x). Testnet asks flicker —
  took 3 quote attempts (`stale-book` between market-maker requotes).
- Mint tx `0xb8181a1d…dcc3`: parlay #2, escrow 6.900592 pulled.
- vaultA `settle(0)` killed the YES leg; poker synced the mint via the (new)
  chunked scan and poked in the same tick: `parlay-minted` 19:14:13.159,
  `poking-dead-parlay` 19:14:13.443, `parlay-resolved` 19:15:16.
- Verified: parlay(2).status = 2 (Dead), 2 legs stored correctly, vault USDC
  0, deployer restored to 65.335456, allowance 487231 = 10M − 2112177 −
  7400592 (cumulative non-restore across both parlays).

### Bug found & fixed (the gate earning its keep)

**Poker event scan bricked on block-range cap.** `Poker.fetchEvents` did one
`eth_getLogs` from `nextBlock` to head; the testnet RPC caps ranges at 1000
blocks (~1000s of chain time at ~1 block/s). Any writer start >1000 blocks
after `PARLAY_DEPLOY_BLOCK` — or any tick gap that long — failed every tick
forever (`nextBlock` never advances). Fixed: chunked scan via `blockRanges`
helper in `pure.ts`, ≤1000 blocks per query, 5 new unit tests (writer suite
39/39 green).

### RPC ops facts

- **F5: official testnet RPC (`rpc.hyperliquid-testnet.xyz/evm`) rate-limits
  hard** — a burst of precompile probing + poker retries exhausted the per-IP
  quota for >10 minutes (even `eth_blockNumber` 429'd); viem's built-in
  retries make the pile-up worse. **`https://hyperliquid-testnet.drpc.org`
  works as a fallback** (chain 998). Beta writer deploy should use a
  dedicated RPC, not the public endpoint. `.env` TESTNET_RPC currently points
  at dRPC.
- getLogs max range 1000 blocks (source of the poker bug above).

## Scope caveats (what this gate did NOT cover)

- **Coin↔vault mapping was operator config**: leg vaults' MARKETS entries
  pointed at other outcomes' live books (their own outcomes are
  pruned/bookless — that's what makes them settleable on demand). Per spec §3
  this mapping is trusted config, but a beta deploy must map vaults to their
  true outcome coins.
- **Settlement fraction was keeper-relayed** (status-3 path with chosen
  fraction), not Core-computed (status-2 path). The status-2 precompile
  branch is covered by forge tests only.
- Won/claim and Void paths not exercised live (Dead only, both rounds).
