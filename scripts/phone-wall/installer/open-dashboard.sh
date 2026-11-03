#!/bin/bash
set -euo pipefail
ROOT='/Library/Application Support/PhoneWall'
if [ ! -r "$ROOT/config.json" ] || [ ! -r "$ROOT/operator.key" ]; then
  /usr/bin/osascript -e 'display alert "Phone Wall" message "The controller is not installed, or this account cannot open its dashboard."'
  exit 1
fi
PORT="$(/usr/bin/plutil -extract port raw "$ROOT/config.json")"
for ATTEMPT in $(/usr/bin/seq 1 20); do
  if /usr/bin/curl --silent --fail --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null; then
    KEY="$(/usr/bin/tr -d '\r\n' < "$ROOT/operator.key")"
    /usr/bin/open "http://127.0.0.1:$PORT/admin/phone-wall#operatorKey=$KEY"
    exit 0
  fi
  /bin/sleep 1
done
/usr/bin/osascript -e 'display alert "Phone Wall" message "The controller is still starting or needs attention. Please try again shortly. The installation logs are in /Library/Logs/PhoneWall."'
exit 1
