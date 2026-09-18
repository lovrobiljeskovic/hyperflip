# S8a/S2b overnight evidence — September 18, 2026

Read-only collection from authorized `root@91.99.94.25`, `/opt/hype-v2`,
chain 998, approximately 08:05–08:14 UTC / 10:05–10:14 Europe/Zagreb.
[Full assessment](../../s8a-testnet-evidence.md#overnight-review--2026-09-18-08050814-utc--10051014-zagreb).

**G1 PASS:** ticket 3 Dead; stored maker A sent the transaction and received the
full 0.959514 USDC escrow. **S2b item 4 verified with limits:** net 9.986 USDC
credit after 0.014 fee; outcome status 3 and surviving USDC corroborated.
Item 6 trading behavior and precise failed token-read semantics remain gaps.

| File | Source / contents |
| --- | --- |
| `checkout.json` | HEAD/branch/dirty-state record before documentation edits; laptop maker ports closed |
| `server.json` | Initial unit state, HTTP health, saved maker indexes, journal counts/lifecycle and allowlisted resolution records since September 17 21:55 UTC |
| `settlement-19467.jsonl` | Complete server observer-file snapshot: 614 lines, 612 samples, two starts; no tail-only analysis |
| `chain.json` | Testnet tickets 1–5 and underlying results, actual resolution transaction/receipt/raw logs/decoded logs/block, fresh live precompile sample |
| `keeper-receipt.json` | Actual successful losing-leg settlement transaction/receipt/block, stored keeper, historical settled/fraction reads at ticket resolution |
| `public-api.json` | Testnet info API `outcomeMeta`, probe `spotClearinghouseState`, `userFills`, `userNonFundingLedgerUpdates`; server ESPN attempt failed |
| `event-status.json` | Successful laptop ESPN event-401872932 summary header, final BUF 41–DET 31 |
| `precompile-recheck.json` | Fresh raw configured/official testnet reads; private URL omitted, errors retain only code and classification flags |
| `diagnostics.json` | Journal marker counts/ranges, parsed keeper settlement records, installed rotation-rule booleans, positions HTTP results |
| `health-final.json` | Later current units/health/indexes; v1 health through existing Caddy route |
| `timeline-summary.json` | Generated full-log transition windows/error counts and pruning-time bounds |
| `verify.py`, `verification.txt` | Offline assertions and actual check output |
| `SHA256SUMS` | SHA256 of every other file in this evidence directory |

Observer reads have their own start/end timestamps; sequential requests and
sampling intervals do not establish exact transition ordering. Token `rpc-error`
records are not explicit EVM-revert or zero-balance proof. Current status 3,
settlement fills and info-API absence corroborate different aspects separately.
No order/cancel behavior was observed, and no universal kickoff halt is inferred.

Journals were parsed server-side: only `at`, `event`, `id`, `hash`, `block`,
`status`, source-unit identity and journal timestamps retained for poke/receipt
records. Systemd lifecycle messages contain no private config. Raw application
errors were not copied; marker counts may overlap within multiline dumps and
are not incident counts. No suppression marker was found, but retained-log
absence is not proof of all possible unlogged activity. Configured RPC URLs,
env files and signing keys are excluded. Collection made no server file changes
or transactions; services continued their already-authorized operation.

The observer snapshot is immutable for this review; the server's original keeps
advancing. The checksum manifest authenticates these local copies against later
accidental changes, not an atomic snapshot of all remote state. The external
tracker was read and remains stale/unmodified. Application tests were not rerun;
this review changed documentation and evidence only.

Run the relevant checks from the repository root:

```bash
python3 docs/evidence/2026-09-18-overnight/verify.py
(cd docs/evidence/2026-09-18-overnight && shasum -a 256 -c SHA256SUMS)
git diff --check
```
