from __future__ import annotations

import asyncio
import json
import math
import time
import os
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services.market_data_provider import get_market_data_provider

ET = ZoneInfo("America/New_York")
PT = ZoneInfo("America/Los_Angeles")

router = APIRouter(prefix="/trading-coach/vwap3", tags=["trading-coach"])

# Phase 7 performance caches. These are deliberately short-lived for current-day
# scanner data, while historical bars can be retained longer because completed
# sessions do not change. All caches are process-local and safe to discard on
# backend restart.
_SETUP_CACHE_TTL_SECONDS = 10.0
_STUDY_CACHE_TTL_SECONDS = 30.0
_CURRENT_DAY_BARS_TTL_SECONDS = 30.0
_HISTORICAL_BARS_TTL_SECONDS = 30.0 * 60.0
_REVIEW_CACHE_TTL_SECONDS = 5.0 * 60.0

_setup_rows_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_study_rows_cache: Dict[int, Tuple[float, List[Dict[str, Any]]]] = {}
_trade_bars_cache: Dict[Tuple[str, str, str], Tuple[float, List[Dict[str, Any]]]] = {}
_review_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def _cache_now() -> float:
    return time.monotonic()


def _copy_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [dict(row) for row in rows]


def _app_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def _setup_archive_dir() -> Path:
    raw = os.getenv("VWAP3_SETUP_ARCHIVE_DIR", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return _app_dir() / "data" / "scanner_history" / "vwap3_setups"


def _hit_archive_dir() -> Path:
    raw = os.getenv("VWAP3_TARGET_HIT_ARCHIVE_DIR", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return _app_dir() / "data" / "scanner_history" / "vwap3_target_hits"


def _state_path() -> Path:
    raw = os.getenv("VWAP3_SCANNER_STATE_PATH", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return _app_dir() / "data" / "scanner_state" / "vwap3_target.json"


def _safe_float(value: Any) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else 0.0
    except Exception:
        return 0.0


def _parse_dt(value: Any) -> Optional[datetime]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=PT)
        return parsed
    except Exception:
        return None



def _effective_outcome(row: Dict[str, Any]) -> str:
    """Normalize old/new archive rows into mutually exclusive research outcomes."""
    target_dt = _parse_dt(row.get("target_hit_time"))
    invalidation_dt = _parse_dt(row.get("invalidation_time"))

    if target_dt is not None:
        if (
            invalidation_dt is not None
            and invalidation_dt.astimezone(timezone.utc) < target_dt.astimezone(timezone.utc)
        ):
            return "target_hit_after_invalidation"
        return "target_hit"

    if invalidation_dt is not None:
        return "invalidated"

    existing = str(row.get("outcome") or "").strip().lower()
    if existing in {"expired", "active"}:
        return existing
    return existing or "active"


def _normalize_setup_row(row: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row)
    outcome = _effective_outcome(normalized)
    normalized["outcome"] = outcome
    normalized["valid_target_hit"] = outcome == "target_hit"
    normalized["target_hit_after_invalidation"] = outcome == "target_hit_after_invalidation"
    # target_hit means the price eventually touched the frozen target. Keep it
    # true for the after-invalidation bucket while valid_target_hit identifies
    # actual setup wins.
    normalized["target_hit"] = outcome in {"target_hit", "target_hit_after_invalidation"}
    if outcome == "target_hit_after_invalidation":
        normalized["confirmation_status"] = "TARGET HIT AFTER INVALIDATION"
        normalized["setup_stage"] = "TARGET HIT AFTER INVALIDATION"
    return normalized


def _bar_dt(row: Dict[str, Any]) -> Optional[datetime]:
    raw = row.get("time", row.get("t"))
    try:
        ts = int(raw or 0)
        if 0 < ts < 10_000_000_000:
            ts *= 1000
        if ts > 0:
            return datetime.fromtimestamp(ts / 1000.0, timezone.utc)
    except Exception:
        pass
    return _parse_dt(row.get("dt_et") or row.get("timestamp"))


def _load_json_rows(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
    except Exception:
        return []
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []
    return [dict(row) for row in rows if isinstance(row, dict)]


def _load_state_rows() -> List[Dict[str, Any]]:
    path = _state_path()
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
        rows = payload.get("tracked") or []
        return [dict(row) for row in rows if isinstance(row, dict)]
    except Exception:
        return []


def _load_setups_for_date_uncached(trade_date: str) -> List[Dict[str, Any]]:
    # Prefer the unbiased all-setup archive. The target-hit archive is included
    # only as a backward-compatible source for dates recorded before this upgrade.
    merged: Dict[str, Dict[str, Any]] = {}
    for path in (
        _setup_archive_dir() / f"{trade_date}.json",
        _hit_archive_dir() / f"{trade_date}.json",
    ):
        for row in _load_json_rows(path):
            key = str(row.get("setup_key") or "").strip()
            if key:
                merged[key] = row
    for row in _load_state_rows():
        if str(row.get("trade_date") or "") != trade_date:
            continue
        key = str(row.get("setup_key") or "").strip()
        if key:
            merged[key] = row
    return [_normalize_setup_row(row) for row in merged.values()]


def _load_setups_for_date(trade_date: str) -> List[Dict[str, Any]]:
    now = _cache_now()
    cached = _setup_rows_cache.get(trade_date)
    if cached and now - cached[0] < _SETUP_CACHE_TTL_SECONDS:
        return _copy_rows(cached[1])

    rows = _load_setups_for_date_uncached(trade_date)
    _setup_rows_cache[trade_date] = (now, _copy_rows(rows))

    # Prevent unbounded growth if this process stays up for a long time.
    if len(_setup_rows_cache) > 90:
        oldest = sorted(_setup_rows_cache.items(), key=lambda item: item[1][0])[:30]
        for key, _ in oldest:
            _setup_rows_cache.pop(key, None)

    return rows


def _normalize_date(value: Optional[str]) -> str:
    if not value:
        return datetime.now(PT).date().isoformat()
    try:
        return date.fromisoformat(value).isoformat()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="trade_date must be YYYY-MM-DD") from exc


def _setup_detection_dt(row: Dict[str, Any]) -> Optional[datetime]:
    return (
        _parse_dt(row.get("scanner_detected_at"))
        or _parse_dt(row.get("displacement_completed_at"))
        or _parse_dt(row.get("freeze_time"))
    )


def _match_setup(
    symbol: str,
    entry_dt: datetime,
    candidates: Iterable[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    symbol = symbol.upper().strip()
    ranked: List[Tuple[Tuple[int, float], Dict[str, Any]]] = []
    for row in candidates:
        if str(row.get("symbol") or "").upper().strip() != symbol:
            continue
        detected = _setup_detection_dt(row)
        if detected is None:
            continue
        delta_min = (entry_dt.astimezone(timezone.utc) - detected.astimezone(timezone.utc)).total_seconds() / 60.0
        # Prefer setups already known when the entry occurred. If none exist,
        # keep a same-day future detection so the coach can explicitly say the
        # trade preceded the scanner rather than falsely linking it.
        bucket = 0 if delta_min >= 0 else 1
        ranked.append(((bucket, abs(delta_min)), row))
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[0])
    return dict(ranked[0][1])


def _pct_change(value: float, base: float) -> float:
    if base <= 0:
        return 0.0
    return (value / base - 1.0) * 100.0


def _median(values: Iterable[float]) -> Optional[float]:
    clean = [float(v) for v in values if math.isfinite(float(v))]
    return round(float(statistics.median(clean)), 3) if clean else None


REVIEW_VERSION = 2
DISPLAY_TIMEZONE = "America/Los_Angeles"


def _pt_iso(value: Any) -> Optional[str]:
    dt = value if isinstance(value, datetime) else _parse_dt(value)
    if dt is None:
        return None
    return dt.astimezone(PT).isoformat()


def _minutes_between(later: Optional[datetime], earlier: Optional[datetime]) -> Optional[float]:
    if later is None or earlier is None:
        return None
    return round(
        (later.astimezone(timezone.utc) - earlier.astimezone(timezone.utc)).total_seconds() / 60.0,
        2,
    )


def _ohlcv(row: Dict[str, Any]) -> Dict[str, float]:
    return {
        "open": _safe_float(row.get("open", row.get("o"))),
        "high": _safe_float(row.get("high", row.get("h"))),
        "low": _safe_float(row.get("low", row.get("l"))),
        "close": _safe_float(row.get("close", row.get("c"))),
        "volume": max(0.0, _safe_float(row.get("volume", row.get("v")))),
    }


def _ordered_bars(bars: List[Dict[str, Any]], through: Optional[datetime] = None) -> List[Tuple[datetime, Dict[str, float]]]:
    limit = through.astimezone(timezone.utc) if through is not None else None
    out: List[Tuple[datetime, Dict[str, float]]] = []
    for raw in bars:
        dt = _bar_dt(raw)
        if dt is None:
            continue
        dt = dt.astimezone(timezone.utc)
        if limit is not None and dt > limit:
            continue
        row = _ohlcv(raw)
        if row["high"] <= 0 or row["low"] <= 0 or row["close"] <= 0:
            continue
        out.append((dt, row))
    out.sort(key=lambda item: item[0])
    return out


def _ema_value(values: List[float], period: int) -> Optional[float]:
    clean = [float(value) for value in values if value > 0 and math.isfinite(float(value))]
    if period <= 0 or len(clean) < period:
        return None
    multiplier = 2.0 / (period + 1.0)
    current = sum(clean[:period]) / period
    for value in clean[period:]:
        current = (value - current) * multiplier + current
    return current


def _vwap_value(items: List[Tuple[datetime, Dict[str, float]]]) -> Optional[float]:
    pv = 0.0
    volume = 0.0
    for _, row in items:
        if row["volume"] <= 0:
            continue
        typical = (row["high"] + row["low"] + row["close"]) / 3.0
        pv += typical * row["volume"]
        volume += row["volume"]
    return pv / volume if volume > 0 else None


def _atr_value(items: List[Tuple[datetime, Dict[str, float]]], period: int = 14) -> float:
    if len(items) < 2:
        return 0.0
    trs: List[float] = []
    for index in range(1, len(items)):
        row = items[index][1]
        prev = items[index - 1][1]
        trs.append(max(row["high"] - row["low"], abs(row["high"] - prev["close"]), abs(row["low"] - prev["close"])))
    sample = trs[-period:]
    return sum(sample) / len(sample) if sample else 0.0


def _pivot_points(items: List[Tuple[datetime, Dict[str, float]]], strength: int = 3) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    highs: List[Dict[str, Any]] = []
    lows: List[Dict[str, Any]] = []
    if len(items) < strength * 2 + 1:
        return highs, lows
    for index in range(strength, len(items) - strength):
        row = items[index][1]
        if all(row["high"] > items[index - offset][1]["high"] and row["high"] >= items[index + offset][1]["high"] for offset in range(1, strength + 1)):
            highs.append({"index": index, "price": row["high"], "time": items[index][0]})
        if all(row["low"] < items[index - offset][1]["low"] and row["low"] <= items[index + offset][1]["low"] for offset in range(1, strength + 1)):
            lows.append({"index": index, "price": row["low"], "time": items[index][0]})
    return highs, lows


def _structure_context(items: List[Tuple[datetime, Dict[str, float]]]) -> Dict[str, Any]:
    highs, lows = _pivot_points(items, 3)
    last_high = highs[-1] if highs else None
    prev_high = highs[-2] if len(highs) >= 2 else None
    last_low = lows[-1] if lows else None
    prev_low = lows[-2] if len(lows) >= 2 else None

    higher_highs = bool(last_high and prev_high and last_high["price"] > prev_high["price"])
    lower_highs = bool(last_high and prev_high and last_high["price"] < prev_high["price"])
    higher_lows = bool(last_low and prev_low and last_low["price"] > prev_low["price"])
    lower_lows = bool(last_low and prev_low and last_low["price"] < prev_low["price"])

    if higher_highs and higher_lows:
        trend = "bullish"
    elif lower_highs and lower_lows:
        trend = "bearish"
    else:
        trend = "neutral"

    bos = False
    choch = False
    break_direction: Optional[str] = None
    break_time: Optional[datetime] = None
    lookback_start = max(0, len(items) - 12)
    prior_highs = [point for point in highs if point["index"] < lookback_start]
    prior_lows = [point for point in lows if point["index"] < lookback_start]
    reference_high = prior_highs[-1] if prior_highs else (prev_high or last_high)
    reference_low = prior_lows[-1] if prior_lows else (prev_low or last_low)
    previous_close = items[lookback_start - 1][1]["close"] if lookback_start > 0 else 0.0
    for index in range(lookback_start, len(items)):
        close = items[index][1]["close"]
        if reference_high and previous_close <= reference_high["price"] < close:
            break_direction = "bullish"
            break_time = items[index][0]
        if reference_low and previous_close >= reference_low["price"] > close:
            break_direction = "bearish"
            break_time = items[index][0]
        previous_close = close
    if break_direction:
        bos = (trend == break_direction) or trend == "neutral"
        choch = trend != "neutral" and trend != break_direction

    return {
        "trend": trend,
        "higher_highs": higher_highs,
        "higher_lows": higher_lows,
        "lower_highs": lower_highs,
        "lower_lows": lower_lows,
        "last_swing_high": round(last_high["price"], 6) if last_high else None,
        "last_swing_low": round(last_low["price"], 6) if last_low else None,
        "bos": bos,
        "choch": choch,
        "last_break_direction": break_direction,
        "last_break_time": _pt_iso(break_time),
    }


def _trend_context(items: List[Tuple[datetime, Dict[str, float]]]) -> Dict[str, Any]:
    if not items:
        return {}
    closes = [row["close"] for _, row in items]
    last = items[-1][1]
    ema9 = _ema_value(closes, 9)
    ema20 = _ema_value(closes, 20)
    ema200 = _ema_value(closes, 200)
    ema9_prev = _ema_value(closes[:-1], 9) if len(closes) > 9 else None
    ema20_prev = _ema_value(closes[:-1], 20) if len(closes) > 20 else None
    vwap = _vwap_value(items)

    if ema9 and ema20 and ema9 > ema20:
        alignment = "bullish"
    elif ema9 and ema20 and ema9 < ema20:
        alignment = "bearish"
    else:
        alignment = "neutral"

    def slope(current: Optional[float], previous: Optional[float]) -> str:
        if current is None or previous is None:
            return "unknown"
        tolerance = max(abs(current) * 0.0002, 0.000001)
        if current > previous + tolerance:
            return "rising"
        if current < previous - tolerance:
            return "falling"
        return "flat"

    return {
        "price": round(last["close"], 6),
        "ema9": round(ema9, 6) if ema9 else None,
        "ema20": round(ema20, 6) if ema20 else None,
        "ema200": round(ema200, 6) if ema200 else None,
        "ema9_slope": slope(ema9, ema9_prev),
        "ema20_slope": slope(ema20, ema20_prev),
        "ema_alignment": alignment,
        "above_ema9": bool(ema9 and last["close"] > ema9) if ema9 else None,
        "above_ema20": bool(ema20 and last["close"] > ema20) if ema20 else None,
        "above_ema200": bool(ema200 and last["close"] > ema200) if ema200 else None,
        "vwap": round(vwap, 6) if vwap else None,
        "above_vwap": bool(vwap and last["close"] > vwap) if vwap else None,
        "vwap_distance_pct": round(_pct_change(last["close"], vwap), 3) if vwap else None,
    }


def _liquidity_context(items: List[Tuple[datetime, Dict[str, float]]]) -> Dict[str, Any]:
    if not items:
        return {}
    highs, lows = _pivot_points(items, 3)
    last_price = items[-1][1]["close"]
    atr = _atr_value(items)
    tolerance = max(0.0001, abs(last_price) * 0.00035, atr * 0.07)

    def clusters(points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for point in points:
            cluster = next((item for item in result if abs(item["anchor"] - point["price"]) <= tolerance), None)
            if cluster is None:
                result.append({"anchor": point["price"], "prices": [point["price"]], "indices": [point["index"]]})
                continue
            if point["index"] - cluster["indices"][-1] < 5:
                continue
            cluster["prices"].append(point["price"])
            cluster["indices"].append(point["index"])
            cluster["anchor"] = sum(cluster["prices"]) / len(cluster["prices"])
        return [item for item in result if len(item["prices"]) >= 2]

    high_clusters = clusters(highs)
    low_clusters = clusters(lows)
    levels_above = [p["price"] for p in highs] + [c["anchor"] for c in high_clusters]
    levels_below = [p["price"] for p in lows] + [c["anchor"] for c in low_clusters]
    nearest_above = min((level for level in levels_above if level > last_price), default=None)
    nearest_below = max((level for level in levels_below if level < last_price), default=None)

    events: List[Dict[str, Any]] = []
    pool_levels = [("buy-side", p["price"], p["index"]) for p in highs] + [("sell-side", p["price"], p["index"]) for p in lows]
    start = max(0, len(items) - 30)
    for index in range(start, len(items)):
        row = items[index][1]
        for side, level, established_index in pool_levels:
            if established_index >= index:
                continue
            if side == "buy-side" and row["high"] > level + tolerance and row["close"] < level:
                held = index + 1 < len(items) and items[index + 1][1]["close"] <= level + tolerance
                events.append({"side": side, "direction": "bearish", "price": level, "time": items[index][0], "reclaimed": held})
            if side == "sell-side" and row["low"] < level - tolerance and row["close"] > level:
                held = index + 1 < len(items) and items[index + 1][1]["close"] >= level - tolerance
                events.append({"side": side, "direction": "bullish", "price": level, "time": items[index][0], "reclaimed": held})
    latest = events[-1] if events else None
    return {
        "nearest_above": round(nearest_above, 6) if nearest_above else None,
        "nearest_below": round(nearest_below, 6) if nearest_below else None,
        "distance_above_pct": round(_pct_change(nearest_above, last_price), 3) if nearest_above else None,
        "distance_below_pct": round(_pct_change(last_price, nearest_below), 3) if nearest_below else None,
        "equal_highs": bool(high_clusters),
        "equal_lows": bool(low_clusters),
        "latest_sweep": None if latest is None else {
            "side": latest["side"],
            "direction": latest["direction"],
            "price": round(latest["price"], 6),
            "time": _pt_iso(latest["time"]),
            "reclaimed": bool(latest["reclaimed"]),
        },
    }


def _demand_context(items: List[Tuple[datetime, Dict[str, float]]]) -> Dict[str, Any]:
    if len(items) < 8:
        return {"timeframe": "5m", "zone": None}
    highs, lows = _pivot_points(items, 2)
    zones: List[Dict[str, Any]] = []
    for high_point in highs:
        high_index = high_point["index"]
        pivot_row = items[high_index][1]
        body_top = max(pivot_row["open"], pivot_row["close"])
        breakout_index: Optional[int] = None
        for index in range(high_index + 1, len(items)):
            row = items[index][1]
            if row["high"] > high_point["price"] and row["close"] > body_top:
                breakout_index = index
                break
        if breakout_index is None:
            continue
        leg_lows = [point for point in lows if high_index < point["index"] < breakout_index]
        leg_start = leg_lows[-1]["index"] if leg_lows else max(high_index + 1, breakout_index - 12)
        selected: Optional[Tuple[int, int]] = None
        search_end = min(len(items) - 1, breakout_index + 1)
        for fvg_index in range(max(2, leg_start + 2), search_end + 1):
            # Bullish 3-candle FVG: candle 3 low is above candle 1 high.
            if items[fvg_index][1]["low"] <= items[fvg_index - 2][1]["high"]:
                continue
            origin_index = fvg_index - 2
            selected = (fvg_index, origin_index)
            break
        if selected is None:
            continue
        fvg_index, origin_index = selected
        origin = items[origin_index][1]
        status = "fresh"
        touch_count = 0
        mitigation = 0.0
        width = max(0.000001, origin["high"] - origin["low"])
        for index in range(breakout_index + 1, len(items)):
            row = items[index][1]
            if row["close"] < origin["low"]:
                status = "failed"
                break
            if row["low"] <= origin["high"] and row["high"] >= origin["low"]:
                touch_count += 1
                penetration = max(0.0, origin["high"] - max(origin["low"], row["low"]))
                mitigation = max(mitigation, min(100.0, penetration / width * 100.0))
                status = "mitigated" if mitigation >= 50 else "touched"
        zones.append({
            "bottom": origin["low"],
            "top": origin["high"],
            "origin_time": items[origin_index][0],
            "confirmation_time": items[breakout_index][0],
            "fvg_time": items[fvg_index][0],
            "status": status,
            "touch_count": touch_count,
            "mitigation_pct": round(mitigation, 1),
        })
    if not zones:
        return {"timeframe": "5m", "zone": None}
    price = items[-1][1]["close"]
    active = [zone for zone in zones if zone["status"] != "failed"]
    candidates = active or zones
    zone = min(
        candidates,
        key=lambda item: 0.0 if item["bottom"] <= price <= item["top"] else min(abs(price - item["top"]), abs(price - item["bottom"])),
    )
    if zone["bottom"] <= price <= zone["top"]:
        location = "inside"
        distance_pct = 0.0
    elif price > zone["top"]:
        location = "above"
        distance_pct = round((price - zone["top"]) / price * 100.0, 3)
    else:
        location = "below"
        distance_pct = round((zone["bottom"] - price) / price * 100.0, 3)
    return {
        "timeframe": "5m",
        "zone": {
            "bottom": round(zone["bottom"], 6),
            "top": round(zone["top"], 6),
            "origin_time": _pt_iso(zone["origin_time"]),
            "confirmation_time": _pt_iso(zone["confirmation_time"]),
            "fvg_time": _pt_iso(zone["fvg_time"]),
            "status": zone["status"],
            "touch_count": zone["touch_count"],
            "mitigation_pct": zone["mitigation_pct"],
            "entry_location": location,
            "distance_pct": distance_pct,
        },
    }


def _window_path_stats(
    bars: List[Dict[str, Any]],
    entry_dt: datetime,
    entry_price: float,
    side: str,
) -> Dict[str, Any]:
    items = _ordered_bars(bars)
    entry_utc = entry_dt.astimezone(timezone.utc)
    is_short = str(side or "buy").lower() in {"sell", "short"}
    result: Dict[str, Any] = {}
    for minutes in (5, 15, 30):
        end = entry_utc + timedelta(minutes=minutes)
        sample = [row for dt, row in items if entry_utc <= dt <= end]
        if not sample or entry_price <= 0:
            result[f"{minutes}m"] = {"mfe_pct": None, "mae_pct": None}
            continue
        high = max(row["high"] for row in sample)
        low = min(row["low"] for row in sample)
        if is_short:
            mfe = (entry_price - low) / entry_price * 100.0
            mae = (high - entry_price) / entry_price * 100.0
        else:
            mfe = (high - entry_price) / entry_price * 100.0
            mae = (entry_price - low) / entry_price * 100.0
        result[f"{minutes}m"] = {
            "mfe_pct": round(max(0.0, mfe), 3),
            "mae_pct": round(max(0.0, mae), 3),
            "high": round(high, 6),
            "low": round(low, 6),
        }
    return result


def _first_confirmation_after_entry(
    bars: List[Dict[str, Any]],
    entry_dt: datetime,
    max_minutes: int = 120,
) -> Optional[Dict[str, Any]]:
    all_items = _ordered_bars(bars)
    if not all_items:
        return None
    entry_utc = entry_dt.astimezone(timezone.utc)
    cutoff = entry_utc + timedelta(minutes=max_minutes)
    for index, (dt, row) in enumerate(all_items):
        if dt < entry_utc or dt > cutoff:
            continue
        history = all_items[: index + 1]
        closes = [item[1]["close"] for item in history]
        ema9 = _ema_value(closes, 9)
        ema20 = _ema_value(closes, 20)
        prev9 = _ema_value(closes[:-1], 9) if len(closes) > 9 else None
        vwap = _vwap_value(history)
        reasons: List[str] = []
        if ema9 and row["close"] > ema9 and prev9 and ema9 > prev9:
            reasons.append("price reclaimed a rising EMA9")
        if ema9 and ema20 and ema9 > ema20:
            reasons.append("EMA9 was above EMA20")
        if vwap and row["close"] > vwap:
            reasons.append("price was above VWAP")
        if len(reasons) >= 2:
            return {
                "time": _pt_iso(dt),
                "price": round(row["close"], 6),
                "reasons": reasons,
            }
    return None


def _coach_guidance(
    *,
    setup_valid_at_entry: bool,
    entry_after_invalidation: bool,
    trend_1m: Dict[str, Any],
    structure_5m: Dict[str, Any],
    liquidity: Dict[str, Any],
    demand: Dict[str, Any],
    planned_stop: float,
) -> Tuple[List[str], List[str]]:
    guidance: List[str] = []
    positives: List[str] = []
    if entry_after_invalidation or not setup_valid_at_entry:
        guidance.append("Do not keep using the old frozen +3 target after the scanner setup invalidates; require a fresh displacement/setup or a new independent reversal thesis.")
    if trend_1m.get("ema_alignment") == "bearish" or trend_1m.get("ema9_slope") == "falling":
        guidance.append("Wait for price to reclaim EMA9 with EMA9 rising; stronger confirmation is EMA9 back above EMA20 instead of buying while short-term trend is still falling.")
    if trend_1m.get("above_vwap") is False:
        guidance.append("Price was below VWAP at entry; prefer a VWAP reclaim/hold or clearly treat the trade as a counter-trend reversal with separate confirmation.")
    if structure_5m.get("trend") == "bearish" and not structure_5m.get("choch"):
        guidance.append("The 5-minute structure had not produced a bullish change of character. Wait for a bullish structure shift before treating a deep selloff as a new long setup.")
    latest_sweep = liquidity.get("latest_sweep") if isinstance(liquidity, dict) else None
    if not latest_sweep or latest_sweep.get("direction") != "bullish" or not latest_sweep.get("reclaimed"):
        guidance.append("For a reversal entry, prefer a sell-side liquidity sweep followed by a reclaim/hold instead of anticipating the low.")
    zone = demand.get("zone") if isinstance(demand, dict) else None
    if not zone:
        guidance.append("No confirmed nearby 5-minute demand/FVG zone was found at entry; avoid using 'it looks cheap' as the support thesis.")
    elif zone.get("status") == "failed" or zone.get("entry_location") == "below":
        guidance.append("The nearest demand zone was failed or already lost. Wait for price to reclaim the zone or for a new demand zone to form.")
    elif zone.get("entry_location") in {"inside", "above"}:
        positives.append("Entry had an identifiable 5-minute demand/FVG reference nearby.")
    if planned_stop > 0:
        positives.append("You defined risk with a planned stop; keep that discipline even when the setup quality is weak.")
    if not guidance:
        guidance.append("The entry had multiple confirmations. Keep using the same checklist and focus on executing the planned stop/target rather than reacting to noise.")
    return guidance[:6], positives[:4]


class Vwap3TradeReviewRequest(BaseModel):
    trade_id: str = Field(min_length=1)
    symbol: str = Field(min_length=1)
    side: str = "buy"
    shares: float = 0
    entry_price: float
    exit_price: float
    entry_time: str
    exit_time: str
    planned_target: Optional[float] = None
    planned_stop: Optional[float] = None
    strategy: Optional[str] = None
    realized_pnl: Optional[float] = None
    r_multiple: Optional[float] = None


class Vwap3TradeReviewBatchRequest(BaseModel):
    trades: List[Vwap3TradeReviewRequest] = Field(default_factory=list)


def _review_cache_key(payload: Vwap3TradeReviewRequest) -> str:
    try:
        data = payload.model_dump(mode="json")
    except AttributeError:
        data = payload.dict()
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)


def _get_cached_review(payload: Vwap3TradeReviewRequest) -> Optional[Dict[str, Any]]:
    key = _review_cache_key(payload)
    cached = _review_cache.get(key)
    if not cached:
        return None
    if _cache_now() - cached[0] >= _REVIEW_CACHE_TTL_SECONDS:
        _review_cache.pop(key, None)
        return None
    result = dict(cached[1])
    result["cache_hit"] = True
    return result


def _put_cached_review(payload: Vwap3TradeReviewRequest, result: Dict[str, Any]) -> Dict[str, Any]:
    key = _review_cache_key(payload)
    stored = dict(result)
    stored.pop("cache_hit", None)
    _review_cache[key] = (_cache_now(), stored)

    if len(_review_cache) > 500:
        oldest = sorted(_review_cache.items(), key=lambda item: item[1][0])[:100]
        for old_key, _ in oldest:
            _review_cache.pop(old_key, None)

    response = dict(stored)
    response["cache_hit"] = False
    return response


async def _load_trade_day_bars(
    symbol: str,
    trade_date: str,
    timeframe: str = "1m",
) -> List[Dict[str, Any]]:
    normalized_symbol = symbol.upper().strip()
    normalized_timeframe = str(timeframe or "1m").strip().lower()
    key = (normalized_symbol, trade_date, normalized_timeframe)
    now = _cache_now()
    cached = _trade_bars_cache.get(key)

    today_et = datetime.now(ET).date().isoformat()
    ttl = (
        _CURRENT_DAY_BARS_TTL_SECONDS
        if trade_date == today_et
        else _HISTORICAL_BARS_TTL_SECONDS
    )

    if cached and now - cached[0] < ttl:
        return _copy_rows(cached[1])

    market = get_market_data_provider()
    try:
        rows = await market.get_bars(
            symbol=normalized_symbol,
            timeframe=normalized_timeframe,
            session="extended",
            date=trade_date,
            limit=5000,
        )
        clean = [dict(row) for row in rows if isinstance(row, dict)]
        _trade_bars_cache[key] = (now, _copy_rows(clean))

        if len(_trade_bars_cache) > 160:
            oldest = sorted(_trade_bars_cache.items(), key=lambda item: item[1][0])[:40]
            for old_key, _ in oldest:
                _trade_bars_cache.pop(old_key, None)

        return clean
    except Exception as exc:
        print(f"[vwap3-coach] bars unavailable symbol={normalized_symbol} date={trade_date}: {exc}", flush=True)
        return []


def _path_stats(
    bars: List[Dict[str, Any]],
    entry_dt: datetime,
    exit_dt: datetime,
    target: float,
    invalidation: float,
) -> Dict[str, Any]:
    entry_utc = entry_dt.astimezone(timezone.utc)
    exit_utc = exit_dt.astimezone(timezone.utc)
    after_entry: List[Tuple[datetime, Dict[str, Any]]] = []
    after_exit: List[Tuple[datetime, Dict[str, Any]]] = []
    through_exit: List[Tuple[datetime, Dict[str, Any]]] = []

    for row in bars:
        dt = _bar_dt(row)
        if dt is None:
            continue
        dt = dt.astimezone(timezone.utc)
        if dt >= entry_utc:
            after_entry.append((dt, row))
        if entry_utc <= dt <= exit_utc:
            through_exit.append((dt, row))
        if dt > exit_utc:
            after_exit.append((dt, row))

    def max_high(items: List[Tuple[datetime, Dict[str, Any]]]) -> float:
        values = [_safe_float(row.get("high", row.get("h"))) for _, row in items]
        return max(values, default=0.0)

    def min_low(items: List[Tuple[datetime, Dict[str, Any]]]) -> float:
        values = [v for v in (_safe_float(row.get("low", row.get("l"))) for _, row in items) if v > 0]
        return min(values, default=0.0)

    def first_hit(items: List[Tuple[datetime, Dict[str, Any]]], level: float, side: str) -> Optional[datetime]:
        if level <= 0:
            return None
        for dt, row in items:
            high = _safe_float(row.get("high", row.get("h")))
            low = _safe_float(row.get("low", row.get("l")))
            if side == "high" and high >= level:
                return dt
            if side == "low" and low <= level:
                return dt
        return None

    target_before_exit = first_hit(through_exit, target, "high")
    target_after_exit = first_hit(after_exit, target, "high")
    invalidation_before_exit = first_hit(through_exit, invalidation, "low")
    invalidation_after_exit = first_hit(after_exit, invalidation, "low")

    return {
        "max_high_after_entry": max_high(after_entry),
        "min_low_after_entry": min_low(after_entry),
        "max_high_after_exit": max_high(after_exit),
        "min_low_after_exit": min_low(after_exit),
        "target_hit_before_exit_time": target_before_exit.isoformat() if target_before_exit else None,
        "target_hit_after_exit_time": target_after_exit.isoformat() if target_after_exit else None,
        "invalidation_hit_before_exit_time": invalidation_before_exit.isoformat() if invalidation_before_exit else None,
        "invalidation_hit_after_exit_time": invalidation_after_exit.isoformat() if invalidation_after_exit else None,
    }


def _review_classification(
    entry: float,
    exit_price: float,
    target: float,
    invalidation: float,
    path: Dict[str, Any],
) -> Tuple[str, str, int]:
    if target > 0 and exit_price >= target * 0.995:
        return "target_exit", "Target exit", 95
    if invalidation > 0 and exit_price <= invalidation * 1.005:
        return "stop_or_invalidation_exit", "Invalidation/stop exit", 82

    target_after_time = _parse_dt(path.get("target_hit_after_exit_time"))
    invalid_after_time = _parse_dt(path.get("invalidation_hit_after_exit_time"))
    target_after = target_after_time is not None
    invalid_before = bool(path.get("invalidation_hit_before_exit_time"))
    invalid_after = invalid_after_time is not None
    target_won_race = target_after and (
        invalid_after_time is None
        or target_after_time.astimezone(timezone.utc) <= invalid_after_time.astimezone(timezone.utc)
    )

    if target > exit_price > 0 and not invalid_before and target_won_race:
        return (
            "likely_early_exit",
            "Likely early exit",
            91,
        )
    if target > exit_price > 0 and invalid_before:
        return "defensive_exit", "Justified defensive exit", 88
    if target > exit_price > 0 and invalid_after and not target_won_race:
        return "defensive_exit", "Good defensive exit", 84
    if target > exit_price > 0:
        return "early_exit_unresolved", "Early exit — outcome unresolved", 68
    return "neutral_exit", "Exit review", 60


def _entry_quality(entry: float, setup: Dict[str, Any], detected_dt: Optional[datetime], entry_dt: datetime) -> Dict[str, Any]:
    freeze = _safe_float(setup.get("freeze_price"))
    disp_low = _safe_float(setup.get("displacement_low"))
    disp_high = _safe_float(setup.get("displacement_high"))
    target = _safe_float(setup.get("frozen_target") or setup.get("target_price"))
    delay = None
    if detected_dt:
        delay = round((entry_dt.astimezone(timezone.utc) - detected_dt.astimezone(timezone.utc)).total_seconds() / 60.0, 2)

    entry_vs_freeze = round(_pct_change(entry, freeze), 3) if freeze > 0 else None
    target_remaining = round((target - entry) / entry * 100.0, 3) if entry > 0 and target > 0 else None
    risk_to_disp_low = round((entry - disp_low) / entry * 100.0, 3) if entry > 0 and disp_low > 0 else None

    score = 70.0
    if entry_vs_freeze is not None:
        if -7 <= entry_vs_freeze <= 2:
            score += 18
        elif 2 < entry_vs_freeze <= 5:
            score += 5
        elif entry_vs_freeze > 8:
            score -= 22
        elif entry_vs_freeze < -12:
            score -= 10
    if target_remaining is not None and target_remaining >= 8:
        score += 6
    if disp_high > 0 and entry > disp_high * 1.03:
        score -= 12
    score = int(max(0, min(100, round(score))))

    if entry_vs_freeze is None:
        label = "Unknown"
    elif entry_vs_freeze > 8:
        label = "Chased"
    elif entry_vs_freeze > 3:
        label = "Slightly extended"
    elif entry_vs_freeze >= -1:
        label = "Near scanner/freeze"
    elif entry_vs_freeze >= -8:
        label = "Pullback entry"
    else:
        label = "Deep pullback"

    return {
        "score": score,
        "label": label,
        "delay_minutes": delay,
        "entry_vs_freeze_pct": entry_vs_freeze,
        "target_remaining_pct_at_entry": target_remaining,
        "risk_to_displacement_low_pct": risk_to_disp_low,
    }


@router.post("/review-trade")
async def review_vwap3_trade(payload: Vwap3TradeReviewRequest):
    cached_review = _get_cached_review(payload)
    if cached_review is not None and int(cached_review.get("review_version") or 0) >= REVIEW_VERSION:
        return cached_review

    entry_dt = _parse_dt(payload.entry_time)
    exit_dt = _parse_dt(payload.exit_time)
    if entry_dt is None or exit_dt is None:
        raise HTTPException(status_code=400, detail="entry_time and exit_time must be ISO timestamps")
    if payload.entry_price <= 0 or payload.exit_price <= 0:
        raise HTTPException(status_code=400, detail="entry_price and exit_price must be positive")

    # Scanner archives are keyed by the U.S. market date (ET). Coach-facing
    # timestamps are always returned/displayed in Pacific Time.
    trade_date = entry_dt.astimezone(ET).date().isoformat()
    setups = _load_setups_for_date(trade_date)
    matched = _match_setup(payload.symbol, entry_dt, setups)

    if not matched:
        result = {
            "review_version": REVIEW_VERSION,
            "display_timezone": DISPLAY_TIMEZONE,
            "trade_id": payload.trade_id,
            "symbol": payload.symbol.upper(),
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
            "entry_time_pt": _pt_iso(entry_dt),
            "exit_time_pt": _pt_iso(exit_dt),
            "scanner_match": False,
            "entry_verdict": "UNMATCHED",
            "headline": "No 3-VWAP scanner match",
            "summary": "No archived 3-VWAP setup for this symbol was found on the trade date.",
            "classification": "not_vwap3",
            "confidence": 1.0,
        }
        return _put_cached_review(payload, result)

    detected_dt = _setup_detection_dt(matched)
    scanner_invalidation_dt = _parse_dt(matched.get("invalidation_time"))
    entry_after_scanner = bool(detected_dt and entry_dt.astimezone(timezone.utc) >= detected_dt.astimezone(timezone.utc))
    entry_after_invalidation = bool(
        scanner_invalidation_dt
        and entry_dt.astimezone(timezone.utc) >= scanner_invalidation_dt.astimezone(timezone.utc)
    )
    exit_after_invalidation = bool(
        scanner_invalidation_dt
        and exit_dt.astimezone(timezone.utc) >= scanner_invalidation_dt.astimezone(timezone.utc)
    )
    setup_valid_at_entry = not entry_after_invalidation
    setup_valid_at_exit = not exit_after_invalidation
    minutes_after_invalidation = (
        max(0.0, _minutes_between(entry_dt, scanner_invalidation_dt) or 0.0)
        if entry_after_invalidation
        else None
    )

    scanner_target = _safe_float(matched.get("frozen_target") or matched.get("target_price"))
    planned_target = _safe_float(payload.planned_target)
    target = scanner_target if scanner_target > 0 else planned_target
    planned_stop = _safe_float(payload.planned_stop)
    displacement_low = _safe_float(matched.get("displacement_low"))
    trade_invalidation = planned_stop if planned_stop > 0 else displacement_low

    bars_1m, bars_5m = await asyncio.gather(
        _load_trade_day_bars(payload.symbol, trade_date, "1m"),
        _load_trade_day_bars(payload.symbol, trade_date, "5m"),
    )
    path = _path_stats(bars_1m, entry_dt, exit_dt, target, trade_invalidation)

    # Preserve scanner invalidation separately from the user's stop. The old
    # setup can be invalid before a later trade stop is hit.
    scanner_path = _path_stats(bars_1m, entry_dt, exit_dt, target, displacement_low)

    archived_target_hit = _parse_dt(matched.get("target_hit_time"))
    if (
        not path.get("target_hit_after_exit_time")
        and archived_target_hit
        and archived_target_hit.astimezone(timezone.utc) > exit_dt.astimezone(timezone.utc)
    ):
        path["target_hit_after_exit_time"] = archived_target_hit.isoformat()

    classification, classification_label, confidence_score = _review_classification(
        payload.entry_price,
        payload.exit_price,
        target,
        trade_invalidation,
        path,
    )

    entry_items_1m = _ordered_bars(bars_1m, entry_dt)
    entry_items_5m = _ordered_bars(bars_5m, entry_dt)
    trend_1m = _trend_context(entry_items_1m)
    structure_1m = _structure_context(entry_items_1m)
    structure_5m = _structure_context(entry_items_5m)
    liquidity = _liquidity_context(entry_items_1m)
    demand = _demand_context(entry_items_5m)
    path_windows = _window_path_stats(bars_1m, entry_dt, payload.entry_price, payload.side)
    first_confirmation = _first_confirmation_after_entry(bars_1m, entry_dt)

    entry_quality = _entry_quality(payload.entry_price, matched, detected_dt, entry_dt)
    entry_score = int(entry_quality.get("score") or 0)
    score_reasons: List[str] = []
    if not setup_valid_at_entry:
        entry_score = min(entry_score, 20)
        entry_quality["label"] = "Invalidated setup"
        score_reasons.append("Original 3-VWAP setup had already invalidated before entry.")
    if trend_1m.get("ema_alignment") == "bearish":
        entry_score = max(0, entry_score - 10)
        score_reasons.append("EMA9 was below EMA20 at entry.")
    if trend_1m.get("above_vwap") is False:
        entry_score = max(0, entry_score - 6)
        score_reasons.append("Entry was below VWAP.")
    if structure_5m.get("trend") == "bearish" and not structure_5m.get("choch"):
        entry_score = max(0, entry_score - 8)
        score_reasons.append("5-minute structure remained bearish without bullish CHoCH.")
    entry_quality["score"] = entry_score
    entry_quality["score_reasons"] = score_reasons

    if not setup_valid_at_entry:
        entry_verdict = "AVOID"
    elif entry_score >= 80:
        entry_verdict = "STRONG"
    elif entry_score >= 65:
        entry_verdict = "ACCEPTABLE"
    elif entry_score >= 45:
        entry_verdict = "CAUTION"
    else:
        entry_verdict = "AVOID"

    guidance, positives = _coach_guidance(
        setup_valid_at_entry=setup_valid_at_entry,
        entry_after_invalidation=entry_after_invalidation,
        trend_1m=trend_1m,
        structure_5m=structure_5m,
        liquidity=liquidity,
        demand=demand,
        planned_stop=planned_stop,
    )

    historical_rows = _study_rows(60)
    pullback_tests = _pullback_tests(historical_rows)
    historical_candidates = [
        item
        for item in pullback_tests
        if item["opportunities"] >= 5 and item["hit_rate_pct"] is not None
    ]
    best_historical_pullback = (
        max(historical_candidates, key=lambda item: (item["hit_rate_pct"], item["opportunities"]))
        if historical_candidates
        else None
    )

    missed_per_share = (
        max(0.0, target - payload.exit_price)
        if target > 0 and classification == "likely_early_exit" and setup_valid_at_exit
        else 0.0
    )
    missed_pnl = missed_per_share * max(0.0, payload.shares)
    target_after_exit = _parse_dt(path.get("target_hit_after_exit_time"))
    minutes_exit_to_target = None
    if target_after_exit:
        minutes_exit_to_target = round(
            max(0.0, (target_after_exit.astimezone(timezone.utc) - exit_dt.astimezone(timezone.utc)).total_seconds() / 60.0),
            2,
        )

    max_high_after_exit = _safe_float(path.get("max_high_after_exit"))
    mfe_after_exit_pct = (
        round((max_high_after_exit - payload.exit_price) / payload.exit_price * 100.0, 3)
        if payload.exit_price > 0 and max_high_after_exit > 0
        else 0.0
    )

    if not setup_valid_at_entry:
        wait_text = (
            f" about {minutes_after_invalidation:.0f} minutes after invalidation"
            if minutes_after_invalidation is not None
            else " after invalidation"
        )
        summary = (
            f"You entered{wait_text}. The original 3-VWAP thesis was already invalid, so this should not be scored as a normal pullback entry. "
            "A better plan is to require a fresh scanner setup or a new reversal thesis confirmed by structure/liquidity/trend."
        )
        headline = f"AVOID · Entry after setup invalidation · {matched.get('grade') or '3-VWAP'}"
    elif classification == "likely_early_exit":
        summary = (
            f"You exited before the frozen +3 target while the setup was still valid. "
            f"Price later reached the target{f' {minutes_exit_to_target:.0f} minutes after your exit' if minutes_exit_to_target is not None else ''}. "
            "This is a repeatable early-exit behavior worth tracking."
        )
        headline = f"{classification_label} · {matched.get('grade') or '3-VWAP'}"
    elif classification == "defensive_exit":
        summary = (
            "You exited before the +3 target, but the price path threatened the trade invalidation before a later target. "
            "The exit was technically defensible rather than automatically being treated as fear."
        )
        headline = f"{classification_label} · {matched.get('grade') or '3-VWAP'}"
    elif classification == "target_exit":
        summary = "The exit captured the scanner's frozen +3 target area."
        headline = f"{classification_label} · {matched.get('grade') or '3-VWAP'}"
    else:
        summary = "The trade is linked to a 3-VWAP setup. Review the setup-validity, trend, structure, liquidity, demand, and entry-path sections below for the actionable lesson."
        headline = f"{entry_verdict} entry · {matched.get('grade') or '3-VWAP'}"

    # Coach-facing path timestamps are Pacific Time.
    for key in (
        "target_hit_before_exit_time",
        "target_hit_after_exit_time",
        "invalidation_hit_before_exit_time",
        "invalidation_hit_after_exit_time",
    ):
        if path.get(key):
            path[key] = _pt_iso(path[key])
        if scanner_path.get(key):
            scanner_path[key] = _pt_iso(scanner_path[key])

    result = {
        "review_version": REVIEW_VERSION,
        "display_timezone": DISPLAY_TIMEZONE,
        "trade_id": payload.trade_id,
        "symbol": payload.symbol.upper(),
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "entry_time_pt": _pt_iso(entry_dt),
        "exit_time_pt": _pt_iso(exit_dt),
        "scanner_match": True,
        "setup_key": matched.get("setup_key"),
        "scanner_grade": matched.get("grade"),
        "scanner_status": matched.get("confirmation_status"),
        "scanner_detected_at": _pt_iso(matched.get("scanner_detected_at")),
        "freeze_time": _pt_iso(matched.get("freeze_time")),
        "setup_invalidation_time": _pt_iso(scanner_invalidation_dt),
        "freeze_price": _safe_float(matched.get("freeze_price")),
        "frozen_target": scanner_target,
        "displacement_low": displacement_low,
        "displacement_high": _safe_float(matched.get("displacement_high")),
        "planned_stop": planned_stop if planned_stop > 0 else None,
        "entry_after_scanner": entry_after_scanner,
        "setup_valid_at_entry": setup_valid_at_entry,
        "entry_after_invalidation": entry_after_invalidation,
        "minutes_after_invalidation": minutes_after_invalidation,
        "setup_valid_at_exit": setup_valid_at_exit,
        "entry_verdict": entry_verdict,
        "entry_quality": entry_quality,
        "classification": classification,
        "classification_label": classification_label,
        "confidence": confidence_score / 100.0,
        "headline": headline,
        "summary": summary,
        "target_hit_after_exit": bool(path.get("target_hit_after_exit_time")),
        "target_hit_after_exit_time": path.get("target_hit_after_exit_time"),
        "minutes_exit_to_target": minutes_exit_to_target,
        "missed_upside_per_share": round(missed_per_share, 6),
        "estimated_missed_pnl_to_target": round(missed_pnl, 2),
        "mfe_after_exit_pct": mfe_after_exit_pct,
        "trend_context": {
            "timeframe": "1m",
            **trend_1m,
        },
        "structure_context": {
            "1m": structure_1m,
            "5m": structure_5m,
        },
        "liquidity_context": liquidity,
        "demand_context": demand,
        "entry_path": path_windows,
        "first_confirmation_after_entry": first_confirmation,
        "next_time_guidance": guidance,
        "what_went_well": positives,
        "path": path,
        "scanner_path": scanner_path,
        "historical_context": {
            "study_days": 60,
            "sample_size": len(historical_rows),
            "best_observed_pullback": best_historical_pullback,
        },
        "scanner_setup": matched,
    }
    return _put_cached_review(payload, result)


@router.post("/review-trades")
async def review_vwap3_trades(payload: Vwap3TradeReviewBatchRequest):
    if not payload.trades:
        return {"count": 0, "reviews": []}
    if len(payload.trades) > 50:
        raise HTTPException(status_code=400, detail="review-trades accepts at most 50 trades")

    # Cap concurrent market-data lookups so a journal with many historical
    # trades cannot create a burst against the provider. Cache hits complete
    # immediately and do not consume meaningful backend work.
    semaphore = asyncio.Semaphore(4)

    async def review_one(item: Vwap3TradeReviewRequest) -> Dict[str, Any]:
        async with semaphore:
            return await review_vwap3_trade(item)

    reviews = await asyncio.gather(*(review_one(item) for item in payload.trades))
    return {
        "count": len(reviews),
        "reviews": reviews,
    }


def _study_rows_uncached(days: int) -> List[Dict[str, Any]]:
    archive_dir = _setup_archive_dir()
    today = datetime.now(ET).date()
    earliest = today - timedelta(days=max(1, days) - 1)
    merged: Dict[str, Dict[str, Any]] = {}

    if archive_dir.exists():
        for path in sorted(archive_dir.glob("*.json")):
            try:
                trade_date = date.fromisoformat(path.stem)
            except Exception:
                continue
            if trade_date < earliest or trade_date > today:
                continue
            for row in _load_json_rows(path):
                key = str(row.get("setup_key") or "").strip()
                if key:
                    merged[key] = _normalize_setup_row(row)

    # Include live/current rows even before the first permanent archive file exists.
    for row in _load_state_rows():
        key = str(row.get("setup_key") or "").strip()
        if key:
            merged[key] = _normalize_setup_row(row)
    return list(merged.values())


def _study_rows(days: int) -> List[Dict[str, Any]]:
    normalized_days = max(1, int(days))
    now = _cache_now()
    cached = _study_rows_cache.get(normalized_days)
    if cached and now - cached[0] < _STUDY_CACHE_TTL_SECONDS:
        return _copy_rows(cached[1])

    rows = _study_rows_uncached(normalized_days)
    _study_rows_cache[normalized_days] = (now, _copy_rows(rows))
    if len(_study_rows_cache) > 12:
        oldest = sorted(_study_rows_cache.items(), key=lambda item: item[1][0])[:4]
        for key, _ in oldest:
            _study_rows_cache.pop(key, None)
    return rows


def _aggregate_group(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    normalized = [_normalize_setup_row(row) for row in rows]
    hits = [row for row in normalized if row.get("outcome") == "target_hit"]
    hit_after_invalidation = [
        row for row in normalized if row.get("outcome") == "target_hit_after_invalidation"
    ]
    invalidated = [row for row in normalized if row.get("outcome") == "invalidated"]
    expired = [row for row in normalized if row.get("outcome") == "expired"]
    resolved = [
        row
        for row in normalized
        if row.get("outcome")
        in {"target_hit", "target_hit_after_invalidation", "invalidated", "expired"}
    ]
    eventual_hits = len(hits) + len(hit_after_invalidation)
    return {
        "setups": len(normalized),
        "resolved": len(resolved),
        "target_hits": len(hits),
        "target_hits_after_invalidation": len(hit_after_invalidation),
        "eventual_target_hits": eventual_hits,
        "invalidated": len(invalidated),
        "expired": len(expired),
        "hit_rate_pct": round(len(hits) / len(resolved) * 100.0, 2) if resolved else None,
        "eventual_target_rate_pct": round(eventual_hits / len(resolved) * 100.0, 2) if resolved else None,
        "median_pullback_before_target_pct": _median(_safe_float(row.get("pullback_before_target_pct")) for row in hits),
        "median_minutes_to_target": _median(_safe_float(row.get("minutes_to_target")) for row in hits if _safe_float(row.get("minutes_to_target")) > 0),
    }


def _pullback_tests(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for threshold in (0, 2, 3, 5, 7, 10):
        offered = 0
        wins = 0
        for row in rows:
            freeze = _safe_float(row.get("freeze_price"))
            if freeze <= 0:
                continue
            touched_low = _safe_float(row.get("min_low_before_target") or row.get("min_low_after_freeze"))
            if threshold == 0:
                was_offered = True
            else:
                level = freeze * (1.0 - threshold / 100.0)
                was_offered = touched_low > 0 and touched_low <= level
            if not was_offered:
                continue
            offered += 1
            if _effective_outcome(row) == "target_hit":
                wins += 1
        results.append(
            {
                "pullback_pct": threshold,
                "opportunities": offered,
                "target_hits": wins,
                "hit_rate_pct": round(wins / offered * 100.0, 2) if offered else None,
            }
        )
    return results


@router.get("/study")
async def vwap3_study(days: int = Query(30, ge=1, le=365)):
    rows = _study_rows(days)
    by_grade: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_grade[str(row.get("grade") or "UNKNOWN")].append(row)

    pullbacks = _pullback_tests(rows)
    candidates = [item for item in pullbacks if item["opportunities"] >= 5 and item["hit_rate_pct"] is not None]
    best = max(candidates, key=lambda item: (item["hit_rate_pct"], item["opportunities"])) if candidates else None

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "days": days,
        "overall": _aggregate_group(rows),
        "by_grade": {grade: _aggregate_group(group) for grade, group in sorted(by_grade.items())},
        "pullback_entry_tests": pullbacks,
        "best_observed_pullback": best,
        "notes": [
            "Statistics include all permanently archived qualified setups, not only target hits.",
            "TARGET HIT requires the frozen target to be reached before invalidation. TARGET HIT AFTER INVALIDATION is tracked separately and is not counted as a valid setup win.",
            "Eventual target rate includes both valid target hits and target hits after invalidation for research context.",
            "Pullback tests measure whether the entry level was offered and whether a still-valid setup later reached its frozen target; they are descriptive, not guarantees.",
        ],
    }


@router.get("/setups")
async def vwap3_setups(trade_date: Optional[str] = Query(None), symbol: Optional[str] = Query(None)):
    selected_date = _normalize_date(trade_date)
    rows = _load_setups_for_date(selected_date)
    if symbol:
        normalized = symbol.upper().strip()
        rows = [row for row in rows if str(row.get("symbol") or "").upper().strip() == normalized]
    rows.sort(key=lambda row: str(row.get("freeze_time") or ""))
    return {
        "trade_date": selected_date,
        "count": len(rows),
        "rows": rows,
    }
