# Testnet Correlation Verification

Evidence dates: 2026-08-28 local fixture acceptance; 2026-08-30 Ubuntu testnet operations.

## Acceptance state

- Local fixture implementation: **Passed**. The final Task 8 commands are recorded below.
- Testnet operational acceptance: **PARTIAL / Rejected**, not full Task 9 acceptance. The approved
  Ubuntu run proved anchored Linux persistence and the live
  collect → derive → calibrate → replay → Rejected report path. The statistical candidate was not
  eligible for promotion.
- Statistical decision: **Rejected**. The exact candidate projection error
  `0.314324004721122` exceeded the `0.10` policy limit. This is not evidence about production
  expected value.
- Mainnet: **Not authorized and not accessed**.

The run deliberately did not promote a candidate, restart either service, request a runtime quote,
or mint a parlay after the Rejected verdict. Full operational acceptance remains pending the
criteria listed at the end of this document.

## Scope and safety boundary

All SSH/SCP commands used `-o BatchMode=yes` and targeted the documented existing host
`root@91.99.94.25`. The run used only the existing fixed-price EUR 4.99/month VPS and public
Hyperliquid testnet resources. It provisioned no resource, installed no downloaded dependency,
called no paid backup target, and incurred **zero incremental real-money cost**. Faucet-issued
testnet assets were authorized but were not consumed because promotion was prohibited.

Secret values were never printed. Checks inspected only key presence, ownership/mode, public
deployment values, public hashes, and configuration derived without displaying the RPC endpoint.
No private key, invite code, raw signature, or credential entered this document or a commit.

## Read-only preflight

The isolated linked worktree began at exact HEAD
`0225c0db9c213e77e55b267336a22b9ff3b6ae08` on
`feature/testnet-correlation-system`. Only the pre-existing untracked `keeper/node_modules` and
`writer/node_modules` directories were present.

The preflight exited 0 and established:

- host `ubuntu-4gb-fsn1-1`, Ubuntu 26.04, Linux 7.0.0-29-generic;
- configured RPC chain ID `998`, without printing the endpoint;
- profile network `testnet`, EVM chain ID `998`, and testnet Info URL
  `https://api.hyperliquid-testnet.xyz/info`; its metadata response contained 210 universe entries;
- public parlay vault `0x407cdc0b15e8d81f4d122481ecf92dbe07dc0169`, deploy block
  `61906227`, and deployed code on chain 998;
- 16 active and 59 archived box-authoritative markets; every active vault had code on chain 998;
- `keeper.service`, `writer.service`, and `caddy.service` active/enabled; keeper PID `255151` and
  writer PID `255152`;
- `rotate.timer` active/enabled and `rotate.service` inactive/static;
- 32,908,684 KiB free on `/opt/hype` (13% used);
- `/opt/hype/research/testnet` absent, permitting creation of a fresh root without deleting or
  replacing data; and
- `/opt/hype/.env` a regular `hype:hype` mode `0600` file with required key names present. No value
  was displayed.

There was no hostname, chain, deployment, testnet-host, path-type, disk, mainnet, nonempty-root, or
non-testnet-data stop condition.

Checked-in raw input SHA-256 values before transfer were:

| Input | SHA-256 |
|---|---|
| `registry/research-network.testnet.json` | `ba58ac628e0b1422cd35ea92777319eb93eae5eeae22e24216948e883022d1c7` |
| `registry/correlation-sources.json` | `7664559b0bfe4e9d86f5753e748cda46ddbf352c21acfa7edb6a8657c2de7b9d` |
| `registry/deployment.testnet.json` | `b833d50e933dc30a39b39b9be714957be3cd8eadabe18d1d156b63b8adf723b7` |
| `registry/correlations.json` | `b4ba39c3700d7f2ad2c537d1748fd7c657fe7a590327af49145626ca2bc51e39` |
| box `registry/markets.json` before marker | `46821f2b7108fcd5de33442fcbb4247e5a5d4f4c9a8d25d7f9f33da507bf1d74` |

## Minimal testnet research deployment

The explicit host and resolved paths were rechecked before every mutation. The run:

- created `/opt/hype/research/testnet/state` under the absent root; root and state are
  `hype:hype` mode `0700`;
