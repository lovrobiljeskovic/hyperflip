# Overnight evidence handoff — September 18, 2026

**Reviewed September 18, 08:05–08:14 UTC / 10:05–10:14 Zagreb: G1 PASS.**
Ticket 3's successful Dead receipt pays stored maker A the full 0.959514 USDC.
S2b item 4 credit/pruning is verified: 10 USDC gross less 0.014 fee, 9.986 net;
status 3 follows roughly 110 minutes later. Item 6 trading behavior remains
unobserved, and failed token reads do not prove explicit reverts or zero balances.
See [full review](s8a-testnet-evidence.md#overnight-review--2026-09-18-08050814-utc--10051014-zagreb)
and [sanitized evidence with runnable checks](evidence/2026-09-18-overnight/README.md).
The checklist below is retained as the original collection procedure.

**G1 and S2b were pending when the server was left running.** The services collect
observations and submit eligible resolutions; they do not automatically certify
either gate. Operating commands and deployment details: [server runbook](s8b-server.md).

## Starting point

- Server: `root@91.99.94.25`; isolated root `/opt/hype-v2`; chain **998**.
- Units: `maker-v2@a`, `maker-v2@b`, `relay-v2`, `observe-settlement-v2`.
- V2 vault: `0x075b4c6a7ce42890d839f774abfe8206f3c18a76`.
- Last check September 17, 22:01 UTC: tickets **1–5 Open**, A owns risk for
  1–4, B for 5. A/B exposure recovery and relay restart passed.
- Tickets **3/4** cover opposite DET@BUF selections; after normal binary
  settlement at least one has a losing leg. Void/fractional outcomes differ.
- Last verified kickoff: September 18, **00:15 UTC / 02:15 Zagreb**. Recheck
  actual event status; neither kickoff nor game final proves testnet settlement.

## Collect, then assess

1. **Health and continuity.** Read unit state, restart counts, maker health on
   loopback 8791/8792, relay 8788, and v1 writer/keeper/Caddy health. Check current
   ticket states and index checkpoints. Do not restart services merely to inspect
   them. V1's recorded PIDs were 676748/676749/4895; investigate any change rather
   than treating a changed PID alone as failure.
2. **Preserve evidence.** Copy the full observer file
   `/opt/hype-v2/state/settlement-19467.jsonl` into a new timestamped local evidence
   directory. Collect maker events since `2026-09-17 21:55:00 UTC`: receipt records
   and parsed, allowlisted fields (`at`, `event`, `id`, `hash`, `block`, `status`)
   for `poking-dead-parlay`, `parlay-resolution-receipt`, and `poke-failed`.
   Retain source unit identity. Raw errors may contain RPC credentials: omit
   `err`/error text and never copy env files into evidence. Preserve server originals.
3. **G1 receipt proof.** For each resolved candidate, retain transaction hash,
   receipt, block/time, sender, stored maker and decoded logs. Require successful
   receipt, `ParlayResolved(id, 2)` (**Dead**), and the actual USDC `Transfer` from
   the v2 vault to that ticket's stored maker for its **full `maxPayout`**. Verify
   the losing leg's recorded OutcomeVault result. Check the stored maker's poker
   submitted the transaction and inspect the other maker's logs for attempts;
   missing/incomplete logs limit that conclusion. A balance change or a log line
   alone is insufficient. If receipt logs are missing, query resolution events
   over a bounded interval using the provider's **100-block maximum** with pacing;
   do not restart a deployment-to-head scan.
4. **S2b credit, timing, pruning.** Parse the full JSONL timeline for outcome
   **19467**, probe `0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E`.
   Baseline raw totals: USDC token 0 = **900000000**; YES 100194670 = **1000000**;
   NO 100194671 = **1000000**; all holds zero. Expected gross credit is **10 USDC**,
   token-0 total **1900000000** if there was no other probe activity. Record last
   pre-change and first post-change timestamps for outcome status, token removal,
   USDC credit, and later pruning. Samples are roughly 60 seconds apart and reads
   sequential: report intervals/gaps, not exact ordering within a sample. Confirm
   suspected pruning with fresh reads; `rpc-error` is not pruning proof, and an
   execution revert needs corroboration. The observer did not test order acceptance
   or fills, so kickoff/in-play trading behavior remains unproven.
5. **Write the result.** Add exact evidence paths, hashes, amounts, UTC/Zagreb
   times and limitations to `docs/s8a-testnet-evidence.md`,
   `script/spike/FINDINGS-hedge.md`, and the latest summary in
   `docs/s8a-handoff.md`. Update `docs/mainnet-hardening-facts.md` only for facts
   actually established. If still unsettled or evidence is incomplete, state the
   remaining dependency and keep the affected gate pending.

## Copy-paste prompt for a new session

```text
Review the S8a/S2b overnight results in /Users/lovrobiljeskovic/hype-evm.
Read docs/s8a-overnight-review.md, docs/s8b-server.md, docs/s8a-handoff.md,
docs/s8a-testnet-evidence.md, then the referenced external tracker and latest
script/spike/FINDINGS-hedge.md entries. Check the actual checkout/dirty state first.

The authorized v2 server is root@91.99.94.25 under /opt/hype-v2. A/B, relay and
the read-only settlement observer run under systemd; v1 must keep running.
Use read-only SSH/RPC checks to collect the overnight evidence and current health.
Recheck event status and tickets 1–5, prioritizing tickets 3/4 for G1. Verify the
actual Dead receipt and full escrow payment to the stored maker before passing G1.
Analyze S2b settlement credit, timing intervals and pruning from the full observer
log. Do not infer a universal kickoff halt or claim unobserved trading behavior.

Preserve sanitized evidence locally and update the evidence/handoff/findings.
Report what passed, what remains pending, and any observation gaps. Do not
redeploy, fund, mint, restart services, or send manual settlement transactions
as part of this review. Keep v1, production, unrelated changes, broadcast
artifacts, .env.s8a*, and ~/.local/state/hype-s8a intact. Keep laptop makers off;
server journals/indexes are the advancing copies. Never print private config.
```
