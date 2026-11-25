"""Read-only, opt-in 1m/5m/15m Fibonacci higher-low sweep alerts.

For every timeframe the Higher Low must be confirmed by the chart engine.
A completed 1m candle can give an early sweep warning against an already
confirmed 5m or 15m HL, before the larger candle closes. Separately, each
completed timeframe candle can confirm an immediate or <=4-bar reclaim.
No automated trading or order-placement imports.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx
import requests

from app.backtests.fib_liquidity_sweep_backtest import (
    detect_fib_hl_reclaims,
    get_app_confirmed_hls,
)
from app.services.ai_pattern_engine import closed_bars
from app.services.alpaca_market_service import AlpacaMarketService
from app.services.daily_watchlist_store import DailyWatchlistStore
from app.workers.fvg_sweep_alert_worker import _load_seen, _save_seen

log = logging.getLogger("fib-hl-sweep-alert")
ET = ZoneInfo("America/New_York")
STATE_FILE = (
    Path(__file__).resolve().parents[1]
    / "data" / "app_state" / "fib_hl_sweep_alerts.json"
)
SYM_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
MINUTE_MS = 60_000
TIMEFRAMES = (1, 5, 15)
# Last processed candle signature and its confirmed chart HLs (per timeframe).
_POINTS_CACHE: Dict[tuple, tuple] = {}


def symbols_to_monitor() -> List[str]:
    """Independent Fib-HL symbol settings, plus today's existing watchlist."""
    supplied = os.getenv("TT_FIB_HL_SYMBOLS", "").split(",")
    if os.getenv("TT_FIB_HL_USE_WATCHLIST", "1") != "0":
        today = datetime.now(ET).date().isoformat()
        watchlist = DailyWatchlistStore().load(today) or {}
        manual = watchlist.get("manual") or {}
        supplied.extend(manual.get("symbols") or [])
        supplied.extend(watchlist.get("scannerSymbols") or [])
    limit = max(1, min(30, int(os.getenv("TT_FIB_HL_MAX_SYMBOLS", "10"))))
    return list(dict.fromkeys(
        symbol for item in supplied
        if (symbol := str(item).strip().upper()) and SYM_RE.fullmatch(symbol)
    ))[:limit]


