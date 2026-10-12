# Operating the sports testnet app

Writer and keeper are separate long-running services. Keep the keeper running
continuously: it records settlement fractions before Core prunes them. The web
frontend can be deployed separately. This runbook uses `/opt/hype` as an example
installation root; adjust paths for your host.

## Service layout

```text
/opt/hype/
  .env
  keeper/
    abi/OutcomeVault.json
    abi/KeeperVerifier.json
  writer/
    abi/OutcomeVault.json
    abi/ParlayVault.json
  registry/markets.json
  registry/deployment.testnet.json
  registry/deployment.mts
  services/files.mts
```

Both services resolve configuration from this layout and load their packaged
ABIs. To regenerate interfaces, run `forge build && node scripts/abis.mjs` in
the source checkout; commit the generated JSON. `bash scripts/verify.sh` checks
drift against the build, imports each packed service without `out/` or Foundry,
and verifies the frontend's smaller interfaces. Service hosts no longer need a
compiler or the Foundry artifact tree. The separate rotation checkout still does.

Package each service from the repository root with the existing lockfile included:

```bash
tar -czf /tmp/writer.tar.gz writer/package.json writer/package-lock.json writer/tsconfig.json writer/src writer/abi registry/deployment.mts registry/deployment.testnet.json services/files.mts
```

Replace `writer` with `keeper` for the keeper package. These explicit paths exclude private
configuration and runtime state. Unpack into the layout above without overwriting
existing state. Install service dependencies with
`npm ci --include=dev`: startup uses `tsx`, which is a dev dependency.

Use the root `.env.example` for configuration. Set `CORS_ORIGINS` to the frontend
origins, including `https://hyperflip.xyz` and `https://app.hyperflip.xyz` for the
split deployment. The writer reads its registry from `MARKETS_FILE` and its
deployment identity from `registry/deployment.testnet.json`.
`PRICING_MODE` can be unset or `independent`; other values fail startup.

The signer, bankroll, and keeper must match the deployed contracts. Run services
as an unprivileged user with a mode-0600 `.env`. Keep the deployer key out of the
service installation; only the separate rotation/deployment checkout needs it.

## Deployment identity

`registry/deployment.testnet.json` owns the public chain, ParlayVault address and
exact deployment block. Existing `PARLAY_VAULT_ADDRESS`, `PARLAY_DEPLOY_BLOCK`,
`EVM_CHAIN_ID` and corresponding `NEXT_PUBLIC_` settings must match this manifest
when present. Remove matching duplicates during configuration migration; a
mismatch fails startup/build instead of silently selecting another deployment.
Keys, RPC credentials and the rotated market registry remain separate.

For another deployment on chain 998, copy the manifest, set its address and exact
creation block, and set `DEPLOYMENT_FILE` to that file's absolute path in each
service and frontend build environment. Remove or update conflicting legacy
settings. Verify the creation receipt before selecting the file. Services check
RPC chain and vault code at the current, creation and preceding blocks before
starting; their RPCs must serve historical code. A wrong block or unavailable
history fails startup. The writer also requires positive `POKER_INTERVAL_MS`.

The web upload is self-contained: `node scripts/deployment.mjs` copies the public
manifest and loader into `web/deployment`; commit those generated files. The gate
checks drift. Frontend builds validate the selected manifest and embed only its
public identity, without making RPC requests. An alternate manifest must be
available at build time; never put secrets in it. Rollback selects the previous
manifest and matching environment settings without restoring runtime state.

## Elysium (Season 1): ParlayVault on chain 99801, vaults on 998

Elysium testnet is an Arbitrum Orbit rollup settling to HyperEVM testnet (chain ID 99801,
RPC `https://testnet-rpc.elysium.kinetiq.xyz`, HYPE gas, no subgraph, no published explorer
yet). The outcome layer never moves: every `OutcomeVault` stays on 998 as the Core account
and the settlement source. On Elysium live one `ParlayVault` v2 (quote token = bridged USDC
`0x7D29d8047B905000459c0E80c34a26CeedcB47b2`) and one `OutcomeLeg` per market; on 998 one
`SettlementRelay` bound to the Orbit Inbox `0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0`.

Registry rows on Elysium carry two addresses: `vault` is the leg the ParlayVault reads (what
the writer quotes and the app mints against) and `sourceVault` is the 998 vault behind it
(what the keeper settles and rotation checks). Writer and web read `vault` as before.

