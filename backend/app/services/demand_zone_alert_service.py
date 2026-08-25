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



def _true_range(current: Dict[str, float], previous: Optional[Dict[str, float]] = None) -> float:
    if not previous:
        return max(0.0, current["high"] - current["low"])
    return max(
        current["high"] - current["low"],
        abs(current["high"] - previous["close"]),
        abs(current["low"] - previous["close"]),
    )


def _average_true_range(bars: List[Dict[str, float]], end_index: int, length: int = 14) -> float:
    if not bars:
        return 0.0
    safe_end = max(0, min(len(bars) - 1, int(end_index)))
    safe_start = max(0, safe_end - max(2, int(length)) + 1)
    values: List[float] = []
    for index in range(safe_start, safe_end + 1):
        previous = bars[index - 1] if index > 0 else None
        values.append(_true_range(bars[index], previous))
    return (sum(values) / len(values)) if values else 0.0


def _meaningful_pullback_distance(
    bars: List[Dict[str, float]],
    extreme_index: int,
    atr_multiplier: float,
    price_floor_pct: float = 0.0025,
) -> float:
    """Use pre-expansion ATR so a giant spike candle cannot hide its pullback."""
    pre_index = max(0, extreme_index - 1)
    pre_atr = _average_true_range(bars, pre_index, 14)
    fallback_atr = _average_true_range(bars, extreme_index, 14)
    atr = pre_atr if pre_atr > 0 else fallback_atr
    price = max(0.000001, abs(bars[extreme_index]["close"]))
    return max(atr * atr_multiplier, price * price_floor_pct)


def _bullish_pullback_qualifies(
    bars: List[Dict[str, float]],
    *,
    extreme_index: int,
    extreme_price: float,
    pullback_low: float,
    pullback_lowest_close: float,
    pullback_bars: int,
    minimum_bars: int,
    atr_multiplier: float,
) -> bool:
    if pullback_bars < max(1, minimum_bars):
        return False
    required = _meaningful_pullback_distance(
        bars,
        extreme_index,
        atr_multiplier,
    )
    if required <= 0:
        return False
    return (
        extreme_price - pullback_low >= required
        and extreme_price - pullback_lowest_close >= required * 0.45
    )


def _is_consolidating_after_high(
    bars: List[Dict[str, float]],
    extreme_index: int,
    current_index: int,
) -> bool:
    start_index = extreme_index + 1
    if current_index - start_index + 1 < 4:
        return False
    atr = _average_true_range(bars, max(0, extreme_index - 1), 14)
    if atr <= 0:
        return False

    start = max(start_index, current_index - 7)
    segment = bars[start : current_index + 1]
    if not segment:
        return False
    range_high = max(row["high"] for row in segment)
    range_low = min(row["low"] for row in segment)
    total_range = range_high - range_low
    net_progress = abs(segment[-1]["close"] - segment[0]["close"])

    compressed = total_range <= atr * 0.90 and net_progress <= atr * 0.35

    tolerance = max(atr * 0.18, abs(segment[0]["close"]) * 0.0005)
    levels = [row["low"] for row in segment]
    maximum_touches = 0
    for candidate in levels:
        touches = sum(1 for level in levels if abs(level - candidate) <= tolerance)
        maximum_touches = max(maximum_touches, touches)

    repeated_level = (
        maximum_touches >= 3
        and total_range <= atr * 1.35
        and net_progress <= atr * 0.45
    )
    return compressed or repeated_level


