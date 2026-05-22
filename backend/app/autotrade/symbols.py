from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from app.autotrade.models import AutoTradeConfig


def normalize_symbol_list(items: List[Any]) -> List[str]:
    seen = set()
    out: List[str] = []
    for item in items or []:
        symbol = "".join(ch for ch in str(item or "").upper().strip() if ch.isalpha() or ch == ".")
        if symbol and symbol not in seen:
            seen.add(symbol)
            out.append(symbol)
    return out


def app_state_file() -> Path:
    return Path(__file__).resolve().parents[1] / "data" / "app_state" / "alpaca_state.json"


def load_manual_symbols() -> List[str]:
    path = app_state_file()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    manual = data.get("manualWatchlist") if isinstance(data, dict) else []
    selected = data.get("selectedSymbol") if isinstance(data, dict) else None
    return normalize_symbol_list([*(manual or []), selected or ""])


def latest_scanner_cache_file() -> Path:
    return Path(__file__).resolve().parents[1] / "data" / "scanner_cache_latest.json"


def load_scanner_symbols() -> List[str]:
    # Professional worker is process-isolated, so it cannot read FastAPI memory.
    # This file is optional. If absent, scanner mode can be wired to a scanner cache writer later.
    path = latest_scanner_cache_file()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    rows = data.get("rows") if isinstance(data, dict) else []
    return normalize_symbol_list([row.get("symbol") for row in rows or [] if isinstance(row, dict)])


def resolve_symbols(config: AutoTradeConfig) -> List[str]:
    symbols: List[str] = []
    if config.source in {"manual", "both"}:
        symbols.extend(load_manual_symbols())
    if config.source in {"scanner", "both"}:
        symbols.extend(load_scanner_symbols())
    return normalize_symbol_list(symbols)[: max(1, int(config.max_symbols))]