Manifest: same `registry/deployment.testnet.json`, with `evmChainId: 99801`, `coreChainId: 998`,
`settlementRelay` and `inbox`. `registry/deployment.hyperevm-testnet.json` keeps the 998
identity (the subgraph generator reads that one; it is also the fallback if Elysium slips).

Deploy order, all from the registrar key (`PRIVATE_KEY`), which needs HYPE on both chains
(`cast send $INBOX "depositEth()" --value 0.05ether` on 998 lands on the same address on
Elysium in about a minute; no faucet):

```bash
INBOX_ADDRESS=0x1117…8Ec0 forge script script/DeployRelay.s.sol --rpc-url hyperevm_testnet --private-key $PRIVATE_KEY --broadcast --legacy
QUOTE_TOKEN_ADDRESS=0x7D29…47b2 WRITER_ADDRESS=… QUOTE_SIGNER_ADDRESS=… MIN_PREMIUM_BPS=500 \
  LEG_REGISTRAR_ADDRESS=… OWNER_ADDRESS=… forge script script/DeployParlay.s.sol --rpc-url elysium_testnet --private-key $PRIVATE_KEY --broadcast --skip-simulation --gas-estimate-multiplier 150
SOURCE_VAULT=<998 vault> RELAY_ADDRESS=… PARLAY_VAULT_ADDRESS=<Elysium vault> \
  forge script script/DeployLeg.s.sol --rpc-url elysium_testnet --private-key $PRIVATE_KEY --broadcast --skip-simulation --gas-estimate-multiplier 150
```

Every Elysium broadcast needs `--skip-simulation --gas-estimate-multiplier 150`: Nitro counts L1 data posting as gas
units that float with the parent basefee, so Forge's own limit fails with `intrinsic gas too low` or runs out of gas mid-creation (the first ParlayVault attempt died at exactly its 6.9M limit). Load
`.env` into the shell first (`set -a; source .env; set +a`); Forge reads it for itself but
does not export `$PRIVATE_KEY`.

Only our own HIP-4 venues (`flip`, `flp`) are listed on Elysium: `tools/mirror-legs.mjs` mirrors the live
house rows and archives every other venue's rows, and `ROTATE_VENUES=flip,flp` in `.env` keeps hourly
rotation from adding foreign-venue markets (house games are wrapped by `house-markets.mjs sync`).

Rotation does the third step itself for every new vault once `ELYSIUM_RPC`, `RELAY_ADDRESS`
and `PARLAY_VAULT_ADDRESS` are in `.env` (`tools/rotate-lib.mjs` `deployPair`). The bank
approves the Elysium vault from the cold key (ceremony) after bridging its float.

Services: the writer points `WRITER_RPC` at Elysium (its ParlayVault, poker index and quote
domain are all there; pricing is HTTP and unchanged); set `PARLAY_INDEX_FROM_BLOCK` to the
Elysium deploy block and delete `writer/parlays.json` once. The keeper keeps `TESTNET_RPC`
on 998 for `settle()` and adds `ELYSIUM_RPC`; after each settled vault it calls `relay()`
once (retryable fees paid in HYPE on 998, doubled and refunded on Elysium) and stops when
the leg reports settled. The web build reads the manifest as usual; set
`NEXT_PUBLIC_POSITIONS_SOURCE=legacy` (no subgraph on Elysium) and `NEXT_PUBLIC_CORE_RPC_URL`
for the bridge step, which moves the USDC shortfall and 0.01 HYPE of gas from 998 through
the canonical bridge before the first mint.

### Two lanes: HyperEVM (default) and Elysium side by side

Both chains trade at once from one checkout and one `registry/markets.json`. Rows are written
Elysium-first (`vault` = OutcomeLeg, `sourceVault` = 998 OutcomeVault); a writer whose manifest is
the Core chain reads `sourceVault` as its vault (`laneRows` in `writer/src/markets.ts`), so no second
registry exists. Chain identity is the manifest alone, so a second writer is a second systemd unit
with `Environment=` overrides (they beat the shared `.env`, which dotenv loads without override):

