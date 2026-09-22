#!/usr/bin/env bash
# Point the Vercel production project at the Elysium deployment and deploy web/.
# Run from the repo root: bash tools/vercel-cutover.sh
set -uo pipefail
cd "$(dirname "$0")/../web"
SCOPE=lovrobiljeskovics-projects
rm_var() { vercel env rm "$1" production --yes --scope $SCOPE 2>&1 | grep -v "^Vercel CLI" || true; }
add_var() { vercel env add "$1" production --value "$2" --yes --scope $SCOPE 2>&1 | grep -v "^Vercel CLI"; }

# Legacy identity values from the 998 days; the manifest in web/deployment now owns identity.
for v in NEXT_PUBLIC_PARLAY_VAULT NEXT_PUBLIC_CHAIN_ID NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK NEXT_PUBLIC_RPC_URL \
         NEXT_PUBLIC_POSITIONS_SOURCE NEXT_PUBLIC_CORE_RPC_URL; do rm_var $v; done
add_var NEXT_PUBLIC_RPC_URL https://testnet-rpc.elysium.kinetiq.xyz
add_var NEXT_PUBLIC_POSITIONS_SOURCE legacy
add_var NEXT_PUBLIC_CORE_RPC_URL https://rpcs.chain.link/hyperevm/testnet

echo "== production env"
vercel env ls production --scope $SCOPE 2>&1 | grep -v "^Vercel CLI"
echo "== deploy"
vercel --prod --yes --scope $SCOPE
