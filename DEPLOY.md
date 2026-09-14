# Deploying the keeper and writer

Both long-lived services run on a single Hetzner Cloud VPS. This document is the source of
truth for that deployment: what runs where, how to redeploy, and how to verify it.

## Why a fixed-price VPS

The keeper's failure mode is silence — a keeper that is not running looks exactly like a keeper
with nothing to do. HyperCore prunes a settled outcome within roughly ten minutes, and once
pruned, the only way to settle a vault is for a keeper to relay a fraction it personally observed
while the outcome was still at status 2. Miss that window and the vault is stranded permanently.
See the comment block at the top of `tools/supervise.sh` and `keeper/src/keeper.ts:110-112`.

That rules out any host which sleeps, scales to zero, or can be suspended for billing reasons:

- **Render free tier** — instances sleep after 15 minutes idle. Reproduces the exact failure.
- **Cloud Run / anything scale-to-zero** — same problem.
- **Fly.io** — no billing cap and no billing alerts; prepaid credits reportedly roll into card
  billing rather than suspending. Metered billing cannot offer a guaranteed ceiling, and the one
  mechanism that does stop spend (credit exhaustion) suspends the account, which kills the keeper.

A fixed-price VPS bills the same amount every month regardless of load, and nothing on it can
decide to become more expensive.

## The server

| | |
|---|---|
| Provider | Hetzner Cloud |
| Type | CX23 (2 vCPU, 4 GB RAM, 40 GB disk) |
| Location | Falkenstein (fsn1) |
| OS | Ubuntu 26.04 LTS |
| IP | `91.99.94.25` |
| Cost | EUR 4.49 + EUR 0.50 IPv4 = **EUR 4.99/mo**, billed hourly but capped at the monthly rate |

Hetzner includes 20 TB/month of outbound traffic in EU locations (EUR 1.00/TB beyond). Inbound is
free. Realistic usage here is a rounding error against that allowance.

## Layout

```
/opt/hype/
  .env                    # filtered secrets, mode 600, owned by hype
  research/testnet/       # preserved testnet research facts, artifacts, journals, state, reports
  research.env            # public/read-only research inputs only, mode 600
  research-backup.env     # least-privilege backup credentials only, mode 600
  keeper/                 # rsynced from repo keeper/
    settlement-cache.json # observed pre-prune settlement fractions — DO NOT LOSE
  writer/                 # rsynced from repo writer/
  registry/markets.json   # the market registry both services read
  out/                    # exactly three forge artifacts, see below
```

Both services resolve paths relative to the repo root (`<service>/src/../..`), so the layout on
the server has to mirror the repo layout.

### Required forge artifacts

`keeper/src/abi.ts` and `writer/src/abi.ts` read ABIs from `<repo root>/out/` at import time.
Only three files are needed, and omitting them crash-loops both services on startup:

```
out/OutcomeVault.sol/OutcomeVault.json
out/KeeperVerifier.sol/KeeperVerifier.json
out/ParlayVault.sol/ParlayVault.json
```

Run `forge build` locally before deploying if these are stale.

## Secrets

`/opt/hype/.env` is the root `.env` with `PRIVATE_KEY` (the deployer key) stripped — neither
service uses it, and it has no business on an internet-facing box. Everything else is required:
`TESTNET_RPC`, `KEEPER_PRIVATE_KEY`, `MARKETS_FILE`, `PARLAY_VAULT_ADDRESS`, `WRITER_ADDRESS`,
`QUOTE_SIGNER_PRIVATE_KEY`, `POKER_PRIVATE_KEY`, `MAX_STAKE`, `PER_MARKET_CAP`,
`PER_CLUSTER_CAP`, `INVITE_CODES`. Sports beta adds `PRICING_MODE=independent` and
`PARLAY_DEPLOY_BLOCK` (the `RESEARCH_*` variables are then unused by the writer).

The file is mode 600, owned by `hype`. Both services load it via dotenv from the repo root.

### Keeper RPC endpoints