| var | `writer` (998, default) | `writer-elysium` |
| --- | --- | --- |
| `DEPLOYMENT_FILE` | `/opt/hype/registry/deployment.hyperevm-testnet.json` | `/opt/hype/registry/deployment.elysium-testnet.json` |
| `WRITER_RPC` | archive-capable 998 endpoint with quota | keyed Elysium (Conduit) URL |
| `WRITER_PORT` | 8787 | 8789 (8788 and 8791+ belong to the v2 trial units under `/opt/hype-v2`) |
| `PARLAY_INDEX_FILE` | `/opt/hype/writer/parlays.json` | `/opt/hype/writer/parlays-elysium.json` |
| `PARLAY_INDEX_FROM_BLOCK` | a recent 998 block (the poker scans 100-block chunks; the v1 deploy block is millions back) | Elysium deploy block |
| `QUOTE_JOURNAL_FILE`, `WAITLIST_FILE` | per lane | per lane |

Unset `PARLAY_VAULT_ADDRESS`, `PARLAY_DEPLOY_BLOCK` and `EVM_CHAIN_ID` in `.env`; when set they must
agree with the manifest and can only agree with one lane. `WRITER_ADDRESS` and the signer and poker keys
are shared: USDC balances are per chain, so each lane's bankroll is its own, but the per-market and
per-cluster caps apply per lane (house exposure to one outcome can reach the cap on both chains).
The keeper stays one process: it settles 998 vaults and relays to Elysium legs, reading the same
registry. `ops/systemd/rotate.service` restarts `writer writer-elysium keeper` when the registry
changes. Caddy: `writer.hyperflip.xyz` to 8787, `writer-elysium.hyperflip.xyz` to 8789.

Web: one Vercel project per chain, same repo, configured and deployed by `tools/vercel-lanes.sh hyperevm|elysium`. `scripts/deployment.mjs` copies every manifest into
`web/deployment/`; each project sets `DEPLOYMENT_FILE` to its copy, `APP_ORIGIN` to its app host
(default `https://app.hyperflip.xyz`), `NEXT_PUBLIC_WRITER_URL` to its writer host, and
`NEXT_PUBLIC_ALT_LANE_URL` to the sibling app for the header link. The 998 project runs
`NEXT_PUBLIC_POSITIONS_SOURCE=subgraph` against the Goldsky subgraph (998 only); the Elysium project
keeps `legacy`, `ELYSIUM_RPC` and `NEXT_PUBLIC_CORE_RPC_URL`. `web/public/position-markets.json` is
keyed by the 998 vault for the same reason.

## Persistent state

Preserve these files across deployments, backups, and host replacement:

| File | Purpose |
| --- | --- |
| `keeper/settlement-cache.json` | Settlement fractions observed before Core pruning |
| `writer/waitlist.json` | Pending signups, cohort admissions, Privy account bindings and email-send timestamps |
| `writer/quotes.jsonl` | Signed-quote audit records |
| `registry/markets.json` | Current deployed markets and historical vault metadata |

Paths can be overridden with `SETTLEMENT_CACHE_PATH`, `WAITLIST_FILE`, and
`QUOTE_JOURNAL_FILE`. Give the service user write access to the parent directories.
Mount persistent storage when using containers. Do not overwrite these files
with a checkout or delete them during source synchronization. The rotated
registry on the service host is authoritative; back it up before changing it.

Run one writer per ParlayVault. Quote reservations are in memory, so replicas
would not share exposure limits. The writer reconstructs minted exposure at
startup and returns `503 warming-up` until that completes. Keep
`POKER_INTERVAL_MS` positive to continue tracking minted exposure.

Missing state files are allowed on first startup. Unreadable, malformed or
truncated existing files stop startup; they are never treated as an empty cache.
New files use mode 0600. Waitlist and settlement-cache replacement writes and
flushes a temporary file, renames it in the same directory, then flushes that
directory. Use a local filesystem that supports these operations. Back up state
with its ownership and permissions; leftover `*.tmp` files are uncommitted writes,
not automatic recovery candidates.

A failed signup save disables further signup in that process; fix the disk and
restart so memory reloads whichever complete file reached disk. Access checks also fail closed until the writer restarts. A keeper save failure retains the fraction in memory and
alerts while continuing the existing settlement attempt. Repair storage promptly:
a restart cannot recover an observation that never reached disk. Keep the keeper
running while investigating a save failure when possible.

