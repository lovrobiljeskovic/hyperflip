# S8a: v2 on the laptop

**September 17/18 server handover:** A/B, relay, and the S2b observer now run
under systemd on the authorized server. Keep laptop makers stopped while server
makers run. Read [the server handoff](s8b-server.md) before using any restart
commands below. Original `.env.s8a*` and local state remain intact; these laptop
steps are retained for reference, not an instruction to run duplicate wallets.

**Resuming the September 16 session?** Read [the handoff](s8a-handoff.md)
first. Deployment, maker approvals, and the first mint are already complete;
do not repeat the deployment steps. G1 settlement evidence is still pending.

Run these steps in order from `/Users/lovrobiljeskovic/hype-evm`. This runs a relay,
two makers, and the web app locally, against **HyperEVM testnet, chain 998**.
Deploying, approving, and minting still send real testnet transactions.
Existing OutcomeVaults and their existing keeper supply settlement; no new keeper
or market rotation is needed for this step. Do not run the box deployment steps.

Source: [session tracker, S8a and next prompt](/Users/lovrobiljeskovic/docs/superpowers/plans/2026-09-16-bedlam-sessions.md:52),
with the [Plan 1B hand-off](/Users/lovrobiljeskovic/docs/superpowers/plans/2026-09-16-multi-maker-1b-offchain.md:261).
G1 requires a live round trip with two competing house keys, including the Dead
path returning funds to the winning maker. Minting alone does not complete S8a.

1. **Verify the checkout.** Use the repo's Node version and installed Foundry.
   If dependencies are missing, install the locked versions first.

   ```bash
   cd /Users/lovrobiljeskovic/hype-evm
   nvm use
   # Only if dependencies are missing:
   # git submodule update --init --recursive
   # for project in keeper writer web; do npm ci --prefix "$project"; done
   bash scripts/verify.sh
   ```

   Stop on a failing gate. Do not regenerate ABIs just to silence drift without
   reviewing the change.

