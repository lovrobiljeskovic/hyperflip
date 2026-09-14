# Batch 3/4 rollout, 2026-09-14

Completed at 21:48 UTC; see the execution record below. The baseline and plan
remain as the record of what was inspected before deployment.

Operator approved pushing all cleanup work and deploying it. Local code candidate:
acef5bf, including the 6315a23 hero update. No contract deployment or logic change.
The repository gate passed 365 tests before rollout; see CLEANUP_HANDOFF.md.

## Read-only baseline at 21:02 UTC

- Writer release 907ccd1, MainPID 606418, one listener (child 606443).
- Keeper MainPID 595221, continuously running since 12:14 UTC.
- Caddy active. Rotation idle, timer next 21:10 UTC. Suspend the timer and guard
  rotate.service while preparing the release; neither service must overlap.
- Frontend rollback: dpl_GcP88tWngfknZemS2AdrpkD3Gb98, READY,
  https://overround-av30fhzox-lovrobiljeskovics-projects.vercel.app (6315a23).
- Live registry: 177 active sports markets, 152 archived entries. Registry symlink
  resolves to /opt/hype/registry/markets.json; retain all historical entries.
- Valid state: 120 settlement fractions, 3 waitlist entries, 39 journal records
  (schemas 1 and 3), newline terminated. Private environment remains mode 0600.
- Remote cleanup branch is 6315a23; archive branch remains f0db775.

## Execution

1. Commit the handoff/rollout records and README link; push cleanup/sports-v1.
   Require CI for the pushed revision. Do not change the archive branch.
2. Stage exact committed service packages under /opt/hype/releases; install locked
   dependencies and run both service checks. Do not start staged services.
   Validate canonical identity against each effective RPC configuration and parse
   the actual state with new readers, without changing its bytes. Verify private
   settings, registry and contract identities remain compatible.
3. Prepare an isolated frontend from the same commit with verified production
   settings. Stage a production Vercel deployment without moving aliases and
   check routes/assets. Do not reuse the fixture build from scripts/verify.sh.
4. Back up exact current service code/dependencies, proxy, units, private config
   and runtime state under /opt/hype/backups/cleanup-20260914 (root mode 0700).
   Keep quote journal and waitlist in place during code swaps. Snapshot the
   keeper cache with a stable read; take another copy during its brief stop.
5. Gate public quotes, stop the writer, verify no listener, then wait the effective
   quote TTL and a fresh chain timestamp strictly beyond its latest possible
   deadline. Keep keeper running through writer drain and staging.
6. Switch only staged source, ABIs and dependencies plus the two shared modules
   and public manifest. Do not replace registry/markets.json or any runtime file.
   Restart keeper once with the preserved cache and validate startup immediately.
   Start exactly one writer; require seeded exposure and successful polling.
7. Verify on-chain open exposure, sports-only public metadata, signed quote and
   durable journal append, then promote the staged frontend and reopen quoting.
   No signup emails or manual chain transactions are included without a supplied
   test identity. Report browser/wallet paths as untested if unavailable.
8. Restore the timer with a future firing time, skipping any missed catch-up;
   never invoke a rotation as a deployment test. Record service PIDs, deployment
   IDs, fingerprints, backups and exact smoke output.

## Rollback

Keep the public quote gate closed if checks fail. Stop the new writer and drain
its quotes by the same TTL/chain rule. Restore the captured service code and
its dependencies, with current state files and the working private RPC settings.
Restore keeper code with minimal interruption if its startup fails; never restore
an older cache over newer observations. Reconstruct writer exposure before
reopening. Promote the captured frontend rollback deployment if needed. Restore
compatible rotation scheduling only after services are healthy. No stale state
snapshot is part of a code rollback.

## Execution record

