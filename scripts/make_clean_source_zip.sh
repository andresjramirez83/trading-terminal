#!/usr/bin/env bash
set -euo pipefail
SRC_DIR="${1:-/opt/trading-terminal}"
OUT="${2:-trading-terminal-clean.zip}"
cd "$SRC_DIR"
zip -r "$OUT" . \
  -x '*/.venv/*' '*/venv/*' '*/node_modules/*' '*/dist/*' '*/build/*' \
     '*/__pycache__/*' '*.pyc' '*.pyo' '.env' '*/.env' '*/.env.*' \
     '*/app/data/autotrade/*.sqlite3*' '*/app/data/**/*.sqlite*' '*/app/data/**/*.db*'
echo "Created $OUT"
