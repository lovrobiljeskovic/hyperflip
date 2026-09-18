# S8a handoff — 2026-09-16

**Next session explicitly chosen by the user:** draft the S9 MarginVault
specification, resolving remaining parameters inside the concrete design rather
than reopening agreed product policies. Start with the
[decision record](superpowers/plans/2026-09-18-hedge-execution-policy.md), its
remaining specification items, and the [copy-ready prompt below](#prompt-for-the-next-session).
Write the draft locally under `docs/superpowers/specs/`; propose explicit buffer
and hedge-budget defaults with tradeoffs for review. S10 adversarial review
follows the draft before money-path implementation. S9 is **not written yet**.

At this handoff, checkout is `new-design`, HEAD
`30a614c061afd03d4d225f8d538cd75633fd0709`, ahead two, with extensive existing
writer/web/docs changes and untracked evidence. Recheck actual state first.
No commit, runtime edit or deployment was performed to prepare this handoff.
Earlier service and balance observations below are dated, not fresh health claims.

**September 18 follow-up decision:** user confirms live HIP-4 order placement on
OutcomeXYZ. The missing local kickoff trace remains an evidence gap, but is no
longer a blocker for S9; no dedicated repeat kickoff test is required. User agreed
to capped hedge execution, confirmed partial fills and continued backing for the
remainder. [Segment-1 execution plan](superpowers/plans/2026-09-18-hedge-execution-policy.md)
uses IOC and durable reconciliation. The separately approved September 18 spike
passed full/partial/no-fill and discarded-response recovery; see the
[execution evidence](evidence/2026-09-18-ioc-execution/README.md). User agreed to
HIP-4 order-book pricing for production live games and strict testnet validation,
without pregame-price or `spotPx` fallbacks, accepting temporary unavailability
when a leg lacks usable pricing. The user subsequently approved a testnet demo
exception, including during live games: prefer usable books, otherwise allow
valid `spotPx` or explicitly configured demo prices (including pregame priors),
visibly labelled **Testnet fallback pricing** with actual sources recorded.
Fallbacks establish neither live pricing nor executable hedge liquidity and
grant no hedge credit; retain required backing if no hedge fills. Production and
strict validation keep book checks. This supersedes the blanket testnet ban.
The user also agreed to pause affected strict quotes for missing/stale/disconnected
book data, insufficient depth, or excessive spread. A two-second maximum book
age is agreed for strict testnet evaluation, checked for every leg immediately before
signing using venue and receipt timestamps. Reconnect requires a fresh valid
snapshot; heartbeats do not refresh books. Production suitability is unverified.
Size-aware ask-depth pricing is agreed: use the average across the required
quantity within the execution price cap; reject insufficient depth, or offer a
smaller stake only after recalculating its quote. Hedge sizing remains for margin
design. Pausing issuance does not revoke existing signed quotes. This policy is
not implemented yet. Strict testnet spread limits are now agreed: require both
sides and a gap <= 0.05 USDC AND <= 10% of midpoint. These are unvalidated for
production; demo fallback pricing remains available. Testnet quote lifetimes
are agreed: 30 seconds for demo, 10 seconds for strict evaluation. Refreshed
payout terms require user acceptance; approval precedes the final actionable
quote. Relay/frontend timing must be aligned before those lifetimes are tested.
Margin stake convention is agreed: premium stays in the ParlayVault pot; maker
obligation is total payout minus premium. Never also count the premium as maker
cash. Confirmed vault-controlled hedges receive conservative net scenario credit
against the portfolio's worst uncovered obligation. Deduct purchase costs from
cash; count neither hedge payoff nor retained stakes twice. This is not yet a
withdrawal rule or verified on-chain formula. Reserve-before-send is agreed:
exclude maximum purchase spend including fees from backing before submission;
credit only confirmed coverage. Uncertain results retain unresolved reservations
and block another hedge attempt. Withdrawal policy is agreed: unsettled hedge
relief stays available inside the account, but cannot by itself unlock withdrawals.
Withdraw only available EVM USDC while retaining cash backing without unsettled
hedge credit, pending reservations and the claim buffer. Actual settled proceeds
may contribute to surplus after arrival and reconciliation. Exact bounds/buffer
remain unspecified. Winning-claim policy is agreed: preserve the full unpaid
obligation until payment; use available EVM cash while preserving remaining
backing, otherwise retain the ticket and show pending funding. Automate transfers
with permissionless recovery; prioritize unpaid claims over new exposure and
withdrawals. The discussed post-credit seconds-to-low-minutes timing is only a
planning estimate, not measured end-to-end latency or a payout SLA.
Void/fractional policy is agreed: preserve current loss-at-resolution precedence
and whole-ticket premium refund on fractional settlement, including early void
before other legs settle. Keep obligations until confirmed resolution/payment;
fractional hedge proceeds are accounted separately at conservative net value.
Custody is agreed: one vault/Core account per maker, guarded CoreWriter orders,
no unrestricted agent trading or administrative bypass on collateral accounts.
Credited hedges cannot be disposed of without preserving backing; permitted
sales remove credit before execution. Keep HedgeProbe's agent unchanged and
separate. Guarded IOC/recovery still needs its own integration proof.
The user requested an official Hyperliquid PM cross-reference before choosing
allocation. [Research and sources](superpowers/plans/2026-09-18-hyperliquid-margin-reference.md)
support account-wide risk and separate capacity measures, not copying native
borrowing/liquidation formulas for custom parlays. The single-leg calculation
was subsequently accepted after the comparison below; accounts/runtime are unchanged.
The authorized [offline calculation](evidence/2026-09-18-margin-calculation/README.md)
compared exact binary terminal requirements with one-leg assignment. All 3,645
portfolios / 13,041 assignments in its stated domain passed the conservative
bound check; examples also show 30–50 extra cash from missed offsets. The user
subsequently approved the conservative one-leg calculation for the first version,
using exact enumeration as a test oracle. This is not the full lifecycle proof.
Next: consolidate S9, specifying the claim buffer/throttle, hedge selection and
budgets, net-fee/rounding assumptions, account mode/limits and lifecycle invariant;
then S10 adversarial review. The user explicitly chose to finish
that discussion before implementing local quoting changes. The dated overnight results
below remain unchanged; the spike does not establish v2 app integration.

**G1 PASS: two-maker RFQ/mint plus ticket 3's Dead receipt and full stored-maker
payment are verified.** S2b item 4 credit/pruning verified with observation
limits; item 6 remains unobserved. Full S8b public rollout is pending.

**Overnight review — September 18, 08:05–08:14 UTC / 10:05–10:14 Zagreb:** read-only
overnight review verified ticket 3's successful Dead transaction
`0x4a4712a6e7ca86f72d8acbad4d8c4848750e2c6a15aed972daab86e560567232`, block
64569579, 04:12:54 UTC / 06:12:54 Zagreb: A's poker sent it and USDC transferred
the full **959514 raw = 0.959514 USDC** to stored maker A. DET/BUF YES lost;
the keeper had recorded fraction 0 at 04:12:35 UTC. B's retained journal has
no poke attempt. Tickets 1/2/4/5 remain Open; 4 still awaits CAR/ATL.

The full observer snapshot has 612 samples. Probe credit was **9.986 USDC net**
(10 gross minus the API-recorded 0.014 settlement fee), leaving **18.986 USDC**.
Status 2 and credit first appear at 04:10:23–24 UTC / 06:10 Zagreb; status 3
first appears at 06:00:28 UTC / 08:00 Zagreb, roughly 110 minutes later.
Fresh reads corroborate pruning and surviving USDC. Outcome-token reads fail
with `rpc-error`/code −32003: they do not establish zero balances or an explicit
EVM revert. Exact ordering/delay within the sampled interval and kickoff/in-play
order/cancel behavior remain unobserved. **S2b overall stays partial.**

A/B/relay/observer are active; A open=3, B open=1, both indexes advance with all
five tickets. Overnight RPC/poker errors occurred, so this is not uninterrupted
availability proof. V1 writer/keeper remain healthy after rotation-aligned
restarts (current PIDs 688080/688077); Caddy PID 4895 is unchanged and its v1
health route passes. Keep laptop makers off and server state authoritative.
No service/config/transaction changes were made. The external tracker still
says S8a NEXT; this result supersedes that stale row and older snapshots below.
See [full evidence](s8a-testnet-evidence.md#overnight-review--2026-09-18-08050814-utc--10051014-zagreb)
and [saved evidence/checks](evidence/2026-09-18-overnight/README.md).

For the overnight results, use the [evidence checklist and new-session prompt](s8a-overnight-review.md).

**Previous — September 17, 22:02 UTC / September 18, 00:02 Zagreb:** user authorized
isolated v2 services on `root@91.99.94.25` and explicitly approved private config
transfer. A/B, relay, and read-only S2b observer now run under systemd in
`/opt/hype-v2`; see [server handoff](s8b-server.md). A recovered four open tickets,
B one; relay serves all five. Restart recovery and a fresh two-maker quote
passed. V1 writer/keeper/Caddy remain running with their original PIDs; production
and the public v2 host/preview were not changed. Keep laptop makers stopped;
original env/state files are preserved. All five tickets remain Open; G1 and
S2b credit/pruning remain pending. This supersedes the laptop-only instructions
and older service-state snapshots below. The full S8b public rollout is pending.

**September 17 resume update:** [fresh evidence](s8a-testnet-evidence.md#resume-checks--2026-09-17-17481751-utc)
supersedes the single-ticket snapshot below. Checkout is now `30a614c` on
`new-design`; all four existing tickets are Open and belong to A. Tickets 3/4
already cover opposite DET@BUF selections. Web responded 200; both makers and
relay were stopped at 17:48 UTC. At 17:53 UTC B and the relay were running;
a fresh B quote passed with A unreachable and B tracking zero A tickets.
B mint/restart recovery and G1 remain pending. Relay `/limits` and `/parlays`
returned 503 while A was down; quote failover does not establish full UI failover.
Current event timing and probe balances were rechecked in the hedge findings.

**September 17, 18:10 UTC blocker:** maker restart failed because dRPC rejects
`eth_getCode`, including latest state. Official/Chainlink still fail pre-creation
history; a Tatum public candidate passed code history but rate-limited and
rejected `eth_call`. See the evidence's RPC startup blocker before restarting.
Env/state files and the guard are unchanged. The frontend was also found to be
running legacy writer/v1 settings; its corrected restart remains unverified.

**September 17, 19:29 UTC update:** user configured private Alchemy testnet in
`.env.s8a`; deployment history/current reads passed. User chose Free-tier
compatibility: writer log batches are now 10 blocks and catch-up yields about
every 30 seconds to save progress. Writer typecheck + 139 tests passed; the
patched scanner also passed a live read-only 20-block check. Full service
restart/catch-up and B mint remain pending. Re-source `.env.s8a` in each
backend terminal; keep the private RPC out of public frontend variables.

**19:34 UTC:** B and relay are running, B seeded with zero open tickets, A
intentionally stopped. Catch-up checkpoints are advancing. First RFQ missed
the 1.5-second window; a retry returned a B quote in 911 ms with no config
change. Frontend HTML references 28 missing JS assets: restart step 10 before
minting, using the public official testnet RPC for the browser. B mint and G1
remain pending.

**19:46–19:50 UTC:** Alchemy returned HTTP 429 during unpaced catch-up (monthly
quota exhaustion was not established). User stopped B and replaced `WRITER_RPC`.
The replacement passes deployment history/current reads and 100-block logs;
1,000-block logs fail with RPC code 35/range error. Scanner now uses 100 blocks,
pauses one second between chunks, and retains the 30-second checkpoint yield.
Typecheck and all 139 writer tests passed; a live in-memory 200-block scan passed.
A/B are stopped; relay is running with its old process environment and must also
be restarted with the updated env. All four tickets remain Open under A.
Wait for catch-up verification before another mint; B mint/recovery and G1 are pending.

**19:58 UTC:** B/relay restarted successfully; B-only quote passed in 1007 ms.
Frontend v2/local-relay assets now verified over HTTP (51/51 load). B's saved
index retains IDs 1–4 and is advancing, but remains about 64k blocks behind;
observed rate estimates another 18 minutes. Keep B/relay running, A stopped,
and verify the scanner reaches current blocks before the B mint test.

**Positions follow-up:** relay positions/limits still depended on A and returned
503 during failover, although B held all four ticket refs. Patched their shared
GET proxy to try the next available maker. Typecheck + 140 writer tests passed;
a temporary patched relay returned positions 4/3/2/1 and limits from running B.
User must restart only the relay to activate this patch; keep B catching up and
A stopped. Browser positions refresh and subsequent B mint remain unverified.

**20:05:47 UTC:** user restarted relay; live `/parlays` now returns HTTP 200
with tickets 4/3/2/1 through B, and `/limits` returns 200. A remains stopped;
B is healthy with no quote rejections. B checkpoint 64498461 versus head
64539864 leaves 41403 blocks (roughly 13 minutes at observed rate). Browser
rendering and catch-up completion remain unverified; wait before minting.

**20:18 UTC — B-only mint passed:** ticket 5 minted in
`0xd0cb2c0ba3cc8e9511c7b5978d0895e1a6d35e1569cc5af3c4927a8b9dce92e1`,
block 64540525, stored maker B. Actual slip HOU YES + GB YES, premium 0.20,
payout 0.659078 USDC; receipt proves taker 0.20 + B 0.459078 escrow transfers.
RFQ records A unreachable/B won. By 20:18:25 B caught up past the mint, tracks
one open ticket, and serves all five ticket refs through the relay. Initial
post-mint check preceded catch-up and showed B open=0; do not omit that delay.
Next user step: restart only B, verify seeded open=1/index retained, then restore
A and verify its four tickets exclude B's. All five tickets last read Open;
G1 remains pending a real Dead settlement receipt. No additional mint needed.

**20:21 UTC — B restart recovery passed:** seeded open=1; HOU/GB exposure
459078 each, DET/CAR exposure 0; IDs 1–5 preserved and served through relay.
Fresh B-only quote passed in 1062 ms. A is still stopped. Next: restore A and
verify its four-ticket exposure, plus post-mint relay recovery. A's old taker
index initially lacks ticket 5; first-available positions proxy prefers A when
it returns, so account for that catch-up gap before claiming full positions
continuity. G1 and S2b settlement observations remain pending.

**Positions architecture follow-up:** user requested an implementation plan for
independent hosted indexing. See
[the proposed positions plan](superpowers/plans/2026-09-17-independent-positions-index.md).
It moves reads to an app-owned API backed by a testnet subgraph and separates
maker live exposure from historical positions indexing. No contract change or
redeployment is required. Planning only: no provider, dependency, implementation,
env/state, or production changes were made for this follow-up. S8a/G1/S2b gates
remain as recorded above.

**Overnight preparation follow-up:** a newer local health check found both A
and B unreachable, relay healthy with both makers down, Mac on battery, and no
running `caffeinate` process. Earlier B recovery remains verified historical
evidence, not current uptime. User was given foreground restart-loop commands
wrapped in `caffeinate -is`, one per maker; plug into AC, keep lid and terminal
windows open, and lock the screen instead of choosing Sleep. The shell wrapper
passed `zsh -n`; actual overnight uptime is not yet verified. This setup survives
child-process exits but not a terminal closure, reboot, or loss of network/power.
No service was started by the agent and no env/state file was changed. Recheck
both makers' seeded exposure (A=4, B=1 while tickets remain Open) after user starts
them. S2b observation polling is separate and still needs startup confirmation.

## Read first

- [Verified mint evidence](s8a-testnet-evidence.md): transaction, RFQ, escrow,
  maker ownership, and ticket selections.
- [Laptop commands](s8a-laptop.md): steps 7–10 restart the services; steps 12–13
  cover G1 and further laptop checks. Steps 4–6 already ran.
- [Hedge findings](../script/spike/FINDINGS-hedge.md#documentation-review--2026-09-16)
  and [S2b runbook](../script/spike/README-hedge.md#s2b-runbook--items-4-and-6-after-2026-09-16-run-see-findings-hedgemd).
- External tracker: `/Users/lovrobiljeskovic/docs/superpowers/plans/2026-09-16-bedlam-sessions.md`.
  It still labels S8a NEXT; this handoff records the newer G1 pass and partial S2b.
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

> Work in /Users/lovrobiljeskovic/hype-evm. Check actual checkout/dirty state first.
> Read docs/s8a-handoff.md, then
> docs/superpowers/plans/2026-09-18-hedge-execution-policy.md and
> docs/superpowers/plans/2026-09-18-hyperliquid-margin-reference.md.
> Read docs/evidence/2026-09-18-margin-calculation/README.md and run its verify.py.
> Consult docs/evidence/2026-09-18-ioc-execution/README.md and the latest
> script/spike/FINDINGS-hedge.md for execution evidence and limits.
> Use the external tracker at
> /Users/lovrobiljeskovic/docs/superpowers/plans/2026-09-16-bedlam-sessions.md
> and its referenced roadmap sections 4 Stage 3, 8 and 9 for context; stale
> statuses/formulas do not override our later agreed policies.
>
> Draft the S9 MarginVault specification locally in docs/superpowers/specs/.
> Preserve agreed policies, including the conservative one-leg accounting bound,
> testnet demo fallback exception, guarded CoreWriter custody, and stricter
> withdrawal rule. Specify lifecycle invariants, pending signed quotes/orders,
> settlement/refund/claim transitions and unit/fee handling. Propose explicit
> testnet payout-buffer, hedge-selection/budget and portfolio-limit defaults;
> distinguish proposed parameters from established facts. Resolve routine
> engineering details without repeated approval questions. Surface material
> capital/availability tradeoffs in the reviewable draft. Include S10 adversarial
> review cases; do not claim the binary checker proves the full lifecycle.
>
> Design only: no application/contract implementation, deployment, account-mode
> changes, new trading, funding, minting, settlement transactions or service
> restarts. Keep v1, production, /opt/hype and deployed v2 unchanged. Preserve
> unrelated dirty work, broadcast artifacts, .env.s8a* and
> ~/.local/state/hype-s8a. Keep laptop makers off and server journals/indexes
> authoritative. Never print private config. G1 and the existing IOC spike passed;
> the missing kickoff trace is not an S9 blocker. No automatic commit or push.

### IOC execution test result — September 18, 09:07 UTC

User chose to validate execution mechanics before moving to live quoting.
[Approved test](superpowers/plans/2026-09-18-ioc-execution-test.md) used the existing
HedgeProbe and recovered September 16 agent, SEA/ARI outcome 19468, controlled
full/partial/no-fill IOC cases, and persisted-intent recovery with a discarded
response. **All four execution cases passed**, including fresh-process recovery
and refusal to resend the persisted intent. Independent Core reads match final
probe 11.486 USDC + 15 YES and counterparty 13.48270019 USDC + 15 NO. Probe cost
7.50, buyer/split fees zero, seller fees 0.006 USDC. Both asks filled; no open
orders/holds or cleanup cancellation. Positions remain for natural settlement
or a separately authorized unwind. Partial IOC reports `filled` even with only
5/10 bought; use fill quantity and balances, never that label alone. Empty IOC
has explicit no-match plus `iocCancelRejected`. Sanitized evidence and runnable
checks are linked at the top. This completes the bounded mechanics test and
does not enable margin relief
or change v1/v2 services. The local UI is not currently verified against v2:
HTML responds, 28 scripts are missing, and local relay/makers are not listening.