- preserved all 16 active and 59 archived market records, adding only the required top-level
  `"network":"testnet"` marker; resulting raw SHA-256
  `afebf7e6e2350fe854ec753b5c02662b143e7894c8ab34f775c41c347bf20240`;
- installed only the current research/runtime closure and public testnet profile/registries;
- reused existing dependencies. Local and remote `writer/package-lock.json` SHA-256 was
  `29968c39a47cf085f1b9f29a0ea73fdc3252b9865f12cbc2690491b77d1c453c`;
  `npm ls --depth=0` exited 0, and no install/download ran;
- installed `/opt/hype/research.env` as `hype:hype` mode `0600` with the public profile/root,
  `RESEARCH_REQUIRE_ANCHORED_FS=1`, public seed, and already-configured chain-998 read endpoint;
- installed only the writer drop-in, SHA-256
  `4bd4b24ef35a752b5b53eed0e4c67d5a7f3d6f967ecefcf30946c067236c7a5e`, and ran
  `systemctl daemon-reload`; and
- staged but did not install, enable, or start any research unit/timer.

The first broad remote typecheck exposed an incomplete minimal runtime-source copy. A checksum
dry-run identified the exact missing/current-interface closure, which was copied; the pinned
source-only TypeScript check then exited 0. Neither writer nor keeper was restarted.

## Linux containment

The Ubuntu command used the anchored flag without displaying other environment values:

```text
runuser -u hype -- env RESEARCH_REQUIRE_ANCHORED_FS=1 \
  ./node_modules/.bin/tsx --test test/research-persistence.test.ts
```

The first run was intentionally retained as RED: exit 1, `tests 10`, `pass 9`, `fail 1`. The
runtime selected Linux `/proc/self/fd` anchored persistence before the compatibility branch.
Leaf-symlink rejection, root swap, intermediate-directory swap, and destination swap containment
passed. The remaining intermediate-symlink case was safely rejected as Linux `ENOTDIR`; its test
expected only text matching `symbolic link`.

Commit `e960fa90499608d71838c1ac0b46b64ab928a8c7` changed only that assertion to accept the
platform's equivalent `ENOTDIR`. Production persistence behavior did not change. The exact test
file SHA-256 installed on Ubuntu was
`6b35782e3f617a9fb0f31a881c54f76b0799e2eef5349db1d3b5429d0c48145a`.

The anchored Ubuntu rerun exited 0: `tests 10`, `pass 10`, `fail 0`. It exercised
`/proc/self/fd`, rejected symlink substitution and root/destination/intermediate swaps, and did not
use compatibility mode.

## Immutable identity closure

The installed profile/root marker and live artifacts closed over these canonical identities:

| Identity | SHA-256 |
|---|---|
| profile | `b6675ff82b02639efb3fa60c5d25a0284cb54b7dff19682d20dcf399f3786407` |
| source registry | `cefb4c5ab11ce43b3f827d5e382d9025a36fb5a5b7cc24f93e9a81ab3a756f76` |
| market registry | `2a1f7159abddc21b37a2d79c2d0b78262395614fe70ccce58152f0527f15835b` |
| deployment registry | `a0b951f3c300a8756665e52884c8cb89eb16b0ae1eaa9a6c8a23d19599b33f63` |
| baseline correlation | `fed2e49307bf899f3a9fa174da557ecabe5f7a3feb80ec2ca2bceb9aca3520a7` |
| data manifest | `dda295a1a802dc1eb4a0902565e1d9ba631abfe4f4685f354951bbc5ecc7b4c8` |
| derived manifest file | `2950f8941cdfc11d47fc324bd1c4e70c561d4b142a1c5fd2d78a733afce9c00b` |
| returns-v2 data | `4a0ee6b17ba37dcf5804d55eb8b3aafd4fe33fffe8cdb5fa617ac6f5851d080c` |
| exclusions data | `7fb8ca32fa3be404b89d44c296b54e2b0e49e8710f02bd6cd30a14dd19d07030` |
| candidate | `a2aacaf6cc71c17ed0e557599cb786d433fc584c2a59f4f1c841f5c623137e9c` |
| validation sidecar | `6b784000f45f2e0b3f2676d622e486ed90a6a48ec67f62024ef201192de8084c` |
| final HTML report | `cb4ce10a92a2d22f359399505cea7dc6931825113ceb0980aa60572614d818d9` |

