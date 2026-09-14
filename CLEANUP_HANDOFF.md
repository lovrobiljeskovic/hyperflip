# Sports release and remaining cleanup handoff

## Original handoff status (before rollout)

Prepared on 2026-09-14. The next action is to deploy and verify the sports release,
then start the remaining cleanup batches against that known working revision.
Deployment is an operational checkpoint, not a technical dependency of the refactors.

| Item | State |
| --- | --- |
| Sports release | `cleanup/sports-v1`, commit `e707d93c4cc9e22005be8d342cbe562693c10030`, pushed |
| Preserved implementation | `archive/correlation-research`, commit `f0db77514456c0334b988c933721d7d81d8ce899`, pushed |
| Local verification | 350 tests passed; builds, typechecks, formatting, and bundle checks passed |
| GitHub CI | [Passed for e707d93](https://github.com/lovrobiljeskovic/hyperflip/actions/runs/34883841567) |
| Live deployment | Not performed in this cleanup session; live revision and configuration still need verification |
| Remaining work | Batch 3: service setup and persistence. Batch 4: frontend maintainability |

Repository: [lovrobiljeskovic/hyperflip](https://github.com/lovrobiljeskovic/hyperflip).
The configured `Pythia-Labs/hyperflip` remote redirects there. The existing working
checkout is on `main`; cleanup work lives in `/tmp/hype-sports-v1-cleanup` on
`cleanup/sports-v1`. Preserve the original checkout's untracked files. A fresh
checkout of the pushed branch is sufficient to resume implementation.

## Constraints for both remaining batches

- Keep the app sports-only, including historical positions, errors, and pricing copy.
- Keep the archived branch intact. Do not restore its pricing model to this release.
- Preserve contract logic, deployed addresses, signed quote terms, and settlement behavior.
  ABI packaging changes how clients load interfaces; it does not change contracts.
- Keep comments only where they explain a necessary invariant or a non-obvious choice.
  Make them short and understandable without development history.
- Use small, reviewable changes. Review, fix findings, and run relevant checks before
  calling a batch complete. Record any checks that could not be performed.
- Ask before adding dependencies, changing scope, or modifying shared/live state.
  Do not overwrite uncommitted work or private runtime data.
- Prefer existing modules and standard-library facilities. A database, new framework,
  generic storage layer, or package publishing system is not an assumed requirement.

## First checkpoint: deploy the sports release

Use [DEPLOY.md](DEPLOY.md) for operations and [.env.example](.env.example) for the
configuration inventory. The release changes writer, frontend, and rotation code.
It does not require new contracts or a keeper-code rollout.

1. Verify the current live revision, service paths, and frontend project before changing
   them. Record the working rollback revision and deployment ID. Confirm that the
   proposed release is `e707d93`, not the archive branch.
2. Back up the host's market registry, keeper settlement cache, waitlist, quote journal,
   and private configuration. Keep these backups private. The host's rotated registry
   is authoritative; do not replace it with the checkout's snapshot.
3. Confirm writer configuration: sports-only active markets, deployment address/block,
   matching signer and bankroll, positive mint-watcher polling interval, existing risk
   limits, writable state paths, and frontend CORS origins. `PRICING_MODE` must be unset
   or `independent`. Retain existing keys and fee settings.
4. Update writer and rotation code, retaining the matching Foundry ABIs for this release.
   Install service dependencies with `npm ci --include=dev`. Remove obsolete research
   service configuration and disable its jobs as part of the approved rollout; preserve
   their data. Keep the keeper running while updating the writer. Coordinate rotation
   so its timer does not race the deployment; a live rotation broadcasts new vaults and
   is not required merely to release this code.
5. Build the matching frontend with production environment settings. Verify the writer
   URL, RPC, vault address/block, wallet-provider origins, and both app domains. This
   repository selects domain links at build time, so do not reuse a preview build as
   though it had been built with production settings. Never deploy the web artifact
   produced by `scripts/verify.sh`: that build deliberately uses fixture endpoints.
6. Check writer health (`seeded: true`), sports-only markets and historical labels,
   wallet connection, quotes, quote expiry, minting, position loading, and settlement
   actions on testnet. Record transaction IDs for approved transaction checks. If no
   claimable test ticket exists, record that limitation instead of claiming claims
   were verified. Check signup if enabled, journal writes, and service logs.
7. Record the deployed writer revision, frontend deployment, smoke-test evidence, state
   backup location, and rollback procedure. Rollback must preserve current state and
   account for journal schema differences; it must not restore stale runtime files.

Release acceptance: the sports UI and writer run matching code, the keeper remains
healthy, required live checks have evidence, and there is a working rollback plan.
GitHub CI passing does not establish live deployment correctness.

## Batch 3: service setup and persistent state

### Objective

Make the writer and keeper reproducible to package and safer to restart, while
preserving the existing single-writer operating model and all quote/settlement rules.

### Work

1. **Package ABIs.** Start with [writer/src/abi.ts](writer/src/abi.ts) and
   [keeper/src/abi.ts](keeper/src/abi.ts), which read `out/` at import time. Generate
   the required ABI files from the contracts, ship them with the service package, and
   add a drift check against a fresh Foundry build. Consumers should not need a local
   compiler or the full Foundry artifact tree at startup. Review the frontend's
   [contract interfaces](web/lib/contracts.ts) for compatibility without importing
   compiler artifacts or unnecessary interfaces into the browser.
2. **Consolidate deployment identity.** Start with the existing
   [testnet manifest](registry/deployment.testnet.json), service configuration, and
   [frontend chain configuration](web/lib/chain.ts). Establish one canonical public
   identity for chain, vault, and deployment block. Validate it at startup/build time
   and against RPC where appropriate. Keep private credentials separate. Preserve an
   explicit, validated path for alternate test deployments and document how existing
   environment settings migrate; do not silently change which deployment is used.
3. **Harden file persistence.** Review [keeper/src/keeper.ts](keeper/src/keeper.ts),
   [writer/src/waitlist.ts](writer/src/waitlist.ts), and
   [writer/src/index.ts](writer/src/index.ts). The keeper currently overwrites its cache
   directly and treats read failures as an empty cache; distinguish missing files from
   corruption and permission failures. The waitlist already uses temporary-file rename;
   check failure ordering so an unsuccessful save cannot become a successful in-memory
   signup. Define the journal's append/recovery guarantees and preserve old records.
   Use the smallest storage changes that satisfy those guarantees.
4. **Document recovery and packaging.** Update the install, deployment, state ownership,
   backup, and recovery instructions to match the actual implementation. Preserve
   existing state formats or provide an explicit, reversible migration with fixtures.

### Acceptance and checks

- A packaged service imports its ABIs with no source `out/` tree or Foundry installation.
  A deliberate ABI mismatch fails the generation/drift check.
- Chain, address, and block mismatches fail clearly rather than selecting another
  deployment or starting an incorrect history scan.
- Restart and failure tests cover existing state, first startup, malformed/truncated
  state, and failed writes. Previously saved settlement fractions and invite codes
  survive. A journal failure cannot return a successful signed quote response.
- Quote reservation checks remain synchronous with reservation; startup still gates
  quoting on exposure reconstruction. File persistence does not make replicas safe:
  multiple writers and restart recovery of unminted reservations remain separate
  design questions unless explicitly added to scope.
- Run targeted service tests, then `bash scripts/verify.sh`. Include the package-without-
  `out/` check and any new ABI/state checks in the repository gate.

Suggested review order: ABI packaging, deployment configuration, then persistence.
These can be separate commits within the batch. Contract changes, new deployments,
pricing changes, and horizontal scaling are outside its intended scope.

## Batch 4: frontend maintainability

### Objective

Make the existing trading flows easier to understand and change without redesigning
the app or changing its behavior.

### Work

1. **Separate ticket behavior from rendering.** Start with
   [ticket.tsx](web/app/(trading)/build/ticket.tsx). Trace quote refresh/expiry, wallet and
   chain changes, approval, re-quoting, mint simulation, and receipt handling before
   extracting code. Reuse [web/lib/writer.ts](web/lib/writer.ts) and
   [web/lib/format.ts](web/lib/format.ts). Extract focused behavior and display pieces
   only where there is a clear responsibility; avoid a generic transaction framework.
2. **Separate position loading from display.** Start with
   [the positions page](web/app/(trading)/positions/page.tsx) and
   [web/lib/scan.ts](web/lib/scan.ts). Separate on-chain loading and derived status from
   rendering and claim/resolve actions. Keep concurrency bounded, handle partial RPC
   failures, and prevent stale results from one account replacing another account's
   positions. Scope persisted scan checkpoints to deployment and account; invalidate
   incompatible caches safely without deleting unrelated browser data.
3. **Simplify state and duplication.** Remove redundant derived state and duplicated
   formatting/error logic in the touched flows. Retain existing shared market polling,
   loading/error behavior, sports filtering, accessibility, and responsive layouts.
   Shorten useful comments and remove obvious narration or historical notes.

### Acceptance and checks

- A quote for old selections, stake, wallet, or chain cannot become the current ticket.
  Expired quotes and rejected transactions recover through the existing user flow.
- Approval/re-quote/mint ordering and signed terms remain intact. Pending actions do
  not accidentally submit twice; wallet or RPC failures leave a usable interface.
- Position loading, refresh, claim/resolve, and historical labels still work. Unsupported
  market wording does not appear. Test account changes and stale async responses.
- The landing page still excludes wallet providers from its initial JavaScript, and
  trading pages still load them. Keep request concurrency and polling bounded.
- Read the installed Next.js guidance before editing. Run focused behavioral tests,
  `npm run check --prefix web`, and finally `bash scripts/verify.sh`. Perform a browser
  walkthrough on testnet; report untested transaction paths explicitly.

Suggested review order: ticket flow, positions flow, then remaining duplication and
comments. No visual redesign, wallet-provider replacement, new feature, dependency
upgrade campaign, or contract change is included.

## Completion record

For the release and each batch, record the commit, review findings and fixes, exact
checks/results, live checks or limitations, and any migration/rollback instructions.
Keep secrets, signup data, credentials, and private backup contents out of this file.

### Resumed inspection, 2026-09-14

See [SPORTS_ROLLOUT.md](SPORTS_ROLLOUT.md) for the read-only live observations,
rollout/rollback proposal, and repeated verification (350 tests passed).
The live writer differs from e707d93, and the frontend is a CLI deployment of
main at e8891e6. SSH was subsequently found in the original checkout's DEPLOY.md:
root@91.99.94.25. Read-only host inspection confirmed writer source matching
f0db775 and keeper source matching ca21a65; keeper remains running. The rollout
must preserve WRITER_RPC when retiring the research drop-in and explicitly
address the host's later deployment-block setting. Production-setting export
was initially blocked by automatic approval review, then downloaded privately
after explicit operator authorization. An isolated production-configured build
of e707d93 passed on Node 24: 28 frontend tests and both wallet-bundle checks.
Production domain settings, rewrite and landing links also passed output checks.
The operator then approved the live rollout. The sports release is deployed as
907ccd1 (e707d93 plus its missing reduced-motion poster), with frontend deployment
dpl_9arnaeeM7brodnb9UyrfTa76tKby. Public signed-quote smoke, journal preservation,
exposure reconstruction and both CORS origins passed. Keeper PID stayed unchanged.
RPC quota exhaustion required using the existing frontend RPC as writer primary,
retaining old endpoints as fallbacks. Rotation resumes at 21:10 UTC; no rotation
was invoked during release. Browser/wallet transaction paths remain untested.
See SPORTS_ROLLOUT.md for exact backups, evidence, failures and rollback details.
Batch 3 and Batch 4 remain local cleanup work; their deployment is not yet approved.

### Local cleanup checkpoints, 2026-09-14

The sports release remains recorded separately as `907ccd1`; the following work
has not been pushed or deployed. Preserve the concurrent hero commit `6315a23`.
The archive branch remains `f0db77514456c0334b988c933721d7d81d8ce899`.

| Checkpoint | Commit | Verification |
| --- | --- | --- |
| Generated ABI packages | `8994dc0` | 352 tests; package imports without out/Foundry; deliberate ABI drift rejection |
| Deployment identity | `a9a945c` | 354 tests; canonical manifest and explicit alternate fixture; mismatches and unavailable history rejected |
| Persistent service state | `7b5fa8f` | 357 tests; restart, malformed/truncated state, permissions, partial append and replacement failures |
| Ticket behavior | `fe9bbab` | Included in final 365-test gate; delayed/superseded replies, duplicate mint guard, approval/requote/simulation order, expired quotes and rejected/reverted transactions |
| Position loading/status | `81dfab6` | Included in final gate; partial row failures, bounded reads, burned-token distinction, deployment/account scan keys and damaged/unavailable browser storage |

Final command: `bash scripts/verify.sh`, exit 0. Output:

```text
172 contracts passed, 0 failed
26 keeper tests passed, 0 failed
120 writer tests passed, 0 failed
37 frontend tests passed (8 files)
10 ABI/rotation/gate tests passed, 0 failed
PASS: service ABIs match Foundry artifacts
PASS: frontend deployment files match registry
PASS: packed keeper imports its ABIs without out/ or Foundry
PASS: packed writer imports its ABIs without out/ or Foundry
PASS: frontend interfaces match generated contract ABIs
PASS: index excludes wallet provider code
PASS: build loads wallet provider code
```

Log: `/tmp/hyperflip-batch4-verify.log`. Builds, service typechecks, formatting,
contract sizes, and final `git diff --check` passed. Earlier gate failures were
fixed: Next configuration needed an explicit TypeScript module extension and its
compiler setting; Vitest needed its own matching manifest rather than inheriting
the build fixture. State-test callback typing and one trailing blank line were
also corrected. Existing Foundry lint and Vite configuration-loader warnings
remain; no dependencies were added or upgraded.

Review fixes: curated tar packages retain lockfiles; legacy environment identity
cannot silently override the manifest; failed saves do not commit invite codes
in memory; a failure after rename requires restart to recover the saved code;
failed journal appends block later writes. The keeper retains new observations
in memory and continues existing settlement attempts after a save failure, with
an alert. A disk failure still means those observations are not restart-durable.

Ticket rendering is separate from quote/mint behavior. Requests carry an input
revision, and mint invalidates pending quote requests. New quote terms are
validated before being displayed or spent. Position loading and status derivation
are separate from rendering/actions. Account/chain changes remount the position
content, invalidate outstanding loads, and isolate pending action results.

Limits: automated tests use mocked RPC/wallet writes and do not broadcast. No
browser was available, so wallet connection, rendered account changes, approval,
mint, positions, claim/resolve, responsiveness and accessibility still need a
browser walkthrough. The React account boundary and effect cleanup were reviewed,
not exercised through a mounted browser. No claim that live transaction paths
passed is intended. Local implementation/checks are complete; browser acceptance
and deployment of Batch 3/4 are outstanding.

Next rollout requires separate approval. Reinspect live revisions, RPC history,
state readability and rotation before scheduling it. Package these commits per
DEPLOY.md, preserving all private files and the host registry. Stage and validate
both services before pausing quoting; drain quote deadlines, coordinate the
rotation timer, and never overlap writers. Preserve the current settlement cache
before the required keeper-code restart, minimizing interruption. Verify seeded
exposure, journal/signup persistence and frontend settings before reopening.
Rollback restores previous code with current state files; never restore stale
runtime snapshots. Frontend scan keys are versioned and leave unrelated browser
storage and old checkpoints untouched.

Before the next Vercel rollout, upgrading the locally outdated CLI is recommended
with `npm i -g vercel@latest`; no upgrade was performed in this cleanup.

### Deployment authorized

The operator subsequently approved pushing all work and deploying Batch 3/4.
See [CLEANUP_ROLLOUT.md](CLEANUP_ROLLOUT.md) for the current inspected baseline,
concrete execution and rollback procedure. Earlier pending-approval notes above
are historical.

### Merged and deployed, 2026-09-14

Cleanup was merged into main as `b644aba`. The writer runs `c1a3d8a`, which adds
the tested public-RPC scan-size fix; the keeper runs `b644aba`. Both are deployed,
and the cleanup frontend is promoted on the public domains. Release CI passed.
The original uncommitted handoff/README work is preserved in committed history;
archive/correlation-research remains unchanged at `f0db775`.

See [CLEANUP_ROLLOUT.md](CLEANUP_ROLLOUT.md) for exact deployment IDs, RPC findings,
quote-drain and exposure checks, state preservation, smoke output and rollback.
Earlier pending-deployment notes are historical. Browser/wallet transaction
acceptance remains untested; automated and read-only checks do not establish it.
