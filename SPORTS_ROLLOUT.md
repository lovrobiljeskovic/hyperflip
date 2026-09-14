# Sports release rollout checkpoint

The operator approved the rollout on 2026-09-14. The sports release is now live;
see the execution record below. Earlier observations and the approved plan are
retained for rollback context.

## Executed release

- Release: `907ccd1b6538259a4eca148c9ddbceade91cac0d`, pushed to
  `cleanup/sports-v1`. This is e707d93 plus the missing reduced-motion poster.
  The poster was extracted from the existing animation, decoded and visually
  checked. No contract or writer source changes were added to e707d93.
- Frontend: `dpl_9arnaeeM7brodnb9UyrfTa76tKby`, production READY, serving
  `hyperflip.xyz` and `app.hyperflip.xyz`. Its Vercel build compiled, typechecked
  and generated all 10 pages successfully. The production landing, trading,
  positions and pricing routes returned HTTP 200. The deployed poster matches
  the committed file byte-for-byte.
- Writer: `/opt/hype/writer`, source hashes match e707d93; RELEASE records the
  full 907ccd1 release. Rotation's two source files also match e707d93.
  All three existing contract ABIs match the release and were left untouched.
  The staged host typecheck and all 116 writer tests passed before cutover.
- Private rollback directory:
  `/opt/hype/backups/sports-e707d93-20260914` (root-owned, mode 0700).
  It contains configuration/code backups, stable state snapshots, pause/drain
  evidence and smoke records. Configuration and private records were not printed.
- Writer quotes were gated at Caddy before stopping the old process. Port 8787
  had no listener before cutover. Wall-clock expiry and a fresh chain timestamp
  were checked before starting one replacement writer. A later RPC-only restart
  used the same drain procedure. The gate stayed closed until validation passed.
- Keeper PID **595221**, started 12:14:05 UTC, remained unchanged throughout.
  Its code and RPC settings were not replaced. Original registry and waitlist
  bytes, every prior journal byte and all saved cache entries were preserved.
- `PARLAY_DEPLOY_BLOCK` was corrected from 61907400 to the verified 61906227.
  The research drop-in was retired and its RPC configuration moved privately
  into the root service environment. Existing pricing and exposure limits remain.
- During cutover the private dRPC endpoint reported its monthly quota exhausted;
  existing public/Chainlink fallbacks returned rate limits. The already-used
  frontend RPC `https://hyperliquid-testnet.drpc.org` passed chain and concurrent
  contract-read checks and became writer primary. All former writer endpoints
  remain as fallbacks. This recovery changes writer routing only; it does not
  replace credentials or the keeper's Core-sensitive RPC configuration.
- Rebuilt exposure matched all **7** open on-chain positions and active-market
  totals. The first comparison ran during the smoke reservation's configured
  grace period; after expiry/grace, reserved exposure was zero and no market
  mismatches remained. No exposure logic was changed.
- Public signed-quote smoke and both production CORS origins passed:

  ```text
  SMOKE OK: live 177/177, priced 30, open 7, bankroll 1053317479, reserved 0, quote 2.60x on Paris Saint-Germain + Los Angeles Rams
  PASS: writer CORS https://hyperflip.xyz
  PASS: writer CORS https://app.hyperflip.xyz
  ```

  Quote signing appended schemaVersion 1 records while preserving all 37 earlier
  schemaVersion 3 records. Active markets are sports-only (177), and the writer
  exposes only sports historical entries (56); the full host registry remains.
- Caddy's original configuration is restored and public quoting is open.
  Rotation's temporary guard was retired. The persistent timer stamp was advanced
  to skip the missed 20:10 run; next rotation is **21:10 UTC on 2026-09-14**.
  No rotation or contract deployment was invoked during this release. Future
  scheduled rotation retains its existing registry-update/service-restart behavior.