Network is `testnet`, chain is `998`, model is `2026-08-30.dda295a1`, data-as-of is
`2026-08-30T04:59:59.999Z`, and the reviewed public seed is
`task9-testnet-0225c0d-20260830`.

## Collect and derive

The bounded collector command ran under a 900-second timeout using only the installed testnet
profile/root. Exit was 0; wall time was 19.29 seconds and peak RSS was 490,656 KiB. The immutable
operation recorded 38,033 accepted rows, 0 conflicts, and 0 failures. Nine HTTP requests returned
200. Every request reported `ignoredBefore=0` and `ignoredAfter=0`; SP500 and ZEC were explicitly
measurement-disabled and made no request.

| Underlying | Accepted raw rows | Manifest rows | Missing/closed intervals |
|---|---:|---:|---:|
| AAPL | 1,245 | 1,245 | 525 |
| BTC | 5,000 | 4,321 | 0 |
| ETH | 5,000 | 4,321 | 0 |
| GOLD | 4,568 | 4,321 | 0 |
| HYPE | 5,000 | 4,321 | 0 |
| NVDA | 4,989 | 4,310 | 0 |
| SNDK | 2,413 | 2,413 | 333 |
| SOL | 5,000 | 4,321 | 0 |
| SP500 | 0 | 0 | 750 |
| TSLA | 4,818 | 4,139 | 30 |
| ZEC | 0 | 0 | 4,320 |

The manifest source range is `1772513999999` through `1788065999999`. The first derive wrapper
precheck had a shell-quoting error before the CLI or data mutation; no operation/output artifact was
created. The corrected derive exited 0 and produced closure ID
`b4b82159ce97a4a3aed3f26c9f93ecd098c4ea8c87b6b2881fba95660916caad`:

- returns-v2 rows: 17,996 = 17,276 hourly + 720 daily;
- BTC, ETH, HYPE, and SOL: 4,499 return rows each;
- exclusions: 19,189 = 19,140 `missing-interval` + 49 `no-synchronized-peer`;
- exclusion rows by underlying: AAPL 1,760; BTC 6; ETH 6; GOLD 1,757; HYPE 5;
  NVDA 1,755; SNDK 1,754; SOL 3; SP500 1,752; TSLA 1,751; ZEC 8,640; and
- return close range: `1772521199999` through `1788065999999`.

## Calibration and pair disposition

Calibration used explicit data/derived manifests, exited 0 in 74.82 seconds, and peaked at
494,336 KiB RSS. Candidate model `2026-08-30.dda295a1` contains 55 canonical pairs:

- Direct, 6: `BTC/ETH`, `BTC/HYPE`, `BTC/SOL`, `ETH/HYPE`, `ETH/SOL`, `HYPE/SOL`.
- Fallback, 49, each reason `operator-reviewed-testnet-bootstrap`:
  `AAPL/BTC`, `AAPL/ETH`, `AAPL/GOLD`, `AAPL/HYPE`, `AAPL/NVDA`, `AAPL/SNDK`,
  `AAPL/SOL`, `AAPL/SP500`, `AAPL/TSLA`, `AAPL/ZEC`, `BTC/GOLD`, `BTC/NVDA`,
  `BTC/SNDK`, `BTC/SP500`, `BTC/TSLA`, `BTC/ZEC`, `ETH/GOLD`, `ETH/NVDA`,
  `ETH/SNDK`, `ETH/SP500`, `ETH/TSLA`, `ETH/ZEC`, `GOLD/HYPE`, `GOLD/NVDA`,
  `GOLD/SNDK`, `GOLD/SOL`, `GOLD/SP500`, `GOLD/TSLA`, `GOLD/ZEC`, `HYPE/NVDA`,
  `HYPE/SNDK`, `HYPE/SP500`, `HYPE/TSLA`, `HYPE/ZEC`, `NVDA/SNDK`, `NVDA/SOL`,
  `NVDA/SP500`, `NVDA/TSLA`, `NVDA/ZEC`, `SNDK/SOL`, `SNDK/SP500`, `SNDK/TSLA`,
  `SNDK/ZEC`, `SOL/SP500`, `SOL/TSLA`, `SOL/ZEC`, `SP500/TSLA`, `SP500/ZEC`,
  `TSLA/ZEC`.