`TESTNET_RPC` is a comma-separated fallback list, and every endpoint in it now serves the
keeper's safety-critical 0x801 balance reads (not just 0x814 status), since a balance read can
land on any endpoint in the list. That means every endpoint must be Core-state-fresh: one whose
HyperCore view lags by more than `balanceTimeoutMs` (60s) can show no delta on an executed op and
drive a false `executed=false` attestation. Run `keeper/rpc-check.mjs` with the full list (it
cross-checks freshness across endpoints) before changing `TESTNET_RPC`.

## Services

Two systemd units, `keeper.service` and `writer.service`, both running as the unprivileged
`hype` user. Separate units so restarting the writer never bounces the keeper.

```ini
[Unit]
Description=hype-evm keeper
After=network-online.target
Wants=network-online.target

# Failure mode here is silence, so never give up restarting. This key is
# [Unit]-only: under [Service] systemd ignores it and the default
# 5-starts-in-10s limit applies, which is exactly how a crash-looping
# service goes quiet for good.
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

The writer unit is identical with `WorkingDirectory=/opt/hype/writer` and this additional
fail-closed storage requirement under `[Service]`:

```ini
Environment=RESEARCH_REQUIRE_ANCHORED_FS=1
```

Both units also carry a drop-in (`/etc/systemd/system/<unit>.service.d/chown.conf`) that
re-owns the tree as root before every start. An rsync from a Mac (openrsync, no `--chown`)
leaves `/opt/hype/writer` owned by uid 501; the writer then cannot create `quotes.jsonl` and
every quote 503s with `journal-failed`. The drop-in makes a forgotten `chown` self-heal on
the next restart:

```ini
[Service]
ExecStartPre=+/bin/chown -R hype:hype /opt/hype/writer
```

`tools/supervise.sh` is not used on the server — systemd replaces it. The script remains for
local runs.

## TLS and networking

`writer.hyperflip.xyz` (canonical since 2026-09-14) and `writer.overround.xyz` (kept serving)
both have A records pointing at the box. Caddy terminates TLS with Let's Encrypt certificates
(auto-renewing) and reverse-proxies to the writer on loopback:

```
writer.overround.xyz, writer.hyperflip.xyz {
	reverse_proxy localhost:8787
}
```

`/etc/caddy/Caddyfile`. Port 8787 is **not** open to the internet; the writer is reachable only
through Caddy. Firewall:

| port | purpose |
|---|---|
| 22 | ssh |
| 80 | Caddy, redirects to https |
| 443 | Caddy → localhost:8787 |

### Registering a new domain

A freshly registered `.xyz` appears in RDAP immediately, but the CentralNic zone does not publish
the delegation for several minutes. `dig @x.nic.xyz <domain> NS` returning the zone SOA means
wait, not misconfiguration. Do not let Caddy retry issuance during that gap — Let's Encrypt
allows only 5 failed validations per hostname per hour.

## Redeploying after a code change

```bash
cd <repo root>
forge build   # only if contracts changed

rsync -az --delete --exclude node_modules --exclude .env --exclude settlement-cache.json keeper/ root@91.99.94.25:/opt/hype/keeper/
rsync -az --delete --exclude node_modules --exclude .env --exclude waitlist.json --exclude quotes.jsonl writer/ root@91.99.94.25:/opt/hype/writer/
# Registry is BOX-AUTHORITATIVE (rotate.timer rewrites it nightly) — pull, never push:
rsync -az root@91.99.94.25:/opt/hype/registry/ registry/

