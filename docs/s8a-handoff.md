# S8a handoff — 2026-09-16

**S8a is partial: the two-maker RFQ and mint worked; G1 still needs a live Dead
settlement.** Resume the existing deployment. No box or production cutover has
been performed as part of this laptop session.

## Read first

- [Verified mint evidence](s8a-testnet-evidence.md): transaction, RFQ, escrow,
  maker ownership, and ticket selections.
- [Laptop commands](s8a-laptop.md): steps 7–10 restart the services; steps 12–13
  cover G1 and further laptop checks. Steps 4–6 already ran.
- [Hedge findings](../script/spike/FINDINGS-hedge.md#documentation-review--2026-09-16)
  and [S2b runbook](../script/spike/README-hedge.md#s2b-runbook--items-4-and-6-after-2026-09-16-run-see-findings-hedgemd).
- External tracker: `/Users/lovrobiljeskovic/docs/superpowers/plans/2026-09-16-bedlam-sessions.md`.
  It still labels S8a NEXT; this handoff records the newer partial progress.
- Research: `/Users/lovrobiljeskovic/docs/superpowers/specs/2026-09-15-bedlam-parlays-hip4-roadmap.md`.

## State to preserve

| Item | Recorded state |
| --- | --- |
| Network | HyperEVM testnet, chain 998; no mainnet work |
| v2 manifest | `registry/deployment.testnet-v2.json`, included in the S8a checkpoint |
| v2 vault | `0x075b4c6a7ce42890d839f774abfe8206f3c18a76`, creation block `64446629` |
| Maker A | `0x0EBdE2ec018fE1168DF56d62facd5eB98A569Ab9`, port 8791 |
| Maker B | `0xc37EAC616146A8D66823A0396e95358Ea5dAde48`, port 8792 |
| Relay / web | localhost ports 8787 / 3000 |
| Common config | ignored `.env.s8a` |
| Maker secrets | ignored `.env.s8a-maker-a`, `.env.s8a-maker-b`; keep private |
| Persistent state | `$HOME/.local/state/hype-s8a`: market snapshot, RFQ/quote journals, maker indexes |
| Backend RPC | `https://hyperliquid-testnet.drpc.org` via `WRITER_RPC` |
| Deployment identity | absolute `DEPLOYMENT_FILE` selects v2 for backend and web |

The user funded the wallets and ran deployment/approvals. Both makers approved
10 USDC to v2. Allowance is consumed by minting; it is not restored when escrow
returns. The reserve wallet is distinct from the deployer; the deployer needs
gas, not USDC. Each maker uses its own key for bankroll, quotes, and poker.
Root `.env` contains the deployer key; do not print or copy it into the frontend.

The user owns the foreground service terminals. They were running at the last
check; recheck listeners and health before starting duplicates. Preserve all
state files when restarting. The existing box keeper must keep recording real
OutcomeVault results before Core pruning; the laptop makers resolve parlays
after those underlying results are available.

## What worked and what remains

Ticket 1 minted successfully:
`0xc6abcc96d35c55bf719811253a7af1a7dfa7e1b7e5f492b9d0eef735af2ee879`.
Both makers gave valid quotes. A won with 0.502084 USDC payout versus B's
0.492955. The vault received 0.2 USDC from the taker plus 0.302084 from A.
After mint, A tracked one open ticket and B tracked zero. Last recorded status:
Open. These are completed observations, not a fresh check at handoff time.

For G1, retain a resolution receipt showing a losing leg makes the ticket Dead
and the full escrow goes to its stored maker. Confirm the losing maker does not
poke that ticket. Ticket 1 uses HOU and GB selections with recorded kickoff
September 20 at 17:00 UTC; metadata expiry is September 23 at 17:00 UTC, not an
exact settlement prediction. If it wins or voids, it does not prove Dead.

Two tickets with opposite selections on one shared game and the same other leg
can ensure at least one has a losing leg after a normal binary resolution.
Void/fractional settlement is an exception. This was discussed only: **no second
mint is recorded**. A nearer real event could shorten the wait if still quotable;
recheck availability and lockout before selecting it. No arbitrary market was
created and no real sports outcome should be falsely settled for a test.

Still unrecorded: live failover to B, maker/relay restart recovery, winning claim,
and void refund. The latter two are additional coverage; G1 explicitly needs Dead.

## Startup findings

- Deployment exceeded the 3M small-block gas limit. The successful Foundry 1.8
  simulation used `--no-isolate --block-gas-limit 30000000`; the user enabled
  account big-block mode for broadcast and reported successful reset afterward.
  Do not redeploy or toggle mode just to resume services.
- Official and Chainlink RPCs returned code before the vault's creation block
  during our check. dRPC passed current/creation/pre-creation code validation.
  Do not bypass `verifyDeploymentRpc` or alter the creation block.
- Empty `NEXT_PUBLIC_PRIVY_APP_ID` made Connect Wallet a no-op. The corrected
  launch unsets the shell override so `web/.env.local` supplies the configured
  Privy ID. No wallet runtime code change was needed.
- Two browser signatures were approval and mint. They are unrelated to having
  two makers. `bankroll: null` before quoting and `waitlist-disabled` with no
  Resend key did not prevent this successful invite/quote/mint.

## S2b and the research roadmap

G0 already passed: contract CoreWriter orders and the agent-key path both filled
and appeared in the probe's Core balances. S2b is narrower than our earlier
discussion suggested: HIP-4 documents automatic YES/NO conversion and Core-state
precompile reads. Measure our actual settlement credit, timing, and pruning;
observe trading around kickoff without assuming a universal halt. Sources and
the sports-template restriction are recorded in the hedge findings.

Probe `0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E` last held 10 YES + 10 NO +
9 USDC on DET@BUF outcome 19467. Expected gross settlement credit: 10 USDC.
Recorded kickoff: September 18, 00:15 UTC (02:15 Zagreb); observation window
00:10–00:25 UTC. Final/settlement near 04:00 UTC was an estimate. Recheck timing
and start the existing settlement poller before settlement; it has not been
started by this handoff. It labels failed reads `REVERT` while suppressing RPC
errors, so corroborate any such line before claiming a protocol-level revert.

Next roadmap work remains S2b before S9; S9/S10 specify and review per-maker
MarginVault accounting, S11–S15 implement simulation/vault/escrow/hedging support,
and S16 proves G3 (requirement 150 → 0, unsafe withdrawal blocked, claim after
sweep). No live maker hedging or MarginVault has been demonstrated by this RFQ mint.
S8b is a separate box/preview deployment. S8c waits for G3 or explicit user call
and all v1 parlays settled. Keep v1, `/opt/hype`, and production web untouched.

## Working tree and validation

Session source revision: `20cd9927d6ccb8479ccb2c27ca7677da7a3ba688` plus dirty
working tree. The S8a checkpoint includes the laptop docs, this handoff, evidence,
and v2 manifest. README/web README contain the Privy correction;
hedge docs contain the documentation review. Broadcast artifacts also changed
locally and are excluded from the checkpoint.
Pre-existing changes include `DEPLOY.md`, `ops/systemd/rotate.service`,
`tools/smoke.mjs`, `tools/verify.test.mjs`, `writer/src/relay.ts`, and its test.
Review paths explicitly before committing; do not sweep up unrelated work or secrets.

Earlier session checks: user reported `scripts/verify.sh` passed. Agent-side full
verification had encountered a Turbopack EPERM failure; the user's report is not
an agent rerun. The evidence file records successful read-only receipt/RFQ checks.
This handoff changes documentation only; it does not establish fresh chain state
or complete any live gate.

## Prompt for the next session

> Read docs/s8a-handoff.md and docs/s8a-testnet-evidence.md first, then the S8a
> tracker row and the S2b documentation review. Resume the existing testnet v2
> deployment; do not redeploy or repeat funding. Recheck ticket 1 and local
> service health, then guide me through remaining laptop checks and the next
> real settlement observation. G1 is pending Dead; S2b credit/pruning and
> kickoff trading observations are also pending. Keep the box and prod untouched.