- Quarantined, 0: none.

Direct correlations were:

| Pair | Correlation |
|---|---:|
| BTC/ETH | `0.4820301407807348` |
| BTC/HYPE | `-0.035233305987373204` |
| BTC/SOL | `0.38379767563644` |
| ETH/HYPE | `-0.007088306614043628` |
| ETH/SOL | `0.40257857652651635` |
| HYPE/SOL | `0.006721482766762755` |

The two negative direct targets were recorded as clipped-negative evidence. Candidate quality also
recorded Higham delta `9.318003980283441e-11` and maximum projection error
`0.314324004721122`.

## Replay and Rejected decision

The first exact replay used the same candidate, derived closure, and public seed under an
operator-imposed 1,800-second timeout. It remained healthy near 101% CPU and about 400 MiB RSS but
timed out. Its immutable start record is retained with no fabricated terminal:
`20260830T055841201Z-76e284c0-8d85-4183-b12d-e6ca1d1aee80`.

One authorized retry used the shipped 7,200-second limit and no recollect/recalibration. It ran from
`2026-08-30T06:29:25.344Z` to `07:26:10.972Z`, remained near 101% CPU with observed RSS up to
406,600 KiB, and wrote a successful terminal operation with decision `Rejected`.
`deterministicRerunMatches` is `true`; draw count is 20,000; origin stride is 24 hours. Selected
ticket counts were:

| Stratum | 2 legs | 3 legs | 4 legs |
|---|---:|---:|---:|
| cross-cluster | 0 | 0 | 0 |
| same-cluster | 69 | 176 | 139 |
| same-underlying | 830 | 202 | 0 |

Replay excluded 86 structurally unavailable rows. All five models evaluated 1,416 rows, 1,132
eligible after 284 band-market exclusions:

| Model | Log loss | Brier | Sharpness |
|---|---:|---:|---:|
| filtered historical simulation | `0.5119543146795522` | `0.17129514378221058` | `0.025198232740055237` |
| independence | `0.5430473647405126` | `0.17927686184189856` | `0.01390057012056095` |
| measured hierarchical Gaussian | `0.501383726813419` | `0.16699803027434595` | `0.01866596732605618` |
| signed t-copula | `0.4989927658226084` | `0.16641509966662213` | `0.019004105213904936` |
| static hierarchical Gaussian | `0.5310658440416727` | `0.17466565905644318` | `0.01914888832049653` |

The 96-hour, 2,000-sample block-bootstrap improvement interval was point
`-0.05589159529138254`, lower `-0.08873309844880416`, upper
`-0.021856351266114092`. That interval and determinism did not override the hard quality gate:
maximum projection error `0.314324004721122` independently exceeded policy `0.10`, so the exact
verdict is **Rejected**.

## Join and report

The chain-998 join scan was allowed to read existing public events and append research journal
state. It succeeded from `09:02:35.273Z` to `09:06:25.016Z`, appended 49 events, found 0
resolutions, and advanced to block `62923638`. It retained one pre-existing pending public event:
parlay ID `2`, quote ID
`0x9c6e7bf56ecbb6f389112b7d7b79b63888425151de0c191a83eee0b4c3a3ded1`, vault
`0x79B4b1a83aBf8619711ea3f6DAA096584313B0Ef`. This run did not create that quote or mint.

Report history is preserved rather than rewritten:

1. Run `20260830T103354042Z-f57e0e0f-a1ac-4d5a-8ee2-d79c215a265f` failed closed with
   `artifact: maxProjectionError exceeds policy`.
2. Reviewed commit `539326e4579db38c1b79c064c8fa05b21ec9334e` allowed report-only rendering of
   deterministic Rejected projection evidence while keeping default parsing/promotion closed.
   Local and Ubuntu focused tests passed 20/20.
3. Run `20260830T124806150Z-e867ad9c-a3e2-441c-95b3-db607e3f12f0` then failed closed on
   `source/market cluster disagreement for XYZ100`. The preserved box registry has unmapped legacy
   markets outside the exact 11-source research set; its identity was not changed.
