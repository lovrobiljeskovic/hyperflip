# Key custody and vault hardening

Written September 19, 2026. Testnet only, including every probe. Season 1 of
trading is planned on testnet, so the goal is a system where no single online
machine can move the bankroll or decide an outcome.

## Why

A read-only review of the live deployment found the trust model collapsed into
one key. On ParlayVault `0x407cdc0b15e8d81f4d122481ecf92dbe07dc0169`:

```
owner       = 0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D
writer      = 0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D
quoteSigner = 0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D
minPremiumBps = 100
allowance(writer -> vault) = unbounded, balance 1012.97 USDC
```

Deriving addresses from the repository `.env` (addresses only, never the keys):
`PRIVATE_KEY` and `QUOTE_SIGNER_PRIVATE_KEY` are the same key, and it is all
three roles above. `KEEPER_PRIVATE_KEY` and `POKER_PRIVATE_KEY` are also one key
(`0x51Ae82D30646b1d8aC782C9E02AB06ca8a436eD1`). The signer key is deployed to
`/opt/hype/.env` on the Hetzner box, so root there is owner, bankroll and signer
at once. The deploy note claiming the shipped `.env` "drops `PRIVATE_KEY`, which
neither service needs" is misleading: identical key material ships under the
other name.

Three consequences, each independently sufficient to lose the bankroll:

1. Box compromise moves the USDC directly, or calls `setQuoteSigner` /
   `setWriter` to lock the owner out. There is no pause switch by design
   (`ParlayVault.sol:17`); pausing means revoking the writer allowance, which
   needs the key that was just stolen.
2. A signer-only compromise is equally total, because `mint` deliberately does
   not validate leg vaults (`ParlayVault.sol:148`). An attacker signs a quote
   whose legs are their own contracts returning `settled() == true` and
   `settleFractionWad() == 1e18`, pays the `minPremiumBps` floor of 1%, and
   claims the full `maxPayout`. Repeatable until the bankroll is empty.
3. `OutcomeVault.settle` lets the keeper supply the settlement fraction itself
   once Core has pruned the market (`OutcomeVault.sol:269`), and `keeper` is
   `immutable` (`OutcomeVault.sol:59`). A leaked keeper key decides outcomes on
   every existing vault permanently; `setVerifier` only swaps the split/merge
   verifier, and `KeeperVerifier`'s 10-minute delay does not cover this path.

Two facts shape the fix. Neither contract has `setOwner` or
`transferOwnership`, so rotating an owner requires a redeploy. And the writer
service never signs with the bankroll key — `writer/src/index.ts:110` only reads
its allowance and balance — so the bank key can go fully cold today, with no
contract change at all.

## Phase 1 — key surgery, no redeploy

**Executed 2026-09-20** with one deviation: the float is bounded by the bank wallet's
*balance*, not its allowance. The bank (`0x3325…C5A7`, ParlayVault `writer`) holds 250 USDC
with an unbounded approval; a separate cold reserve (`0x520d…37F2`) holds the remaining
~763 USDC. Same blast radius, but escrow returned on resolution replenishes a balance
where an allowance only counts down. Signer `0x2B24…91EC`, `minPremiumBps` 500, verified
by a live mint (parlay 29). Two steps the list below omits: `WRITER_ADDRESS` in the box
`.env` must change with `setWriter` (the writer reads it from env, not chain), and
`setMinPremiumBps` needs a writer restart (read at boot only). Full record in the vault
note `Operations/Key Custody.md`.

Most of the risk reduction, using only owner transactions. Every key action is
the owner's to perform; secrets never enter chat or the repository.

1. Generate three keys, all distinct from `0x171070FE…`: **signer** (box, holds
   nothing, no admin), **deploy/rotation** (box, HYPE gas only, no USDC —
   `tools/rotate-markets.mjs:13` needs it hourly), **bank** (cold, never on the
   box, holds the USDC).
2. Fund the bank, then approve a bounded float to the ParlayVault instead of
   today's unbounded allowance. Suggested start: 250 of the 1013 USDC, with a
   documented refill step. The float is the cap on a total compromise.
3. Owner transactions from the laptop: `setWriter(bank)`,
   `setQuoteSigner(signer)`, and `setMinPremiumBps` above 100. The writer's own
   `edgeBps` is 500, so a 1% floor sits far below real pricing and hands a rogue
   mint 99% for 1%.
4. Rewrite `/opt/hype/.env` to hold only the signer, keeper/poker and deploy
   keys. The old key leaves the box and becomes an offline owner-only key. Keep
   it: parlays minted before the switch snapshot the old writer address for
   refunds (`ParlayVault.sol:47`), so it must stay recoverable, though it needs
   no balance.
