# OutcomeVault v1 — Build State (handoff)

**As of:** 2026-08-16 · **Branch:** `outcomevault-v1-keeper` · **HEAD:** post-final-review fix wave
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
| 3 — OutcomeVault rework + mocks + tests | ✅ complete, review clean |
| 4 — `script/Deploy.s.sol` per-market deploy | ✅ complete, review clean |
| 5 — `keeper/` TypeScript service | ✅ complete, review clean |
| 6 — testnet e2e (chain 998) | ✅ complete, review clean |
| Final whole-branch review + fix wave | ✅ complete — merge-ready |

Task briefs: `task-1-brief.md` … `task-6-brief.md` in the SDD workspace dir. Reports: `task-N-report.md`.

## Task 3 — what happened (the hard part)

Went 5 review rounds + 1 post-breaker adjudicated round to close a series of
money-path defects (dwell-target donation attack, live-market keeper
fallback, silent payout shortfall, settlement-sweep burn vectors) ending in a
pool-adequacy floor on `redeemSettled`. Full round-by-round detail is in the
SDD ledger (`progress.md`, search `Task 3:`), not duplicated here.

`test/anchor/Anchor.t.sol` never edited (repo rule); anchor kept green by editing the `test/BaseTest.sol` fixture only.

## Key rulings (full list in ledger, search `Ruling:`)

- Timeout-gated cancel **removed** — cancel gated solely on verifier `Failed`; keeper-dead recovery = owner `setVerifier` swap.
- `settle()` hybrid: permissionless 0x814 read while live/settled; keeper relay only once pruned (status 3).
- Task 3 broke the 5-round cap by one adjudicated round because the fix was a **known convergent structural fix** (pool floor), not a guess — dust-burn is the vault's central safety property, not deferrable.
- Deferred to mainnet hardening: owner→timelock, 2-step owner handover, broader owner rescue/sweep, minDelay tuning, lying-keeper mitigation beyond setVerifier/pause.

## Open technical risks — mainnet gates + parked Importants

Testnet e2e (Task 6) closed the original open-risk list (spotSend verified live, contract-address info-API shape confirmed, outcome-leg fee is not an attest risk, ~7bps round-trip loss attributed). What's left before mainnet, from the final whole-branch review:

- **M1 (gate, cause pinned 2026-08-17):** USDC EVM→Core deposit crediting via CoreDepositWallet fails on testnet for amounts above ~1 USDC — a testnet-only CCTP anti-abuse rule, not a protocol regression. Live controls (wallet `0x1710…576d`, `userRole: missing` on mainnet, official frontend + raw calls): 1.0 USDC credited instantly three times; 1.5 and 2×2.0 USDC silently sunk. Circle CCTP-on-HyperCore docs: testnet transfers require the recipient to exist on HyperCore **mainnet** (then capped at $1000); observed behavior adds a ~1 USDC carve-out for mainnet-missing recipients. Explains the 22 USDC sunk in the 8/16 controls (all ≥5 USDC) and why creating a *testnet* Core account didn't help. Remaining verification: (a) >1 USDC deposit from a mainnet-existing wallet credits on testnet; (b) dust-amount deposit check on mainnet before first real deposit. See `script/e2e-report-2026-08-16.md` F0.
- **M2 (gate):** Vault Core account needs activation (Core-side spotSend of dust, 1 USDC sender-side fee) before it can receive anything — missing from all scripts/runbooks; add to the deploy runbook. **Extended by M3 result:** the same runbook step must also fund the vault's Core account with HYPE dust (fee currency — see M3) and keep it topped up.
- **M3 (gate) — CLOSED 2026-08-17, live testnet experiment.** Answers:
  - Fee is charged **on top**, sender side, **never netted** from the amount. feeToken is Core **HYPE** (0.00002 observed) when the sender's Core account holds any, else the **sent token** (0.000563–0.00058 USDC observed; floats with HYPE price).
  - `amount + fee > balance` → **silent drop** (proved: fresh USDC-only account, full-2.0-balance send dropped; 1.999-with-headroom landed exactly, fee 0.000563 on top).
  - **New constraint found:** Core→EVM spotSend requires the wei amount to be a whole number of EVM token units (multiple of 100 for USDC, `evm_extra_wei_decimals: -2`) — else **silent drop even with fee headroom**. This, not fees, was the first observed full-balance drop: real Core-fee dust (19 wei) made the raw balance unsendable.
  - Resolution of Parked #2: **representability floor added in code** (`pullSettledFunds` floors through the EVM-unit round trip, strands sub-unit dust, and no longer arms the gate on a sub-unit balance — closes the sub-unit-credit arming vector too; CoreSim models the drop; test `test_SweepFloorsUnrepresentableDust`). **No USDC fee margin in code** — instead the deploy runbook (M2) must fund the vault's Core account with **HYPE dust** (e.g. 0.01 HYPE ≈ 500 sends) so fees come from HYPE and USDC amounts send exactly; keeper/ops top up. Without Core HYPE, an exact-balance `_payOut` send silently drops (recovery: `clearOutbound`), so the HYPE-dust funding is an operational requirement, monitored, not best-effort.
  - Deployer Core left with 0.00000019 USDC dust + keeper Core 0.000437 USDC (experiment residue); deployer EVM +5.335 (round-tripped), keeper EVM 1.999 USDC.
- **Parked Important #3:** no `transferOwnership` on `OutcomeVault`/`KeeperVerifier` — owner→timelock is a contract change, not a config toggle. Carried to mainnet hardening, no testnet impact.

## Resume in a new session

Branch complete; final whole-branch review passed and the fix wave (header comment, keeper clock-skew margin + MAX_SAMPLE_AGE, floor-boundary test, this refresh, testnet minDelay restore) is done. See `.superpowers/sdd/2026-08-16-outcomevault-v1-keeper-architecture/progress.md` for the full ruling history and `task-6-report.md`'s "Final-review fix wave" section for fix-wave details. Next step is `superpowers:finishing-a-development-branch`.