4. Reviewed commit `e0f1f73dd549cbf6c72fd649798b952274be1593` allowed exact unmapped markets while
   preserving rejection of cluster disagreement for mapped markets. Source-only TypeScript checks
   exited 0 and local/Ubuntu focused suites passed 21/21.
5. Run `20260830T132959738Z-bc9015e0-6415-4087-a265-780754624be9` succeeded.

Final report:

```text
/opt/hype/research/testnet/reports/2026-08-30-2026-08-30.dda295a1.html
SHA-256 cb4ce10a92a2d22f359399505cea7dc6931825113ceb0980aa60572614d818d9
owner/mode hype:hype 0600; size 117433 bytes
```

The report renders `Rejected`, projection `0.314324`, candidate/validation/profile/manifest
identities, `not promoted`, a per-pair fallback column, a quarantine section, both prior report
failures, and the explicit warning that testnet P&L is not production expected-value evidence.
Generation exited 0 in 4.03 seconds with peak RSS 212,280 KiB. The fuller precision and complete
identity closure remain verified by the immutable candidate, sidecar, derived closure, and hashes
above.

## Immutable operation record summary

| Operation | Run ID / status | Record SHA-256 |
|---|---|---|
| collect | `20260830T055039775Z-b2f1e360-4301-45fa-aa7c-3f36a630d62f` / success | `f5c9fb604b7e8006d9a3e59367094322ba3d3c204aa565952a7dbe0fadf5e9ef` terminal |
| calibrate | `20260830T055624868Z-d0f48fc3-861e-4181-adaf-8b96fa2fe301` / success | `46f3fb91d1ff246636472245eee297a911e9b404cb791d57b116ab73e90d8ba5` terminal |
| replay first attempt | `20260830T055841201Z-76e284c0-8d85-4183-b12d-e6ca1d1aee80` / timed out, no terminal | `6e7f9b2fd9a7fe798ef97707f4159cde8efd8a98aa796321ce8c54a47c78037c` start |
| replay retry | `20260830T062925344Z-359d7a37-52b5-477f-8fce-b5e6b513319f` / success, Rejected | `aa86868dd27d1693028da6801573df7c5de0148fc1d891ec62e88f85eb3e131f` terminal |
| join | `20260830T090235273Z-8d73a554-a640-4942-9982-83001977e81b` / success | `a84a34944c4a7bed9e2f05009c220191cec5b51405f33788fc949c282f99ae68` terminal |
| report attempt 1 | `20260830T103354042Z-f57e0e0f-a1ac-4d5a-8ee2-d79c215a265f` / failure | `ded09ec8f743f7974b862430a1452ff549ea0e31942094daf48f6c99bd351a76` terminal |
| local disabled backup | `20260830T103602131Z-2b081164-2e3d-4f31-aefe-72b0e366589c` / success | `0c5ccda13ad6e3ca289c2f54f93247a07525b2f7175636a94a5d0f342a0a587a` terminal |
| report attempt 2 | `20260830T124806150Z-e867ad9c-a3e2-441c-95b3-db607e3f12f0` / failure | `68e8104ddcc5ee22559069601d93d012de2467b149ac89dd1138b543951a923a` terminal |
| report attempt 3 | `20260830T132959738Z-bc9015e0-6415-4087-a265-780754624be9` / success | `9908cc3f3f5eb6e4809b8b9993cb9dfc95a306ea79c5f178b07d8d22b9117603` terminal |

Derive is a synchronous artifact-producing CLI branch rather than an operation-wrapped branch; its
exit and content-addressed closure are recorded above.

## Durability and backup boundary

At the final remote check, root/state remained `hype:hype` mode `0700`, device `2049`, inodes
`414705` and `414706`; candidate and validation hashes were unchanged. No champion exists because
the candidate is Rejected.

Keeper PID `255151` and writer PID `255152` remained active with their original
`2026-08-30T03:18:03Z` starts from preflight through the final report. No task command restarted,
stopped, or reloaded either service. The writer restart/champion durability criterion therefore was
correctly not exercised.

