# Next session — ship void poking to the live v1 writer

We are on `main`, the live v1 lineage. Testnet only — no mainnet work, not even
read-only probes. Do not run box-mutating commands yourself: hand me each one as
a single line to run, and wait for my output before continuing.

## Where we left off

Four commits sit on local `main`, unpushed (`main` is 4 ahead of
`hyperflip/main`, which is still at `5f75737`):

- `daf0eeb` — writer pokes **Void** parlays, not just Dead. `parlayIsVoid` added
  to `writer/src/settlement.ts`, poke condition widened in `writer/src/poker.ts`,
  logging split into `poking-dead-parlay` / `poking-void-parlay`. Plus the v1
  escrow flow diagram in `docs/diagrams/`.
- `fe02ec0` — independent positions index: `subgraph/` package plus the app read
  path (`web/app/api/positions/route.ts`, `web/lib/positions-index.ts` and
  friends), retargeted from the v2 vault to v1.
- `d01c743` — subgraph lockfile regenerated so `npm ci` succeeds.
- `20801d5` — the implementation plan, retargeted to v1.

Local gates were green at that point: `cd writer && npm run check` 123 pass,
`bash scripts/verify.sh` exit 0, `node web/scripts/check-positions-http.mjs`
pass, Matchstick 4/4.

Nothing has been deployed. `/opt/hype/writer` on the Hetzner box (91.99.94.25)
still runs the old poker, which pokes Dead only.

## The step

Get `daf0eeb` onto the live writer and confirm it actually pokes a Void ticket.

Why this one first: it is finished, tested, and its value is only realised on the
box. Every Void ticket that nobody clicks "Reclaim premium" on keeps the house's
contribution escrowed and counted against the exposure caps, which shrinks how
much the writer can quote. The subgraph work is opt-in and blocked on a Goldsky
account, so it is not the next thing.

## Implementation path

**1. Push the branch.** `main` is 4 ahead. Push before deploying so the box and
the remote agree on what is running.

**2. Pre-check how much the first tick will do.** Before restarting anything,
count the currently-open parlays that the new predicate will classify as Void, so
a burst of `resolveParlay` transactions is expected rather than a surprise. The
poker resolves serially inside one tick and awaits each receipt, so N Void
tickets means N sequential transactions from the writer key. Read-only testnet
RPC is fine here. Check the writer's current exposure first so there is a
before/after number:

```bash
curl -s https://writer.hyperflip.xyz/limits | jq
```

If the count is large, say so and let me decide whether to stage it.

**3. Re-run the gate on this revision.** `bash scripts/verify.sh` from the repo
root, in the foreground, one run at a time. Do not package a red tree.

**4. Package the writer.** From the repository root, per `DEPLOY.md`:

```bash
tar -czf /tmp/writer.tar.gz writer/package.json writer/package-lock.json writer/tsconfig.json writer/src writer/abi registry/deployment.mts registry/deployment.testnet.json services/files.mts
```

Deploy is rsync-based, not git. The three forge artifacts under `out/` that the
services import at startup must already be on the box — they are unchanged by
this commit, so do not re-sync them unless something says otherwise.

**5. Hand me the box commands, one line each.** Unpack into `/opt/hype/` without
overwriting `.env`, `registry/markets.json` (box-authoritative — pull, never
push), `writer/parlays.json`, or any runtime state. Then `npm ci --include=dev`
in `/opt/hype/writer` if the lockfile changed (it did not in this commit — say so
and skip it if that holds).

**6. Restart the writer only.** Not the keeper: it must keep recording settlement
fractions before Core prunes them. Note the hourly `rotate.timer` also restarts
the writer on registry drift; if a rotation is mid-flight, wait it out rather
than racing it.

**7. Verify.** In order:

```bash
systemctl is-active keeper writer caddy
curl --fail http://localhost:8787/health          # seeded: true
journalctl -u writer -n 100 --no-pager | grep -E 'poking-(dead|void)-parlay|poke-failed'
WRITER_URL=http://localhost:8787 node tools/smoke.mjs
```

Then `curl -s https://writer.hyperflip.xyz/limits | jq` again and compare with
step 2. Released exposure is the point of the change; if the number does not move
and step 2 found Void tickets, something is wrong — do not call it done.

**8. If a poke reverts `NOT_OPEN`,** that is the designed no-op: `resolve` in
`writer/src/index.ts` calls `writeContract` without a pre-simulate, so gas
estimation reverts and nothing is broadcast when the taker already reclaimed.
Taker-first, keeper-as-fallback is intended. A `poke-failed` line for that reason
is not a failure; anything else is.

## Rollback

`git revert daf0eeb`, repackage, re-deploy, restart the writer. The change is
additive — reverting returns to Dead-only poking and strands Void escrow again,
which is the old behaviour, not a new failure.

## Out of scope

- Hosted subgraph deployment. It needs a Goldsky project that supports chain 998
  and its exact network slug, plus billing confirmation — all yours to do first.
  The local `local` network manifest is deliberately not deployable. Ask me before
  any account, billing or deploy action.
- Section 5 of the plan (retiring the writer's `/parlays` taker index). That waits
  on subgraph parity.
- Any web/Vercel deploy. `NEXT_PUBLIC_POSITIONS_SOURCE` stays unset, so the app
  keeps using the writer-backed path.
- Mainnet, including read-only probes.
