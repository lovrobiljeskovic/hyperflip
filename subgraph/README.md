# Independent positions (HyperEVM testnet)

Event-only index for the live v1 vault in `registry/deployment.testnet.json`:
chain **998**, vault **0x407cdc0b15e8d81f4d122481ecf92dbe07dc0169**, start block
**61906227**. No contract changes. The app hydrates immutable legs and current
OutcomeVault results through its own RPC; the writer service is not on that read path.

## Tooling and build

The owner approved these isolated, pinned development dependencies:
`@graphprotocol/graph-cli@0.98.1`, `@graphprotocol/graph-ts@0.38.2`, and
`matchstick-as@0.6.0`. Install from this directory:

```sh
npm install --no-save   # see the lockfile note below
npm run check
```

Lockfile note: `npm ci` currently rejects the committed `package-lock.json`
("lock file's @types/node@12.20.55 does not satisfy @types/node@26.6.2"). A
floating `@types/node: >=18` peer inside the Graph CLI's transitive tree now
resolves above the hoisted pin the lockfile recorded. The same failure happens
with the untouched lockfile on `new-design`, so it is not a port artifact.
`npm install --no-save` installs a working tree without rewriting the lockfile.
Repairing it hoists `@types/node` to 26.6.2 and adds transitive dev
`undici-types@8.9.0`; that is a dependency change and needs owner approval.

`generate.mjs` derives event ABIs and identity from the existing repository.
The checked-in `local` network is deliberately **not deployable to Goldsky**.
The individual build steps are:

```sh
node generate.mjs --local
npx --no-install graph codegen
npx --no-install graph build
npx --no-install graph test -v 0.6.0
node generate.mjs --check
```

Matchstick tests execute the actual mapping handlers. A local Graph Node replay
and rollback test is a separate integration gate; unit tests do not establish
provider reorg behavior. Mac binary/library support may require a supported
container environment. Do not install system tooling without approval.

## Hosted testnet preflight

Goldsky documents HyperEVM testnet support, but account access and its exact
network slug must be confirmed before generating the hosted manifest. The local
CLI is currently not authenticated. No subscription or deployment is created by
these files.

1. Log into the intended Goldsky project locally; do not paste credentials in
   chat or put them in this repository. Confirm testnet 998 support, exact network
   slug, available credits, rate limits, and applicable billing in that project.
2. Generate with `node generate.mjs --network=<verified-testnet-slug>`, then
   codegen/build/test and inspect the generated identity before deployment.
3. Proposed hosted name/version: `hyperflip-positions-testnet/0.1.0`.
   After deployment approval, use:
   `goldsky subgraph deploy hyperflip-positions-testnet/0.1.0 --path ./build`.
4. Wait for `_meta` to catch up without indexing errors. Compare the existing
   tickets against their canonical receipts and contract state at the indexed
   block: terms, owner, mint references, recorded status and burn state. The
   tickets minted so far do not cover all Won/Void/transfer scenarios.

