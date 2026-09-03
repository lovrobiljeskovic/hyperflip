# Testnet Correlation System Handover

Updated: 2026-09-01
Branch: `feature/testnet-correlation-system`
Implementation HEAD before this handover: `0dd4fb1277fd0419ea210bada61a53590adfe335`

## 2026-09-01 production incident and temporary rollback

Status: **ROLLBACK ACTIVE / NEW CHAMPION PATH DISABLED UNTIL ROTATION COMPATIBILITY IS FIXED**.
The activation narrative below is historical evidence for the first successful champion, not the
current production state.

At the 2026-09-01 03:10 UTC market rotation, `rotate.service` deployed six markets, pruned fourteen,
rewrote the box-authoritative market registry, and restarted writer. Writer then rejected champion
`2026-08-31.2270db3d` with `artifact profile identity mismatch`, fell back to `profile-baseline`,
and set `multiAssetEnabled: false`. The public metrics endpoint subsequently recorded every quote
rejection as `correlation-unavailable`. This is fail-closed behavior, but it makes normal nightly
vault rotation an availability event.

The coupling is too strict at runtime: a champion is bound to the exact `marketRegistrySha256`,
even though nightly rotation normally changes volatile vault addresses, outcome coin IDs, expiries,
and titles without changing the correlation taxonomy. Under the current implementation every such
change requires a new candidate, review, manual promotion, and writer restart. The collector,
daily, and backup timers are also not installed on the box; installing them alone would not solve
activation because daily processing deliberately never promotes.

The durable fix must preserve immutable artifact and validation identities while introducing a
separate runtime-compatibility decision:

- Keep the artifact's exact market-registry hash as provenance; do not rewrite or weaken historical
  candidate/validation identity checks.
- Permit activation against a rotated live registry only when every market maps to an allowed
  underlying and the same cluster/direction taxonomy, and every requested underlying/pair remains
  eligible in the champion. Unknown or remapped inputs must still fail closed locally rather than
  disabling unrelated pairs.
- Record both the champion registry snapshot and the live registry snapshot in quote/report evidence.
- Stage registry rotation and compatible champion activation atomically so a restart cannot expose
  a half-transition.
- Retain the existing seven-day model-age limit. Removing daily registry coupling removes the daily
  promotion burden, but a fresh Supported champion is still required at least weekly unless that
  separate policy is deliberately changed.

### Required unattended operating model

Routine candidate production, promotion, activation, and recovery must be automated. Human approval
is reserved for changes to model code, policy or quality thresholds, data sources, enabled networks,
or the underlying/cluster/direction taxonomy; it is not required for each fresh candidate that passes
the already-approved deterministic gates.

The scheduled path is:

```text
collect -> derive -> calibrate -> replay
                                |
                         all fixed gates pass?
                           yes        no
                            |          |
                    atomic promotion  retain current valid champion + alert
                            |
                     activate writer
                            |
              health, identity, and cross-underlying quote check
                            |
                      keep or auto-rollback
```

Automation requirements:

- Promote only a fresh `Supported` candidate with deterministic rerun matching, projection error at
  or below `0.10`, and exact immutable candidate, validation, manifest, returns, exclusions, profile,
  source, deployment, and baseline identities. `Rejected`, `Inconclusive`, stale, mismatched, or
  incomplete candidates must never replace the current champion.
- Write the existing verification and promotion receipts, preserve the displaced champion/release,
  and switch the champion and writer atomically. Never restart keeper for a correlation activation.
- After activation require healthy writer/caddy/keeper state, the expected champion hash/version,
  `multiAssetEnabled: true`, current `/markets`, and a successful controlled cross-underlying quote
  without minting. Restore the prior champion/release automatically if any check fails.
- Keep the current valid champion live when a scheduled research run fails and emit an actionable
  alert with the failed stage and immutable operation record. If no valid champion remains before
  the seven-day age limit, retain the existing fail-closed behavior.
