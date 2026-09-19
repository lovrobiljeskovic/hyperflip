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

Gates: `/limits` shows the new bounded bankroll; one live mint succeeds; the box
`.env` no longer contains the owner key; `journalctl -u writer` clean.

Result: box compromise costs the float and the ability to quote, not the
bankroll and not the contract.

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

Migration, without a cutover event: the old vault stays live so its open tickets
resolve and claim there, and new mints go to v2. Most of the work is off-chain —
`registry/deployment.testnet.json` must carry both vaults,
`NEXT_PUBLIC_PARLAY_VAULT` moves to v2, and the subgraph needs a second data
source for v1 or wallets lose their history. The schema already keys
`Deployment` by `chainId:vault`, but `subgraph/src/deployment.ts` hardcodes one
deployment, so that is real work. Rotation must register each vault it deploys.

Gates: Forge tests for the new `require` and the registrar role; Matchstick
across two data sources; the parity script re-run against both vaults; a mint
walkthrough on v2; positions history for a pre-migration wallet still complete.

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

Gates: Forge tests for rotation of the settle authority and for the old path
staying closed on live markets; a rotation dry run; the keeper attesting and
relaying against both vault generations; `bash scripts/verify.sh`.

## Order

Phase 1 now. Phase 3 merged next, so every hourly rotation starts shipping it.
Phase 2 last, because it carries the largest off-chain change and its allow-list
should cover both OutcomeVault generations.

## Separate, already shipped

Two smaller findings from the same review were fixed immediately, independent of
the phases above: the rate limiter read the leftmost `X-Forwarded-For` entry,
which the client controls behind an appending proxy, and `/health` published the
full per-market exposure book publicly.

## Out of scope

Mainnet, including read-only probes. Retiring the writer's `/parlays` index
(§5 of the positions-index plan). Any change to the quote pricing model.