ssh root@91.99.94.25 'cd /opt/hype/keeper && npm ci --omit=dev=false && cd /opt/hype/writer && npm ci'
ssh root@91.99.94.25 'chown -R hype:hype /opt/hype/keeper /opt/hype/writer && systemctl restart keeper writer'
```

`--exclude settlement-cache.json` on the keeper rsync protects the box's live cache from both
deletion and overwrite by a local copy — confirm it survives before restarting. Same story for
`--exclude waitlist.json` on the writer rsync: it holds the beta signups and their issued
invite codes (`jq length /opt/hype/writer/waitlist.json` is the signup count).

## Nightly market rotation

`rotate.timer` on the box fires daily at 03:10 UTC (the testnet Crypto 1d board refreshes at
03:00): `rotate.service` runs `node tools/rotate-markets.mjs` from `/opt/hype/repo`, which
deploys vaults for fresh markets, prunes expired entries into `archived`, rewrites
`/opt/hype/registry/markets.json` (`/opt/hype/repo/registry` is a symlink to it), then
restarts writer + keeper.

`ROTATE_MODE` selects the board. `crypto` (default) wraps price binaries (incl. the Recurring
1d set) and needs `correlation-sources.json`; the writer runs `PRICING_MODE=correlated`.
`sports` wraps HIP-4 sports fixtures — templated questions (match A/Draw/B, tournament
winner) whole, one vault per named outcome with the real `QUESTION_ID`, plus standalone
winner and over/under outcomes — and the writer runs `PRICING_MODE=independent` (product of
leg prices, legs sharing a game or question refused as `same-game`, no research root). Set
`Environment=ROTATE_MODE=sports` in `rotate.service` and `PRICING_MODE=independent` +
`PARLAY_VAULT_ADDRESS` + `PARLAY_DEPLOY_BLOCK` in `/opt/hype/.env` together; a sports
registry under a correlated writer refuses every cross-game ticket (`correlation-unavailable`).

The repo copy at `/opt/hype/repo` is rsynced from the laptop (same excludes as above plus
`--exclude registry`); its `.env` holds only `PRIVATE_KEY`, `TESTNET_RPC`, `KEEPER_ADDRESS`
(root-only, 600 — the deployer key must live here for forge). forge + uv are installed for
root. After changing rotation code:

```bash
rsync -az --delete --exclude node_modules --exclude .git --exclude cache --exclude out \
  --exclude broadcast --exclude web --exclude '.env*' --exclude registry --exclude '*.html' \
  ./ root@91.99.94.25:/opt/hype/repo/
ssh root@91.99.94.25 'cd /opt/hype/repo && ROTATE_MODE=sports node tools/rotate-markets.mjs --dry-run'  # sanity
ssh root@91.99.94.25 'systemctl start rotate.service'                                # live run
ssh root@91.99.94.25 'journalctl -u rotate.service -n 50 --no-pager'                 # logs

Note `npm ci` must install devDependencies — `npm start` runs `tsx`, which is a devDependency.
Do not set `NODE_ENV=production`.

## Bankroll (house wallet)

The house is the writer wallet (`WRITER_ADDRESS`). Every mint pulls `maxPayout - premium` from
it into ParlayVault; a won ticket pays that to the taker for good, a dead ticket returns it to the
wallet, but the allowance is spent either way. The writer caps exposure at
`min(allowance, balanceOf(writer))` and logs an `ALERT low-bankroll` line once when that drops
below `LOW_BANKROLL` USDC (default 100); `/health` shows `bankroll`.

Refill = top up the wallet, then re-approve. Testnet drip and app transfers land on HyperCore
spot; move them to EVM with (writer key = `QUOTE_SIGNER_PRIVATE_KEY`):

```sh
PRIVATE_KEY=$QUOTE_SIGNER_PRIVATE_KEY uv run --with hyperliquid-python-sdk --with eth-account python tools/core-to-evm.py 999
```

Approving the max once means only the balance ever needs attention:

```sh
cast send $USDC "approve(address,uint256)" $PARLAY_VAULT_ADDRESS \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --private-key $WRITER_PRIVATE_KEY --legacy
```

`USDC` is `cast call $PARLAY_VAULT_ADDRESS "usdc()(address)"`. Long-dated legs (UCL winner,
Super Bowl) lock escrow for months; `PER_CLUSTER_CAP` is what bounds that, not the picker.

## Alerts to Telegram

