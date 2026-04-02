#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_PATH="${1:-}"
OUTPUT_DIR="${2:-$ROOT_DIR/public/fonts/ticker-msdf}"
FONT_NAME="${3:-TickerMSDF}"
GENERATOR_BIN="${GENERATOR_BIN:-msdf-bmfont-xml}"

if [[ -z "$FONT_PATH" ]]; then
  echo "Usage: $0 /path/to/font.ttf [output-dir] [font-name]" >&2
  exit 1
fi

if [[ ! -f "$FONT_PATH" ]]; then
  echo "Font file not found: $FONT_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

CHARSET_FILE="$(mktemp)"
cleanup() {
  rm -f "$CHARSET_FILE"
}
trap cleanup EXIT

cat > "$CHARSET_FILE" <<'EOF'
 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸàâäçéèêëîïôöùûüÿÆŒæœ.,;:!?…()[]{}<>"'`“”‘’«»-–—_/\|@#&%$€£+*=^~°©®™✓•·
EOF

"$GENERATOR_BIN" \
  -f xml \
  -t msdf \
  -m 512,512 \
  -s 96 \
  -r 8 \
  --pot \
  --smart-size \
  -i "$CHARSET_FILE" \
  -o "$OUTPUT_DIR/$FONT_NAME.fnt" \
  "$FONT_PATH"

echo "Generated MSDF font assets in $OUTPUT_DIR"