2. **Prepare the identities and funds.** You need a deployer with testnet HYPE;
   two distinct maker bankroll wallets with testnet USDC and HYPE; and a separate
   browser/taker wallet with USDC and HYPE. Funds must be on EVM, not only Core.
   For the existing 400 USDC, use these starting balances:

   | Wallet | Testnet USDC | Testnet HYPE gas budget |
   | --- | ---: | ---: |
   | Existing wallet / reserve | 360 | — |
   | Deployer (separate wallet) | 0 | 0.10 |
   | Maker A (bankroll + signer + poker) | 10 | 0.02 |
   | Maker B (bankroll + signer + poker) | 10 | 0.02 |
   | Browser / taker | 20 | 0.02 |
   | Total | 400 | 0.16 |

   Transfer 10 USDC to each maker and 20 USDC to the taker; leave 360 USDC in
   the existing wallet. Use only funds available for this test, not collateral
   needed by existing v1 tickets. The deployer does not need USDC to deploy.
   HYPE figures are starting budgets, not exact predicted fees; check the deploy
   simulation before broadcasting. HYPE is needed in addition to the 400 USDC.
   Start at 1 USDC per ticket, with two reasonably balanced outcomes. The maker
   caps and approvals below are deliberately 10 USDC; long-odds tickets or
   several outstanding tickets can exhaust that room. Reuse the reserve as needed.

   For this laptop test each maker can use its own bankroll key as both quote
   signer and poker. The template assumes this, so `maker:signer` uses the same
   address twice. You can instead use separate signing/poker keys: update the
   signer addresses in `MAKERS`, and fund each poker address with gas.

   Create three ignored env files without overwriting existing files:

   ```bash
   umask 077
   for file in .env.s8a .env.s8a-maker-a .env.s8a-maker-b; do
     if [ ! -e "$file" ]; then touch "$file"; fi
     chmod 600 "$file"
   done
   git check-ignore .env.s8a .env.s8a-maker-a .env.s8a-maker-b
   ```

   The three files have been prepared for this laptop session, including a random
   shared token. Fill in the three address placeholders in `.env.s8a` and each
   maker key in its maker file; keep the generated token. The blocks below remain
   templates for recreating the files. If recreating, replace the shared-token
   placeholder with a long random token, e.g. from your password manager.
   Use one RPC URL here because the `cast` commands expect a single endpoint.

   ```bash
   TESTNET_RPC=https://rpc.hyperliquid-testnet.xyz/evm
   WRITER_RPC=https://hyperliquid-testnet.drpc.org
   INFO_API_URL=https://api.hyperliquid-testnet.xyz/info
   DEPLOYMENT_FILE=/Users/lovrobiljeskovic/hype-evm/registry/deployment.testnet-v2.json
   S8A_STATE="$HOME/.local/state/hype-s8a"
   MARKETS_FILE="$S8A_STATE/markets.json"
   DEPLOYER_ADDRESS=0xREPLACE
   MAKER_A_ADDRESS=0xREPLACE
   MAKER_B_ADDRESS=0xREPLACE
   MAKERS="$MAKER_A_ADDRESS:$MAKER_A_ADDRESS,$MAKER_B_ADDRESS:$MAKER_B_ADDRESS"
   MAKER_TOKEN=REPLACE_WITH_RANDOM_SECRET
   INVITE_CODES=S8A-LAPTOP
   CORS_ORIGINS=http://localhost:3000
   WRITER_PORT=8787
   RELAY_MAKERS="$MAKER_A_ADDRESS=http://127.0.0.1:8791,$MAKER_B_ADDRESS=http://127.0.0.1:8792"
   RFQ_WINDOW_MS=1500
   RFQ_MIN_TTL_MS=8000
   QUOTE_TTL_MS=15000
   MIN_PREMIUM_BPS=100
   MIN_LEGS=2
   MAX_STAKE=1000000
   PER_MARKET_CAP=10000000
   PER_CLUSTER_CAP=20000000
   PER_CODE_RESERVED_CAP=20000000
   LEG_EDGE_BPS=300
   MIN_BOOK_DEPTH=50
   LOCKOUT_MS=600000
   SPOT_PX_STALE_MS=60000
   POKER_INTERVAL_MS=15000
   LOW_BANKROLL=2
   RFQ_JOURNAL_FILE="$S8A_STATE/rfq.jsonl"
   WAITLIST_FILE="$S8A_STATE/waitlist.json"
   # Empty exported values prevent root .env settings leaking into this run.
   PARLAY_VAULT_ADDRESS=
   PARLAY_DEPLOY_BLOCK=
   EVM_CHAIN_ID=
   PARLAY_INDEX_FROM_BLOCK=
   PRICING_MODE=independent
   RESEND_API_KEY=
   ```

   Edit `.env.s8a-maker-a`:

   ```bash
   WRITER_ADDRESS="$MAKER_A_ADDRESS"
   QUOTE_SIGNER_PRIVATE_KEY=0xREPLACE_WITH_MAKER_A_KEY
   POKER_PRIVATE_KEY="$QUOTE_SIGNER_PRIVATE_KEY"
   MAKER_PORT=8791
   EDGE_BPS=500
   QUOTE_JOURNAL_FILE="$S8A_STATE/maker-a-quotes.jsonl"
   PARLAY_INDEX_FILE="$S8A_STATE/maker-a-parlays.json"
   ```

   Edit `.env.s8a-maker-b`:

   ```bash
   WRITER_ADDRESS="$MAKER_B_ADDRESS"
   QUOTE_SIGNER_PRIVATE_KEY=0xREPLACE_WITH_MAKER_B_KEY
   POKER_PRIVATE_KEY="$QUOTE_SIGNER_PRIVATE_KEY"
   MAKER_PORT=8792
   EDGE_BPS=700
   QUOTE_JOURNAL_FILE="$S8A_STATE/maker-b-quotes.jsonl"
   PARLAY_INDEX_FILE="$S8A_STATE/maker-b-parlays.json"
   ```

   Keep actual keys out of command history and the frontend. Do not enable shell
   tracing (`set -x`). Services always load the root `.env`, but exported values
   above take precedence. A `writer/.env` or `--env-file` is not needed.

