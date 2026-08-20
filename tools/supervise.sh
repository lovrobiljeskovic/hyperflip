#!/usr/bin/env bash
# Restart policy for the keeper and writer.
#
# Both are long-lived services whose failure mode is silence: a keeper that is not running looks
# exactly like a keeper with nothing to do. That is what stranded the 8/19 vaults — it was never
# started, nobody noticed, and by the time anyone looked Core had pruned every outcome and the
# trustless settle path was gone for good.
#
# Restarting is only half of it. The keeper caches settlement fractions it observed pre-prune to
# keeper/settlement-cache.json, so the restart must keep that file — it survives here because
# this runs on a normal filesystem. Under Docker/Fly/Cloud Run, point SETTLEMENT_CACHE_PATH at a
# mounted volume or the cache dies with the container and the restart buys nothing.
#
# Usage:  tools/supervise.sh keeper
#         tools/supervise.sh writer
#
# For a real host, prefer the platform's own supervisor and skip this script. systemd equivalent:
#
#   [Service]
#   WorkingDirectory=/srv/hype-evm/keeper
#   ExecStart=/usr/bin/npm start
#   Restart=always
#   RestartSec=5
#   StandardOutput=append:/var/log/hype-keeper.log
#   StandardError=append:/var/log/hype-keeper.log
#
# pm2 equivalent: pm2 start npm --name hype-keeper -- start

set -uo pipefail  # deliberately NOT -e: a non-zero exit from the child is the case we handle
set -m            # job control: each child gets its own process group, so we can kill the tree

SERVICE="${1:-}"
if [[ "$SERVICE" != "keeper" && "$SERVICE" != "writer" ]]; then
  echo "usage: $0 <keeper|writer>" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/$SERVICE" || exit 66

# Back off on repeated fast failures so a crash-on-boot (bad config, unreachable RPC) does not
# spin at full speed, but recover the short delay once the process has proven it can stay up.
MIN_BACKOFF=2
MAX_BACKOFF=60
STABLE_AFTER=60 # seconds alive before a run counts as healthy
backoff=$MIN_BACKOFF

# npm spawns tsx which spawns node, so killing the child alone orphans the grandchildren and
# leaves the service holding its port. -m above puts each run in its own process group; the
# negative PID kills the whole group.
child=""
cleanup() {
  echo "[supervise] stopping $SERVICE"
  [[ -n "$child" ]] && kill -- "-$child" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

while true; do
  started=$(date +%s)
  echo "[supervise] starting $SERVICE at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  npm start &
  child=$!
  wait "$child"
  code=$?

  ran=$(( $(date +%s) - started ))
  if (( ran >= STABLE_AFTER )); then
    backoff=$MIN_BACKOFF # it was healthy; treat this as a fresh failure, not an escalating one
  fi

  echo "[supervise] $SERVICE exited code=$code after ${ran}s — restarting in ${backoff}s" >&2
  sleep "$backoff"

  backoff=$(( backoff * 2 ))
  (( backoff > MAX_BACKOFF )) && backoff=$MAX_BACKOFF
done
