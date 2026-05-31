#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="${BACKEND_DIR:-/opt/trading-terminal/backend}"
FRONTEND_DIR="${FRONTEND_DIR:-/opt/trading-terminal/frontend}"
TS="$(date +%Y%m%d_%H%M%S)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

backup_install() {
  local src="$1"
  local dest="$2"
  if [ -f "$dest" ]; then
    cp "$dest" "$dest.bak_$TS"
  fi
  install -D -m 0644 "$src" "$dest"
}

echo "Deploying optimized backend files to $BACKEND_DIR"
backup_install "$ROOT_DIR/backend/app/autotrade/execution.py" "$BACKEND_DIR/app/autotrade/execution.py"
backup_install "$ROOT_DIR/backend/app/services/alpaca_service.py" "$BACKEND_DIR/app/services/alpaca_service.py"
backup_install "$ROOT_DIR/backend/app/services/polygon_service.py" "$BACKEND_DIR/app/services/polygon_service.py"
backup_install "$ROOT_DIR/backend/app/services/polygon_ws.py" "$BACKEND_DIR/app/services/polygon_ws.py"
backup_install "$ROOT_DIR/backend/app/main.py" "$BACKEND_DIR/app/main.py"

python3 -m py_compile \
  "$BACKEND_DIR/app/autotrade/execution.py" \
  "$BACKEND_DIR/app/services/alpaca_service.py" \
  "$BACKEND_DIR/app/services/polygon_service.py" \
  "$BACKEND_DIR/app/services/polygon_ws.py" \
  "$BACKEND_DIR/app/main.py"

systemctl restart trading-backend.service

if [ -d "$FRONTEND_DIR/src" ]; then
  echo "Deploying optimized frontend files to $FRONTEND_DIR"
  backup_install "$ROOT_DIR/frontend/src/services/api.ts" "$FRONTEND_DIR/src/services/api.ts"
  backup_install "$ROOT_DIR/frontend/src/components/ChartPanel.tsx" "$FRONTEND_DIR/src/components/ChartPanel.tsx"
  if [ -f "$FRONTEND_DIR/package.json" ]; then
    (cd "$FRONTEND_DIR" && npm run build)
  else
    echo "No package.json found in $FRONTEND_DIR; skipped frontend build."
  fi
else
  echo "Frontend dir not found at $FRONTEND_DIR; skipped frontend deploy."
fi

echo "Cleaning deploy/runtime noise from backend source tree"
find "$BACKEND_DIR/app" -type d -name __pycache__ -prune -exec rm -rf {} + || true

echo "Done. Test Hail Mary: time_in_force should be gtc and extended_hours true."