3. **Load the common config and prepare a market snapshot.** Use this terminal
   for deployment, approvals, and checks. These files are outside Git.

   ```bash
   set -a
   source .env.s8a
   set +a
   mkdir -p "$S8A_STATE"
   chmod 700 "$S8A_STATE"
   if [ ! -e "$MARKETS_FILE" ]; then
     cp -f registry/markets.json "$MARKETS_FILE"
   fi
   cast chain-id --rpc-url "$TESTNET_RPC"
   cast balance "$DEPLOYER_ADDRESS" --rpc-url "$TESTNET_RPC"
   ```

   Chain ID must be `998`. If the local registry is stale, fetch the current
   public board into the laptop snapshot. This only reads the existing service:

   ```bash
   curl --fail --silent --show-error https://writer.hyperflip.xyz/markets \
     --output "$S8A_STATE/markets.download.json"
   node -e 'const fs=require("node:fs"); const p=process.env.S8A_STATE+"/markets.download.json"; const r=JSON.parse(fs.readFileSync(p)); if(!Array.isArray(r.markets)||r.markets.length<2) throw Error("Need at least two markets");'
   # Only after the validation succeeds:
   cp -f "$S8A_STATE/markets.download.json" "$MARKETS_FILE"
   ```

   Relay and makers read this snapshot at startup. After any later refresh,
   restart all three processes. Leave the existing box keeper running; laptop
   processes do not settle the underlying OutcomeVaults themselves.

4. **Deploy v2.** Read the quote token from the existing deployment instead of
   typing a potentially wrong token address. Preview, then broadcast once.
   The simulation needs no private key. The broadcast's `--interactive` prompts
   privately for the deployer key.

   ```bash
   V1_VAULT=$(node -p 'require("./registry/deployment.testnet.json").parlayVault')
   export QUOTE_TOKEN_ADDRESS=$(cast call "$V1_VAULT" 'usdc()(address)' --rpc-url "$TESTNET_RPC")
   cast call "$QUOTE_TOKEN_ADDRESS" 'decimals()(uint8)' --rpc-url "$TESTNET_RPC"

   forge script script/DeployParlay.s.sol:DeployParlay \
     --rpc-url "$TESTNET_RPC" --sender "$DEPLOYER_ADDRESS" \
     --no-isolate --block-gas-limit 30000000
   ```

   HyperEVM small blocks have a 3M gas limit; this deployment exceeds it.
   Foundry 1.8's isolated execution on a small-block fork still capped CREATE at
   3M with a block-limit override alone. The two flags above passed the testnet
   simulation together with gas-limit checks enabled. No `forge clean` is
   required to fix that OutOfGas error. Verification output (2026-09-16):

   ```text
   Script ran successfully.
   Estimated total gas used for script: 6472326
   SIMULATION COMPLETE.
   ```

   Before broadcasting, enable the deployer's big-block mode using the existing
   helper. The root `.env`'s `PRIVATE_KEY` must match `DEPLOYER_ADDRESS`; this
   helper signs a testnet account-setting change. It affects all transactions
   from that wallet while enabled, including any v1 use of the same wallet.
   Coordinate with other activity using the deployer before running it.
   The deployer must already have a Core account (the existing deployer does).

   ```bash
   uv run --env-file .env tools/bigblocks.py on
   ```

   Require a successful response. After reviewing the successful simulation,
   with token decimals confirmed as 6, broadcast once:

   ```bash
   forge script script/DeployParlay.s.sol:DeployParlay \
     --rpc-url "$TESTNET_RPC" --sender "$DEPLOYER_ADDRESS" \
     --no-isolate --block-gas-limit 30000000 \
     --interactive --broadcast --slow --timeout 180
   ```

   Big blocks are approximately one minute apart; the three transactions can
   take several minutes with `--slow`. Once all receipts have succeeded, restore
   the usual small-block mode before normal wallet activity:

   ```bash
   uv run --env-file .env tools/bigblocks.py off
   ```

   Require a successful response. If broadcast times out or partially fails,
   inspect receipts and pending transactions before retrying or changing modes.
   Reference: [Hyperliquid dual-block documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture).

   Require successful receipts for the deployment and both `setMaker` calls.
   Every fresh script broadcast creates another vault; do not rerun it as a
   health check. The script comment mentioning `parlayVaultV2` is stale: the
   actual loader expects `parlayVault` in a separate v2 manifest.