Keeper, writer and rotate only ever write `ALERT`/`FATAL` lines to journald. `alert-relay.timer`
greps them every 5 minutes and posts to a Telegram bot (`ops/alert-relay.sh`). One-time setup:
create a bot with @BotFather (token), message it once, read your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`, then on the box:

```sh
printf 'TG_TOKEN=<token>\nTG_CHAT=<chat id>\n' > /opt/hype/alert.env && chmod 600 /opt/hype/alert.env
cp /opt/hype/repo/ops/systemd/alert-relay.* /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now alert-relay.timer
logger -t writer -p err "ALERT relay smoke test" && /opt/hype/repo/ops/alert-relay.sh
```

The last line is a `logger` line, not a service line, so it will NOT be picked up by `-u writer`;
to test end to end restart the writer with `LOW_BANKROLL` above the balance and quote once, or
just wait for a real one. Pair with an external ping on `/health` (UptimeRobot free tier) so a
dead box, which cannot relay its own death, still pages.

## Launch-day smoke

```sh
INVITE_CODE=<code> node tools/smoke.mjs
```

One line: live markets, priced legs (allMids not pinned at 0.5), open parlays, bankroll,
reserved, and a real 2-leg quote multiple. Exit 1 on anything missing. Run before invites go out
and after every rotation you care about.

## Writer drop-ins

`/etc/systemd/system/writer.service.d/research.conf` adds the research env; a `rollback.conf`
that pinned the unit to an old checkout was removed on 2026-09-03 (kept at
`/opt/hype/backups/`). If `/health` ever reports a stale build, check `systemctl cat writer`
for a `WorkingDirectory` override before anything else.

## Verifying

```bash
ssh root@91.99.94.25 'systemctl is-active keeper writer caddy'
ssh root@91.99.94.25 'journalctl -u keeper -f'
curl https://writer.hyperflip.xyz/health
```

The keeper logs only on events, not on every poll, so silence in its journal is normal.
`systemctl is-active` is the liveness check. On a healthy start it logs the vault config for each
market followed by `keeper started { vaults: N, pollIntervalMs: 5000 }`.

## Isolated correlation research operations

Research data for the only enabled profile lives below `/opt/hype/research/testnet`; writer/repo
rsync destinations must never be changed to `/opt/hype/research` or any child. Before separately
approving unit installation, create the private state directory without replacing existing research
data:

```bash
ssh -o BatchMode=yes root@91.99.94.25 'install -d -o hype -g hype -m 0700 /opt/hype/research /opt/hype/research/testnet /opt/hype/research/testnet/state'
```

The immutable inputs are under `facts/source-registries/`, `facts/baselines/`, `raw/`, and
`manifests/`. Derived returns, candidates, validation sidecars, promotion receipts, journals,
operator state, and HTML evidence are under `derived/`, `artifacts/`, `journal/`, `state/`, and
`reports/`, all relative to `/opt/hype/research/testnet`. Never delete or replace this tree during
a deploy. Source, market, and baseline content rotations create content-addressed epochs inside the
same root. A network, profile declaration, chain, or deployment-registry change requires a fresh
root; do not edit or reuse `network-profile.json`. Verify the testnet root around rotation:

```bash
ssh -o BatchMode=yes root@91.99.94.25 'test -d /opt/hype/research/testnet && stat -c "%U:%G %a %n" /opt/hype/research/testnet /opt/hype/research/testnet/state && test -r /opt/hype/registry/correlation-sources.json'
ssh -o BatchMode=yes root@91.99.94.25 'systemctl start rotate.service && test -d /opt/hype/research/testnet && test -r /opt/hype/research/testnet/network-profile.json && test -r /opt/hype/registry/correlation-sources.json'
```

`tools/rotate-markets.mjs` reads and parses `correlation-sources.json` before calling
`bigBlocks("on")`. The box-authoritative `markets.json` remains untouched by the separately
approved, non-destructive mapping install:

```bash
scp -o BatchMode=yes registry/correlation-sources.json root@91.99.94.25:/opt/hype/registry/correlation-sources.json.new
ssh -o BatchMode=yes root@91.99.94.25 'chown hype:hype /opt/hype/registry/correlation-sources.json.new && mv -f /opt/hype/registry/correlation-sources.json.new /opt/hype/registry/correlation-sources.json'
```

`/opt/hype/research.env` is owned by `hype:hype`, mode `0600`, and contains only these public or
read-only inputs. Keep the profile path absolute because the writer runtime and research CLI resolve
relative paths from different bases:

```dotenv
RESEARCH_NETWORK_PROFILE_FILE=/opt/hype/registry/research-network.testnet.json
RESEARCH_ROOT=/opt/hype/research/testnet
RESEARCH_REQUIRE_ANCHORED_FS=1
WRITER_RPC=<approved-testnet-read-endpoint>
RESEARCH_REPLAY_SEED=<reviewed-public-seed>
```

The selected profile is the sole source of the Info URL plus source, market, deployment, and
baseline registries. Collection publishes the
mapping-epoch-specific rolling closure through `manifests/current.json`; daily derives its fixed
180-day window and as-of from that pointer, then passes the derived manifest and candidate paths
between steps without mutable environment pins. The file contains no signer, poker,
invite, waitlist, deployer, or keeper secret. `/opt/hype/research-backup.env` is separate, mode
`0600`, is never loaded by writer/keeper, and contains only `RESEARCH_BACKUP_ENDPOINT`,
`RESEARCH_BACKUP_REGION`, `RESEARCH_BACKUP_BUCKET`, `RESEARCH_BACKUP_ACCESS_KEY`, and
`RESEARCH_BACKUP_SECRET_KEY` for a least-privilege write/read bucket principal.

The bounded units are `hype-research-collector.{service,timer}` (hourly),
`hype-research-daily.{service,timer}` (01:15 UTC), and
`hype-research-backup.{service,timer}` (03:30 UTC). Unit installation and enablement require a
separate approval. Every service sets `RESEARCH_REQUIRE_ANCHORED_FS=1`; on Linux it must use the
`/proc/self/fd` anchored backend or fail closed. macOS fixture runs use compatibility storage and
cannot satisfy Linux operational containment acceptance. After approval, install non-interactively
and verify on Ubuntu before enabling:

```bash
scp -o BatchMode=yes ops/systemd/hype-research-* root@91.99.94.25:/tmp/
ssh -o BatchMode=yes root@91.99.94.25 'cp -f /tmp/hype-research-* /etc/systemd/system/ && systemd-analyze verify /etc/systemd/system/hype-research-* && systemctl daemon-reload && systemctl enable --now hype-research-collector.timer hype-research-daily.timer hype-research-backup.timer'
```

Daily processing derives, calibrates, replays, joins, and reports; it never promotes or restarts a
service. Promotion is manual and explicit, and the same command rolls back by atomically promoting
a previously verified candidate:

```bash
ssh -o BatchMode=yes root@91.99.94.25 'cd /opt/hype/writer && /usr/bin/npm run research -- promote --candidate artifacts/candidates/<model-version>.json'
```

The optional backup uploads the verified immutable closure to S3-compatible storage and records
its last verified object hash in `state/backup.json`. Production acceptance requires the daily
off-box backup to be configured and green; a missing configuration reports `disabled`, while a
lock, HTTP, checksum, or total timeout fails the unit.

Health checks:

```bash
ssh -o BatchMode=yes root@91.99.94.25 'systemctl list-timers --all hype-research-* --no-pager && systemctl status hype-research-collector.service hype-research-daily.service hype-research-backup.service --no-pager'
ssh -o BatchMode=yes root@91.99.94.25 'journalctl -u hype-research-collector.service -u hype-research-daily.service -u hype-research-backup.service -n 100 --no-pager'
ssh -o BatchMode=yes root@91.99.94.25 'test -s /opt/hype/research/testnet/state/backup.json && find /opt/hype/research/testnet/reports -type f -name "*.html" -print'
```

## Future mainnet checklist (non-executable)

Mainnet remains disabled. Before any future enablement, separately review and add a mainnet profile
and all referenced registries, land a reviewed change adding mainnet to the single
enabled-research-network allowlist, allocate a fresh mainnet research root, deploy fresh contracts,
collect fresh mainnet evidence, validate the complete immutable closure, and promote only a fresh
mainnet champion produced and validated from that fresh mainnet root and evidence. This is a design
boundary, not authorization; no mainnet values or executable commands belong in the current testnet
runbook.

## Recovering the settlement cache

`/opt/hype/keeper/settlement-cache.json` holds settlement fractions observed before Core pruned
them. It is the only thing that can settle an already-pruned vault. It survives restarts and
reboots because it is on the server's disk. If the box is ever rebuilt, copy this file across
before starting the keeper.
