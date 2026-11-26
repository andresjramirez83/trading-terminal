"""Pushover notifications for newly completed Momentum & Volume Runner scans.

No order execution. This module is invoked from the existing backend scanner loop,
not a separate service. Alert cooldown state is runtime data, not source control.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any

import requests

STATE_FILE = Path(__file__).resolve().parents[1] / "data" / "app_state" / "mvr_alert_state.json"
ENV_FILES = (
    Path("/opt/trading-terminal/backend/.env"),
    Path("/etc/trading-terminal/ai.env"),
    Path("/etc/trading-terminal/fvg-sweep-alerts.env"),
)
CHART_URL = "https://165.22.145.148/chart"


def _number(value: Any) -> float:
    try:
        value = float(value)
        return value if math.isfinite(value) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _setting(name: str) -> str:
    if os.getenv(name, "").strip():
        return os.environ[name].strip()
    for path in ENV_FILES:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            key, sep, value = line.removeprefix("export ").partition("=")
            if sep and key.strip() == name:
                return value.strip().strip('"').strip("'")
    return ""


def _load_state() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _kind(row: dict) -> tuple[str, int] | None:
    change = _number(row.get("change_5m_pct"))
    ratio = _number(row.get("relative_volume_5m"))
    price = _number(row.get("last_price"))
    resistance = _number(row.get("resistance_level"))
    if change >= 5 and ratio >= 2:
        return "BIG MOVE", 3
    if change >= 3 and ratio >= 1.6 and resistance > 0 and price > resistance:
        return "BREAKOUT", 2
    if change >= 2.5 and ratio >= 1.3:
        return "WAKING UP", 1
    return None


def dispatch_mvr_alerts(result: Any, *, now: float | None = None, post=None) -> dict:
    """Notify at most 2 fresh MVR signals per scan, with persisted cooldowns.

    `post` can be injected to test behavior without contacting Pushover.
    """
    if not isinstance(result, dict) or not isinstance(result.get("rows"), list):
        return {"sent": 0}

    rows = result["rows"]
    if not rows:
        return {"sent": 0}

    user = _setting("PUSHOVER_USER_KEY")
    token = _setting("PUSHOVER_APP_TOKEN")
    if not user or not token:
        return {"sent": 0, "warning": "Pushover credentials not available to backend"}

    now = time.time() if now is None else now
    state = _load_state()
    sent = 0
    # Caps alert noise across all symbols, as well as per-symbol cooldowns.
    recent_sent = [float(t) for t in state.get("_hourly", []) if 0 <= now - _number(t) < 3600]
    http_post = requests.post if post is None else post

    for row in sorted(
        (r for r in rows if isinstance(r, dict)),
        key=lambda r: _number(r.get("runner_score")),
        reverse=True,
    ):
        if sent >= 2 or len(recent_sent) >= 12:
            break

        symbol = str(row.get("symbol") or "").strip().upper()
        price = _number(row.get("last_price"))
        stamp = _number(row.get("signal_time"))
        stamp = stamp / 1000 if stamp > 1e11 else stamp
        if not symbol or not 0.5 <= price <= 20 or not 0 <= now - stamp <= 240:
            continue
        if _number(row.get("active_candles_5m")) < 4 or _number(row.get("dollar_volume_5m")) < 50000:
            continue

        classified = _kind(row)
        if classified is None:
            continue
        label, priority = classified
        previous = state.get(symbol, {})
        if isinstance(previous, dict):
            age = now - _number(previous.get("at"))
            old_priority = _number(previous.get("priority"))
            old_price = _number(previous.get("price"))
            if age < 1800:
                # An escalation is allowed only for a real additional 4% move
                # after at least 3 minutes; otherwise suppress duplicates.
                if not (age >= 180 and priority > old_priority and old_price > 0 and price >= old_price * 1.04):
                    continue

        ss = " SS" if row.get("short_squeeze_label") == "SS" else ""
        message = (
            f"{symbol} ${price:.4f} | 5m {_number(row.get('change_5m_pct')):+.1f}% | "
            f"Volume {_number(row.get('relative_volume_5m')):.1f}x | "
            f"${_number(row.get('dollar_volume_5m')):,.0f} in 5m | "
            f"{int(_number(row.get('active_candles_5m')))}/5 active candles | "
            f"Score {int(_number(row.get('runner_score')))}. "
            "Scanner alert only; no trade recommendation."
        )
        try:
            response = http_post(
                "https://api.pushover.net/1/messages.json",
                data={
                    "user": user,
                    "token": token,
                    "title": f"MVR {label}{ss} | {symbol}",
                    "message": message,
                    "priority": 0,
                    "url": CHART_URL,
                    "url_title": "Open trading chart",
                },
                timeout=12,
            )
            response.raise_for_status()
            if response.json().get("status") != 1:
                raise RuntimeError("Pushover declined notification")
        except Exception as exc:
            return {"sent": sent, "warning": f"MVR notification error: {exc}"}

        state[symbol] = {"at": now, "priority": priority, "price": price}
        recent_sent.append(now)
        state["_hourly"] = recent_sent
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
        sent += 1

    return {"sent": sent}
