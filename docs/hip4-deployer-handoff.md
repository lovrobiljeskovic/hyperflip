# Handoff: house HIP-4 deployer (venue `flip`)

Branch `hip-4-deployment`. State as of 2026-09-15. Read `DEPLOY.md` "House HIP-4 markets"
for the runbook and `tools/house-lib.mjs` for the slot rule.

## Done

- `tools/hip4.py`: signs and posts any HyperCore exchange action with `PRIVATE_KEY`.
  Verified live with a no-op `evmUserModify`.
- `tools/house-markets.mjs sync` (+ `house-lib.mjs`, tests): settle finals from ESPN,
  register `sportsContestWinner7` outcomes, wrap them in OutcomeVaults via the rotate deploy
  path, refresh `priorYes`. Runs first in hourly `rotate.service`. Dry run against live data
  picks 10 Week 2 games.
- Writer prices a leg from registry `priorYes` when the Core book is empty, pre-kickoff only
  (`source: "prior"`). Web `marketMid` falls back to it.
- Slot rule: 10 active outcomes on testnet. A game needs `HOUSE_MIN_WINDOW_HOURS` (18) before
  kickoff; balanced games win contested slots. Expect ~12 of 16 Week 2 games; CLE@TB, NO@BAL,
  MIA@SF and one -300 game are dropped on purpose.

## Live since 2026-09-15

- Venue `flip` activated, box EOA granted both sub-deployer variants (`outcomeMeta.deployers`
  lists them as `[variant, [user]]` pairs). Box EOA registers as `unifiedAccount` without issue.
- First laptop smoke registered + wrapped CAR@ATL (outcome 19463, vault `0x4c021a…676f`);
  its registry entry was hand-inserted into `/opt/hype/registry/markets.json` before the box
  ran, since the box registry is authoritative and a missing entry re-wraps the outcome.
- Box `rotate.service` filled all 10 slots (outcomes 19463-19472), writer serves them with
  `priorYes`. ESPN's default scoreboard reported week 1 on Tuesday; `house-markets.mjs` now
  advances to the next week once every game on the default board has kicked off.
- Local writer cannot boot on the laptop: the deployment RPC history check needs an archive
  endpoint (public RPCs ignore block tags). Verify quotes against the live writer instead.

## Next steps, in order

1. Live quote verified 2026-09-15: CAR YES + JAX YES priced 0.5635 / 0.4486 (exact registry
   priors), joint 0.2528, 500 bps edge.
2. After DET@BUF (Thu 2026-09-18 00:15 UTC) goes final: confirm settle in `journalctl -u rotate`,
   keeper relays status 2, vault `settled`, next run registers the 11th game.

## Open decisions

- In-play house legs are unquotable by design (prior frozen at kickoff). Grace window is a
  one-line change if wanted.
- ESPN feeds are public and unkeyed but unofficial. Manual settle fallback is one `hip4.py`
  call per game. Slashing only after a week unsettled.
- Other sports: college football fits with a second `LEAGUE` constant. European soccer needs
  the 3-way `sportsContestResult5` question (4 slots per game). MLB and NHL have no ESPN odds.
