# S8a laptop evidence — 2026-09-16

Status: **mint verified; G1 still pending Dead-path settlement**.
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
