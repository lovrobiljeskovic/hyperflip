#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
forge fmt --check
forge build --sizes
node scripts/abis.mjs --check
node scripts/check-service-packages.mjs
forge test
for project in keeper writer; do
  (cd "$project" && npm run check)
done
(
  cd web
  # Build with fixture endpoints, independent of local app configuration.
  export NEXT_TELEMETRY_DISABLED=1
  export NEXT_PUBLIC_WRITER_URL=http://127.0.0.1:1
  export NEXT_PUBLIC_INFO_API=http://127.0.0.1:1
  export NEXT_PUBLIC_RPC_URL=http://127.0.0.1:1
  export NEXT_PUBLIC_PRIVY_APP_ID=""
  export NEXT_PUBLIC_PARLAY_VAULT=0x1111111111111111111111111111111111111111
  export NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK=1
  npm run check
)
node --test scripts/abis.test.mjs tools/rotate-lib.test.mjs tools/rotate-markets.test.mjs tools/verify.test.mjs
