#!/usr/bin/env bash
# Configure and deploy one web lane on Vercel. Usage: tools/vercel-lanes.sh hyperevm|elysium
#   hyperevm = project `overround`         (app.hyperflip.xyz, the default, 998, subgraph positions)
#   elysium  = project `overround-elysium` (elysium.hyperflip.xyz, 99801, legacy positions)
# Both deploy from web/; the script links web/.vercel to the lane's project for the run and relinks to `overround`.
# Secrets are never written here: `overround` keeps POSITIONS_SUBGRAPH_URL, POSITIONS_RPC_URL and
# NEXT_PUBLIC_PRIVY_APP_ID from before the cutover; `overround-elysium` gets NEXT_PUBLIC_PRIVY_APP_ID
# piped in once (see DEPLOY.md "Two lanes"). Both lanes carry APP_RPC, the server-only comma-separated
# upstream list behind /api/rpc (keyed URLs first, public fallbacks after), set by hand:
#   vercel env add APP_RPC production --value '<keyed>,<public>,<public>' --scope lovrobiljeskovics-projects
# The lane must have it before this script deploys; the 998 list must hold 998 endpoints only.
set -uo pipefail
cd "$(dirname "$0")/../web"
SCOPE=lovrobiljeskovics-projects
LANE=${1:?usage: vercel-lanes.sh hyperevm|elysium}
case $LANE in
  hyperevm) PROJECT=overround ;;
  elysium) PROJECT=overround-elysium ;;
  *) echo "unknown lane $LANE"; exit 1 ;;
esac
# CLI 59 reads web/.vercel/project.json only (VERCEL_PROJECT_ID is not honoured by `env`), so link
# to the lane's project for the run and always relink to `overround`, the default lane, afterwards.
# Two lanes at once would relink under each other (2026-10-11: the 998 values landed on the Elysium
# project), so runs serialize on a lock and every write checks the link first.
unset VERCEL_ORG_ID VERCEL_PROJECT_ID
LOCK=.vercel-lanes.lock
until mkdir "$LOCK" 2>/dev/null; do echo "another lane run holds $PWD/$LOCK; waiting"; sleep 5; done
trap 'vercel link --project overround --yes --scope $SCOPE >/dev/null 2>&1; rmdir "$LOCK"' EXIT
vercel link --project "$PROJECT" --yes --scope $SCOPE 2>&1 | grep -v "^Vercel CLI" || { echo "project $PROJECT not found; create it: vercel project add $PROJECT --scope $SCOPE"; exit 1; }
echo "== $LANE -> $PROJECT"
linked() { grep -q "\"projectName\":\"$PROJECT\"" .vercel/project.json || { echo "link moved away from $PROJECT; aborting"; exit 1; }; }
rm_var() { linked; vercel env rm "$1" production --yes --scope $SCOPE 2>&1 | grep -v "^Vercel CLI\|not found" || true; }
set_var() { rm_var "$1"; linked; vercel env add "$1" production --value "$2" --yes --scope $SCOPE 2>&1 | grep -v "^Vercel CLI"; }

# The manifest is the chain identity; the path is where Vercel builds the uploaded web/ directory.
set_var DEPLOYMENT_FILE "/vercel/path0/deployment/deployment.$LANE-testnet.json"
set_var NEXT_PUBLIC_INFO_API https://api.hyperliquid-testnet.xyz/info
if [ "$LANE" = hyperevm ]; then
  set_var APP_ORIGIN https://app.hyperflip.xyz
  set_var NEXT_PUBLIC_WRITER_URL https://writer.hyperflip.xyz
  set_var NEXT_PUBLIC_RPC_URL https://rpcs.chain.link/hyperevm/testnet
  set_var NEXT_PUBLIC_POSITIONS_SOURCE subgraph
  set_var NEXT_PUBLIC_ALT_LANE_URL https://elysium.hyperflip.xyz
  # The bridge step does not exist on 998. ELYSIUM_RPC is the pre-2026-10-17 name of APP_RPC.
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
linked
ENV=$(vercel env ls production --scope $SCOPE 2>&1 | grep -v "^Vercel CLI")
echo "$ENV"
echo "$ENV" | grep -q "APP_RPC" || { echo "$PROJECT has no APP_RPC; add the lane's upstream list first (see header)"; exit 1; }
echo "== deploy"
linked
vercel --prod --yes --scope $SCOPE
