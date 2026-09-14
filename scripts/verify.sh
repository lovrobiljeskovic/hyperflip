#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
forge fmt --check
forge build --sizes
forge test
for project in keeper writer web; do
  (cd "$project" && npm run check)
done
node --test tools/rotate-lib.test.mjs
