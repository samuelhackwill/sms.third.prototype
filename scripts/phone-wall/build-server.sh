#!/bin/bash
set -euo pipefail
: "${NODE_BINARY:?Set Node 22.13+}"
: "${NPM_BINARY:?Set the matching npm binary}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/server/phone-wall"
export PATH="$(dirname "$NODE_BINARY"):$PATH"
"$NPM_BINARY" ci --omit=dev
"$NPM_BINARY" test
