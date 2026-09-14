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
  writer/
  registry/markets.json
  out/OutcomeVault.sol/OutcomeVault.json
  out/KeeperVerifier.sol/KeeperVerifier.json
  out/ParlayVault.sol/ParlayVault.json
```

Both services resolve configuration and ABIs from this layout. Build the matching
contracts with `forge build` before packaging. Install service dependencies with
`npm ci --include=dev`: startup uses `tsx`, which is a dev dependency.

Use the root `.env.example` for configuration. Set `CORS_ORIGINS` to the frontend
origins, including `https://hyperflip.xyz` and `https://app.hyperflip.xyz` for the
split deployment. The writer reads its registry from `MARKETS_FILE` and its
ParlayVault address/block from `PARLAY_VAULT_ADDRESS` and `PARLAY_DEPLOY_BLOCK`.
`PRICING_MODE` can be unset or `independent`; other values fail startup.

The signer, bankroll, and keeper must match the deployed contracts. Run services
as an unprivileged user with a mode-0600 `.env`. Keep the deployer key out of the
service installation; only the separate rotation/deployment checkout needs it.

## Persistent state

Preserve these files across deployments, backups, and host replacement:

| File | Purpose |
| --- | --- |
| `keeper/settlement-cache.json` | Settlement fractions observed before Core pruning |
| `writer/waitlist.json` | Signup emails and issued invite codes |
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

Sports quote journals use `schemaVersion: 1` with quote identity, book observations,
probability, edge, and signed terms. Earlier journal records remain untouched;
readers must distinguish their schema versions. Archived branch data requires
its corresponding readers.

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

Run `bash scripts/verify.sh` before packaging. Synchronize source and matching
ABIs while excluding private environment files, runtime state, `node_modules`,
and the host's registry. Install dependencies, check ownership, then restart only
the affected service. Verify service state and logs:

```bash
systemctl is-active keeper writer caddy
journalctl -u keeper -u writer -n 50 --no-pager
curl --fail http://localhost:8787/health
WRITER_URL=http://localhost:8787 node tools/smoke.mjs
```

With `INVITE_CODE` set, the smoke command also requests a real quote and temporarily
reserves exposure. Without it, the command checks health and market availability.
`/health` must report `seeded: true`; `bankroll` is populated after a quote reads it.
The repository tests do not broadcast transactions or validate a live deployment.

For an upgrade from the archived implementation, remove obsolete research
service drop-ins and timers from the deployment configuration. Preserve their
private data for use with the archive branch. Deploy the writer and frontend from
this revision together; the app no longer displays model adjustments.

## Sports market rotation

Run rotation from a separate checkout with Foundry and `uv` installed. Its root
`.env` needs `PRIVATE_KEY`, `TESTNET_RPC`, and `KEEPER_ADDRESS`. The keeper address
is immutable in each new OutcomeVault, so verify it before broadcasting.

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

Restore the settlement cache before starting a replacement keeper. Fractions
lost after Core pruning cannot be reconstructed by restarting. Do not overwrite
the cache during recovery. `ops/alert-relay.sh` and its systemd timer can forward
service alerts using a separately configured private `alert.env`; pair this with
an external health monitor because a stopped host cannot report its own failure.
