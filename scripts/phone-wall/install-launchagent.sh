#!/bin/bash
set -euo pipefail
: "${1:?Usage: bash install-launchagent.sh /absolute/reviewed.plist}"
/usr/bin/plutil -lint "$1"
if /usr/bin/grep -Eq 'REPLACE_|/ABSOLUTE|EXISTING_DATABASE' "$1"; then
  echo 'Replace all deployment placeholders before installing.' >&2
  exit 1
fi
TARGET="$HOME/Library/LaunchAgents/org.museum.phonewall.plist"
if [ -e "$TARGET" ]; then
  echo 'LaunchAgent already exists; review it and unload it before replacing.' >&2
  exit 1
fi
mkdir -p "$HOME/Library/LaunchAgents"
umask 077
cp "$1" "$TARGET"
chmod 600 "$TARGET"
launchctl bootstrap "gui/$(id -u)" "$TARGET"