5. **Create and check the public v2 manifest.** Set `DEPLOY_TX` to the contract
   creation transaction hash, not either maker-registration transaction.

   ```bash
   DEPLOY_TX=0xREPLACE_WITH_CREATION_TX_HASH
   cast receipt "$DEPLOY_TX" --rpc-url "$TESTNET_RPC" --json \
     > "$S8A_STATE/deploy-receipt.json"
   node --input-type=module <<'NODE'
   import { readFileSync, writeFileSync } from 'node:fs';
   import assert from 'node:assert/strict';
   const r = JSON.parse(readFileSync(`${process.env.S8A_STATE}/deploy-receipt.json`, 'utf8'));
   assert.equal(BigInt(r.status), 1n, 'Deployment reverted');
   assert.match(r.contractAddress, /^0x[0-9a-fA-F]{40}$/);
   assert.notEqual(BigInt(r.contractAddress), 0n);
   assert(BigInt(r.blockNumber) > 0n);
   const manifest = { schemaVersion: 1, network: 'testnet', evmChainId: 998,
     parlayVault: r.contractAddress, parlayDeployBlock: BigInt(r.blockNumber).toString() };
   writeFileSync(process.env.DEPLOYMENT_FILE, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
   console.log(manifest);
   NODE

   V2_VAULT=$(node -p 'require(process.env.DEPLOYMENT_FILE).parlayVault')
   cast call "$V2_VAULT" 'owner()(address)' --rpc-url "$TESTNET_RPC"
   cast call "$V2_VAULT" 'usdc()(address)' --rpc-url "$TESTNET_RPC"
   cast call "$V2_VAULT" 'minPremiumBps()(uint16)' --rpc-url "$TESTNET_RPC"
   cast call "$V2_VAULT" 'signerOf(address)(address)' "$MAKER_A_ADDRESS" --rpc-url "$TESTNET_RPC"
   cast call "$V2_VAULT" 'signerOf(address)(address)' "$MAKER_B_ADDRESS" --rpc-url "$TESTNET_RPC"
   ```

   Expected: your deployer, the quote token, `100`, and the two configured signer
   addresses. The file creation refuses to overwrite an existing manifest.
   Service startup also verifies code at the current, creation, and preceding
   blocks; the selected RPC must support that history. During this S8a run,
   the official RPC and Chainlink returned vault code even before its creation
   block. dRPC correctly returned empty code before creation and deployed code
   afterward, so the local `WRITER_RPC` selects dRPC for both makers and relay.
   If changing RPCs, rerun that history check; do not alter the creation block
   or bypass verification to accommodate an endpoint serving incorrect history.

   Commit only the public manifest after these checks. The command scopes the
   commit so unrelated staged work is excluded; review that one file first.

   ```bash
   git add -- registry/deployment.testnet-v2.json
   git diff --cached -- registry/deployment.testnet-v2.json
   git commit --only -m "chore(testnet): register v2 vault" -- registry/deployment.testnet-v2.json
   ```

   Keep the v1 manifest unchanged. `node scripts/deployment.mjs` copies only the
   default manifest; it does not install the alternate v2 file. Local Next.js
   reads the absolute `DEPLOYMENT_FILE` directly.

6. **Approve each maker's bankroll.** Enter the corresponding bankroll key at
   each private prompt. These approvals authorize only the new v2 address.

   ```bash
   cast call "$QUOTE_TOKEN_ADDRESS" 'balanceOf(address)(uint256)' "$MAKER_A_ADDRESS" --rpc-url "$TESTNET_RPC"
   cast call "$QUOTE_TOKEN_ADDRESS" 'balanceOf(address)(uint256)' "$MAKER_B_ADDRESS" --rpc-url "$TESTNET_RPC"

   cast send "$QUOTE_TOKEN_ADDRESS" 'approve(address,uint256)' "$V2_VAULT" 10000000 \
     --from "$MAKER_A_ADDRESS" --rpc-url "$TESTNET_RPC" --interactive
   cast send "$QUOTE_TOKEN_ADDRESS" 'approve(address,uint256)' "$V2_VAULT" 10000000 \
     --from "$MAKER_B_ADDRESS" --rpc-url "$TESTNET_RPC" --interactive

   cast call "$QUOTE_TOKEN_ADDRESS" 'allowance(address,address)(uint256)' "$MAKER_A_ADDRESS" "$V2_VAULT" --rpc-url "$TESTNET_RPC"
   cast call "$QUOTE_TOKEN_ADDRESS" 'allowance(address,address)(uint256)' "$MAKER_B_ADDRESS" "$V2_VAULT" --rpc-url "$TESTNET_RPC"
   ```

   Both allowances should be `10000000` (10 USDC). Minting consumes allowance;
   returned escrow does not restore it. Reapprove when needed during testing.

