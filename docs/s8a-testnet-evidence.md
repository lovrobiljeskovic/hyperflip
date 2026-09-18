# S8a laptop evidence — 2026-09-16

Status: **G1 PASS — ticket 3 Dead receipt and full stored-maker payment verified September 18.**
S2b item 4 credit/pruning verified with read-semantics limits; item 6 unobserved.
See [overnight review](#overnight-review--2026-09-18-08050814-utc--10051014-zagreb).
Resume instructions and latest HIP-4 findings: [session handoff](s8a-handoff.md).
Source checkout: `20cd9927d6ccb8479ccb2c27ca7677da7a3ba688` plus uncommitted working-tree changes.
Scope: testnet chain 998, laptop relay and two makers, local web app.

- Vault: `0x075b4c6a7ce42890d839f774abfe8206f3c18a76`
- Creation block: `64446629`
- Deployment: `0x0508462ba1030502b24d102ec1e4c0a686d2192e6201fb70929933c41f0b2801`
- Maker A: `0x0EBdE2ec018fE1168DF56d62facd5eB98A569Ab9`
- Maker B: `0xc37EAC616146A8D66823A0396e95358Ea5dAde48`
- Both registration receipts succeeded. User reported successful big-block reset
  and both 10 USDC approvals. dRPC passed the actual deployment history check;
  the official and Chainlink endpoints returned code even before creation.

Ticket **1** minted in block `64447715`:

- Transaction: `0xc6abcc96d35c55bf719811253a7af1a7dfa7e1b7e5f492b9d0eef735af2ee879`
- Taker / verified NFT owner: `0xC1b15e354D5E4561B5692735070d874727001e48`
- Minted quote: `0xaf78ceadfd86afa7b17f9d5fb3f2c48c7811cdf12969623a0de6cdc3f637f767`
- Matching RFQ: `0x8474fc60ae475b3bfd107c4d8717b93c05e98eef551a124d9a1778ad9947c114`
- RFQ recorded at `2026-09-16T18:53:42.122Z`: two valid responses.
- A offered **0.502084 USDC**, B offered **0.492955 USDC**; A won.
- Receipt verified token transfers to the vault: **0.2 USDC** from the taker and
  **0.302084 USDC** from A. Total escrow / maximum payout: **0.502084 USDC**.
- Stored `writer` is A; stored premium/payout match the event; status is **0 (Open)**.
- Local health after mint: A `ok=true`, `seeded=true`, `openParlays=1`;
  B `ok=true`, `seeded=true`, `openParlays=0`.

Selected legs, from the local market snapshot:

| Vault | Selection | Game |
| --- | --- | --- |
| `0x33f2f57b35b357e3fc48f6c38948471798f43871` | NO / HOU | Cincinnati Bengals vs Houston Texans |
| `0x6ddec67fb9b3a37c11e9e6ce1037e255b77d0d41` | YES / GB | Green Bay Packers vs New York Jets |

Both entries have `startMs` corresponding to **2026-09-20 17:00 UTC** and registry
expiry **2026-09-23 17:00 UTC**. These are snapshot metadata, not proof of a final
result or an exact settlement time.

Read-only checks run against the configured testnet RPC and local maker health:

```text
PASS: mint receipt, NFT owner and both escrow transfers
PASS: minted quote matches a two-maker RFQ and the highest payout won
```

Remaining G1 evidence: a losing leg settles, A's poker resolves the ticket to
Dead, and the resolution receipt transfers the full payout to its snapshotted
maker. B must not poke A's ticket. If ticket 1 wins or voids, it cannot supply
the required Dead-path evidence; another ticket is needed. Failover, restart,
winning-claim and void-refund checks have not been recorded here.

## Resume checks — 2026-09-17, 17:48–17:51 UTC

Checkout: `new-design` at `30a614c`, containing checkpoint `68eea2d` and two
later commits. Existing uncommitted web changes were preserved. No deployment,
funding, approval, or settlement transaction was sent during these checks.

Network-enabled checks (initial sandbox attempts could not access the network):

```text
web /build: HTTP 200
maker A :8791 /health: connection refused (HTTP 000)
maker B :8792 /health: connection refused (HTTP 000)
relay   :8787 /health: connection refused (HTTP 000)
RPC chain ID: 998; observed head: 64531525
ticket 1: status 0 (Open), stored maker A, premium 200000, payout 502084
nextId: 4 (last minted ID; tickets 1–4 exist)
PASS: tickets 1–4 mint receipts, matching RFQs, stored makers, escrow transfers
```

The receipt checks asserted success, matched each minted quote to the local RFQ
winner, and checked quote-token transfers from both taker and maker to v2.
All four RFQs recorded A `won` and B `lost`; all four tickets remain Open and
store A. Each premium is 0.2 USDC. Newly recovered evidence:

| Ticket | Selections | Payout (USDC) | Mint block / transaction |
| --- | --- | ---: | --- |
| 2 | CIN YES + GB YES | 0.671283 | `64448147` / `0xf6eb227ad440b579e8b46068efc5fdf8d67da04d8632235c58ed1ef00bdc6d89` |
| 3 | DET YES + CAR YES | 0.959514 | `64449940` / `0x772219f8edf99bd0cd1ecd60f0a5e1d7b82c5d533e9695e50c311c33cf04592b` |
| 4 | CAR YES + BUF NO | 0.499823 | `64449961` / `0x24048a4200629314daa506337e65a0fff17891de9e50ee91dcf4dcf510cad9f0` |

Tickets 3 and 4 use opposite selections on DET@BUF outcome 19467, vault
`0xae7a3c27cf8468d5547461c8d2b978335ad9ee95`. Both share CAR YES, vault
`0x4c021a2428d93b2c0d4c58bda0a20f68b878676f`. A normal binary DET@BUF
settlement supplies a losing leg for one of them; fractional/void resolution
does not guarantee Dead. No additional opposing pair is needed for this test.

Both saved maker indexes already contain ticket IDs 1–4. Expected cold-start
exposure is A `openParlays=4`, B `openParlays=0`, provided chain status is unchanged.
Both taker indexes should show all four IDs; that does not mean B owns their risk.

Next interactive step: user starts B and the relay in their foreground terminals,
leaving A stopped. Verify B seeded and a fresh RFQ succeeds through B, then mint
a small B ticket in the browser and check its receipt. Restore A, check its four
open tickets are recovered, then restart B and the relay one at a time and check
the B ticket, indexes, and fresh quotes survive.

Known availability limit from current `writer/src/relay.ts`: `/limits` and
`/parlays` proxy only maker A. They return 503 while A is down even if B quoting
works. Verify B ownership on-chain during failover; check relay positions again
after A is restored. A successful B RFQ alone does not prove full UI failover.

**G1 remains pending:** no Dead resolution receipt or payout to the stored maker
has been observed. Service recovery and B failover are not yet verified.

### B quote failover — 2026-09-17 17:53 UTC

After the user started B and the relay, A remained unreachable. Assertions passed:

```text
relay health: A ok=false; B ok=true, seeded=true, openParlays=0
POST /quote: HTTP 200; makers={asked:2,quoted:1}; stored quote maker=B
premium=200000; maxPayout=492955; selections HOU NO + GB YES
RFQ: A unreachable; B won; result=quoted
PASS: A unavailable, B seeded with zero A-ticket exposure, relay returned and journaled B quote
GET /limits: HTTP 503 {"error":"maker-unreachable"}
GET /parlays?taker=0xC1b15e354D5E4561B5692735070d874727001e48: HTTP 503 {"error":"maker-unreachable"}
```

RFQ `0xc40393754370ce7dccecee11d65408f3fd0ec1db30ac7bbd5c52c1a3b4104649`;
quote `0xb4d86798ef20adf01b91f170b00fb69e747669167f369a685654c0ec79dfd64f`.
This request reserved capacity but did not mint. Quote failover and B cold-start
maker filtering are verified; a B mint, A exposure recovery, subsequent B/relay
restart recovery, and full browser behavior remain pending. G1 remains pending.

### Browser blocker — September 17 follow-up

User reported “Writer unreachable” on localhost before a B mint. Fresh local
checks returned relay `/health` 200 (A down, B seeded, zero open tickets),
`/markets` 200 with 178 markets, and `/limits` 503 as previously observed.
The JavaScript actually served by `http://localhost:3000/build` embedded:

```text
writer BASE: https://writer.overround.xyz
parlay vault: 0x407cdc0b15e8d81f4d122481ecf92dbe07dc0169 (v1)
```

Thus web HTTP 200 did not establish correct S8a configuration. The running
frontend used legacy settings, not the local relay/v2 launch overrides. No
request was sent to that legacy writer during diagnosis. Restart only the web
dev server using laptop step 10, then verify its served bundle points to
`http://localhost:8787` and v2 before retrying the B mint. Resolution of this
browser blocker and the B mint are pending; no product code was changed.

### RPC startup blocker — September 17, from 18:10 UTC

User reported maker startup exiting in `verifyDeploymentRpc` with “Cannot verify
deployment RPC history; an archive-capable endpoint is required.” At 18:11 UTC,
the preserved common config still selected the correct v2 manifest and dRPC.
Both makers and the relay were unreachable. Read-only diagnosis:

```text
dRPC chain ID: 998
dRPC eth_getCode latest / 64446629 / 64446628:
  HTTP 400, RPC -32601, "the method eth_getCode does not exist/is not available"
Official and Chainlink code bytes latest / creation / pre-creation:
  21788 / 21788 / 21788 (fail: pre-creation must be empty)
Tatum public testnet code bytes latest / creation / pre-creation:
  21788 / 21788 / 0
Tatum actual verifyDeploymentRpc checks completed, but requests hit rate limits;
  subsequent parlay(1) eth_call failed with RPC -16401:
  "Method 'eth_call' is available for paid plans only."
```

dRPC's documented `include_hl_native_tx` / `exclude_hl_native_tx` URL flags did
not restore `eth_getCode`. Tatum is not established as a working service RPC:
the candidate validation exited 1 before signer/log/precompile checks. No RPC
configuration, env file, deployment block, or startup guard was changed. The
error message conflates failed code reads with unavailable archive history;
the observed dRPC failure also affects current code, not just old blocks.

The guard requires chain 998, code now and at creation, and no code immediately
before creation. It must remain enabled. B mint/restart recovery is blocked on
a working RPC; provider availability was requested from the user without keys.
G1 remains pending. No deployment or funding was repeated.

Follow-up env audit: the existing root `.env` lists public Chainlink/official
testnet RPCs; `.env.s8a` overrides `WRITER_RPC` with public dRPC. Web current and
backup env files also select public endpoints. No private RPC was found in
these local env files or the maker env files. Values/credentials were not
printed, and no env file was modified.

### Alchemy Free compatibility — September 17, 19:24–19:29 UTC

User replaced only `WRITER_RPC` in `.env.s8a` with their private Alchemy
testnet endpoint. Its URL/key were not printed or copied into documentation.
The unchanged deployment guard passed: chain 998, code now/at block 64446629,
no code at 64446628. All four tickets remain Open and store maker A; both
registered signers match. Core outcome 19467 remains status 1 and the probe's
USDC balance remains 900000000 (9 USDC).

The 100-block mint-log check failed with the provider's explicit Free-tier
10-block limit. A 10-block check found ticket 1. User chose to keep Free and
authorized the narrow writer change:

- `Poker.fetchEvents` now requests at most 10 blocks per log query.
- Catch-up yields after a completed chunk once approximately 30 seconds have
  elapsed, allowing the existing tick to persist progress and check settlement.
  This avoids processing the entire saved-index backlog in one tick. Individual
  RPC calls can still exceed the budget; it is not a request timeout.
- The existing partial-failure recovery test now enforces 10-block ranges; a
  regression check verifies checkpoint/taker-index recovery after the timed yield.

Validation actually run:

```text
Before patch: poker tests 8 passed, 2 failed (new compatibility/recovery checks)
After patch: poker tests 10 passed, 0 failed
npm run check: initial sandbox run hit tsx IPC EPERM after typecheck
npm run check: network/sandbox-enabled rerun exit 0; typecheck passed
  tests 139; pass 139; fail 0
PASS: patched Poker read 20 historical blocks as four 10-block event queries
PASS: indexed A ticket 1 while B open exposure stayed zero
```

Live scanner validation used blocks 64447710–64447729 with an in-memory index;
it sent no transactions and wrote no saved service state. The user was given
B/relay restart commands again, re-sourcing the updated config. Service startup,
full backlog catch-up, frontend v2 identity, B mint and subsequent restart
recovery still need live checks. Smaller batches increase request count; earlier
100-block cost estimates do not describe this Free-tier configuration.
G1 remains pending a verified Dead resolution receipt.

Post-validation frontend check: `/build` returned 200, but four JavaScript
assets referenced by that response returned 404. The served v2 identity could
not be verified from those missing assets. Browser discovery returned no
available browser; these were HTTP checks, not a visual UI test. Restart the
frontend with the explicit S8a/v2 launch command before attempting a mint.
B and relay were still unreachable at this check; their restart is user-driven.

### B/relay restarted — September 17, 19:32–19:34 UTC

After the user restarted both services with the new config:

```text
A :8791: unreachable (intentionally stopped)
B :8792: HTTP 200, ok=true, seeded=true, openParlays=0
Relay :8787: HTTP 200; A ok=false; B ok=true, seeded=true, openParlays=0
B saved index scannedTo: 64453901, then 64454611; existing IDs 1–4 preserved
First fresh quote: HTTP 503 no-quotes; relay window expired at 1505 ms
Retry: HTTP 200, 911 ms client elapsed; makers={asked:2,quoted:1}; B won
```

For the failed RFQ `0xd694513944a88b6772d1fe355fa8cb4a9317ed809fbebad504af2050d017cb26`,
B subsequently journaled a quote about 2.45 seconds after request start: maker
latency exceeded the 1.5-second relay window. B metrics recorded a quote and
no rejection. The warm retry succeeded without a window/config change:
RFQ `0x122d721cfbe27720ac3a6ebdf5937e159f7bb4645c0a5e56bf23ad51bffe77d8`,
quote `0x644da3570c26565ae3fe939e3fcca6330da453dff584b8a12ea02eb9063560c5`,
premium 200000, payout 492955, HOU NO + GB YES; B response latency 844 ms.
This does not establish sustained latency reliability while catch-up runs.

All 28 referenced frontend JavaScript assets returned 404 despite `/build`
returning 200. User's next step is restarting only the frontend with the v2
manifest, localhost relay, and the official **public testnet** RPC. That public
RPC passed chain 998, current `nextId=4`, and mint block 64447715 reads; it is
for frontend reads only and still unsuitable for the backend history guard.
The private Alchemy endpoint stays out of `NEXT_PUBLIC_*` settings.

No B mint has occurred. Backlog catch-up is progressing but not complete;
A recovery, B-ticket restart recovery, frontend identity verification, and G1
remain pending.

### RPC throughput and replacement — September 17, 19:38–19:50 UTC

After intermittent successful browser RFQs, a later request returned `no-quotes`
and B recorded `rpc-down`. A direct read-only `eth_blockNumber` request returned
HTTP 429; a subsequent contract read succeeded. This confirms throttling, not
monthly allowance exhaustion. The 10-block scanner had no pause between chunks,
so catch-up competed with quote reads. User stopped B, then replaced `WRITER_RPC`
in `.env.s8a` with another endpoint; no endpoint URL or credential was recorded.

Read-only replacement checks at 19:46 UTC:

```text
Deployment guard: PASS (chain 998, current/creation/pre-creation code)
Head: 64538706; nextId: 4
Tickets 1–4: status 0/Open, stored maker A
10-block logs:  mint PASS (309 ms), resolve PASS (170 ms)
100-block logs: mint PASS (191 ms), resolve PASS (271 ms)
1000-block logs: both FAIL, RPC code 35
Follow-up 1000-block query: HTTP 400; error identifies a block range problem
A :8791 and B :8792: stopped; relay :8787 HTTP 200, both makers unavailable
```

Ranges began at 64447710; successful mint queries found ticket 1. A 101-block
inclusive query also passed; we did not establish the exact maximum. Use the
verified conservative 100-block size, not 1,000. Relative to 10 blocks, it needs
one tenth as many log requests to cover the same full ranges; provider billing
and sustained throughput were not measured.

The scanner now uses 100-block ranges and waits one second between chunks,
retaining completed chunks and the approximately 30-second checkpoint yield.
This supersedes the earlier Alchemy-specific 10-block change. It is pacing for
this scanner, not a global limiter across makers/relay. Validation:

```text
Focused poker tests: tests 10; pass 10; fail 0
npm run check: exit 0 (typecheck + tests 139; pass 139; fail 0)
Live patched scanner: PASS; 200 blocks, 4 log calls, chunk start gap 1364 ms
Indexed A ticket 1; B open exposure 0; state writes 0; transactions 0
git diff --check: exit 0
```

The live scanner used an in-memory index over 64447710–64447909. No env/state
files were edited by the agent and no deployment, funding, or mint occurred.
User must restart B and reload the relay so both use the new endpoint. Catch-up
must be checked before another mint: exposure seeds from current state, but
subsequent mint detection shares the historical scan cursor. Quote latency and
sustained operation remain to be verified; these small probes do not prove them.
G1 remains pending a real Dead settlement receipt paying the stored maker.

### Replacement RPC service checks — September 17, 19:56–19:59 UTC

User restarted B and the relay with the replacement endpoint. Local checks:

```text
A :8791: unreachable (intentionally stopped)
B :8792: HTTP 200, seeded=true, openParlays=0
Relay :8787: HTTP 200; B reachable
Frontend /build: HTTP 200; all 51 referenced JS assets HTTP 200
Served JS: v2 vault and localhost:8787 present; legacy v1 vault absent
19:57 RFQ: HTTP 200, 1007 ms; asked=2, quoted=1, B won
19:58 RFQ: HTTP 200, 1119 ms; B won again
B metrics: quoted=2, minted=0, rejected={}
Relay metrics: quoted=2, noQuotes=0; B unreachable=0, invalid=0
```

RFQ `0x985969cba515afddb443960336803389ef87577e906402f76afcce4565855a30`
returned quote `0x002d0dbc51e743f14d06f1a4302d13c2fc20a65ba0eedbd3c4eb049a185132e6`:
HOU NO + GB YES, premium 200000, payout 492955. A was unreachable and B's
recorded latency was 941 ms. This is quote-only failover; no mint was sent.
Frontend checks inspect HTTP assets/configuration, not an interactive wallet flow.

B preserved taker-index IDs 1–4 through restart. Its checkpoint advanced from
64472461 at 19:57:56 to 64475061 at 19:58:38; head advanced from 64539385 to
64539428. Remaining backlog: 64367 blocks. The measured net rate suggests about
18 more minutes, subject to RPC variability. Leave B/relay running and wait for
fresh catch-up verification before minting; the historical cursor also gates
new-mint detection. A remains stopped for the B-only failover test. G1 pending.

### Positions failover correction — September 17

User reported positions failing to load while A was intentionally stopped.
Live local reproduction: relay `/parlays?taker=…` and `/limits` returned HTTP
503 `maker-unreachable`, while B's direct `/parlays` returned HTTP 200 with
IDs 4, 3, 2, 1 and their original mint blocks. The relay's shared GET proxy
always selected the first configured maker (A), so quote failover did not
cover positions or limits. This was independent of B's catch-up backlog.

Changed the shared proxy to try configured makers in order after transport,
timeout, invalid-JSON, HTTP 5xx, or HTTP 429 failures. Other responses, including
client validation errors, retain their status. Positions use the first available
maker's index; indexes are not merged or ranked by freshness. Limits likewise
use that maker's policy; distinct-policy aggregation remains outside this fix.

```text
Before patch, new HTTP regression: FAIL (503 !== 200)
After patch, npm run check: exit 0; typecheck passed
  tests 140; pass 140; fail 0
Temporary patched local relay against running B, with A stopped:
  /parlays HTTP 200, ticket IDs [4,3,2,1]
  /limits HTTP 200, makers=2
```

The temporary verification server was closed afterward. The user's running
relay still needs a restart to load this change; B should remain running so
catch-up continues. No env/state files, frontend code, box, v1, or production
were changed. Refresh positions after the relay restart, then recheck catch-up
before minting. G1 remains pending.

Relay restart verified at **20:05:47 UTC** after the user's restart:

```text
Live relay /parlays: HTTP 200, ticket IDs [4,3,2,1]
Live relay /limits: HTTP 200
Live relay /health: A unavailable; B ok=true, seeded=true, openParlays=0
B metrics: quoted=2, minted=0, rejected={}
RPC head: 64539864; B scannedTo: 64498461; backlog: 41403 blocks
```

This confirms the running relay now serves positions through B with A stopped.
Browser rendering still needs the user's refresh/observation. Compared with
19:58:38, B advanced 23400 blocks while head advanced 436; extrapolating that
net rate gives roughly 13 minutes more catch-up. This is an estimate, not a
mint-ready verdict. All four index refs are preserved; no new mint was sent.

20:07:30 UTC status recheck: B remains healthy/seeded, openParlays=0;
checkpoint 64503661, head 64539970, backlog 36309 blocks. Recent progress
still estimates about 13 minutes (around 22:20 Zagreb). Covering this snapshot
requires 364 100-block chunks / 728 log requests, excluding new blocks, retries,
head checks and normal service reads. This is a request-count estimate, not a
provider billing/remaining-quota estimate. Catch-up completion remains pending.

User subsequently confirmed positions are visible in the browser. At 20:13:24
UTC, relay health still shows A down/B healthy and seeded with zero open tickets.
B checkpoint 64524461 versus head 64540329 leaves 15868 blocks; original IDs
1–4 remain indexed. No new readiness quote or mint was sent while behind.
Planned B-only mint remains HOU NO + GB YES, premium 0.20 USDC, after catch-up.

### B-only mint verified — September 17, 20:17–20:18 UTC

User minted ticket **5**. Actual on-chain selections are **HOU YES + GB YES**,
not the suggested HOU NO + GB YES; this still exercises B-only mint failover.
No replacement mint is needed. All five tickets were Open at the 20:17 read;
tickets 1–4 still store A, and ticket 5 stores B.

| Field | Verified value |
| --- | --- |
| Transaction | `0xd0cb2c0ba3cc8e9511c7b5978d0895e1a6d35e1569cc5af3c4927a8b9dce92e1` |
| Receipt / block | success / `64540525` |
| Stored maker | `0xc37EAC616146A8D66823A0396e95358Ea5dAde48` (B) |
| Taker | `0xC1b15e354D5E4561B5692735070d874727001e48` |
| Premium / payout | `200000` / `659078` (0.20 / 0.659078 USDC) |
| Quote | `0x4c528452b3ca227a762ee5a3e048ff27041e3ca2ebd0eea18ea9d38738defeef` |
| RFQ | `0xc4f371a9d16821b07e3e8d932bee696eaa26ef26531fe2cebe1d4269010c0393` |

Receipt assertions passed: successful transaction, matching maker/taker, and
USDC transfers into v2 of 200000 from the taker plus 459078 from B. The matching
RFQ journal records A unreachable and B won, with B latency 1139 ms. This proves
live B-only quote/mint failover, independently of subsequent settlement.

At the initial 20:17:09 check, B's scanner was still about 2998 blocks behind
and reported zero open tickets, although ticket 5 was already on-chain. By
20:18:25, normal catch-up had processed the mint without resetting state:

```text
B checkpoint: 64540620 (past mint block 64540525)
B health: ok=true, seeded=true, openParlays=1
Relay health: A down, B healthy with openParlays=1
Relay /parlays: HTTP 200, IDs [5,4,3,2,1]
Saved B index: original IDs 1–4 preserved, ticket 5 added at 64540525
```

Next: restart only B and verify startup rebuilds its one open ticket and retains
the full index; then restore A and verify it tracks its four tickets, not B's.
The relay has already been restarted with existing state preserved, but another
post-mint relay recovery check can verify positions/quotes with the new ticket.
No deployment, funding, or agent-sent transaction occurred. **G1 remains pending**
a live Dead settlement receipt paying the stored maker; ticket 5's mint is not
settlement evidence. S2b credit/timing/pruning observations remain pending.

### B restart recovery passed — September 17, 20:20–20:21 UTC

After the user restarted B, live checks returned:

```text
B health: HTTP 200, ok=true, seeded=true, openParlays=1
B per-market exposure: HOU/CIN=459078, GB/NYJ=459078, DET/BUF=0, CAR/ATL=0
B checkpoint: 64540769, updated 20:20:36 UTC; IDs [1,2,3,4,5] preserved
Relay positions: HTTP 200, IDs [5,4,3,2,1]; limits: HTTP 200
A remains stopped
Post-restart quote: HTTP 200, 1062 ms; asked=2, quoted=1, B won
```

Exposure equals ticket 5's risk (659078 minus 200000) on its two markets and
excludes A's tickets. Startup metrics were reset to quoted=0/minted=0 before
the probe; seeded open=1 shows chain-state recovery, not a new mint. Quote ID
`0x682a9e4de612b051993156dd655bc6a7e61f5cf3f0b4ebed347a5b9dfc28e531`.
No additional mint was sent. B ticket/exposure/index recovery is verified.

A restoration and post-mint relay recovery remain next; G1 remains pending.
Before restoring A, account for its older index: the positions proxy prefers
configured order, so A can temporarily return only IDs 1–4 until its scan reaches
ticket 5. Both makers index all tickets, but each tracks only its own exposure.
The relay currently delegates positions indexing to those maker processes;
the chain remains the authoritative owner/status record.

### Settlement timing rechecked — September 17, 21:26 UTC

ESPN and fresh testnet outcome metadata still schedule DET@BUF for September
18 at 00:15 UTC / 02:15 Zagreb. Core outcome 19467 is still active (status 1),
its OutcomeVault is not settled, and tickets 3/4 remain Open under A. Probe
balances still show 9 USDC + 10 YES + 10 NO, with no settlement credit observed.
See the latest hedge findings for exact balances and timing qualifications.

Earliest G1 opportunity remains one of tickets 3/4 after a normal binary DET/BUF
resolution, EVM result recording, and a Dead resolution paying stored maker A.
No exact settlement timestamp is known. An early-morning game finish is an
estimate, not proof of when testnet settles. A is still unreachable locally at
this check; restore it for automatic poking. This read-only recheck sent no
transactions and did not start a poller. G1/S2b remain pending.

Overnight preparation follow-up: local `/health` found A and B unreachable;
relay returned HTTP 200 with both makers `ok=false`. `pmset -g batt` showed
battery power (100%, discharging); `pgrep -x caffeinate` returned no process.
Consulted the installed `caffeinate(8)` manual: `-i` prevents idle sleep and `-s`
prevents system sleep while on AC. Provided per-maker foreground restart loops
under `caffeinate -is`; shell syntax validation exited 0. This is preparation,
not evidence of running overnight or of a passed settlement. User must start
the processes and their health must be rechecked; no state/env edits or agent
service starts occurred.

### Authorized server handover — September 17, 21:55–22:02 UTC

User selected `root@91.99.94.25`, required v1 remain live, and explicitly approved
copying testnet maker keys, RPC credential, relay token, and saved journals/indexes.
New installation `/opt/hype-v2` uses the existing v2 deployment. Laptop makers
were confirmed unreachable before server startup; original env/state retained.
Private installed env files are 0600, state 0700; temporary transfer copies removed.

```text
Server deployment RPC guard: PASS
A/B quote signer and poker-key identity checks: PASS
V2 maker A 127.0.0.1:8791: HTTP 200, seeded=true, openParlays=4
V2 maker B 127.0.0.1:8792: HTTP 200, seeded=true, openParlays=1
V2 relay 127.0.0.1:8788: HTTP 200, both makers healthy
Relay positions: IDs [5,4,3,2,1]
A exposure: CIN/HOU=773367, GB/NYJ=773367, DET/BUF=1059337, CAR/ATL=1059337
B exposure: CIN/HOU=459078, GB/NYJ=459078; no DET/BUF or CAR/ATL exposure
V1 writer: HTTP 200, seeded=true, openParlays=12
V1 writer/keeper/Caddy PIDs unchanged: 676748 / 676749 / 4895
All four new v2 units: active, enabled, NRestarts=0
```

A's positions checkpoint advanced to 64458049, still IDs 1–4; B advanced to
64546941 with IDs 1–5. Server relay tries B first for indexed positions; A's
historical catch-up remains in progress. Startup exposure is recovered from
current chain state, separately from historical positions catch-up.

At 22:00:43 UTC a server RFQ returned HTTP 200 in 1091 ms, asked=2/quoted=2,
A won, quote `0xb95e1b53566ff9f3d0e7ea37547665b07cf5332b8af79a1831e963587ff120ce`.
Then B, relay, and observer were deliberately restarted. Their seeded exposure,
all five positions, and existing observer log survived. At 22:02:30 UTC another
RFQ returned HTTP 200 in 966 ms, asked=2/quoted=2, A won, quote
`0x6cb5cf1a4553d97c1f6d7732e20a3054c0b4a978cf6a7a3b3081949451932934`.
No mint was sent. Startup journal scan found zero FATAL, poker tick failures,
or rate-limit markers; this is a bounded startup check, not an overnight SLA.

Fresh chain reads starting 22:01:54 UTC: chain 998, tickets 1–5 all status 0
(Open), stored makers A for 1–4 and B for 5. No resolution receipt yet.
**G1 remains pending.** Do not substitute service health or an RFQ for receipt
proof of Dead settlement and full escrow paid to the stored maker.

Observer logged its first sample at 21:55:05 UTC; seven samples and two starts
were present at the recovery check. Latest 22:01:08 sample: outcome 19467 status
1, settledValue 0, USDC total 900000000, YES and NO totals 1000000 each; all
holds 0. No settlement credit/pruning observed. It continues roughly every
60 seconds in `/opt/hype-v2/state/settlement-19467.jsonl` without signing keys.
It distinguishes RPC failures from execution reverts and does not test trading.

Full isolated `scripts/verify.sh` exited 0: Forge 184, keeper 26, writer 142,
web 36, tooling 16 tests passed; builds/typechecks passed. Server typecheck,
systemd unit validation, and 28-file deployed checksum verification passed.
Unrelated dirty web changes were excluded from the isolated gate/deployment.
See [server runbook](s8b-server.md) for service checks and release fingerprint.
Public v2 host/preview smoke remains pending; v1, production, rotation, original
laptop env/state and broadcast artifacts remain untouched.

## Overnight review — 2026-09-18, 08:05–08:14 UTC / 10:05–10:14 Zagreb

**G1 PASS. S2b item 4 verified with the limitations below; item 6 remains
unobserved, so S2b as a whole is partial.** This supersedes earlier pending
settlement snapshots. Read-only SSH/RPC/API checks only; no deployment, funding,
mint, manual settlement, service restart, or private configuration change.

Checkout was checked first: `new-design`, HEAD
`30a614c061afd03d4d225f8d538cd75633fd0709`, two commits ahead of
`hyperflip/new-design`, with existing writer, web, documentation and unit changes.
Those changes were preserved. The external tracker
`/Users/lovrobiljeskovic/docs/superpowers/plans/2026-09-16-bedlam-sessions.md`
was read; it still labels S8a NEXT and has no S2b result. It was not edited;
this review is the newer result. No commit was made.

Sanitized evidence: [2026-09-18-overnight](evidence/2026-09-18-overnight/README.md).
The complete copied observer file contains **614 JSONL records: 612 samples,
two starts**, September 17 21:55:05.777 through September 18 08:06:33.603 UTC.
It is a snapshot; the original server log continues advancing. Maker journals
were queried from September 17 21:55 UTC, retaining unit identity and only
allowlisted resolution fields. Raw application errors and private RPC URLs
were excluded. Receipts retain their raw logs as well as decoded events.

### Event and tickets

[ESPN event 401872932](https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872932)
returned `STATUS_FINAL`, `completed=true`, **BUF 41–DET 31** at 08:11:57 UTC.
Scheduled kickoff was September 18 00:15 UTC / 02:15 Zagreb. No exact real-world
final timestamp was established. The server's scoreboard request failed HTTP;
the specific event request from the laptop succeeded. Current `outcomeMeta`
no longer includes 19467; the recorded vault still identifies that outcome.

Chain 998 reads at block **64583931** (head 64583961, 08:08 UTC):

| Ticket | Stored maker | Status | maxPayout, USDC | Remaining dependency |
| --- | --- | --- | ---: | --- |
| 1 | A | Open (0) | 0.502084 | CIN/HOU and GB/NYJ unsettled |
| 2 | A | Open (0) | 0.671283 | CIN/HOU and GB/NYJ unsettled |
| 3 | A | **Dead (2)** | **0.959514** | Full escrow returned to A |
| 4 | A | Open (0) | 0.499823 | DET/BUF NO won; CAR/ATL unsettled |
| 5 | B | Open (0) | 0.659078 | CIN/HOU and GB/NYJ unsettled |

`nextId=5`. Initial pinned-head read failed because one provider upstream was
five blocks behind; retrying at head minus 30 succeeded. Precompile samples
remain live reads, not historical reads at this pinned EVM block.

### G1 receipt proof

Ticket 3 resolution transaction:
`0x4a4712a6e7ca86f72d8acbad4d8c4848750e2c6a15aed972daab86e560567232`.

- Successful receipt, block **64569579**, block timestamp **04:12:54 UTC /
  06:12:54 Zagreb**. Input decodes to `resolveParlay(3)`.
- Sender and stored maker both A:
  `0x0EBdE2ec018fE1168DF56d62facd5eB98A569Ab9`.
- V2 vault emitted **`ParlayResolved(3, 2)`**.
- USDC `0x2B3370eE501B4a559b57D449569354196457D8Ab` emitted a `Transfer`
  from v2 `0x075b4c6a7ce42890d839f774abfe8206f3c18a76` to stored A for
  **959514 raw units = 0.959514 USDC**, exactly ticket 3's full `maxPayout`.
- The losing YES leg, OutcomeVault
  `0xae7a3c27cf8468d5547461c8d2b978335ad9ee95`, records outcome 19467,
  `settled=true`, `settleFractionWad=0`, including at the resolution block.
- The keeper's successful `settle(0)` transaction was
  `0x25c52a9132908a35df917e165f659c8f6b0fe6de0598a3997c414f497d6636a8`,
  block **64569560**, **04:12:35 UTC / 06:12:35 Zagreb**, from the stored keeper.
  Thus the result was recorded 19 block-timestamp seconds before the Dead receipt.
- Unit `maker-v2@a` logged `poking-dead-parlay` for 3 at **04:12:52.218 UTC**
  and the matching successful receipt at **04:12:55.140 UTC**. Unit B's retained
  journal contains no poke, resolution receipt or poke-failure attempt. Both
  units later indexed a resolution. This establishes the observed A poker path;
  absence of a B attempt is limited to retained server journals, not a universal
  claim about every possible sender or missing log.

Together with the previously verified two-maker RFQ/mint evidence, these checks
pass G1. Winning claims and void refunds remain additional, unobserved coverage.

### S2b settlement credit and pruning

Probe `0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E` started with token-0 total
**900000000** (9 USDC), YES/NO totals **1000000** each (10 shares), all holds 0.
The settled Core value is **0**: YES loses, NO pays 1.

The observed credit was **998600000 raw = 9.986 USDC net**, leaving token 0
**1898600000 = 18.986 USDC**, not the earlier fee-free projection of 19 USDC.
The testnet `userFills` response corroborates conversion of 10 YES at 0 and
10 NO at 1, both `dir=Settlement`, timestamp **04:10:05.427 UTC / 06:10:05.427
Zagreb**, hash
`0xbcd71a3402122bf8be50042992d30601030032199d154aca609fc586c11605e3`.
The NO settlement entry charges **0.014 USDC** (14 bps of 10 gross); YES fee is 0.
Thus **10 gross − 0.014 fee = 9.986 net** exactly reconciles the balance change.
Returned fills/ledger show no other probe activity during this observation window.
This is an observed fee for this account and settlement, not a universal fee rule.

All following read windows are **September 18 UTC**; add two hours for Zagreb:

| Change | Last pre-change read, start–end | First post-change read, start–end |
| --- | --- | --- |
| Outcome 1 → 2, value 0 | 04:09:23.704–23.842 | 04:10:23.750–23.885 |
| USDC 900000000 → 1898600000 | 04:09:23.842–23.961 | 04:10:23.885–24.003 |
| YES balance read → `rpc-error` | 04:09:23.961–24.074 | 04:10:24.003–24.142 |
| NO balance read → `rpc-error` | 04:09:24.074–24.185 | 04:10:24.142–24.294 |
| Outcome 2 → 3 | 05:59:27.853–27.995 | 06:00:27.866–28.002 |

These windows bound observed transitions; reads are sequential and samples about
60 seconds apart. Status change, credit and token-read failure first appear in
one sample, so their exact intra-sample order or zero settlement-credit delay
is **not** established. The Core fill timestamp precedes first observed credit
by 18.576 seconds; that is an observation lag, not measured protocol credit delay.
Outcome 2 → 3 occurred roughly **109m04s–111m04s** after settlement, rather than
the older fixture's roughly ten-minute pruning observation. Neither is an SLA.

There are **110 status-2 samples**, then **127 status-3 samples** in this snapshot.
Token-0 total stays 1898600000 through all 237 post-settlement samples, including
after pruning. Fresh configured-RPC reads at 08:08 and **08:10:31 UTC** again
return status 3 and the same USDC total. `spotClearinghouseState` independently
reports 18.986 USDC and no old YES/NO balances; `outcomeMeta` omits 19467.
Thus outcome pruning and surviving settlement credit are corroborated.

**Observation limits:** both outcome-token `0x801` calls fail from the first
settled sample onward, through status 3. The observer labels them `rpc-error`,
not `revert`; fresh raw calls return RPC code **−32003**, without an explicit
`execution reverted` message. These failures do not by themselves prove token
removal, an EVM revert, or zero balances. The settlement fills establish conversion;
the later info-API snapshot corroborates absence, but the exact token-removal
instant and precise failed-precompile semantics remain unmeasured. The independent
official RPC returned HTTP 502 on all four corroboration calls. No observer code
or configuration was changed during this review.

One entire sample at **00:17:13.844–14.334 UTC / 02:17 Zagreb** failed all four
reads, bracketed by successful unchanged samples at 00:16 and 00:18. The maximum
sample-start gap was **62.885 seconds**. There are no missing/malformed JSONL
records in the copied file; it contains two startup records, including the
previously documented startup/recovery restart. A valid JSONL sequence cannot
prove there was no unlogged activity outside the observer's scope.

**Item 6 remains unobserved:** no kickoff/in-play order acceptance, fills,
cancellations or rejections were tested by this observer. Status 1 after kickoff
proves neither tradability nor a halt. Do not infer a universal kickoff halt.

### Current health and continuity

At 08:05–08:14 UTC all four v2 units are active/running, `NRestarts=0` since
their documented starts. A/B/relay health return HTTP 200; makers are seeded,
A open=3 and B open=1. Both indexes preserve IDs 1–5 and advance between reads;
A's prior backlog is cleared. Both makers and relay return all five positions.
A's remaining CIN/HOU and GB/NYJ exposure is 773367 each, DET/BUF and CAR/ATL
299823 each; B's CIN/HOU and GB/NYJ exposure is 459078 each.

This was **not an error-free night**. Sanitized journal marker counts include
five A and four B `poker tick failed` lines near 00:16–00:17 UTC, plus RPC/timeout
errors and rate-limit markers. Multiline error dumps account for many non-JSON
journal lines; marker counts are not independent incident counts. No FATAL or
journal suppression marker was found in the queried units. Current health and
later successful settlement show recovery, not uninterrupted quote availability.
No fresh RFQ or browser trading action was sent for this read-only review.

V1 writer/keeper are active with PIDs **688080/688077**, Caddy still **4895**.
Writer HTTP health reports seeded=true, open=10; the existing Caddy route also
returns healthy v1 JSON. Writer/keeper restarted around **22:11, 23:10, 02:10,
and 04:11 UTC**. Their successful stop/start lifecycle records align with rotate
runs; the installed rotate unit retains its registry-mtime-guarded
`systemctl restart writer keeper` rule. This supports routine rotation as the
cause, not a v2 crash. Do not claim original PIDs or uninterrupted v1 uptime.
The keeper continued recording settlements, including 19467; its journal also
contains alerts, retained only as sanitized counts. The agent restarted nothing.

Laptop ports 8791/8792 remain unreachable; makers were not started. Server
journals/indexes remain authoritative. V1, production, broadcast artifacts,
`.env.s8a*`, and `~/.local/state/hype-s8a` were not modified. Full S8b public host,
preview deployment and public smoke remain pending.

Validation actually run (documentation/evidence review; no application edits):

```text
python3 docs/evidence/2026-09-18-overnight/verify.py: exit 0
PASS G1 receipt/sender/full escrow; losing-leg keeper receipt and historical result
PASS tickets 1–5; journal attribution; S2b net credit/fee reconciliation
PASS full 612-sample timeline; fresh pruning/USDC checks; event final
PASS current A/B/relay/Caddy health and advancing indexes; laptop makers off
GAP token-read semantics and kickoff order/cancel observations
```

The runnable verifier and its exact output are in the evidence directory.
Earlier application test results remain historical; Forge/writer/web suites
were not rerun for this documentation-only review.

## Separate approved IOC execution — September 18, 08:59–09:07 UTC

After the read-only overnight review, the user separately approved a bounded
HedgeProbe testnet experiment. Full/partial/no-fill IOC and recovery after a
deliberately discarded response passed. Probe bought 15 native Core YES for
7.50 USDC; counterparty retained 15 NO after splitting 15 USDC, with 0.006 USDC
seller fees. Final balances/zero holds were independently confirmed through
Core precompiles; neither account has open orders. No v2 parlay mint, ERC-20
wrapping, new funding, deployment or service change occurred. See
[complete execution evidence and actual checks](evidence/2026-09-18-ioc-execution/README.md).
This proves the separate contract-agent execution path, not local UI/v2
integration, live-game execution or margin credit.
