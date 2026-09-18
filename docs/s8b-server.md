# Isolated v2 overnight services — September 17/18, 2026

The user authorized `root@91.99.94.25` for side-by-side testnet v2 operation and
explicitly approved transferring maker A/B signing keys, private RPC credential,
relay token, and saved journals/indexes. Installation was verified September 17
at 22:02 UTC (September 18, 00:02 Zagreb). This completes the overnight worker
setup, **not G1 or the full S8b public preview rollout**.

Next session: [overnight evidence checklist and copy-paste prompt](s8a-overnight-review.md).

## Running layout

| Service | Location / listener | Purpose |
| --- | --- | --- |
| `maker-v2@a.service` | `/opt/hype-v2`, loopback 8791 | A quotes, exposure, automatic Dead resolution |
| `maker-v2@b.service` | `/opt/hype-v2`, loopback 8792 | B quotes, exposure, automatic Dead resolution |
| `relay-v2.service` | `/opt/hype-v2`, loopback 8788 | RFQ fan-out, positions/limits proxy |
| `observe-settlement-v2.service` | `/opt/hype-v2` | Read-only S2b outcome 19467 / probe balance samples |

All four are enabled at boot and restart after process failure with a 15-second
delay. They run as existing user `hype`, with filesystem writes restricted to
`/opt/hype-v2/state` plus private temporary storage. Private env files are mode
0600; state is 0700. The observer receives only the RPC credential, no signing key.
This shares the existing Unix account; it is not a separate-user security boundary.

V2 uses `registry/deployment.testnet-v2.json`, chain 998, vault
`0x075b4c6a7ce42890d839f774abfe8206f3c18a76`. The live market registry is read
from `/opt/hype/registry/markets.json`, as specified by the S8b tracker. The
existing v1 keeper remains responsible for recording shared OutcomeVault results.
No contract deployment, funding, production web/DNS, Caddy, v1 unit, or rotation
change was made. V1 writer/keeper/Caddy retained PIDs 676748/676749/4895.

The Mac can sleep or shut down. **Keep laptop A/B stopped while server A/B run.**
Original `.env.s8a*` and `~/.local/state/hype-s8a` remain intact. The server now
owns the advancing journals/indexes. Stop its makers before any later laptop
handover, and copy back current state rather than overwriting server progress
with the older laptop snapshot. Temporary private transfer archives were removed.

## Check from the Mac

Service state:

```bash
ssh -o BatchMode=yes root@91.99.94.25 'systemctl is-active maker-v2@a maker-v2@b relay-v2 observe-settlement-v2 writer keeper caddy'
```

Recent read-only observations (safe JSON output; no RPC URL):

```bash
ssh -o BatchMode=yes root@91.99.94.25 'tail -n 3 /opt/hype-v2/state/settlement-19467.jsonl'
```

Successful or reverted resolution receipt records, when present:

```bash
ssh -o BatchMode=yes root@91.99.94.25 'journalctl -u maker-v2@a -u maker-v2@b --since "2026-09-17 21:55:00 UTC" --no-pager -o cat --grep="parlay-resolution-receipt"'
```

Receipt logging does not itself prove G1. Retrieve the transaction receipt and
verify success, Dead status, the stored maker, and the actual full escrow transfer
to that maker. Retain the evidence and check the other maker did not poke it.
Raw maker error logs can contain provider credentials; do not paste them publicly.

## Verified recovery and remaining checks

- A seeded four open tickets, B one; nonzero exposures match their own tickets.
- Relay returned IDs 5/4/3/2/1. B is first in `RELAY_MAKERS` because its saved
  index includes ticket 5; A is catching up its older positions index. This
  positions preference does not determine the RFQ winner.
- B, relay, and observer were deliberately restarted. Exposure, positions, and
  append-only observations survived. A quote afterward received both makers in
  966 ms (HTTP 200). No new mint was submitted.
- At 22:01:54 UTC all five tickets remained Open: 1–4 stored A, 5 stored B.
- Observer samples every approximately 60 seconds, with timestamps around each
  sequential precompile read. RPC failures are distinguished from explicit
  execution reverts. Credit/settlement order inside one sampling interval cannot
  be resolved more precisely than those observations.
- Baseline: outcome 19467 active (1), USDC total 900000000, YES/NO totals
  1000000 each. Expected gross credit 10 USDC, final token-0 total 1900000000
  if no other probe activity. Continue through settlement and pruning; corroborate
  reverts before claiming pruning. No kickoff halt is assumed.
- Rechecked event timing at 21:26 UTC: DET@BUF September 18, 00:15 UTC / 02:15
  Zagreb. Game completion and testnet settlement times are not known in advance.
  The observer does not place orders or establish in-play trading behavior.

The full S8b `writer2.hyperflip.xyz` host, preview web deployment, and public
smoke remain pending. V2 is currently reachable on server loopback via SSH;
the existing laptop frontend does not automatically switch to this relay.

## Release checks

Source: `new-design` HEAD `30a614c` plus the documented S8a writer changes,
observer, receipt logging and v2 units. Full `scripts/verify.sh` passed in an
isolated checkout: 184 Forge, 26 keeper, 142 writer, 36 web, 16 tooling tests;
typechecks/builds passed. The isolated checkout excluded unrelated dirty web
changes. Server writer typecheck and systemd unit verification also passed.

`/opt/hype-v2/release-sha256.txt` verifies 28 deployed source/configuration-template
files (no private env/state). Its SHA256 is
`49931c6747f834e19a6dd01d559e726ffe760b1fd131f45049eb1dc106e794bc`.
Both deployed sources and installed unit copies matched. No commit was made.
