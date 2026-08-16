# OutcomeVault v1 — Build State (handoff)

**As of:** 2026-08-16 · **Branch:** `outcomevault-v1-keeper` · **HEAD:** `e4bf189`
**Plan:** `~/docs/superpowers/specs/2026-08-16-outcomevault-v1-keeper-architecture.md`
**Worktree:** `~/hype-evm/.worktrees/outcomevault-v1-keeper` (git worktree off `~/hype-evm`, base `f20bbaa` on `main`)
**SDD ledger (rulings + per-round detail):** `.superpowers/sdd/2026-08-16-outcomevault-v1-keeper-architecture/progress.md` (git-ignored; this file duplicates the load-bearing bits so they survive `git clean`).

Execution method: superpowers subagent-driven-development — fresh implementer per task, review gate per task, fix loop with scoped re-reviews.

## Environment / keys (testnet, chain 998)

Plaintext key from the spike was **rotated** (plan open item 1, done). `.env` in the worktree now has:
- `TESTNET_RPC`
- `PRIVATE_KEY` → deployer `0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D` (~2.49 HYPE + 95 USDC)
- `KEEPER_PRIVATE_KEY` → keeper `0x51Ae82D30646b1d8aC782C9E02AB06ca8a436eD1` (0.5 HYPE)

Old key `0xC1b15e354D5E4561B5692735070d874727001e48` retired (may hold Core-side spike dust). Testnet USDC ERC20: `0x2B3370eE501B4a559b57D449569354196457D8Ab`.

## Task status

| Task | State |
|---|---|
| 1 — IExecutionVerifier + KeeperVerifier + tests | ✅ complete, review clean |
| 2 — CoreConstants spike patches | ✅ complete, review clean |
| 3 — OutcomeVault rework + mocks + tests | ⏳ **fix committed, 82/82 green, awaiting one confirmation re-review of `e4bf189`** before marked complete |
| 4 — `script/Deploy.s.sol` per-market deploy | ⛔ not started (brief written) |
| 5 — `keeper/` TypeScript service | ⛔ not started (brief written) |
| 6 — testnet e2e (chain 998) | ⛔ not started (brief written) |
| Final whole-branch review + finish | ⛔ not started |

Task briefs: `task-1-brief.md` … `task-6-brief.md` in the SDD workspace dir. Reports: `task-N-report.md`.

## Task 3 — what happened (the hard part)

Core deliverable. Went 5 review rounds + 1 post-breaker adjudicated round. Money-path defects found and closed, in order:
1. Dwell used an absolute Core-balance target → 1-wei donation to the vault's Core account bricked deposit/redeem/settle. Fixed: dwell confined to `deposit()`, cumulative outbound accounting, owner `clearOutbound()` escape.
2. `settle()` keeper fallback fired on a **live** market (status 0/1). Fixed: keeper relay only at 0x814 status==3 (pruned); trustless read at status 2; fixture default status → pruned to keep anchor DoD 8 green.
3. `_payOut` silently capped a Core-side shortfall into permanent loss. Fixed: `PAYOUT_MIN_BPS`=9900 floor + `Payout` event.
4. `redeemSettled` had no shortfall handling / then burned positions for zero payout in the async sweep window / then a dust Core credit (<100 quote wei rounds EVM→0) + permissionless pull re-opened the burn. **Final fix (`e4bf189`):** pool-adequacy floor `require(available*10_000 >= obligation*PAYOUT_MIN_BPS, "SETTLEMENT_POOL_SHORT")` on the same basis pro-rata scales against — dust pool reverts position-intact, real ≤7bps fee passes, anchor (mergeFeeBps=0) unaffected.
5. `totalOwed` now tracked so short settlement redemptions can't drain quote reserved for prior claimants.
6. EVM-side arrival tracking (`outboundExpectedEvm` vs `balance + totalPaidOutEvm`) replaced griefable Core-balance reads for pricing + unlock.

`test/anchor/Anchor.t.sol` never edited (repo rule); anchor kept green by editing the `test/BaseTest.sol` fixture only.

## Key rulings (full list in ledger, search `Ruling:`)

- Timeout-gated cancel **removed** — cancel gated solely on verifier `Failed`; keeper-dead recovery = owner `setVerifier` swap.
- `settle()` hybrid: permissionless 0x814 read while live/settled; keeper relay only once pruned (status 3).
- Task 3 broke the 5-round cap by one adjudicated round because the fix was a **known convergent structural fix** (pool floor), not a guess — dust-burn is the vault's central safety property, not deferrable.
- Deferred to mainnet hardening: owner→timelock, 2-step owner handover, broader owner rescue/sweep, minDelay tuning, lying-keeper mitigation beyond setVerifier/pause.

## Open technical risks carried into Task 6 (testnet)

- `ACTION_SPOT_SEND` (CoreWriter action id 6, param layout) still **UNVERIFIED against real Core** — every payout depends on it; spike step 6 never ran. Confirm first thing in e2e.
- ~7 bps round-trip loss observed on testnet — reproduce and attribute (split+merge vs spotSend leg).
- If the Core→EVM `spotSend` leg charges a fee/rounds, `outboundExpectedEvm` ratchets a permanent deficit → `clearOutbound` is the owner escape; watch for it in e2e.
- Lying keeper untested — accepted v1 trust model (single trusted keeper + minDelay + pause + setVerifier).

## Resume in a new session

1. `cd ~/hype-evm/.worktrees/outcomevault-v1-keeper`; re-read the SDD ledger.
2. Dispatch the pending confirmation re-review of `e4bf189` (diff package `review-968a901..e4bf189.diff` already built) → mark Task 3 complete.
3. Tasks 4 → 5 → 6 with review gates, then final whole-branch review + `superpowers:finishing-a-development-branch`.