Journal records are appended synchronously and flushed before a signed quote is
returned. Append failure returns no successful quote and disables later appends
until restart. Startup accepts existing positive schema versions, requires each
record to be a JSON object on a newline-terminated line, and never truncates or
rewrites history. This is an audit trail; it does not recover quote reservations.
For a damaged journal, pause quoting and preserve the original privately before
repair. Verify all complete records and retain any damaged tail separately; do
not silently discard bytes. Restore a validated file, wait for outstanding quote
deadlines to expire, then restart one writer and wait for exposure reconstruction.
A complete final JSON record missing only its newline may have that newline added
after inspection. Corrupt waitlist/cache recovery requires a verified backup or
manual repair, retaining all known admissions, account bindings and fractions. Never restore stale state
over a running service. Code rollback uses current state files with compatible
readers, not old snapshots; see the waitlist compatibility note below.

Sports quote journals use `schemaVersion: 1` with quote identity, book observations,
probability, edge, and signed terms. Earlier journal records remain untouched;
readers must distinguish their schema versions. Archived branch data requires
its corresponding readers.

## Waitlist and manual cohorts

Both signup forms record a normalized email and signup timestamp without requiring
login or a wallet. Signup sends no email and works without `RESEND_API_KEY`.
Review and approve cohorts in a private Google Sheet using
[Google Sheets setup](ops/google-sheets-waitlist/README.md). No admin page or token
entry is exposed in the frontend.

Configure server-only `GOOGLE_SHEETS_WEB_APP_URL`, `GOOGLE_SHEETS_SYNC_SECRET`,
`WAITLIST_ADMIN_TOKEN`, `RESEND_API_KEY`, `PRIVY_APP_ID` and `PRIVY_APP_SECRET`.
The Privy app ID must match the frontend's `NEXT_PUBLIC_PRIVY_APP_ID`. Enable email
and external-wallet login in that Privy app. The frontend disables automatic
Ethereum and Solana embedded-wallet creation. Keep the secret on the writer only;
never use a `NEXT_PUBLIC_` variable for it. Restart the writer after config changes.

Signups export immediately after durable save. Failed exports retry once per minute;
idle retries make no Google calls. Repeat signups restore deleted sheet rows without
changing the original signup date, approval or delivery status. Set a Cohort and
check Approved to admit selected users. The edit trigger submits explicit emails
to authenticated `POST /integrations/google-sheets/admit`; the Waitlist menu retries
failed requests or deliveries. Unchecking Approved does not revoke admission.

Admission persists before the approval email sends. The message links to `/access`
and asks the recipient to verify their waitlist email through Privy. Retries skip
recorded sends; provider deduplication uses a hash of the email (24-hour window).
A crash after sending but before saving can repeat the email outside that window.
`Emailed` means provider acceptance, not confirmed inbox delivery. Concurrent
admissions return `admission-in-progress`. Counts represent unique email signups,
not verified people or active traders; bankroll planning remains a manual decision.

The writer verifies each Privy access token and fetches the account's current
verified email and wallet links from Privy. A verified approved email claims its
admission once, atomically binding it to the Privy user ID. Subsequent logins use
that ID, even if the account's email changes. Another account cannot claim the
same approval. The user links their existing wallet by proving ownership through
Privy; a connection alone does not authorize quotes. Every quote requires a taker
wallet currently verified on the admitted account. Reservation limits apply per
account, including across multiple linked wallets (`PER_CODE_RESERVED_CAP` keeps
its historical configuration name).

Old approvals remain eligible for email verification; old invitation codes and
`INVITE_CODES` no longer authorize app access or quotes. Existing delivery timestamps
are preserved, so this migration does not resend old approval emails. Historical
codes remain in the private file for compatibility but are never sent to Sheets.
New approvals have `code: null` plus admission metadata; claims add `privyUserId`.
**Earlier writer versions are not safe rollback targets:** they either reject new
rows or restore bearer-code access. Preserve current state and deploy a compatible
reader; never overwrite new signups or account claims with an old backup.

`POST /api/access` exchanges a Privy access token for a host-only HttpOnly,
SameSite=Lax cookie (Secure over HTTPS, maximum one hour). The writer revalidates
it on each protected app request; missing, expired or invalid tokens return users
to `/access` to refresh sign-in. Provider failures fail closed. The positions API
returns 403/503 instead of data. Logout clears the cookie. The public site, static
assets and access page remain reachable. Old cookies and local-storage codes
cannot unlock the app.

