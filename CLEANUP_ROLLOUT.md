# Batch 3/4 rollout, 2026-09-14

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