- Treat market rotation as a separate runtime-compatibility transaction. A compatible change to
  vault addresses, coin IDs, expiries, or titles must not require recalibration or promotion. Stage
  registry rotation and compatibility activation together; reject only unknown or remapped
  underlyings/pairs, without disabling unrelated eligible pairs.
- Install and monitor the collector, daily pipeline, and backup timers. The daily pipeline must own
  gated automatic promotion and activation rather than stopping after candidate generation.

Temporary recovery uses writer commit
`11b202ffcc5ebbb3ab88c6aa5c13accaed6b4bf0` (`docs(research): design correlation beta`). This is
the last commit before the new research implementation begins and retains the previous static
correlation-table pricing path. Deploy writer only; do not roll back web, keeper, contracts, the
box-authoritative registry, waitlist data, or `/opt/hype/research/testnet`. Preserve the displaced
writer source as the immediate rollback path. After deployment, require writer/caddy/keeper active,
healthy `/health`, current `/markets`, and a successful cross-underlying quote before calling the
temporary recovery live.

The rollback was activated at `2026-09-01T16:47:50Z`:

- Local rollback artifact SHA-256:
  `662b9fd97f549551b8d0d539b67da191cd39209b9e93b1fb67861eb3c8e8f5f9`.
- Exact historical writer check: TypeScript passed and tests passed `155/155`.
- Server-side typecheck passed. A preflight against the newer live `correlations.json` correctly
  caught an old-parser floating-point boundary failure before restart, so the rollback release uses
  commit `11b202f`'s matching historical static table. That table covers all nine markets in the
  current box-authoritative registry.
- The current champion writer remains untouched at `/opt/hype/writer`. The rollback is staged at
  `/opt/hype/writer-rollback-11b202f`; `/opt/hype/research/testnet`, waitlist data, registry, keeper,
  contracts, and web were not changed.
- `/etc/systemd/system/writer.service.d/rollback.conf` points writer at the staged directory and sets
  its historical table path. Writer restarted at PID `352619`; writer, keeper, and caddy all reported
  `active`. Health reported six open parlays and nine markets without the champion-model fields,
  proving the old path is running.
- A public BTC/ETH quote returned HTTP `200`, a signed quote, and
  `jointProbWad=31217082190008632`. No mint was submitted.

After the rotation-compatible champion writer is fixed, verified, and deployed to `/opt/hype/writer`,
restore it by removing only `/etc/systemd/system/writer.service.d/rollback.conf`, then run
`systemctl daemon-reload` and restart only writer. Require healthy champion identity,
`multiAssetEnabled: true`, and a successful cross-underlying public quote before deleting the staged
rollback release. If activation fails, recreate/retain the override and restart writer to return to
the static release.

Separate positions finding: Vercel production uses parlay deploy block `61907400`, while the
authoritative deployment registry says `61906227`. That skips position ID 1, and the localStorage
checkpoint key is not bound to the deploy block. Correct the environment and invalidate/bump the
checkpoint in a separate web change; it is unrelated to writer rollback.

## Start here in a new session

1. Read the repository `AGENTS.md`.
2. Check out or enter `feature/testnet-correlation-system` and verify it contains the implementation
   commit above plus this handover.
3. Read, in order:
   - `docs/research/testnet-correlation-handover.md`
   - `docs/research/testnet-correlation-verification.md`
   - `docs/superpowers/specs/2026-08-29-testnet-only-correlation-corrective-design.md`
   - Task 9 in `docs/superpowers/plans/2026-08-29-testnet-only-correlation-corrective-wave.md`
4. Treat the current production state as **ROLLBACK ACTIVE**. The prior activation and green gate
   matrix are historical evidence for the displaced champion, never current production, mainnet, or
   profitability evidence.
5. Do not access mainnet, lower the projection gate, promote rejected candidate
   `2026-08-30.dda295a1`, restart the keeper, print secrets, buy infrastructure, or wait
   synchronously for settlement.

Suggested new-session request:

