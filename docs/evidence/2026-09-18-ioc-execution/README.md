# Approved testnet IOC execution — September 18, 2026

**PASS: full fill, partial fill, empty-book no fill, discarded-response recovery.**
User approved the [exact capped plan](../../superpowers/plans/2026-09-18-ioc-execution-test.md).
Signed steps ran 08:59:24–09:03:38 UTC; independent Core confirmation completed
09:07:11 UTC. This uses native HIP-4 shares and existing Core USDC, with no ERC-20
wrapping, EVM token mint, v2 parlay mint or new funding.

- Testnet outcome **19468 (SEA/ARI)**, YES asset **100194680**.
- HedgeProbe: `0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E`.
- Existing agent: `0x4328154291e79869Ba76017586533A6Bc50Cf273`.
- Owner/counterparty: `0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D`.
- Approved caps: probe principal 15 + 0.03 fee; counterparty split 15 + 0.03
  split fee + 0.02 seller fee. No additional funding or service changes.

| IOC case | Order ID | Actual result |
| --- | --- | --- |
| Full, request 10 @ 0.50 | 60421939998 | 10 YES; 5 USDC; fee 0 |
| Partial, request 10 @ 0.50 | 60422048731 | 5 YES; 2.5 USDC; fee 0; no resting remainder |
| Empty, request 10 @ 0.50 | 60422101087 | 0 fill/debit; explicit no-match; `iocCancelRejected` |

The partial order's API status is **`filled`**, with `origSz=10`, `sz=5`.
Actual fill records and the +5 balance delta establish quantity. Never treat the
status label as full execution. Empty-book submission has outer `status=ok`
but a per-order error; it is not a successful purchase.

The full-buy response was deliberately discarded after submission. The persisted
intent/client ID survived; a fresh process recovered the actual fill from status,
fills and balances. A second invocation was refused before key read/network use.
This is controlled response loss, not an actual service crash or every possible
transport failure. `run/full-buy-response.json` is intentionally absent.

Counterparty split 15 USDC into 15 YES + 15 NO with zero observed split fee.
Its two asks filled completely; seller fees were 0.004 + 0.002 = **0.006 USDC**.
Probe spent **7.50 USDC**, with zero observed buyer fee.

| Account | Final Core USDC | YES | NO | Open orders / holds |
| --- | --- | --- | --- | --- |
| HedgeProbe | 11.486 | 15 | 0 | None / zero |
| Counterparty | 13.48270019 | 0 | 15 | None / zero |

No cancellation was necessary. These positions remain for natural settlement
or a separately authorized unwind. No manual settlement was sent.

`run/` preserves public intents, responses, reconciliation snapshots and the
duplicate guard result from `/private/tmp/hype-ioc-20260918`; original state is
retained. `final-*.json` are later info API checks; `core-final.json` independently
confirms chain 998, owner, active outcome and both accounts through `0x801`/`0x814`.
No key, signature, private environment content or RPC URL is included.

Run from any directory:

```bash
python3 /Users/lovrobiljeskovic/hype-evm/docs/evidence/2026-09-18-ioc-execution/verify.py
```

`verification.txt` contains actual check output. `SHA256SUMS` hashes these records
and `runner.sha256` identifies the runner used. This proves the controlled
contract-agent path, not organic depth, in-play execution, deployed v2 integration,
production recovery, or safe on-chain margin relief. V1/v2 services and laptop
makers were not changed. Next discussion: live quoting, then margin accounting.
