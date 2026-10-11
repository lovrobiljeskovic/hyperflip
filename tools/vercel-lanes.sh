#!/usr/bin/env bash
# Configure and deploy one web lane on Vercel. Usage: tools/vercel-lanes.sh hyperevm|elysium
#   hyperevm = project `overround`         (app.hyperflip.xyz, the default, 998, subgraph positions)
#   elysium  = project `overround-elysium` (elysium.hyperflip.xyz, 99801, legacy positions)
# Both deploy from web/; VERCEL_PROJECT_ID selects the project so web/.vercel stays linked to `overround`.
# Secrets are never written here: `overround` keeps POSITIONS_SUBGRAPH_URL, POSITIONS_RPC_URL and
# NEXT_PUBLIC_PRIVY_APP_ID from before the cutover; `overround-elysium` gets ELYSIUM_RPC and
# NEXT_PUBLIC_PRIVY_APP_ID piped in once (see DEPLOY.md "Two lanes").
set -uo pipefail
cd "$(dirname "$0")/../web"
SCOPE=lovrobiljeskovics-projects
LANE=${1:?usage: vercel-lanes.sh hyperevm|elysium}
case $LANE in
  hyperevm) PROJECT=overround ;;
  elysium) PROJECT=overround-elysium ;;
  *) echo "unknown lane $LANE"; exit 1 ;;
esac
export VERCEL_ORG_ID=team_VCeCEs2us2sNaddFZgTQydrR
VERCEL_PROJECT_ID=$(vercel project inspect "$PROJECT" --scope $SCOPE 2>&1 | awk '$1 == "ID" { print $2 }')
export VERCEL_PROJECT_ID
[ -n "$VERCEL_PROJECT_ID" ] || { echo "project $PROJECT not found; create it: vercel project add $PROJECT --scope $SCOPE"; exit 1; }
echo "== $LANE -> $PROJECT ($VERCEL_PROJECT_ID)"
rm_var() { vercel env rm "$1" production --yes --scope $SCOPE 2>&1 | grep -v "^Vercel CLI\|not found" || true; }
set_var() { rm_var "$1"; vercel env add "$1" production --value "$2" --yes --scope $SCOPE 2>&1 | grep -v "^Vercel CLI"; }

# The manifest is the chain identity; the path is where Vercel builds the uploaded web/ directory.
set_var DEPLOYMENT_FILE "/vercel/path0/deployment/deployment.$LANE-testnet.json"
set_var NEXT_PUBLIC_INFO_API https://api.hyperliquid-testnet.xyz/info
if [ "$LANE" = hyperevm ]; then
  set_var APP_ORIGIN https://app.hyperflip.xyz
  set_var NEXT_PUBLIC_WRITER_URL https://writer.hyperflip.xyz
  set_var NEXT_PUBLIC_RPC_URL https://rpcs.chain.link/hyperevm/testnet
  set_var NEXT_PUBLIC_POSITIONS_SOURCE subgraph
  set_var NEXT_PUBLIC_ALT_LANE_URL https://elysium.hyperflip.xyz
  # 998 reads must never proxy to Elysium; the bridge step does not exist on 998.
  rm_var ELYSIUM_RPC
  rm_var NEXT_PUBLIC_CORE_RPC_URL
else
  set_var APP_ORIGIN https://elysium.hyperflip.xyz
  set_var NEXT_PUBLIC_WRITER_URL https://writer-elysium.hyperflip.xyz
  set_var NEXT_PUBLIC_RPC_URL https://testnet-rpc.elysium.kinetiq.xyz
  set_var NEXT_PUBLIC_POSITIONS_SOURCE legacy
  set_var NEXT_PUBLIC_CORE_RPC_URL https://rpcs.chain.link/hyperevm/testnet
  set_var NEXT_PUBLIC_ALT_LANE_URL https://app.hyperflip.xyz
fi
echo "== production env"
vercel env ls production --scope $SCOPE 2>&1 | grep -v "^Vercel CLI"
echo "== deploy"
vercel --prod --yes --scope $SCOPE