> Continue the testnet correlation handover at
> `docs/research/testnet-correlation-handover.md` on
> `feature/testnet-correlation-system`. Production is temporarily running the static rollback.
> Implement rotation-compatible champion activation and the recorded unattended gated promotion,
> activation, smoke-check, and rollback flow. Preserve immutable evidence, keep the work testnet-only,
> and do not restart keeper, wait for settlement, rotate, or upload backups.

## Historical champion activation state

The research and runtime plumbing is implemented and locally verified. The first live Ubuntu
testnet run was correctly **Rejected** because projection error `0.314324004721122` exceeded the
fixed `0.10` policy. After diagnosis and local review, an explicitly approved fresh bounded rerun
produced candidate `2026-08-30.6546a1af` with projection error
`1.3322676295501878e-15` and deterministic decision **Supported**. Separate approval then promoted
that exact artifact, deployed reviewed writer commit `5009dc19`, restarted only writer, and minted
one correlated BTC/ETH testnet parlay.

Consequences:

- Champion SHA-256 is `8977a5e1dfcf19eb29a5a49d1aa83bd3a6873dd7218bca7758e0501f66a8fde2`.
- Writer PID `283499` is healthy with `identityFailureReason: null` and `multiAssetEnabled: true`.
- Keeper stayed active at PID `255151` and was never restarted.
- Quote `0xa911699e635a41c5d0d5d2b67374a7cc2399a26c30963e59a00b0e9ddd94a05c`
  minted parlay `18` in transaction
  `0xee85e972d9e13226d092474a37776fc7d2e6abc2feb0370c766c7074dae6bfda`.
- Immediate join recorded the mint as open; no settlement was awaited.

The model-quality, live activation, and final local gate boundaries are cleared for this exact
testnet artifact. The missing fresh-rerun command transcript and terminal-record hashes remain an
audit-evidence gap; natural durability evidence remains non-blocking.

### Local continuation after handover

The projection error has now been diagnosed locally from hash-verified copies of the immutable
candidate and validation sidecar. The exact evidence and local corrective-candidate hash are in
`docs/research/testnet-correlation-verification.md`. The root cause is structurally incompatible
pairwise splicing: the static fallback and measured crypto matrices are each positive semidefinite,
but ZEC's approximately `0.90` static within-crypto edges conflict with the six measured
BTC/ETH/HYPE/SOL edges.

The candidate correction quarantines only the four incompatible ZEC-to-measured-crypto fallback
pairs and leaves the fixed `0.10` projection gate unchanged. A candidate generated twice from
copied immutable inputs recorded projection error `1.3322676295501878e-15`. Replaying that exact
local candidate with the original public seed returned `Supported` with deterministic rerun
matching; validation sidecar SHA-256 is
`c480ec7853a9e81f44b32381853802ef4dbe0a1bae150be093ca5e6063663236`. Independent review found no
remaining code or test findings. At that stage the live state remained `Rejected`; the approved
fresh rerun below supersedes only the latest statistical decision. All other shared-testnet
prohibitions remain, and promotion or activation needs separate explicit approval.

### Approved live rerun result

The bounded Ubuntu flow collected 77 new candles with zero failures, derived 17,996 returns and
19,153 exclusions, calibrated six direct pairs plus 45 retained fallbacks, and quarantined only
the four incompatible ZEC bridge fallbacks. Candidate SHA-256 is
`8977a5e1dfcf19eb29a5a49d1aa83bd3a6873dd7218bca7758e0501f66a8fde2`; validation SHA-256 is
`6f84eca8caba3d9ccee6d84ad2923656bbc3bb44ee58067a347fd11db0fd25b3`. Replay returned `Supported`
with deterministic rerun matching under the unchanged `0.10` gate. The identities, run IDs,
artifact hashes, setup failures, and report hash are in
`docs/research/testnet-correlation-verification.md`; that record explicitly notes the missing
command-level audit transcript and terminal-record hashes.

That rerun itself stopped before promotion. The later separately approved activation is recorded in
`docs/research/testnet-correlation-verification.md`; rotation and backup upload were not attempted.

## What is already working

