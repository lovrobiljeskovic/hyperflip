# Testnet Correlation System Handover

Updated: 2026-08-30
Branch: `feature/testnet-correlation-system`
Implementation HEAD before this handover: `0dd4fb1277fd0419ea210bada61a53590adfe335`

## Start here in a new session

1. Read the repository `AGENTS.md`.
2. Check out or enter `feature/testnet-correlation-system` and verify it contains the implementation
   commit above plus this handover.
3. Read, in order:
   - `docs/research/testnet-correlation-handover.md`
   - `docs/research/testnet-correlation-verification.md`
   - `docs/superpowers/specs/2026-08-29-testnet-only-correlation-corrective-design.md`
   - Task 9 in `docs/superpowers/plans/2026-08-29-testnet-only-correlation-corrective-wave.md`
4. Treat the current operational result as **PARTIAL / Supported candidate**, never as full acceptance.
5. Do not access mainnet, lower the projection gate, promote rejected candidate
   `2026-08-30.dda295a1`, restart the keeper, print secrets, buy infrastructure, or wait
   synchronously for settlement.

Suggested new-session request:

> Continue the testnet correlation handover at
> `docs/research/testnet-correlation-handover.md` on
> `feature/testnet-correlation-system`. Review exact Supported candidate
> `2026-08-30.6546a1af` for separately approved activation. Keep the work testnet-only, do not
> weaken the `0.10` gate, and do not promote, deploy, restart services, quote, or mint without my
> explicit activation approval.

## Executive state

The research and runtime plumbing is implemented and locally verified. The first live Ubuntu
testnet run was correctly **Rejected** because projection error `0.314324004721122` exceeded the
fixed `0.10` policy. After diagnosis and local review, an explicitly approved fresh bounded rerun
produced candidate `2026-08-30.6546a1af` with projection error
`1.3322676295501878e-15` and deterministic decision **Supported**. It was not promoted or activated.

Consequences:

- No champion exists.
- The new writer code has not been activated on the live service.
- No candidate was promoted.
- No correlated runtime quote or mint was attempted.
- The current public writer remains on pre-branch code.
- The new correlation feature is not yet active through the UI.

The model-quality blocker is cleared for the reviewed candidate. Promotion and live activation
remain a separate authorization boundary.

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

No champion exists. Keeper PID `255151` and writer PID `255152` remained unchanged; neither service
was restarted or modified. No quote, mint, rotation, or backup upload was attempted.

## What is already working

| Capability | Evidence |
|---|---|
| Testnet-only profile boundary | Chain `998`, testnet Info host, exact deployment/profile identities; mainnet rejected |
| Linux anchored persistence | Ubuntu suite passed 10/10, including symlink and root/destination swap cases |
| Live collection | Initial 38,033 accepted rows; fresh rerun added 77 with 0 conflicts/failures |
| Returns derivation | Fresh closure has 17,996 returns-v2 rows and 19,153 explicit exclusions |
| Calibration | Candidate `2026-08-30.6546a1af`; 6 direct, 45 fallback, 4 structural quarantines |
| Deterministic replay | Fresh 20,000-draw replay completed `Supported`; deterministic rerun matched |
| Safety decision | Projection `1.3322676295501878e-15 <= 0.10`; no promotion performed |
| Reporting | Supported report rendered with immutable identity/evidence closure |
| Chain join | 49 events appended, 0 resolutions, cursor advanced to block `62923638` |
| Local supported lifecycle fixture | Promotion, writer startup, quote journal, mint/join, reporting, reopen and backup-plan paths exercised without network |
| UI compatibility | Clean production build passed and web tests passed 21/21 using authoritative testnet values |
| Full local gates before the UI config-only commit | Forge 172/172, writer 353/353, research 166/166, keeper 25/25, rotation 15/15, end-to-end 1/1 |

The two-line UI deployment-block correction at handover HEAD changes only public testnet config:
`web/.env.example` and `web/vitest.config.ts` now match
`registry/deployment.testnet.json` at block `61906227`.

## What is implemented but not yet proven live

These paths exist and pass local tests, but neither the original Rejected run nor the later
Supported-candidate rerun authorized live activation:

- Candidate promotion into `artifacts/champion.json`.
- Writer startup validation of exact profile, registry, manifest, candidate and validation hashes.
- Fail-closed writer fallback when no Supported champion exists.
- Cross-underlying eligibility and direct/fallback/quarantine checks.
- Correlated joint-probability pricing and quote evidence journaling.
- Quote-to-mint-to-resolution joining.
- Champion persistence across writer restart.
- Research timers and off-box backup-plan generation.

Do not describe these as live testnet acceptance until the steps below are completed.

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

### 5. Promote and activate only after `Supported`

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

### 6. Exercise the actual UI path

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

### 7. Finalize evidence and PR gates

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
real build precondition. In this worktree, `node_modules` symlinks caused a Turbopack filesystem-root
error. A clean temporary `npm ci` checkout built successfully. Do not commit `node_modules`.

The GitHub workflow currently runs only Forge. Before merging this large TypeScript change, add or
require CI coverage for writer/research, keeper and web, or record an explicit repository-owner
decision to rely on the exact local gate evidence.

The branch is pushed, but no PR was created because `gh` was unauthenticated and no signed-in
browser was available. Open a draft PR from:

`https://github.com/Pythia-Labs/hyperevm-combos/pull/new/feature/testnet-correlation-system`

The PR title/body must say **PARTIAL / Supported candidate** until promotion and activation complete.

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