Source: [Goldsky HyperEVM](https://docs.goldsky.com/chains/hyperevm).
[Billing](https://docs.goldsky.com/pricing/summary) describes Starter as one-time
credits and Scale allowances separately. Verify actual account terms; do not
assume an ongoing free plan from the pricing comparison table.

## App configuration and rollback

Keep all existing env/state files intact. In a separately configured local app,
set:

```dotenv
NEXT_PUBLIC_POSITIONS_SOURCE=subgraph
POSITIONS_SUBGRAPH_URL=<approved-query-endpoint>
POSITIONS_RPC_URL=<testnet-rpc>
# POSITIONS_SUBGRAPH_TOKEN=<query-token-only-if-required>
```

The public flag is compiled into the frontend and requires a rebuild. Default
and explicit `legacy` modes retain the existing writer-backed path (the poker's
`/parlays` taker index). There is no automatic fallback to the writer when the
index fails. Query credentials and private
RPC URLs stay server-side. Do not supply a Goldsky management token.

`GET /api/positions?wallet=0x...&limit=20` returns rows, `next`, snapshot and live
observation references, `stale`, and a failed-row count. Later pages send
`before=<next>&block=<snapshot.number>&snapshot=<snapshot.hash>`.
HTTP 409 asks the UI to refresh its snapshot; 503 is unavailable, never an empty
wallet. No `eth_getLogs` runs in the browser or API.

Limits: 50 tickets/page, six simultaneous server RPC calls, bounded caches,
10-second page/head caching, 15-second outcome cache keyed to the observation
block hash. Even settled outcomes expire in this first release, avoiding an
unverified permanent finality assumption. Immutable legs cache for one hour.
Provider/transport requests have timeouts; new RPC work stops after a 20-second
page budget. Caches are per process; multi-instance deployments can repeat reads.

Position labels are a public build snapshot. Run
`node scripts/position-markets.mjs` from the repository root when the market
registry changes, then deploy the updated app asset. Unknown/new markets display
their vault address until that snapshot updates. Optional live odds use the
existing public information API and do not block positions.

Confirmed mint/claim/refund receipts are kept per chain/vault/wallet (latest 20)
in browser storage and checked against canonical receipts on reload. Mint
navigation retries indexing at 3, 8, 15 and 30 seconds, then leaves manual
refresh available. Summaries cover loaded rows and attribute payouts to the
holder at burn. Pending/failed results cannot enable claim actions.

Rollback: set `NEXT_PUBLIC_POSITIONS_SOURCE=legacy` and rebuild/redeploy the app.
The writer's taker index and checkpoints remain untouched, and the poker keeps
using them for exposure; only the browser read path changes. Retiring the
writer-side taker index is a separate, later change.

## Verification gates

- Subgraph codegen/build and mapping tests; local rollback/reindex.
- `npm run check --prefix web`, `npm run check --prefix writer`, `forge build`,
  `forge test`, generated-file checks, and `scripts/verify.sh` for integration.
- After the fixture build from `scripts/verify.sh`, run
  `node web/scripts/check-positions-http.mjs` from the repository root. This
  starts/stops its own local fixture/app servers and checks the production API
  with 21 synthetic tickets, paging, RPC deduplication and a provider outage.
- Hosted parity for existing tickets, provider lag/errors and actual usage.
- Browser mint/claim/refund lag, pagination, wallet switching and outages.
- User-coordinated writer outage checks, outside settlement observation
  windows. Do not stop funded services as an incidental frontend test.

Local mocked tests and HTTP checks do not prove hosted parity, real settlements,
or measured production savings.

## Local verification recorded September 19, 2026 (v1 port)

Ported to `main` and retargeted from the v2 vault to the live v1 deployment.
`ParlayMinted` on v1 carries no `maker`, so the `Ticket.maker` field, its mapping
assignment and the app's maker cross-check were dropped; `Row.parlay.writer` now
comes from the `parlay(id)` read the API already makes.

- `bash scripts/verify.sh` passed end to end: Solidity 172, keeper 26,
  writer 123, subgraph 4, web 46, repository/tooling 16, plus `forge fmt`,
  `forge build --sizes`, generated-file checks and the Next production build.
- `node web/scripts/check-positions-http.mjs` passed: 400 validation,
  20+1 rows over two pages, 22 `eth_call` (21 tickets + one shared market),
  provider-failure 503, static label asset and positions HTML.
- Matchstick reported `All 4 tests passed!` on macOS arm64 against the v1
  vault and v1 event signature. Its first run downloads the pinned 0.6.0 binary.
- `npm audit` still reports build-tool findings in this isolated dev tree; no
  versions were changed. These packages are not in the web runtime.
- Nothing was deployed. No hosted subgraph exists, no Goldsky account action was
  taken, and `/opt/hype/writer` and the Hetzner box were not touched.
- Local Graph Node rollback/reindex, hosted provider parity and browser
  wallet checks remain unverified.