The frontend uses server-only `WRITER_URL`, falling back to
`NEXT_PUBLIC_WRITER_URL`. Use HTTPS and include the frontend origin in writer
`CORS_ORIGINS`. Deploy writer and frontend together for this authentication change.
Local preview testing does not change production. Test both approved and pending
accounts, a linked external wallet, a different unlinked wallet, and logout.

## RPC and supervision

`TESTNET_RPC` accepts a comma-separated fallback list. Every keeper endpoint must
serve fresh Core state for balance verification and settlement. Before changing
that list, run `node keeper/rpc-check.mjs <url> [<url> ...]` against each candidate.
`WRITER_RPC` may use a separate list for event scans and quote reads.

Use separate systemd units so a writer restart does not stop settlement. A keeper
unit can use:

```ini
[Unit]
Description=Hyperflip keeper
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=hype
WorkingDirectory=/opt/hype/keeper
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The writer unit uses `/opt/hype/writer`. Local supervision is available through
`bash tools/supervise.sh keeper` and `bash tools/supervise.sh writer`.

Place a TLS proxy in front of writer port 8787 and keep that port closed to the
public network. Example Caddy configuration, with your writer domain:

```caddyfile
writer.example.com {
    reverse_proxy localhost:8787
}
```

## Deployment and checks

Run `bash scripts/verify.sh` before packaging. Synchronize source and packaged
ABIs while excluding private environment files, runtime state, `node_modules`,
and the host's registry. Install dependencies, check ownership, then restart only
the affected service. Verify service state and logs:

```bash
systemctl is-active keeper writer caddy
journalctl -u keeper -u writer -n 50 --no-pager
curl --fail http://localhost:8787/health
WRITER_URL=http://localhost:8787 node tools/smoke.mjs
```

With `PRIVY_ACCESS_TOKEN` and a verified linked `TAKER` set, the smoke command also requests a real quote and temporarily
reserves exposure. Without it, the command checks health and market availability.
`/health` must report `seeded: true`; `bankroll` is populated after a quote reads it.
The repository tests do not broadcast transactions or validate a live deployment.

For an upgrade from the archived implementation, remove obsolete research
service drop-ins and timers from the deployment configuration. Preserve their
private data for use with the archive branch. Deploy the writer and frontend from
this revision together; the app no longer displays model adjustments.

## Sports market rotation

Run rotation from a separate checkout with Foundry and `uv` installed. Its root
`.env` needs `PRIVATE_KEY`, `TESTNET_RPC`, `KEEPER_ADDRESS`, and `OWNER_ADDRESS` (the
cold key; the deploy script hands each new vault to it in the same broadcast). The
keeper address is rotatable by the owner (`setKeeper`), but a wrong address still
costs a rotation ceremony, so verify both before broadcasting.

```bash
node tools/rotate-markets.mjs --dry-run
```

The dry run reads the live board and reports candidates. Running without
`--dry-run` broadcasts contract deployments and rewrites the registry. Rotation
supports sports only; `ROTATE_MODE` may be unset or `sports`. It wraps complete
questions and standalone sports outcomes, and retains expired vault metadata in
`archived`. Keep any unsettled retired vaults on the keeper's explicit recovery
list (`VAULT_ADDRESSES`) when needed; that override replaces the active registry
list, so include all vaults the keeper must watch.

The supplied `ops/systemd/rotate.timer` runs hourly at ten minutes past the hour.
Its service assumes `/opt/hype/repo`, a shared registry at `/opt/hype/registry`,
and existing writer/keeper units. Adapt those paths before installation. It
restarts the services after registry changes. Private deploy RPCs can be supplied
through `DEPLOY_RPCS` to avoid sharing public endpoint quotas with running services.

## House HIP-4 markets (venues `flip` and `flp`)

`tools/house-markets.mjs sync` runs first in `rotate.service`, hourly. Each run settles our
finished games from ESPN finals, registers upcoming fixtures, wraps new outcomes in OutcomeVaults
through the rotation deploy path, and refreshes `priorYes` on our registry entries from the
DraftKings lines ESPN publishes. Testnet caps a venue owner at 20 active outcomes (the doc still
says 10) and 50 deployments per day; we own two venues, `flip` filled first, `flp` takes the
overflow. NFL games use the `sportsContestWinner7` template (1 slot each, budget
`HOUSE_NFL_MAX_ACTIVE` = 16, horizon `HOUSE_HORIZON_DAYS` = 7, ESPN current week plus next).
Soccer matches (`HOUSE_LEAGUES=nfl,eng.1,esp.1`) use the 3-way `sportsContestResult5` question
(Home / Draw / Away + fallback = 4 slots), take whatever the NFL budget leaves, horizon
`HOUSE_SOCCER_HORIZON_DAYS` = 14, and settle with `settleQuestion2` (Draw on a postponement past the
deadline). 2-side templates settle draws to 0.5, which `ParlayVault` treats as a void, so soccer is
never listed 2-side. A fixture takes a slot only if it still has `HOUSE_MIN_WINDOW_HOURS` (18) of
pre-kickoff trading and, when slots are contested, the most balanced fixture wins (NFL: moneyline
nearest even; soccer: smallest max of the devigged H/D/A). A soccer fixture without ESPN odds is
not listed. Other knobs: `HOUSE_WEEK` (default: ESPN current week), `HOUSE_MAX_ACTIVE` (10 until the
soccer deploy, then 20). Register and settle cost no gas;
the hourly cadence keeps writer restarts (registry rewrites on moneyline drift) to at most one per hour.

```bash
node tools/house-markets.mjs sync --dry-run
```

One-off setup per venue from its staked owner wallet (100 testnet HYPE, Standard account
abstraction, `userAbstraction` must read `disabled`, not `default`; activation and the venue name
are permanent), then grant the box deployer key. Done for `flip` (2026-09-15) and `flp` (2026-09-23):

```bash
PRIVATE_KEY=<master> uv run tools/hip4.py '{"type":"activateOutcomeDeployer","activate":{"venueName":"flip"}}'
PRIVATE_KEY=<master> uv run tools/hip4.py '{"type":"outcomeDeploy","venue":"flip","operation":{"setSubDeployers":[{"variant":"registerStandaloneOutcomeFromTemplate","user":"<box eoa, lowercase>","allowed":true},{"variant":"settleOutcome","user":"<box eoa, lowercase>","allowed":true}]}}'
```

Settlement copies name, description and side names verbatim from `outcomeMeta`; unsettled
outcomes past their resolution deadline settle to 0.5.

## Bankroll and settlement recovery

The bankroll is `WRITER_ADDRESS`. The writer limits quotes to the smaller of its
USDC balance and allowance to ParlayVault. A mint pulls `maxPayout - premium` into
escrow; dead tickets return that escrow, while winning tickets pay the taker.
Replenishing the wallet does not replenish a spent allowance. Use the bankroll
wallet to review and renew approval when needed.

`LOW_BANKROLL` is human-readable USDC and defaults to 100. The writer emits an
`ALERT low-bankroll` line when headroom falls below it. Long-dated events can hold
escrow for months; set competition exposure limits accordingly.

Before an OutcomeVault receives Core funds, its Core account must be activated
and funded with gas-token dust for transfer fees. Core-to-EVM transfers must be
representable in EVM token units. The vault contracts enforce the rounding rule;
operators must maintain the fee balance.

After settlement, call `pullSettledFunds` only once Core has credited the settlement
and every previously queued spotSend (cancel refunds, redeem payouts) has landed on
the EVM side: the sweep takes the entire Core balance. A pull while the Core balance
is still zero is a harmless no-op that does not open redemption; crank again after
the credit lands.

Restore the settlement cache before starting a replacement keeper. Fractions
lost after Core pruning cannot be reconstructed by restarting. Do not overwrite
the cache during recovery. `ops/alert-relay.sh` and its systemd timer can forward
service alerts using a separately configured private `alert.env`; pair this with
an external health monitor because a stopped host cannot report its own failure.

## Known issues

**M1 (pre-mainnet gate): a deposit Core never credits wedges the vault.** Testnet e2e
showed a deposit's EVM→Core USDC leg can be sent to the CoreDepositWallet and never
credited (cause unconfirmed: testnet regression or a CCTP recipient-existence rule).
`cancelDeposit`'s `CREDIT_NOT_ARRIVED` guard then never clears, the pending slot is
stuck, and `_requireIdle` blocks every other deposit, redeem and settle on that vault.
The only recovery is the owner installing a verifier that attests the op `Failed`,
which refunds the EVM-side principal but, since the Core split never happened, mints an
unbacked oYES/oNO pair that dilutes every other holder. Mainnet needs proof the deposit
leg credits reliably for a contract recipient and an owner recovery path that does not
mint unbacked pairs.