7. **Start maker A in a new terminal.**

   ```bash
   cd /Users/lovrobiljeskovic/hype-evm
   set -a
   source .env.s8a
   source .env.s8a-maker-a
   set +a
   npm start --prefix writer
   ```

8. **Start maker B in another terminal.**

   ```bash
   cd /Users/lovrobiljeskovic/hype-evm
   set -a
   source .env.s8a
   source .env.s8a-maker-b
   set +a
   npm start --prefix writer
   ```

9. **Start the relay in another terminal.**

   ```bash
   cd /Users/lovrobiljeskovic/hype-evm
   set -a
   source .env.s8a
   set +a
   npm run start:relay --prefix writer
   ```

   In your original control terminal, check both makers, not just top-level `ok`:

   ```bash
   curl --fail --silent --show-error http://localhost:8787/health
   curl --fail --silent --show-error http://localhost:8787/limits
   lsof -nP -iTCP:8791 -iTCP:8792 -sTCP:LISTEN
   node --input-type=module <<'NODE'
   import assert from 'node:assert/strict';
   const h = await fetch('http://localhost:8787/health').then(r => r.json());
   assert(h.ok && h.makers.length === 2 && h.makers.every(m => m.ok && m.seeded));
   console.log('PASS: both makers ready');
   NODE
   ```

   Wait for exposure seeding before retrying that assertion. Maker listeners must
   show `127.0.0.1`, and `/limits` must report `makers: 2`. The relay currently binds
   all interfaces; keep this laptop test on a trusted network. `bankroll: null`
   before the first quote is normal.

10. **Start the frontend in a clean fourth terminal.** Do not source the maker
    env files here. Empty legacy overrides neutralize old `web/.env.local`
    values; the Next config then embeds the selected manifest's identity.
    Keep the configured Privy app ID in `web/.env.local`. Unset any shell
    override so Next.js can load that ID; an empty ID disables wallet connection.

    ```bash
    cd /Users/lovrobiljeskovic/hype-evm
    unset NEXT_PUBLIC_PRIVY_APP_ID
    DEPLOYMENT_FILE="$PWD/registry/deployment.testnet-v2.json" \
    NEXT_PUBLIC_PARLAY_VAULT="" NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK="" NEXT_PUBLIC_CHAIN_ID="" \
    NEXT_PUBLIC_WRITER_URL=http://localhost:8787 \
    NEXT_PUBLIC_RPC_URL=https://rpc.hyperliquid-testnet.xyz/evm \
    NEXT_PUBLIC_INFO_API=https://api.hyperliquid-testnet.xyz/info \
    npm run dev --prefix web -- --hostname localhost --port 3000
    ```

    Open `http://localhost:3000/build`. The configured Privy app must allow
    `http://localhost:3000`. Without a Privy ID the app can render and read chain
    state, but Connect Wallet does nothing. Keep the explicit port: CORS allows
    port 3000. Restart the dev server after changing these environment settings.

    The browser uses the public testnet RPC for current contract reads and mint
    timestamps. Keep the private backend `WRITER_RPC` out of `NEXT_PUBLIC_*`:
    those values are embedded in browser JavaScript. The public endpoint does
    not pass the backend deployment-history guard; it is not a backend substitute.