- Merged cleanup/sports-v1 into main as `b644aba`, preserving the concurrent hero
  update and all handoff files. The merge tree matched `f1b7899` exactly.
  [Merge CI passed](https://github.com/lovrobiljeskovic/hyperflip/actions/runs/34897508653).
  Archive branch remains `f0db77514456c0334b988c933721d7d81d8ce899`.
- Live keeper: `b644aba`, MainPID 611700. Cache loaded at 21:33:33; all 177 vaults
  initialized and loops started at 21:34:55. The old keeper ran throughout
  preparation. Its existing RPC read failures stopped after the routing change.
- Live writer: `c1a3d8a`, MainPID 613231, one port-8787 listener. This adds a small
  RPC compatibility fix to the merge: scan 100 blocks per request instead of
  1,000, preserving partial progress and all exposure/signing/settlement rules.
  The strengthened failure/resume test failed before the fix, then all 120 writer
  tests and typechecking passed locally and in the staged host package.
  [Release CI passed](https://github.com/lovrobiljeskovic/hyperflip/actions/runs/34900062534).
- Frontend: `dpl_Axv4yQiqTnTfgau3MSx4g5Ht3YYD`, source metadata `c1a3d8a/main`,
  https://overround-7y8yeo68c-lovrobiljeskovics-projects.vercel.app.
  Production build, 37 frontend tests and both wallet-bundle checks passed.
  Staged route passed before promotion. Both public domains returned 200 for
  `/`, `/build`, and `/positions`; the exact hero poster and deployed Chainlink
  RPC setting were verified. Wallet transactions were not exercised.

### RPC findings and configuration

The private dRPC endpoint had exhausted its monthly free quota. Chainlink and the
official RPC returned rate limits from the host. Chainlink passed twelve
concurrent 1,000-block scans from the operator's Mac, but remained rate-limited
from the host even after keeper traffic moved.

Writer and keeper now use the existing public
`https://hyperliquid-testnet.drpc.org` first, retaining their previous fallbacks.
It passed canonical historical-code checks and fresh Core checks. Read-only
validation covered all 177 vaults, Core reads for 153 unsettled vaults, and 20/20
keeper event scans. Its 500- and 1,000-block log requests failed despite a
misleading provider error naming a 10,000-block limit. The writer's actual
1,000-block catch-up workload passed 20/20 requests when split into 100-block
chunks. No new provider account or dependency was introduced.

Production `NEXT_PUBLIC_RPC_URL` now selects the existing Chainlink default,
`https://rpcs.chain.link/hyperevm/testnet`. Frontend history scans retain their
1,000-block chunks. Free provider quotas remain an operational limit; these
checks establish observed behavior, not a service guarantee.

### Drain, state and smoke evidence

Both public quote routes returned 503 during the pause. The old writer stopped
at 21:44:49 with no listener remaining. Its latest possible deadline was
1789422319; the verified fresh chain timestamp was 1789422330 before startup.
The replacement reconstructed 7 open parlays from 20 total on-chain parlays;
all 177 exposed market counters matched with zero unminted reservations before
the quote smoke. Polling remained enabled at 60 seconds.

Private backups are under `/opt/hype/backups/cleanup-20260914` (root mode 0700).
Registry and waitlist bytes were unchanged; all 120 original cache fractions
were retained. The final pre-restart journal had 40 records; its exact prefix
survived and each of the two smoke quotes appended one flushed schema-1 record.

```text
SMOKE OK: live 177/177, priced 30, open 7, bankroll 1053317479,
reserved 1597996, quote 2.60x on Paris Saint-Germain + Los Angeles Rams
PASS public quote appended one durable journal record; old prefix preserved
PASS CORS: both frontend origins on /health and /quote preflight
PASS untrusted origin excluded
```

The public smoke's reserved amount includes the earlier local smoke quote.
Reservations retain the existing expiry grace. An initial CORS assertion used
the intentionally public `/markets` route and expected an exact origin; the
correct restricted health/quote checks passed without changing application code.

Quotes reopened at 21:48:33. Writer and keeper had zero supervisor restarts.
Rotation was guarded during cutovers, then restored for 22:10 UTC without a
missed-tick catch-up or manual rotation. No contracts were redeployed by this
rollout. No signup email, wallet approval, mint, claim or manual settlement
transaction was submitted; browser/wallet acceptance remains outstanding.

Rollback uses `writer-before-cutover` / `keeper-before-cutover` and current state,
with the original frontend deployment recorded above. Retain working RPC routing.
If restoring the prior writer while using public dRPC, retain the 100-block scan
fix; restoring its old 1,000-block limit reintroduces the observed catch-up failure.
Never restore the initial cache, journal or waitlist over newer runtime state.