`rotate.timer` was active/waiting. Its last service run was
`2026-08-30T03:10:01Z`–`03:18:03Z`, before creation of the research root; the runbook confirms it
restarts both keeper and writer. It was not manually started. Thus a natural post-root rotation
observation remains pending. No `hype-research-*` unit file was installed or enabled.

`/opt/hype/research-backup.env` was absent, and backup-key counts were zero in the main/research env
files without displaying values. For additional containment, all five backup variables were
explicitly empty during the bounded local check. It exited 0 in 2.78 seconds, peak RSS 154,384 KiB,
with `{"status":"disabled","reason":"backup configuration absent"}`. No `state/backup.json`
exists, no network upload occurred, and off-box backup acceptance remains pending.

## Actions prohibited by the Rejected verdict

The run performed no promotion, champion write, writer restart, quote request, testnet mint,
resolution, or artificial void. Keeper state/service was never touched. The operator override also
forbids waiting for settlement or forcing a void; after a future authorized Supported-candidate
mint, post-settlement joining is an asynchronous scheduled-joiner observation.

## Local fixture evidence and final gates

The no-network end-to-end fixture covers profile load, 180-day collection, returns-v2 derivation,
calibration, deterministic replay, direct/fallback/quarantine evidence, fixture-only promotion,
writer startup validation, durable quote journaling, mint/void joining, retained failure history,
reporting, persistence reopen, rotation with a stable root marker, and in-memory backup closure. Its
synthetic Supported value exists only to exercise local lifecycle code; it is not live statistical
evidence.

The following table is populated only from the fresh Task 8 rerun at final HEAD plus this document:

| Command | Exit | Exact result |
|---|---:|---|
| `cd writer && ./node_modules/.bin/tsx --test test/research-end-to-end.test.ts` | 0 | 1 passed, 0 failed, 0 skipped |
| `forge build` | 0 | no files changed; compilation skipped |
| `forge test` | 0 | 172 passed, 0 failed, 0 skipped in 7 suites |
| `cd writer && npm run check` | 0 | typecheck passed; 353 passed, 0 failed, 0 skipped |
| `cd writer && npm run research:check` | 0 | 166 passed, 0 failed, 0 skipped |
| `cd keeper && npm run check` | 0 | typecheck passed; 25 passed, 0 failed, 0 skipped |
| `node --test tools/rotate-lib.test.mjs` | 0 | 15 passed, 0 failed, 0 skipped |
| `./scripts/verify.sh` | 0 | format/build passed; 172/172 Solidity and 166/166 research tests passed |
| forbidden-input audit | 0 | one intentional mainnet hostname literal in the exact-host validator; no deployable mainnet input |
| `git diff --check` | 0 | no whitespace errors |

## Proven and pending criteria

| Criterion | State |
|---|---|
| Linux anchored containment, including intermediate/root/destination swap cases | **Proven**: Ubuntu 10/10, `/proc/self/fd`, compatibility not used |
| Testnet profile/chain/deployment/root identity | **Proven**: network testnet, chain 998, exact hashes above |
| Bounded collect → derive → calibrate → replay → report | **Proven with Rejected decision** |
| Pair and exclusion evidence | **Proven**: 6 direct, 49 reviewed fallback, 0 quarantined; exact exclusions above |
| Deterministic replay | **Proven for this candidate**: deterministic rerun true, but quality verdict Rejected |
| Chain event join scan | **Proven**: 49 appended, 0 resolutions, cursor `62923638` |
| Incremental cost boundary | **Proven**: zero incremental spend; existing fixed-price VPS only |
| Supported candidate | **Pending**: a fresh candidate must pass every policy gate |
| Promotion, champion persistence, writer restart health | **Pending** and prohibited for this Rejected candidate |
| Runtime quote and minimum testnet mint identity | **Pending** and prohibited for this Rejected candidate |
| Post-settlement resolution join | **Deferred asynchronous observation** after a future authorized mint |
| Natural post-root rotation durability | **Pending**; no manual rotate because it restarts keeper |
| Off-box backup and verified object checksum | **Pending**; paid/metered upload not authorized |

This record establishes partial testnet operation and a conservative statistical rejection. It is
not full Task 9 acceptance, mainnet readiness, or profitability evidence.