def _build_confirmed_bullish_highs(bars: List[Dict[str, float]]) -> List[Dict[str, Any]]:
    """Build close-confirmed HHs with O(n) JEM-safe leg segmentation.

    The previous HH is broken only by CLOSE > HH wick. A meaningful pullback
    locks the pre-pullback record high; later wick-only recovery candles cannot
    move that old HH. This mirrors the frontend structure engine without adding
    expensive rescans to the five-minute alert refresh.
    """
    pivot_highs = [
        index for index in range(2, len(bars) - 2) if _is_pivot_high(bars, index, 2)
    ]
    if not pivot_highs:
        return []

    confirmed_price = bars[pivot_highs[0]]["high"]
    points: List[Dict[str, Any]] = []

    pending_confirmation: Optional[int] = None
    candidate_index = -1
    candidate_price = 0.0
    pullback_low = float("inf")
    pullback_lowest_close = float("inf")
    pullback_bars = 0
    locked_index: Optional[int] = None
    locked_price: Optional[float] = None

    index = pivot_highs[0] + 1
    while index < len(bars):
        row = bars[index]

        if pending_confirmation is None:
            if row["close"] > confirmed_price:
                pending_confirmation = index
                candidate_index = index
                candidate_price = row["high"]
                pullback_low = float("inf")
                pullback_lowest_close = float("inf")
                pullback_bars = 0
                locked_index = None
                locked_price = None
            index += 1
            continue

        # A close through an already locked pre-pullback HH confirms it. Reuse
        # this same candle afterward because it can also arm the next BOS.
        if locked_index is not None and locked_price is not None and row["close"] > locked_price:
            points.append(
                {
                    "index": int(locked_index),
                    "price": float(locked_price),
                    "confirmation_index": int(pending_confirmation),
                }
            )
            confirmed_price = float(locked_price)
            pending_confirmation = None
            continue

        # Before a pullback is locked, a true new record wick still belongs to
        # the same breakout leg. After locking, wick-only probes are ignored.
        if locked_index is None and row["high"] > candidate_price:
            candidate_index = index
            candidate_price = row["high"]
            pullback_low = float("inf")
            pullback_lowest_close = float("inf")
            pullback_bars = 0
            index += 1
            continue

        pullback_low = min(pullback_low, row["low"])
        pullback_lowest_close = min(pullback_lowest_close, row["close"])
        pullback_bars += 1

        reference_index = locked_index if locked_index is not None else candidate_index
        reference_price = locked_price if locked_price is not None else candidate_price

        if locked_index is None and _bullish_pullback_qualifies(
            bars,
            extreme_index=candidate_index,
            extreme_price=candidate_price,
            pullback_low=pullback_low,
            pullback_lowest_close=pullback_lowest_close,
            pullback_bars=pullback_bars,
            minimum_bars=1,
            atr_multiplier=0.35,
        ):
            locked_index = candidate_index
            locked_price = candidate_price
            reference_index = locked_index
            reference_price = locked_price

        meaningful_pullback = _bullish_pullback_qualifies(
            bars,
            extreme_index=int(reference_index),
            extreme_price=float(reference_price),
            pullback_low=pullback_low,
            pullback_lowest_close=pullback_lowest_close,
            pullback_bars=pullback_bars,
            minimum_bars=2,
            atr_multiplier=0.55,
        )
        consolidated = _is_consolidating_after_high(
            bars,
            int(reference_index),
            index,
        )

        if meaningful_pullback or consolidated:
            points.append(
                {
                    "index": int(reference_index),
                    "price": float(reference_price),
                    "confirmation_index": int(pending_confirmation),
                }
            )
            confirmed_price = float(reference_price)
            pending_confirmation = None
            continue

        index += 1

    return points


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

    The alert path mirrors the chart's approved rules:
      * HH breaks are CLOSE-confirmed through the previous HH wick
      * explosive candles use pre-expansion ATR for pullback segmentation
      * a later wick-only recovery cannot erase a completed HH/pullback
      * use the first bullish FVG in the successful leg
      * anchor to the full candle immediately before FVG displacement
      * invalidate only on a later 5-minute close below the zone low
      * no ATR requirement for the demand zone itself
    """
    bars = normalize_bars(raw_bars)
    if max_bars > 0 and len(bars) > max_bars:
        bars = bars[-max_bars:]
    if len(bars) < 8:
        return []

    structure_highs = _build_confirmed_bullish_highs(bars)
    zones_by_id: Dict[str, Dict[str, Any]] = {}

    # The first generated HH has only the seed pivot as its predecessor. Match
    # the chart and require a real earlier generated HH before validating demand.
    for point_index in range(1, len(structure_highs)):
        previous_point = structure_highs[point_index - 1]
        current_point = structure_highs[point_index]
        prior_high_index = int(previous_point["index"])
        prior_high = float(previous_point["price"])
        breakout_index = int(current_point["confirmation_index"])

        if not (0 <= prior_high_index < breakout_index < len(bars)):
            continue

        # Authoritative structural rule: the breakout candle must CLOSE above
        # the previous HH wick. A wick-only sweep is not enough.
        if bars[breakout_index]["close"] <= prior_high:
            continue

        leg_start = _latest_leg_base(bars, prior_high_index + 1, breakout_index)
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
        higher_high_index = int(current_point["index"])
        lifecycle_start = max(breakout_index, selected_fvg, higher_high_index) + 1

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
            "higher_high_time": int(bars[higher_high_index]["time"]),
            "fvg_time": int(bars[selected_fvg]["time"]),
            "previous_high": prior_high,
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
