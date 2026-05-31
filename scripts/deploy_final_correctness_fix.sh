#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="/opt/trading-terminal"
BACKEND="$APP_ROOT/backend"
STAMP="$(date +%Y%m%d_%H%M%S)"
cd "$APP_ROOT"
mkdir -p "$APP_ROOT/backups/final_fix_$STAMP"
cp -f backend/app/autotrade/engine.py "$APP_ROOT/backups/final_fix_$STAMP/engine.py.bak"
cp -f backend/app/services/alpaca_service.py "$APP_ROOT/backups/final_fix_$STAMP/alpaca_service.py.bak"
cp -f backend/app/main.py "$APP_ROOT/backups/final_fix_$STAMP/main.py.bak"
cp -f final_fix_pack/backend/app/autotrade/engine.py backend/app/autotrade/engine.py
cp -f final_fix_pack/backend/app/services/alpaca_service.py backend/app/services/alpaca_service.py
cp -f final_fix_pack/backend/app/main.py backend/app/main.py
cd "$BACKEND"
if [ -d .venv ]; then source .venv/bin/activate; elif [ -d venv ]; then source venv/bin/activate; fi
python -m py_compile app/autotrade/engine.py app/services/alpaca_service.py app/main.py
systemctl restart trading-backend.service
systemctl status trading-backend.service --no-pager
