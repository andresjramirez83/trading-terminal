from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        if number != number:
            return default
        return number
    except Exception:
        return default


def _timestamp_ms(value: Any) -> int:
    try:
        number = int(float(value))
        if number > 0:
            return number if number >= 10_000_000_000 else number * 1000
    except Exception:
        pass
    return 0


def normalize_bars(raw_bars: Iterable[Dict[str, Any]], *, now_ms: Optional[int] = None) -> List[Dict[str, float]]:
    """Normalize completed 5-minute bars for automatic demand-zone detection."""
    current_ms = int(now_ms or datetime.now(timezone.utc).timestamp() * 1000)
    rows: Dict[int, Dict[str, float]] = {}

    for raw in raw_bars or []:
        if not isinstance(raw, dict):
            continue
        ts = _timestamp_ms(raw.get("time", raw.get("t")))
        if ts <= 0:
            continue

        # Native 5-minute bars are stamped at the beginning of their bucket.
        # A zone must never be confirmed from a still-forming 5-minute candle.
        if ts + 5 * 60_000 > current_ms:
            continue

        open_price = _safe_float(raw.get("open", raw.get("o")))
        high = _safe_float(raw.get("high", raw.get("h")))
        low = _safe_float(raw.get("low", raw.get("l")))
        close = _safe_float(raw.get("close", raw.get("c")))
        volume = _safe_float(raw.get("volume", raw.get("v")))
        if min(open_price, high, low, close) <= 0 or high < low:
            continue

        rows[ts] = {
            "time": float(ts),
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": max(0.0, volume),
        }

    return [rows[key] for key in sorted(rows)]


def _is_pivot_high(bars: List[Dict[str, float]], index: int, strength: int = 2) -> bool:
    if index - strength < 0 or index + strength >= len(bars):
        return False
    price = bars[index]["high"]
    for offset in range(1, strength + 1):
        if price <= bars[index - offset]["high"] or price < bars[index + offset]["high"]:
            return False
    return True


def _is_local_swing_low(bars: List[Dict[str, float]], index: int, strength: int = 2) -> bool:
    if index - strength < 0 or index + strength >= len(bars):
        return False
    price = bars[index]["low"]
    for offset in range(1, strength + 1):
        if price >= bars[index - offset]["low"] or price > bars[index + offset]["low"]:
            return False
    return True


def _latest_leg_base(bars: List[Dict[str, float]], minimum_index: int, confirmation_index: int) -> int:
    safe_minimum = max(0, minimum_index)
    last_eligible = min(len(bars) - 3, confirmation_index - 2)
    for index in range(last_eligible, safe_minimum + 1, -1):
        if _is_local_swing_low(bars, index, 2):
            return index

    lowest_index = safe_minimum
    for index in range(safe_minimum + 1, confirmation_index):
        if bars[index]["low"] < bars[lowest_index]["low"]:
            lowest_index = index
    return lowest_index


def _is_bullish_fvg(bars: List[Dict[str, float]], index: int) -> bool:
    if index < 2 or index >= len(bars):
        return False
    return bars[index]["low"] > bars[index - 2]["high"]


