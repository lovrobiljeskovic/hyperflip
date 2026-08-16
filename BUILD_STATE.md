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

- **M1 (gate):** USDC EVM→Core deposit crediting via CoreDepositWallet did **not** credit on current testnet (22 USDC sunk in controls) — cause unconfirmed (testnet regression vs. a CCTP recipient-existence rule). Must be proven reliable for a contract recipient before the first real deposit; see `OutcomeVault.sol` header for the vault-wide wedge this causes if it recurs on mainnet.
- **M2 (gate):** Vault Core account needs activation (Core-side spotSend of dust, 1 USDC sender-side fee) before it can receive anything — missing from all scripts/runbooks; add to the deploy runbook.
- **M3 (gate):** spotSend fees are sender-side-on-top; a full-Core-balance send (as `_payOut`/`pullSettledFunds` do) has no fee headroom untested at the margin — could silently wedge the last claim until `clearOutbound`.
- **Parked Important #2:** `pullSettledFunds` sends the vault's full Core balance with no fee margin — same mechanism as M3. Gated on M3's empirical verification; a wrong guess in either direction (add a margin vs. trust Core nets the fee) is worse than documenting and re-checking live. Probable code change once M3 is verified.
- **Parked Important #3:** no `transferOwnership` on `OutcomeVault`/`KeeperVerifier` — owner→timelock is a contract change, not a config toggle. Carried to mainnet hardening, no testnet impact.

## Resume in a new session

Branch complete; final whole-branch review passed and the fix wave (header comment, keeper clock-skew margin + MAX_SAMPLE_AGE, floor-boundary test, this refresh, testnet minDelay restore) is done. See `.superpowers/sdd/2026-08-16-outcomevault-v1-keeper-architecture/progress.md` for the full ruling history and `task-6-report.md`'s "Final-review fix wave" section for fix-wave details. Next step is `superpowers:finishing-a-development-branch`.
