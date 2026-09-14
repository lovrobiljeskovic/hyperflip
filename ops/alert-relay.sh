#!/bin/sh
# Forward ALERT/FATAL journal lines from writer, keeper and rotate to Telegram.
# Runs from alert-relay.timer every 5 minutes as root. Needs /opt/hype/alert.env
# with TG_TOKEN (BotFather) and TG_CHAT (your chat id from getUpdates).
set -u
. /opt/hype/alert.env
: "${TG_TOKEN:?}" "${TG_CHAT:?}"

STAMP=/run/alert-relay.stamp
NOW=$(date +%s)
SINCE=$(cat "$STAMP" 2>/dev/null || echo $((NOW - 300)))

LINES=$(
  {
    journalctl -q -o cat --since="@$SINCE" --until="@$NOW" -u writer -u keeper | grep -E 'ALERT|FATAL|watchdog-stalled'
    journalctl -q -o cat --since="@$SINCE" --until="@$NOW" -u rotate -p err
  } | cut -c1-300 | head -8
)
echo "$NOW" > "$STAMP"
[ -z "$LINES" ] && exit 0

curl -s -o /dev/null --max-time 10 \
  -d "chat_id=$TG_CHAT" --data-urlencode "text=$(hostname): $LINES" \
  "https://api.telegram.org/bot$TG_TOKEN/sendMessage"