def build_active_demand_zones(raw_bars: Iterable[Dict[str, Any]], *, max_bars: int = 650) -> List[Dict[str, Any]]:
    """Build active bullish 5-minute demand zones.

    The detector mirrors the chart's approved demand-zone rules as closely as
    possible in the backend alert path:
      * bullish structure high / prior swing high
      * breakout trades through the prior high and closes above that candle body
      * use the first bullish FVG in the successful leg
      * anchor to the full candle immediately before FVG displacement
      * invalidate only on a later 5-minute close below the zone low
      * no ATR dependency
    """
    bars = normalize_bars(raw_bars)
    if max_bars > 0 and len(bars) > max_bars:
        bars = bars[-max_bars:]
    if len(bars) < 8:
        return []

    pivot_high_indexes = [
        index for index in range(2, len(bars) - 2) if _is_pivot_high(bars, index, 2)
    ]
    zones_by_id: Dict[str, Dict[str, Any]] = {}

    for high_index in pivot_high_indexes:
        prior_high = bars[high_index]["high"]
        prior_body_top = max(bars[high_index]["open"], bars[high_index]["close"])
        breakout_index: Optional[int] = None

        for index in range(high_index + 1, len(bars)):
            row = bars[index]
            if row["high"] > prior_high and row["close"] > prior_body_top:
                breakout_index = index
                break

        if breakout_index is None:
            continue

        leg_start = _latest_leg_base(bars, high_index + 1, breakout_index)
        fvg_search_end = min(len(bars) - 1, breakout_index + 1)
        selected_fvg: Optional[int] = None
        selected_origin: Optional[int] = None

        for fvg_index in range(max(2, leg_start + 2), fvg_search_end + 1):
            displacement_index = fvg_index - 1
            if displacement_index > breakout_index:
                continue
            if not _is_bullish_fvg(bars, fvg_index):
                continue
            origin_index = fvg_index - 2
            if origin_index < leg_start:
                continue
            selected_fvg = fvg_index
            selected_origin = origin_index
            break

        if selected_fvg is None or selected_origin is None:
            continue

        origin = bars[selected_origin]
        bottom = origin["low"]
        top = origin["high"]
        if bottom <= 0 or top <= bottom:
            continue

        active = True
        touch_count = 0
        mitigation_pct = 0.0
        was_inside = False
        height = max(top - bottom, 0.0000001)
        lifecycle_start = max(breakout_index, selected_fvg) + 1

        for index in range(lifecycle_start, len(bars)):
            row = bars[index]
            if row["close"] < bottom:
                active = False
                break

            inside = row["low"] <= top and row["high"] >= bottom
            if inside and not was_inside:
                touch_count += 1
            if inside:
                depth = max(0.0, min(1.0, (top - row["low"]) / height))
                mitigation_pct = max(mitigation_pct, depth * 100.0)
            was_inside = inside

        if not active:
            continue

        origin_time = int(origin["time"])
        confirmation_time = int(bars[breakout_index]["time"])
        zone_id = f"{origin_time}:{confirmation_time}:{round(bottom, 6)}:{round(top, 6)}"
        zones_by_id[zone_id] = {
            "id": zone_id,
            "bottom": bottom,
            "top": top,
            "origin_time": origin_time,
            "confirmation_time": confirmation_time,
            "fvg_time": int(bars[selected_fvg]["time"]),
            "touch_count": touch_count,
            "mitigation_pct": round(mitigation_pct, 1),
            "active": True,
        }

    return sorted(
        zones_by_id.values(),
        key=lambda zone: (int(zone["confirmation_time"]), int(zone["origin_time"])),
    )


def nearest_relevant_zone(zones: Iterable[Dict[str, Any]], price: float) -> Optional[Dict[str, Any]]:
    """Return the nearest active demand zone that is at or below current price."""
    current = _safe_float(price)
    if current <= 0:
        return None

    candidates: List[Tuple[float, Dict[str, Any]]] = []
    for zone in zones or []:
        if not isinstance(zone, dict) or not zone.get("active", True):
            continue
        bottom = _safe_float(zone.get("bottom"))
        top = _safe_float(zone.get("top"))
        if bottom <= 0 or top <= bottom:
            continue
        if current < bottom:
            continue
        distance = 0.0 if current <= top else current - top
        candidates.append((distance, zone))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return dict(candidates[0][1])


def classify_zone_location(price: float, zone: Dict[str, Any], near_pct: float = 1.0) -> Dict[str, Any]:
    current = _safe_float(price)
    bottom = _safe_float(zone.get("bottom"))
    top = _safe_float(zone.get("top"))
    threshold = max(0.0, _safe_float(near_pct, 1.0))

    if current <= 0 or bottom <= 0 or top <= bottom:
        return {"state": "unknown", "distance_pct": None}
    if bottom <= current <= top:
        return {"state": "inside", "distance_pct": 0.0}
    if current < bottom:
        return {"state": "below", "distance_pct": 0.0}

    distance_pct = ((current - top) / top) * 100.0
    return {
        "state": "near" if distance_pct <= threshold else "far",
        "distance_pct": round(distance_pct, 3),
    }


__all__ = [
    "build_active_demand_zones",
    "nearest_relevant_zone",
    "classify_zone_location",
    "normalize_bars",
]