def normalize_bars(bars: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Use 15m/5m/1m Alpaca BAR-START timestamps (epoch milliseconds)."""
    rows = []
    for bar in bars:
        ts = int(bar["time"])
        dt = datetime.fromtimestamp(ts / 1000, ET)
        rows.append({
            "ts": ts,
            "dt_et": dt.isoformat(),
            "trade_date": dt.date().isoformat(),
            "open": float(bar["open"]),
            "high": float(bar["high"]),
            "low": float(bar["low"]),
            "close": float(bar["close"]),
            "volume": float(bar.get("volume") or 0),
        })
    return [row for _, row in sorted({row["ts"]: row for row in rows}.items())]


def _chart_hls(symbol: str, timeframe: int, rows: List[Dict[str, Any]]):
    """Memoize same completed-bar window; indexes belong to that exact window."""
    signature = (
        int(rows[0]["ts"]), int(rows[-1]["ts"]), len(rows),
        float(rows[-1]["high"]), float(rows[-1]["low"]), float(rows[-1]["close"]),
    )
    key = (symbol, timeframe)
    cached = _POINTS_CACHE.get(key)
    if cached is not None and cached[0] == signature:
        return cached[1]
    points = get_app_confirmed_hls(rows)
    _POINTS_CACHE[key] = (signature, points)
    return points


def _preferred_sweeps(events: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """One event for each sweep candle, using the highest confirmed HL."""
    chosen: Dict[str, Dict[str, Any]] = {}
    for event in events:
        if event.get("level_type") != "APP_CONFIRMED_HL":
            continue
        sweep_time = str(event["sweep_time"])
        prior = chosen.get(sweep_time)
        if prior is None or float(event["reference_low"]) > float(prior["reference_low"]):
            chosen[sweep_time] = event
    return chosen


def _events(rows, points, timeframe):
    return _preferred_sweeps(detect_fib_hl_reclaims(
        rows, app_hls=points, candle_ms=timeframe * MINUTE_MS,
    ))


def _fresh(candle_iso: str, minutes: int, now_ms: int, max_age_ms: int) -> bool:
    start = int(datetime.fromisoformat(candle_iso).timestamp() * 1000)
    # The timestamp refers to bar START, so wait for the candle to close.
    age = now_ms - (start + minutes * MINUTE_MS)
    return 0 <= age <= max_age_ms


def _sweep_event(symbol, timeframe, event, *, early):
    time_label = f"{timeframe}m"
    return {
        "key": f"{symbol}:{time_label}:{event['sweep_time']}:SWEEP",
        "symbol": symbol,
        "stage": "SWEEP",
        "timeframe": time_label,
        "message": (
            f"{symbol} {time_label} FIB HL SWEEP WATCH" + (" (early 1m warning)" if early else "") + ". "
            f"Wick broke a chart-confirmed HL ${float(event['reference_low']):.4f} "
            f"at Fib {100 * float(event['reference_fib_fraction']):.1f}%. "
            f"Observed low ${float(event['sweep_low']):.4f}. "
            f"{time_label} reclaim NOT yet confirmed by this alert. "
            "Setup watch only; no order or exit instruction."
        ),
    }


def observed_closed_sweep_alerts(
    symbol: str,
    rows: List[Dict[str, Any]],
    now_ms: int,
    timeframe_minutes: int = 1,
    points: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, str]]:
    """Alert on a just-completed TF candle whose low swept an existing HL."""
    if timeframe_minutes not in TIMEFRAMES or len(rows) < 55:
        return []
    latest = rows[-1]
    if not _fresh(latest["dt_et"], timeframe_minutes, now_ms,
                  max_age_ms=max(2 * MINUTE_MS, timeframe_minutes * MINUTE_MS)):
        return []
    if points is None:
        points = get_app_confirmed_hls(rows)
    event = _events(rows, points, timeframe_minutes).get(latest["dt_et"])
    return [_sweep_event(symbol, timeframe_minutes, event, early=False)] if event else []


def observed_sweep_alerts(
    symbol: str,
    completed_tf: List[Dict[str, Any]],
    closed_1m: List[Dict[str, Any]],
    now_ms: int,
    points: Optional[List[Dict[str, Any]]] = None,
    timeframe_minutes: int = 15,
) -> List[Dict[str, str]]:
    """Early 1m wick warning against confirmed 5m/15m Fibonacci-zone HL.

    Compute all structure and impulse anchors using only completed higher-TF
    candles *prior* to the current partial timeframe candle. Appending the
    partial candle is for SWEEP detection only, never reclaim confirmation.
    """
    if timeframe_minutes not in (5, 15) or len(completed_tf) < 54 or not closed_1m:
        return []
    one = sorted(closed_1m, key=lambda bar: int(bar["time"]))
    latest_minute_start = int(one[-1]["time"])
    age_ms = now_ms - (latest_minute_start + MINUTE_MS)
    if not 0 <= age_ms <= 2 * MINUTE_MS:
        return []

    candle_ms = timeframe_minutes * MINUTE_MS
    sweep_start = (latest_minute_start // candle_ms) * candle_ms
    base = completed_tf
    last_start = int(base[-1]["ts"])
    if last_start == sweep_start:
        # At the last minute of a 5m/15m candle, both feeds may contain it.
        # The swept candle must NOT confirm its own Higher Low first.
        base = base[:-1]
        points = None
    elif last_start != sweep_start - candle_ms:
        return []
    if len(base) < 54 or int(base[-1]["ts"]) + candle_ms != sweep_start:
        return []

    minute_slice = [bar for bar in one
                    if sweep_start <= int(bar["time"]) < sweep_start + candle_ms]
    if not minute_slice:
        return []
    start_dt = datetime.fromtimestamp(sweep_start / 1000, ET)
    partial = {
        "ts": sweep_start,
        "dt_et": start_dt.isoformat(),
        "trade_date": start_dt.date().isoformat(),
        "open": float(minute_slice[0]["open"]),
        "high": max(float(bar["high"]) for bar in minute_slice),
        "low": min(float(bar["low"]) for bar in minute_slice),
        "close": float(minute_slice[-1]["close"]),
        "volume": sum(float(bar.get("volume") or 0) for bar in minute_slice),
    }
    if points is None:
        points = get_app_confirmed_hls(base)
    event = _events(base + [partial], points, timeframe_minutes).get(partial["dt_et"])
    return [_sweep_event(symbol, timeframe_minutes, event, early=True)] if event else []


def observed_alerts(
    symbol: str,
    rows: List[Dict[str, Any]],
    now_ms: int,
    points: Optional[List[Dict[str, Any]]] = None,
    timeframe_minutes: int = 15,
) -> List[Dict[str, str]]:
    """Confirm an immediate/<=4-bar reclaim only AFTER its candle closes."""
    if timeframe_minutes not in TIMEFRAMES or len(rows) < 55:
        return []
    if points is None:
        points = get_app_confirmed_hls(rows)
    selected = _events(rows, points, timeframe_minutes)
    alerts: List[Dict[str, str]] = []
    for event in selected.values():
        if event.get("status") not in ("IMMEDIATE_RECLAIM", "DELAYED_RECLAIM"):
            continue
        signal_time = event.get("signal_time")
        if not signal_time or not _fresh(
            signal_time, timeframe_minutes, now_ms,
            max_age_ms=max(2 * MINUTE_MS, timeframe_minutes * MINUTE_MS),
        ):
            continue
        stage = "IMMEDIATE" if event["status"] == "IMMEDIATE_RECLAIM" else "DELAYED"
        alerts.append({
            # Preserve the old 15m reclaim key for backwards compatibility.
            "key": f"{symbol}:{timeframe_minutes}m:{event['sweep_time']}",
            "symbol": symbol,
            "stage": stage,
            "timeframe": f"{timeframe_minutes}m",
            "message": (
                f"{symbol} {timeframe_minutes}m FIB HL {stage} RECLAIM CONFIRMED. "
                f"Chart-confirmed HL ${float(event['reference_low']):.4f}; "
                f"Fib {100 * float(event['reference_fib_fraction']):.1f}%; "
                f"sweep low ${float(event['sweep_low']):.4f}; "
                f"reclaimed after {int(event['bars_to_reclaim'])} bars. "
                "Setup only; you decide entries and exits."
            ),
        })
    return alerts


def send_pushover(event: Dict[str, str]) -> None:
    """Send a Pushover notification, never an execution order."""
    user = os.getenv("PUSHOVER_USER_KEY", "").strip()
    token = os.getenv("PUSHOVER_APP_TOKEN", "").strip()
    if not user or not token:
        raise RuntimeError("Pushover is not configured")
    response = requests.post(
        "https://api.pushover.net/1/messages.json",
        data={
            "user": user,
            "token": token,
            "title": f"{event['symbol']} | {event['timeframe']} Fib HL {event['stage']}",
            "message": event["message"],
            "priority": 0,
            "url": os.getenv(
                "TT_FIB_HL_CHART_URL",
                os.getenv("TT_FVG_SWEEP_CHART_URL", "https://165.22.145.148/chart"),
            ),
            "url_title": "Open Trading Terminal chart",
        },
        timeout=12,
    )
    response.raise_for_status()
    if response.json().get("status") != 1:
        raise RuntimeError("Pushover declined the notification")


async def tick(
    seen: Dict[str, int], *, initial: bool, path: Path, sender=send_pushover
) -> None:
    """Scan all 3 TFs; early 5/15m sweeps use completed 1m candles."""
    symbols = symbols_to_monitor()
    if not symbols:
        log.info("No configured symbols or watchlist symbols to scan")
        return
    now_ms = int(time.time() * 1000)
    limits = httpx.Limits(max_keepalive_connections=4, max_connections=6)
    timeout = httpx.Timeout(connect=10, read=35, write=20, pool=15)
    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        service = AlpacaMarketService()
        service._client = lambda _timeout: client
        for symbol in symbols:
            try:
                raw = await asyncio.gather(
                    service.get_bars(symbol, "1m", "extended", lookback="2d", limit=500),
                    service.get_bars(symbol, "5m", "extended", lookback="5d", limit=500),
                    service.get_bars(symbol, "15m", "extended", lookback="7d", limit=500),
                )
                closed = {tf: closed_bars(bars, tf, now_ms=now_ms)
                          for tf, bars in zip(TIMEFRAMES, raw)}
                rows = {tf: normalize_bars(closed[tf]) for tf in TIMEFRAMES}
                points = {}
                for tf in TIMEFRAMES:
                    if len(rows[tf]) >= 55:
                        points[tf] = await asyncio.to_thread(
                            _chart_hls, symbol, tf, rows[tf]
                        )

                events: List[Dict[str, str]] = []
                # Early, before a 5m or 15m candle finishes, triggered by 1m wicks.
                for tf in (15, 5):
                    if tf in points:
                        events += await asyncio.to_thread(
                            observed_sweep_alerts, symbol, rows[tf], closed[1],
                            now_ms, points[tf], tf,
                        )
                # A completed TF candle also catches a sweep if 1m data arrived late.
                for tf in TIMEFRAMES:
                    if tf in points:
                        events += await asyncio.to_thread(
                            observed_closed_sweep_alerts, symbol, rows[tf], now_ms,
                            tf, points[tf],
                        )
                for tf in TIMEFRAMES:
                    if tf in points:
                        events += await asyncio.to_thread(
                            observed_alerts, symbol, rows[tf], now_ms,
                            points[tf], tf,
                        )
                for event in events:
                    if event["key"] in seen:
                        continue
                    if not initial:
                        await asyncio.to_thread(sender, event)
                        log.info("Alert sent %s %s %s", symbol, event["timeframe"], event["stage"])
                    seen[event["key"]] = now_ms  # on send success, or startup priming
                _save_seen(path, seen)
            except Exception as exc:
                log.warning("Fib HL scan failed %s: %s", symbol, str(exc)[:220])


async def run() -> None:
    if os.getenv("TT_FIB_HL_ALERTS_ENABLED", "0") != "1":
        raise SystemExit("Fib HL alerts disabled until enabled after validation")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    seen = _load_seen(STATE_FILE)
    initial = seen is None
    if seen is None:
        seen = {}
    log.info("Starting read-only 1m/5m/15m Fib HL alerts (initial=%s)", initial)
    while True:
        await tick(seen, initial=initial, path=STATE_FILE)
        initial = False
        await asyncio.sleep(
            max(30, min(300, int(os.getenv("TT_FIB_HL_POLL_SECONDS", "60"))))
        )


if __name__ == "__main__":
    asyncio.run(run())