11. **Quote and mint through the browser.** Connect the funded taker wallet on
    chain 998, enter invite code `S8A-LAPTOP`, select two live outcomes from
    different games/questions, and enter a 1 USDC stake. Confirm token approval
    and mint. Check that the wallet transaction targets `V2_VAULT` and succeeds.
    Open `/positions`; the minted ticket should appear after the polling interval.

    In the control terminal, inspect the RFQ evidence and ticket count:

    ```bash
    tail -n 1 "$S8A_STATE/rfq.jsonl"
    cast call "$V2_VAULT" 'nextId()(uint256)' --rpc-url "$TESTNET_RPC"
    # For the first mint on this fresh vault:
    cast call "$V2_VAULT" 'ownerOf(uint256)(address)' 1 --rpc-url "$TESTNET_RPC"
    cast call "$V2_VAULT" 'parlay(uint256)(((address,bool)[],address,uint96,uint96,uint8))' 1 --rpc-url "$TESTNET_RPC"
    ```

    Require two valid responses (`won` and `lost`), a selected winner with the
    highest `maxPayout`, the taker as NFT owner, and that maker in the stored
    parlay's `writer` field. Equal payouts use the relay's address tie-break.
    A's lower edge normally makes it win when both have identical prices and
    sufficient capacity. The stored status for a new unresolved ticket is `0`.

    Optional existing quote smoke, using your browser wallet's public address:

    ```bash
    WRITER_URL=http://localhost:8787 INVITE_CODE=S8A-LAPTOP TAKER=0xREPLACE_WITH_TAKER \
      node tools/smoke.mjs
    ```

    This reserves quote capacity but does not mint. Its current market selection
    requires non-0.5 `allMids` prices, so it can fail on otherwise usable house
    prior markets. Record that failure separately; the browser mint and RFQ
    journal verify the actual v2 path.

12. **G1: observe the complete round trip.** The tracker requires all of these:

    - `/health` reports two healthy makers; wait for both to be seeded.
    - The browser's `/quote` response reports `makers.quoted == 2`.
      Retain that response and its matching RFQ journal record.
    - The successful mint escrows `premium` from the taker and
      `maxPayout - premium` from the winning maker. Verify the quote-token
      `Transfer` logs in the mint receipt, not just the stored maker address.
    - Only the winning maker's poker tracks that ticket's exposure and resolution.
      On this fresh deployment, its `openParlays` increases after polling while
      the losing maker's does not. The losing maker must not log a
      `poking-dead-parlay` for that ticket. Both taker indexes may display it;
      indexing all makers' tickets is intentional.
    - Once a selected leg settles against the ticket, the winning maker's poker
      resolves it to Dead (`status == 2`). Verify `ParlayResolved` and the
      quote-token transfer of the full `maxPayout` from the v2 vault to
      `parlay(id).writer == q.maker` in the resolution receipt.

    Use a near-term event so the Dead-path observation is practical. This needs
    a real losing leg; if the ticket wins or voids, another ticket is needed for
    the Dead-path evidence. Keep the existing keeper running and laptop makers
    polling. Do not mark G1 passed while waiting for this settlement.

    Read-only evidence commands in the control terminal:

    ```bash
    MINT_TX=0xREPLACE_WITH_MINT_TX_HASH
    TICKET_ID=1
    cast receipt "$MINT_TX" --rpc-url "$TESTNET_RPC" --json
    curl --fail --silent --show-error http://localhost:8787/health
    # After the maker logs successful resolution, use its on-chain tx hash:
    RESOLVE_TX=0xREPLACE_WITH_RESOLUTION_TX_HASH
    cast receipt "$RESOLVE_TX" --rpc-url "$TESTNET_RPC" --json
    cast call "$V2_VAULT" 'parlay(uint256)(((address,bool)[],address,uint96,uint96,uint8))' "$TICKET_ID" --rpc-url "$TESTNET_RPC"
    ```

    Record the v2 address/block, source revision, quote/RFQ evidence, mint and
    resolution hashes, and per-maker observations. Keep private env/state out of
    Git. These are the observations needed before recording S8a DONE and S8b NEXT.

13. **Additional laptop checks: failover and restart recovery.**

    - Stop maker A with Ctrl-C. Request a fresh quote, mint another small ticket,
      and verify B is the maker. The relay should continue serving via B.
    - Restart A with step 7. After its health is seeded, stop B and repeat via A.
      Restore B afterward. Refill balances/approvals if required.
    - Restart each maker one at a time, then the relay, keeping all state files.
      Require both seeded again and both makers' tickets visible in `/positions`.
    - Check `/health` and logs for healthy polling and no recurring errors.
      An `at-capacity` response can be outstanding reservations or consumed
      allowance; stop automatic browser requoting while allowing reservations
      to expire, then inspect balance and allowance.
    - Record the v2 address/block, source revision, successful mint hashes, maker
      identities, and restart/failover results. Keep private env/state out of Git.

    Winning claims and void refunds are useful further tests; G1 specifically
    requires the Dead-path observation above. Stop local processes with Ctrl-C;
    preserve their state for the next session. S8b and S8c remain separate steps.