5. Restart the writer, then smoke and a real mint walkthrough. A signer
   mismatch does not fail at quote time — it fails at `mint` with `BAD_SIG`, so
   quoting can look healthy while every mint reverts.

Constraint found while planning: the box must keep an admin-capable key. The
box's `PRIVATE_KEY` is the HIP-4 venue deployer — `tools/hip4.py:19` signs Core
`outcomeDeploy` actions for venue `flip` with it, and Core ties the venue to that
address — and hourly rotation also deploys OutcomeVaults with it. It is the same
key as the ParlayVault owner, and ParlayVault has no `setOwner`, so the owner role
cannot leave the box until Phase 2 ships a v2 (and, separately, until a Core venue
key can be split from it).

That is a smaller loss than it sounds. With the bank cold and the allowance
bounded, the worst an attacker with box root can do is `setQuoteSigner` to a key
they hold and mint rogue tickets — capped by the float. `setWriter` does not help
them: it only changes which address escrow is pulled *from*. So the float is the
blast radius either way, which is why Phase 1 is still worth doing before the
redeploys.

Gates: `/limits` shows the new bounded bankroll; one live mint succeeds; the box
`.env` no longer contains the bank-controlling allowance (the bank key itself was
never there); `journalctl -u writer` clean.

Result: box compromise costs the float and the ability to quote — not the
bankroll, and not the contract's ownership.

## Phase 2 — ParlayVault v2, leg allow-list

Contract: add a `legRegistrar` role that can only add allowed leg vaults, a
`mapping(address => bool) allowedLeg`, the `require` in `mint`, and the missing
`setOwner`. Change nothing else, to keep the writer, web and subgraph diffs
small.

The registrar split is the point: rotation deploys vaults hourly and must
register them, so that key is necessarily online, but its worst case is "adds a
vault", not "moves money". Honest limit: an attacker holding both box keys
(signer and registrar) can still mint a rogue ticket, so the allow-list narrows
a signer-only compromise and Phase 1's float caps the remainder.

Migration — decided 2026-09-20: **retire v1 rather than carry it.** The earlier
plan kept both vaults indexed so pre-migration wallets kept their history; at
current volume (low usage, 8.23 USDC of open house risk) that history is not
worth the work. So `registry/deployment.testnet.json` and
`NEXT_PUBLIC_PARLAY_VAULT` point at v2 only, and the subgraph repoints instead of
gaining a data source: change `address` and `startBlock` in `subgraph.yaml`,
regenerate `subgraph/src/deployment.ts`, redeploy, reindex. The schema already
keys `Deployment` by `chainId:vault`, so adding v1 back as a second source later
costs the same as doing it now — which is the argument for not doing it now.
Rotation must register each vault it deploys.

No cutover event is needed, and there is no reason to wait for open tickets to
drain. `resolveParlay` is permissionless (`ParlayVault.sol:184`), so anyone can
crank v1's open tickets indefinitely, and each parlay snapshots its own escrow
return address (`ParlayVault.sol:47-49`), so neither Phase 1's `setWriter` nor the
v2 cutover can misdirect a refund. Escrow is pulled at mint, so claims pay from
v1's own balance and revoking the writer allowance stops new mints without
touching existing tickets. Two things do not survive the repoint: the writer's
poker is configured for one vault, so nothing pokes v1's Dead parlays afterwards
— replace it with a one-off loop calling `resolveParlay(id)` over the open ids —
and holders of won v1 tickets lose the UI path to `claim`, though not the tickets
themselves.

Standing cost introduced by Phase 1: the bank key is cold and the allowance is
bounded per spender, so every ParlayVault redeploy from here on needs a fresh
`approve` from the cold key — a ceremony rather than a script. Budget it into this
phase and every later vault version.

Gates: Forge tests for the new `require` and the registrar role; the parity
script re-run against v2; a mint walkthrough on v2; the subgraph reindexed and
`/positions` correct for a v2 mint; v1's open tickets cranked to resolution with
the one-off loop.

## Phase 3 — OutcomeVault v2, rotatable settle authority

Contract: `immutable keeper` becomes `address public keeper` with an owner-only
`setKeeper`, or `settle`'s pruned branch routes through the same verifier
indirection split/merge already uses. Add an `owner` constructor parameter so a
vault's owner is not merely whatever key deployed it, plus `setOwner`.

