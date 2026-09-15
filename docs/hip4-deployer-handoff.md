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

## Next steps, in order

1. User, from the staked wallet (abstraction `disabled` = standard, checked):
   activate venue `flip`, then grant the box EOA `0x171070fe2e9f5bb1738ecf6979c24057ebe1576d`
   as sub-deployer for `registerStandaloneOutcomeFromTemplate` and `settleOutcome`.
   Commands in `DEPLOY.md`. Verify with `outcomeMeta.deployers`.
   Caveat: the box EOA is the writer wallet and is `unifiedAccount`. Docs only require
   standard abstraction for the deployer itself. If the grant or first register rejects on
   it, switch the box EOA with `userSetAbstraction` `"disabled"`.
2. Laptop smoke: `HOUSE_WEEK=2 HOUSE_MAX_ACTIVE=1 node tools/house-markets.mjs sync`, confirm
   the outcome in `outcomeMeta` (venue `flip`), run again to wrap, check the registry entry
   has `deployer: "flip"` and `priorYes`.
3. Writer: restart, `POST /quote` with the house YES leg, expect 200 and journal
   `source: "prior"`.
4. Box: rsync repo (`DEPLOY.md`), `systemctl daemon-reload`, wait for the next `rotate.timer`
   tick, check `journalctl -u rotate`.
5. After DET@BUF (Thu 2026-09-18 00:15 UTC) goes final: confirm settle in the journal, keeper
   relays status 2, vault `settled`, next run registers the 11th game.

## Open decisions

- In-play house legs are unquotable by design (prior frozen at kickoff). Grace window is a
  one-line change if wanted.
- ESPN feeds are public and unkeyed but unofficial. Manual settle fallback is one `hip4.py`
  call per game. Slashing only after a week unsettled.
- Other sports: college football fits with a second `LEAGUE` constant. European soccer needs
  the 3-way `sportsContestResult5` question (4 slots per game). MLB and NHL have no ESPN odds.