- Frontend rollback target remains `dpl_74jV26eAcfJyM6ctfJWL6wCrrto5` (e8891e6).
  Writer rollback files are under `writer-replaced/` and `writer-code.tar` in the
  private backup directory. On rollback, retain the working RPC routing: blindly
  restoring the original sole, quota-exhausted RPC would prevent quoting.
  Restore code only after the quote drain; preserve current runtime files and
  mixed-version journal. The old independent writer appends without reading that
  journal; do not feed mixed records to archived research readers indiscriminately.
- [CI for 907ccd1](https://github.com/lovrobiljeskovic/hyperflip/actions/runs/34892342336)
  passed (confirmed after the initial post-rollout check). e707d93 CI and the
  pre-rollout 350-test repository gate also passed. Later local cleanup commits
  are not deployed by this rollout.

Limitations: no browser was available after runtime discovery returned an empty
list. Wallet connection, browser position loading, approval/mint and claim/resolve
transactions were not tested. No test emails or manual transactions were sent.
Keeper process continuity was verified; successful settlement transactions were
not independently exercised. The initial asset-upload check failed because the
poster was missing and was corrected before promotion. The first timer-guard move
failed across filesystems; a safe move completed restoration before this record.

## Verified state

- Local and remote `cleanup/sports-v1`: `e707d93c4cc9e22005be8d342cbe562693c10030`.
- Local and remote `archive/correlation-research`:
  `f0db77514456c0334b988c933721d7d81d8ce899`; unchanged.
- Existing README modification and untracked CLEANUP_HANDOFF.md preserved.
- [CI run 34883841567](https://github.com/lovrobiljeskovic/hyperflip/actions/runs/34883841567):
  `status: completed`, `conclusion: success`, exact release SHA confirmed by API.
- `writer.hyperflip.xyz`: `ok: true`, `seeded: true`, 7 open parlays,
  reserved exposure 0, bankroll null, last journal append null. These are a
  momentary observation, not evidence that a restart is safe or journal writes work.
- Writer health still includes `model` and `pricingMode`. `/markets` contains
  177 active sports markets and 152 archived entries: 56 sports, 87 crypto,
  8 equity, 1 commodity. This differs from the release's response shape and
  sports-only historical filtering. Exact host revision remains unknown.
- Public quote TTL: 30,000 ms; max stake: 2,000,000 USDC base units;
  base edge: 500 bps; per-leg edge: 300 bps. Preserve effective host settings.
- Both public frontend domains returned HTTP 200; app root matched `/build`.
- Vercel project: `overround`, `prj_jJiCD64dgtgGiGexTsM0NLWW5nGf`, team
  `team_VCeCEs2us2sNaddFZgTQydrR` / `lovrobiljeskovics-projects`.
- Current production deployment: `dpl_74jV26eAcfJyM6ctfJWL6wCrrto5`, READY,
  <https://overround-6j17h2ivs-lovrobiljeskovics-projects.vercel.app>.
  Metadata identifies CLI source, `main`, commit
  `e8891e6d66918359f22ce4f423a0e817578557c3`, not the sports release.
  Project has no Git link; a branch push is not a frontend rollout.
- Production Node setting is 24.x; local verification used Node 22.22.2.
  A production build still needs verification with the actual production settings.
- Deploying exact e707d93 would replace the newer hero-background artwork from
  e8891e6. Make that consequence explicit in approval; do not silently merge
  main or replace the sports cleanup with its older trading implementation.

## Host inspection and concrete rollout inputs

The original checkout's DEPLOY.md identifies `root@91.99.94.25`, port 22.
Strict known-host verification and batch-mode SSH succeeded. Hostname:
`ubuntu-4gb-fsn1-1`. No SSH credentials need to be supplied by the operator.
Vercel connector access returned 403; the local CLI works with the team above.

- Writer: `/opt/hype/writer`, service user `hype`, systemd MainPID 596368,
  started 13:33:05 UTC; its Node child 596393 owns the single port-8787 listener.
  All 35 inspected source/package files match f0db775 exactly. The rotation
  script in `/opt/hype/repo` also matches f0db775. That directory has no Git
  metadata; preserve installed files as the exact rollback artifact.
- Keeper: `/opt/hype/keeper`, user `hype`, MainPID 595221, started 12:14:05 UTC.
  All eight inspected source/package files match ca21a65. Its keeper.ts differs
  from the release; do not overwrite it during this writer-only rollout.
- Caddy is active; its existing upstream is `localhost:8787`.
- Rotation was inactive at inspection. The timer was active, next run 20:10 UTC,
  hourly at minute 10, `Persistent=true`. Its post-hook can restart BOTH services.
  Recheck immediately before any approved operation. No hype-research unit files
  or timers were installed; `list-unit-files` reported zero matches (exit 1).
- Writer drop-ins: `chown.conf`, `research.conf`. The research drop-in loads
  `/opt/hype/research.env`, which supplies the effective `WRITER_RPC` override.
  Removing it without migrating that setting would silently change RPC routing.
  Proposed approved migration: retain that exact value privately in `/opt/hype/.env`
  before removing the research drop-in; preserve the original file for rollback.
- `/opt/hype/.env`, `/opt/hype/research.env`, `/opt/hype/repo/.env` are mode 0600.
  Rotation's separate config contains its deployer key; it was never printed.
- State resolves to `/opt/hype/registry/markets.json`,
  `/opt/hype/keeper/settlement-cache.json`, `/opt/hype/writer/waitlist.json`,
  `/opt/hype/writer/quotes.jsonl`. The rotation registry is a symlink to the same
  authoritative registry. All parents are writable by `hype`; all four files
  parse. Cache has 120 entries; waitlist has 3; journal has 37 schemaVersion 3
  records and zero malformed lines. Keep every existing record.
- Effective host risk settings: max stake 2,000,000; market cap 50,000,000;
  cluster cap 150,000,000; invite-code reservation cap 30,000,000 (USDC base
  units). Quote TTL 30 seconds; mint polling 60 seconds; independent pricing.
  CORS includes both production domains. Keep these settings unchanged.
- RPC reported chain 998, contract code present, signer/writer/keeper identity
  matches, min premium 100 bps, nextId 20, bankroll balance 1,053,317,479 base
  units and sufficient allowance. No quote or transaction was sent.
- The host sets `PARLAY_DEPLOY_BLOCK=61907400`, but the manifest's 61906227 is
  the verified deployment block: RPC returns no code at 61906226 and code at
  61906227. Local deployment receipt
  `0xef5a2d0af19a9b2a8dc02a96bf577d42fb7aac4ea0265a1c00b06e96cbd4bd5d`
  also records 61906227. Propose correcting the host setting to 61906227 during
  the approved rollout and verifying the production frontend matches; do not
  silently retain the later scan start or change it without approval.
- Recent keeper logs contain one `settlement check failed`; no FATAL or stalled
  watchdog was observed. Process liveness is verified; successful settlement
  transactions and uninterrupted future polling are not established by this.
- Production frontend variable names/targets are present for writer URL, RPC,
  Info API, vault, deployment block and Privy app ID. Values/build compatibility
  remain unverified. Automatic approval review rejected `vercel env pull` to
  `/tmp/hyperflip-production-inspection.env`: exporting potentially secret
  production settings locally was not explicitly authorized. The command did
  not run. The operator subsequently authorized the download; see the
  production-build preparation record below.

Proposed private backup root, created only after approval:
`/opt/hype/backups/sports-e707d93-<UTC timestamp>` (root-owned, mode 0700).
Capture writer source/dependencies, the rotation source, matching ABIs, unit
overrides, Caddy configuration and private settings there; preserve state as
described below. Source fingerprints were compared locally using
`/tmp/hyperflip-host-source-manifest.json` (contains only paths and hashes).

## Remaining inspection and pre-rollout rechecks

On the confirmed host, inspect only selected service properties and sanitized
configuration summaries. Never dump environment files, process environments,
raw unit contents containing credentials, signup records, or quote records.

1. Record writer and keeper PIDs, start times, service users, working directories,
   source revisions or source hashes, unit/drop-in paths, and listener ownership.
   Identify the proxy configuration, rotation checkout, research jobs, active
   timers and any in-progress rotation. Confirm there is exactly one writer.
2. Resolve actual registry, settlement cache, waitlist, journal and private-config
   paths, including symlinks. Record ownership, modes and writable directories.
   Check parseability without printing contents. Do not treat malformed cache
   data as an empty cache. Keep the keeper process running throughout.
3. Compare effective chain/address/block with the public manifest (chain 998,
   ParlayVault `0x407cdc0b15e8d81f4d122481ecf92dbe07dc0169`, block 61906227)
   and the production frontend settings. Check RPC chain ID, deployed code,
   contract signer/writer against locally derived public addresses, allowance
   and balance. Compare deployment-block provenance with deployment records.
   Do not change credentials, contract settings, fees or allowances.
4. Validate sports-only active registry, `PRICING_MODE` unset/independent,
   positive mint polling, existing risk caps, CORS and wallet-provider origins.
   Preserve all historical host registry data and keeper recovery vault lists.
5. Record exact rollback writer files/dependencies and frontend deployment.
   Inspect old journal readers for compatibility with appended schemaVersion 1
   records. Recheck aliases immediately before rollout because production has
   changed since the original handoff.

## Proposed execution after approval

Replace example installation paths below with inspected paths before approval.
Approval covers the exact files, services, timer handling, frontend change and
test transactions; this document alone does not authorize them.

1. Stage exact e707d93 source and matching generated Foundry ABIs separately
   from the running installation. Install locked writer dependencies using
   `npm ci --include=dev`. Never start the staged writer. Keep the keeper's
   source, dependencies and process untouched. Stage matching rotation code
   in its inspected checkout without invoking rotation or broadcasting contracts.
2. Save private rollback copies of code, dependencies and configuration with
   restrictive permissions. Back up the authoritative host registry, waitlist
   and journal. For the still-running keeper's directly overwritten cache,
   obtain a validated stable copy: compare bytes before/after the copy and
   parse the copy, retrying on changes or truncation. Never truncate or restore
   the live cache to obtain a snapshot. Record actual backup paths privately.
3. Suspend the inspected rotation timer and obsolete research jobs, preserving
   their data and exact prior enabled/active states. If rotation is executing,
   let it finish and re-inspect registry/service state before proceeding; do
   not interrupt a broadcast. Block manual/other scheduled rotation too.
4. Gate public quote issuance at the inspected proxy, drain in-flight requests,
   then stop the old writer and verify its PID/listener have gone. Record this
   time. Keep the keeper running. Wait at least the effective old quote TTL
   after the old writer is confirmed stopped, and require a fresh RPC block
   timestamp strictly beyond the latest possible signed deadline. Public TTL
   was 30 seconds, but inspect the effective host value before using it.
   The contract accepts equality at the deadline, so equality is insufficient.
5. With the writer stopped, capture final stable waitlist/journal backups.
   Switch only approved writer source/dependencies/ABIs and rotation source.
   Retain state paths and the host registry; never sync checkout snapshots over
   them or use a broad deletion sync. Remove only inspected obsolete research
   overrides from the active writer configuration, retaining rollback copies.
6. Start exactly one new writer while the public quote gate stays closed.
   Require `seeded: true`, successful mint polling through a fresh head, matching
   on-chain open exposure and healthy logs before allowing quotes. A successful
   HTTP response alone is insufficient. If any check fails, remain paused.
7. Build the frontend from the approved source using production settings and
   the actual writer/RPC/vault/block/wallet origins. Never upload the `.next`
   artifact produced by scripts/verify.sh; it uses fixture endpoints. Verify
   the production build before switching aliases, record the new deployment ID,
   and explicitly approve the hero-artwork consequence above.
8. Open the quote gate only after both components match and read-only smoke
   checks pass. Under the approved test scope, check wallet connection, quote
   issuance/expiry, journal append, approval/re-quote/mint, positions, and
   available resolve/claim paths. Record transaction hashes and actual receipt
   results. Signup sends email: use only an explicitly authorized test address.
9. Recheck keeper PID/start time and settlement progress. Restore rotation only
   after approving its next-run time: the supplied Persistent timer can catch
   up immediately, and its service may restart both writer and keeper after a
   registry change. Do not manually invoke rotation for this release. Coordinate
   a quote drain for any ensuing writer restart. Record research jobs left off.

## Rollback

- Close the quote gate, stop the new writer, prove no writer remains, and wait
  out its effective quote TTL with the same fresh-block deadline check.
- Restore inspected old writer source, ABIs, dependencies and compatible
  configuration only. Keep the latest registry, cache, waitlist and all journal
  bytes. Never restore stale runtime backups as part of a code rollback.
- If old readers cannot tolerate schemaVersion 1 journal lines, preserve the
  complete mixed journal and configure a separate append file for the rolled-back
  writer before starting it. Record both paths; do not rewrite old records.
- Start one old writer, verify exposure reconstruction and polling, and restore
  the captured frontend deployment using the confirmed Vercel rollback operation.
  The ID above is the observed pre-rollout candidate, not a transaction-tested
  fallback. Reconfirm it and its aliases before execution.
- Restore only compatible unit overrides and agreed timer schedules, keeping
  keeper live. Reopen quoting after checks pass; otherwise remain paused.

## Actual checks

Production-build preparation resumed after the operator authorized the local
settings download. Settings are stored privately at
`/tmp/hyperflip-production.EYgM03/.env.production.local`, mode 0600, under a
mode-0700 directory. Vercel withheld the sensitive-marked Privy app ID. The
existing local public app ID was verified against the live frontend's public
initial JavaScript before use; its value was not printed. The production writer
URL, vault and deployment block match the expected release identity.

An isolated export of exact e707d93 is prepared at
`/tmp/hyperflip-production.EYgM03/source/web`, with only the necessary public
frontend settings copied into its private `.env.production.local`. The original
fixture artifact and uncommitted work remain untouched. Node 24.11.1 is used to
match the production project's Node 24 setting. No Vercel environment values
were changed remotely.

With `VERCEL_ENV=production`, `NEXT_TELEMETRY_DISABLED=1` and Node 24.11.1,
`npm run check` in that isolated export exited 0:

```text
Compiled successfully in 7.7s
Finished TypeScript in 5.5s
Generating static pages (10/10)
Test Files 5 passed (5)
Tests 28 passed (28)
PASS: index excludes wallet provider code
PASS: build loads wallet provider code
```

Generated output also passed assertions for both production domain settings,
the app-root rewrite and landing-page app links. The existing Vite config-loader
warning remains. Log: `/tmp/hyperflip-production.EYgM03/production-check.log`.
This is a verified local Next build, not a Vercel deployment or a Vercel Build
Output API artifact. Any later Vercel build must retain these production settings.

`env -u INVITE_CODE WRITER_URL=https://writer.hyperflip.xyz node tools/smoke.mjs`:

```text
SMOKE OK: live 177/177, priced 30, open 7, bankroll n/a, reserved 0, quote skipped (no INVITE_CODE)
```

`bash scripts/verify.sh` initially failed in the sandbox after 172 contract
tests because tsx could not open its IPC socket (`listen EPERM`). Rerun outside
the sandbox exited 0:

```text
Contracts: 172 tests passed, 0 failed, 0 skipped
Keeper:   # tests 25;  # pass 25;  # fail 0
Writer:   # tests 116; # pass 116; # fail 0
Web:      Test Files 5 passed (5); Tests 28 passed (28)
Tools:    # tests 9;   # pass 9;   # fail 0
PASS: index excludes wallet provider code
PASS: build loads wallet provider code
```

Total: 350 tests. Formatting, contract build/sizes, service typechecks and Next
build passed. Vite emitted a warning about future native config-loader support
for ESM syntax in vitest.config.ts. Full local log:
`/tmp/hyperflip-release-verify-unrestricted.log`.

These were the pre-rollout checks. The executed release above adds deployment,
public signed-quote and journal evidence. Wallet transaction and settlement-path
limitations remain explicit. Batches 3 and 4 continue locally after this checkpoint.