No migration event is needed: `rotate-markets.mjs` already deploys fresh vaults
every hour for new fixtures, so merging this ships the new code with new markets
while old vaults drain as their games settle. `settle`'s signature is unchanged,
so the keeper serves both generations, and the registry keeps both.

Because it propagates slowly, merge this earliest of the two contract phases.
`new-design` touches `OutcomeVault.sol` by 18 lines and they are almost entirely
docstring, so this phase and the Bedlam branch barely collide.

Gates: Forge tests for rotation of the settle authority and for the old path
staying closed on live markets; a rotation dry run; the keeper attesting and
relaying against both vault generations; `bash scripts/verify.sh`.

## Order

Phase 1 now. Phase 3 merged next, so every hourly rotation starts shipping it.
Phase 2 last of the three, and **before season 1 opens** — season 1 should run on
one ParlayVault from start to finish, which matters most when something goes wrong
and the logs have to be read against a single address. Its allow-list should cover
both OutcomeVault generations.

Two ParlayVault v2s exist, on purpose. This plan's v2 (`legRegistrar`,
`allowedLeg`, the `require` in `mint`, `setOwner`) lands on `main`. The Bedlam
multi-maker branch `new-design` separately rewrites 83 lines of `ParlayVault.sol`
— `Quote` gains `address maker`, a maker registry, replay key
`keccak256(maker, quoteId)`, EIP-712 domain bumped to `("ParlayVault", "2")`.
Decided 2026-09-20: ship this plan's v2 standalone now, and let Bedlam rebase onto
it and deploy a third version when that roadmap resumes. Testnet redeploys are
cheap, and the two change sets compose — nothing here touches the `Quote` struct,
so there is no typehash conflict. Bedlam's version should land after season 1, or
in a break with no open tickets, never mid-season.

## Separate, already shipped

Two smaller findings from the same review were fixed immediately, independent of
the phases above: the rate limiter read the leftmost `X-Forwarded-For` entry,
which the client controls behind an appending proxy, and `/health` published the
full per-market exposure book publicly.

## Out of scope

Mainnet, including read-only probes. Retiring the writer's `/parlays` index
(§5 of the positions-index plan). Any change to the quote pricing model.

## Phase 4 — pre-mainnet: collateral vault with on-chain caps

Not scheduled, and explicitly not to be worked while the no-mainnet rule stands.
Recorded here because Phase 1's float is a testnet control that does not survive
real volume, and the reasons are structural rather than a matter of sizing.

An ERC-20 allowance is a cumulative budget, not an exposure limit. Each mint
consumes `maxPayout - premium` of it (`ParlayVault.sol:172`) and resolution never
restores it — a Dead ticket returns USDC to the bank while the allowance stays
spent. So the float meters lifetime volume. Against today's 8.23 USDC of open
house risk that is invisible, but at a few hundred tickets a day it forces either
constant re-approval from the cold key or a float so large it is no longer a loss
cap.

The hot signing key is the other half. Quotes are signed in milliseconds, so a
hot key cannot be avoided; what a stolen one can do therefore has to be bounded
by the contract, not by the service. The target shape is a house collateral vault
that holds the bankroll and enforces on-chain what `writer/src/exposure.ts`
currently enforces in memory: maximum open exposure, per-market and per-cluster
caps, escrow pulled per time window, and a guardian pause. A compromised signer
then costs one window's limit, and `ParlayVault.sol:17`'s "there is no pause
switch" stops being true.

That also removes a scaling constraint worth stating plainly: `ExposureBook`
lives in one process and is rebuilt by `Poker.seed()` at boot, so two writer
instances would each believe they own the full caps and jointly oversubscribe the
bankroll. Redundant quoting needs either shared exposure state or leader
election — or caps on chain, which makes the contract the source of truth and
multiple instances safe by construction. Phase 2's leg allow-list is a down
payment on the same idea.

Two further mainnet blockers, listed so they are not rediscovered late. Full
`maxPayout` escrow per ticket means locked capital equals the sum of all open max
payouts; that is the beta's only user-checkable solvency guarantee and it is
honest, but it is capital-expensive, and netting correlated legs or pooling LP
capital is a product decision rather than a bug. And settlement still rests on a
single keeper-attested fraction with `keeper` immutable per vault: Phase 3 makes
the authority rotatable, while mainnet wants the spec's §7 precompile path or
several attesters with a threshold.

This section replaces no invariant on its own. `docs/mainnet-hardening-facts.md`
records the allowance as the hard solvency ceiling, which is accurate today; a
Phase 4 design has to supersede it deliberately, with its own review.