| Capability | Evidence |
|---|---|
| Testnet-only profile boundary | Chain `998`, testnet Info host, exact deployment/profile identities; mainnet rejected |
| Linux anchored persistence | Ubuntu suite passed 10/10, including symlink and root/destination swap cases |
| Live collection | Initial 38,033 accepted rows; fresh rerun added 77 with 0 conflicts/failures |
| Returns derivation | Fresh closure has 17,996 returns-v2 rows and 19,153 explicit exclusions |
| Calibration | Candidate `2026-08-30.6546a1af`; 6 direct, 45 fallback, 4 structural quarantines |
| Deterministic replay | Fresh 20,000-draw replay completed `Supported`; deterministic rerun matched |
| Safety decision | Projection `1.3322676295501878e-15 <= 0.10`; exact candidate promoted |
| Reporting | Supported report rendered with immutable identity/evidence closure |
| Live quote/mint/join | Correlated BTC/ETH quote; parlay `18` minted; one event joined, 0 resolutions |
| Local supported lifecycle fixture | Promotion, writer startup, quote journal, mint/join, reporting, reopen and backup-plan paths exercised without network |
| UI compatibility | Exact Turbopack production build, TypeScript, 6 static pages, and web tests 21/21 passed using authoritative public testnet values |
| Fresh final matrix | Forge 172/172, writer 354/354, research 167/167, keeper 25/25, web 21/21 plus production build, rotation 15/15, aggregate verifier green |

The two-line UI deployment-block correction at handover HEAD changes only public testnet config:
`web/.env.example` and `web/vitest.config.ts` now match
`registry/deployment.testnet.json` at block `61906227`.

## What remains unproven live

Promotion, writer startup validation, correlated pricing, quote journaling, mint joining, and
champion persistence across a writer restart are now proven live. Still pending:

- an interactive browser/wallet screenshot because no browser surface was connected;
- a natural future settlement resolution join;
- observation across a natural nightly rotation; and
- off-box backup configuration/upload, which remains unauthorized.

## Blocking work, in order

### 1. Diagnose the `0.314324` projection error — completed

This was the only model blocker and is now diagnosed and cleared by the reviewed structural
fallback admission rule. The evidence below remains the immutable diagnostic record.

The original candidate assembled 6 measured direct pairs and 49 static fallback pairs. The nearest valid
positive-semidefinite correlation matrix had to change at least one entry by about 31 percentage
points. The completed diagnostic isolated the incompatible original pair values.

Completed diagnostic work:

1. Copy or inspect the immutable candidate and validation sidecar read-only from the existing
   testnet research root. Verify their hashes before analysis. Do not edit remote artifacts.
2. Reconstruct the pre-projection matrix in `quality.matrixOrder` from `directPairs`,
   `fallbackPairs`, `quarantinedPairs`, and unit diagonal.
3. Compare every pre-projection entry with `quality.signedPsdTarget`; rank pairs by absolute delta
   and identify the pair producing `0.314324004721122`.
4. Calculate the pre-projection eigenvalues and confirm whether the failure comes from:
   - the static fallback matrix alone;
   - replacing fallback values with the 6 direct values;
   - one or more negative direct values;
   - a cluster/fallback mapping inconsistency; or
   - another reproducible calibration defect.
5. Run offline leave-one-pair-out or incremental-direct-pair diagnostics to isolate the smallest
   incompatible set. These are diagnostics only, not permission to cherry-pick favorable data.
6. Record the diagnosis and exact evidence before proposing a production fix.

Relevant code:

- `writer/src/research/calibration.ts`
- `writer/src/research/matrix.ts`
- `writer/src/research/artifacts.ts`
- `writer/test/research-calibration.test.ts`
- `writer/test/research-matrix.test.ts`
- `writer/test/research-artifacts.test.ts`

### 2. Implement the smallest statistically justified correction — completed

The exact change depends on the diagnosis. Acceptable categories include a correctly justified
shrinkage/admission rule, quarantining structurally incompatible evidence, or constructing the
target from a model that is valid by design. Do not choose among them before the diagnostic result.

Hard requirements:

- Keep `maxProjectionError: 0.10` unchanged.
- Do not relabel static fallback values as measured testnet data.
- Do not invent ZEC or SP500 candles; their testnet sources are delisted/measurement-disabled.
- Do not manually edit a generated candidate.
- Add a regression test reproducing the actual incompatible-matrix case before changing production
  behavior.
- Preserve exact profile, source, market, deployment, baseline, manifest and validation identities.
- Preserve rejection of unmapped cross-underlying quotes and mapped cluster disagreements.

### 3. Produce and review a fresh local candidate — completed

Use immutable existing facts for fast offline diagnosis where possible. After the fix:

1. Run focused calibration/matrix/artifact tests.
2. Run the research suite and writer suite.
3. Generate a fresh candidate from the controlled dataset.
4. Run deterministic replay.
5. Require all policy gates, including:
   - decision `Supported`;
   - `deterministicRerunMatches: true`;
   - `quality.maxProjectionError <= 0.10`;
   - no non-finite or matrix failure;
   - exact derived and registry identity closure.
6. Obtain independent code review before any shared-testnet mutation.

Passing a local fixture is necessary but is not live acceptance.

### 4. Run a fresh bounded testnet candidate flow — completed through report

This wrote shared testnet research state after explicit approval. The authorization boundary was:
existing fixed-price VPS and faucet testnet assets only; zero incremental real-money spend. The
flow stopped after the Supported report, before promotion.

Before mutation, recheck:

- Ubuntu host and chain `998`.
- Testnet-only profile, Info host, vault and deploy block.
- Exact deployed commit and registry hashes.
- `RESEARCH_REQUIRE_ANCHORED_FS=1`.
- Free disk and research-root ownership/mode.
- Keeper and writer health/PIDs.
- No mainnet endpoint or data.

Then run the bounded flow:

```text
collect → derive → calibrate → replay → report
```

Inspect the candidate and validation sidecar before promotion. A result other than `Supported`
stops the flow without promotion, restart, quote, or mint.

### 5. Promote and activate only after `Supported` — completed

The exact Supported candidate was promoted, reviewed writer commit `5009dc19` was deployed, and
only writer was restarted. The first startup failed closed on an ambiguous relative profile path;
the public setting was corrected to the absolute testnet profile path and the writer recovered at
PID `283499`. Keeper remained PID `255151`; champion bytes survived unchanged.

For a reviewed Supported candidate:

1. Promote the exact candidate.
2. Verify the champion bytes and validation hash.
3. Deploy the reviewed writer commit.
4. Restart **only** the writer. Never stop or restart the keeper for this acceptance.
5. Check writer health shows:
   - the expected model version and data-manifest hash;
   - `identityFailureReason: null`;
   - `multiAssetEnabled: true`;
   - the expected chain/profile/deployment identity.
6. Confirm the research root and champion survive the writer restart.

### 6. Exercise the actual UI path — completed through public API and chain

The public builder API returned the correlated BTC/ETH quote recorded above and the exact web
display math produced `5.165067457103248x` uncorrelated fair,
`5.745580452424828x` corrected fair, and `5.31998x` signed payout. The 0.25 USDC quote minted
parlay `18` successfully. No browser surface was connected, so interactive browser/wallet visual
evidence remains explicitly unavailable rather than inferred.

The UI is already capable of consuming the writer's `jointProbWad` breakdown. No large UI feature
is expected.

Required live example:

1. Open the testnet builder using the deployed writer URL and authoritative chain/vault/deploy-block
   values.
2. Select two non-band markets with different supported underlyings, preferably `BTC` and `ETH`.
3. Request a minimum-stake quote with an authorized beta invite.
4. Verify the quote succeeds rather than returning `correlation-unavailable`.
5. Verify the response includes a correlated joint probability and the UI shows corrected fair
   odds versus the signed quote.
6. Mint one minimum-value quote using faucet testnet USDC/HYPE.
7. Record the public quote ID, transaction hash, parlay ID, exact champion/model/validation hashes,
   and redacted output.

Do not expose invite codes, private keys, signatures beyond public transaction data, RPC secrets,
or environment contents.

