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
`PER_CLUSTER_CAP`, `INVITE_CODES`.

The file is mode 600, owned by `hype`. Both services load it via dotenv from the repo root.

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

The writer unit is identical with `WorkingDirectory=/opt/hype/writer`.

`tools/supervise.sh` is not used on the server — systemd replaces it. The script remains for
local runs.

## TLS and networking

`writer.overround.xyz` has an A record pointing at the box. Caddy terminates TLS with a
Let's Encrypt certificate (auto-renewing) and reverse-proxies to the writer on loopback:

```
writer.overround.xyz {
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

rsync -az --delete --exclude node_modules --exclude .env keeper/ root@91.99.94.25:/opt/hype/keeper/
rsync -az --delete --exclude node_modules --exclude .env writer/ root@91.99.94.25:/opt/hype/writer/
rsync -az registry/ root@91.99.94.25:/opt/hype/registry/

ssh root@91.99.94.25 'cd /opt/hype/keeper && npm ci --omit=dev=false && cd /opt/hype/writer && npm ci'
ssh root@91.99.94.25 'chown -R hype:hype /opt/hype && systemctl restart keeper writer'
```

`--delete` on the keeper rsync will not remove `settlement-cache.json` because it is excluded
from the repo, but confirm it survives before restarting.

Note `npm ci` must install devDependencies — `npm start` runs `tsx`, which is a devDependency.
Do not set `NODE_ENV=production`.

## Verifying

```bash
ssh root@91.99.94.25 'systemctl is-active keeper writer caddy'
ssh root@91.99.94.25 'journalctl -u keeper -f'
curl https://writer.overround.xyz/health
```

The keeper logs only on events, not on every poll, so silence in its journal is normal.
`systemctl is-active` is the liveness check. On a healthy start it logs the vault config for each
market followed by `keeper started { vaults: N, pollIntervalMs: 5000 }`.

## Recovering the settlement cache

`/opt/hype/keeper/settlement-cache.json` holds settlement fractions observed before Core pruned
them. It is the only thing that can settle an already-pruned vault. It survives restarts and
reboots because it is on the server's disk. If the box is ever rebuilt, copy this file across
before starting the keeper.
