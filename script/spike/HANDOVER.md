# Spike handover — next session runs the testnet spike

State as of 2026-08-14. Goal of next session: execute the run order in
`script/spike/README.md` against Hyperliquid testnet and patch
`src/CoreConstants.sol` per findings.

## Already done

- `.env` at repo root exists (gitignored) with `TESTNET_RPC` and
  `PRIVATE_KEY`. Wallet is funded: HYPE on HyperEVM testnet (gas) and
  USDC on the EVM side. `source .env` before each forge command; never
  print the key.
- USDH is sunset — quote token is USDC. Testnet confirms: 339 of 343
  outcomes quote in USDC.

## Target market

Chosen: the daily recurring BTC price-bucket market.

- question id: **976**
- outcome id: **12385** ("above" bucket, index:2), Yes/No sides, USDC
- caveat: the user picked frontend slug `btc-above-63410-yes-aug-15-0300`,
  but on-chain meta shows thresholds 62045/64578 and expiry
  2026-08-15 06:00 UTC — the slug's threshold does not appear on chain.
  Frontend naming differs from chain meta; ids above are chain truth.

**Ids churn daily.** This market expires 2026-08-15 06:00 UTC and rolls
to a new period with new question/outcome ids. At spike start, refetch:

```bash
curl -s -X POST https://api.hyperliquid-testnet.xyz/info \
  -H 'Content-Type: application/json' -d '{"type":"outcomeMeta"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(q) for q in d['questions'] if 'priceBucket' in q['description'] and 'BTC' in q['description']]"
```

Take the current question id; the "above" outcome is the namedOutcome
whose description is `index:2`. Frontend does not expose ids — only this
API does.

Stable fallback market (won't settle mid-spike): question **978**
(sports final, resolution 2026-12-12), outcome **12482**, USDC.

## Run

Follow `script/spike/README.md` steps 1–8 in order. Each write step is
async on Core — wait a few seconds before its read-back. Kill-switch
step (stop and discuss, no patching): deposit ordering false (step 7).
The step-3 "outcome balances unreadable" kill-switch is obsolete since the
2026-08 testnet update (0x801 accepts the encoded outcome id).
