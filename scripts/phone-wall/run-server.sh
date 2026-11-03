#!/bin/bash
set -euo pipefail
: "${PHONE_WALL_ROOT:?Set absolute path to the repository}"
: "${PHONE_WALL_DATA_DIR:?Set absolute path for persistent SQLite and media}"
: "${PHONE_WALL_ADMIN_TOKEN:?Set operator token}"
: "${NODE_BINARY:?Set absolute path to Node 22.13+ (Node 24 LTS for deployment)}"
: "${PHONE_WALL_LOG_DIR:?Set absolute path for bounded server logs}"
export PORT="${PORT:-3000}"
SUPERVISOR="$(cd "$(dirname "$0")" && pwd)/supervise.mjs"
export PHONE_WALL_ENTRY="$PHONE_WALL_ROOT/server/phone-wall/index.mjs"
cd "$PHONE_WALL_ROOT/server/phone-wall"
exec "$NODE_BINARY" "$SUPERVISOR"