### 7. Finalize evidence and PR gates — completed green

Update `docs/research/testnet-correlation-verification.md` with exact commands, exit codes, hashes,
public IDs and redacted output. Then run at the final commit:

```bash
forge build
forge test
cd writer && npm run check && npm run research:check
cd ../keeper && npm run check
cd ../web && npm run check
cd .. && node --test tools/rotate-lib.test.mjs
./scripts/verify.sh
git diff --check
```

For the web build, provide the authoritative public testnet environment values; a missing env is a
real build precondition. Turbopack rejects an external `node_modules` symlink, so this worktree uses
a lockfile-local `npm ci` install. The exact check passes; do not commit `node_modules`.

The GitHub workflow currently runs only Forge. Before merging this large TypeScript change, add or
require CI coverage for writer/research, keeper and web, or record an explicit repository-owner
decision to rely on the exact local gate evidence.

The branch is pushed, but no PR was created because `gh` was unauthenticated and no signed-in
browser was available. Open a draft PR from:

`https://github.com/Pythia-Labs/hyperevm-combos/pull/new/feature/testnet-correlation-system`

The PR title/body should say **ACTIVATED / gate matrix green / audit closure partial** until the
missing fresh-rerun command transcript and terminal-record hashes are recovered or explicitly
waived by the repository owner.

## Definition of working on testnet

The core feature may be called working on testnet only when all of these are true:

- A fresh live candidate is `Supported` and deterministic with projection error at or below `0.10`.
- The exact candidate is promoted as champion.
- Only the writer is restarted and remains healthy with exact testnet identities.
- A cross-underlying UI quote uses the champion and returns correlated pricing evidence.
- A minimum-value quote is minted successfully on chain `998`.
- Evidence is committed and all relevant gates pass at the same commit.

This definition does **not** require waiting for market settlement.

## Non-blocking follow-up evidence

These items should be tracked but must not block the initial correlated UI activation:

- Let the scheduled joiner attach a natural resolution after a future minted parlay settles. Do not
  wait synchronously and do not force a void merely to finish acceptance.
- Observe a natural post-root market rotation and confirm the root/champion persist. The current
  rotation service restarts keeper and writer, so do not manually invoke it during writer-only
  acceptance.
- Configure and verify off-box backup only after an explicit storage/cost authorization. The
  current no-upload check correctly reports backup disabled.
- ZEC and SP500 remain eligible only through reviewed static fallback while their testnet candle
  sources are delisted. Re-enable measurement only if valid testnet sources return and pass the
  normal data-quality gates.
- The clean web install reported existing dependency audit findings (24 moderate, 2 high). This
  branch did not change `web/package-lock.json`; assess them separately rather than mixing an
  unrelated dependency upgrade into the correlation fix.

## Hard prohibitions

- No mainnet candle backfill, endpoint, profile, deployment, relabeling, or mixed-network evidence.
- No lowering or bypassing the `0.10` projection-error gate.
- No promotion of `2026-08-30.dda295a1`.
- No keeper restart or mutation during writer-only acceptance.
- No destructive replacement of `/opt/hype/research/testnet`.
- No paid/metered service or backup upload without fresh approval.
- No secret output in logs, chat, documentation or commits.
- No synchronous settlement wait and no artificial void as an acceptance shortcut.

## Authoritative evidence

The detailed hashes, run IDs, public chain identifiers, service PIDs, candidate statistics,
failures and successful report path are in:

- `docs/research/testnet-correlation-verification.md`
- `docs/superpowers/specs/2026-08-29-testnet-only-correlation-corrective-design.md`
- `docs/superpowers/plans/2026-08-29-testnet-only-correlation-corrective-wave.md`

Final Rejected report on the existing VPS:

```text
/opt/hype/research/testnet/reports/2026-08-30-2026-08-30.dda295a1.html
SHA-256 cb4ce10a92a2d22f359399505cea7dc6931825113ceb0980aa60572614d818d9
```

Do not copy secret environment files when retrieving public/immutable diagnostic artifacts.
