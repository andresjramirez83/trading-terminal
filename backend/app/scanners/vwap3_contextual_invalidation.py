from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# Research/shadow-mode only. This module must never change live scanner outcome,
# actionable score, AutoTrade eligibility, or broker behavior by itself.
CONTEXT_MODE = "shadow"
FVG_LOOKBACK_BARS = 96
RECLAIM_LOOKAHEAD_BARS = 4
SWING_LEFT = 2
SWING_RIGHT = 2
ACCEPTANCE_BPS = 10.0  # 0.10% buffer under support for a normal break close.
DEEP_BREAK_PCT = 0.50  # One close >= 0.50% below support can confirm failure.


def _safe_float(value: Any) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else 0.0
    except Exception:
        return 0.0


def _row_time(row: Dict[str, Any]) -> Optional[str]:
    raw = str(row.get("dt_et") or row.get("timestamp") or "").strip()
    return raw or None


def _round_price(value: Optional[float]) -> Optional[float]:
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), 6)


def _pct_below(value: float, reference: float) -> float:
    if value <= 0 or reference <= 0:
        return 0.0
    return max(0.0, (reference - value) / reference * 100.0)


def _zone_penetration_pct(low: float, bottom: float, top: float) -> float:
    width = top - bottom
    if width <= 0:
        return 0.0
    if low >= top:
        return 0.0
    if low <= bottom:
        return 100.0
    return max(0.0, min(100.0, (top - low) / width * 100.0))


def _pivot_highs(rows: List[Dict[str, Any]], start: int, end: int) -> List[Tuple[int, float]]:
    pivots: List[Tuple[int, float]] = []
    lo = max(start + SWING_LEFT, SWING_LEFT)
    hi = min(end - SWING_RIGHT, len(rows) - 1 - SWING_RIGHT)
    for idx in range(lo, hi + 1):
        high = _safe_float(rows[idx].get("high"))
        if high <= 0:
            continue
        left = [_safe_float(rows[j].get("high")) for j in range(idx - SWING_LEFT, idx)]
        right = [_safe_float(rows[j].get("high")) for j in range(idx + 1, idx + 1 + SWING_RIGHT)]
        if left and right and high >= max(left) and high > max(right):
            pivots.append((idx, high))
    return pivots


def _pivot_lows(rows: List[Dict[str, Any]], start: int, end: int) -> List[Tuple[int, float]]:
    pivots: List[Tuple[int, float]] = []
    lo = max(start + SWING_LEFT, SWING_LEFT)
    hi = min(end - SWING_RIGHT, len(rows) - 1 - SWING_RIGHT)
    for idx in range(lo, hi + 1):
        low = _safe_float(rows[idx].get("low"))
        if low <= 0:
            continue
        left = [_safe_float(rows[j].get("low")) for j in range(idx - SWING_LEFT, idx)]
        right = [_safe_float(rows[j].get("low")) for j in range(idx + 1, idx + 1 + SWING_RIGHT)]
        if left and right and low <= min(left) and low < min(right):
            pivots.append((idx, low))
    return pivots


def _bullish_fvgs(rows: List[Dict[str, Any]], start: int, end: int) -> List[Dict[str, Any]]:
    """Return bullish three-candle fair-value gaps created no later than end.

    A bullish FVG is the price void between candle i-2 high and candle i low.
    The gap exists only when i low > i-2 high.
    """
    output: List[Dict[str, Any]] = []
    for idx in range(max(2, start), min(end, len(rows) - 1) + 1):
        left_high = _safe_float(rows[idx - 2].get("high"))
        right_low = _safe_float(rows[idx].get("low"))
        if left_high <= 0 or right_low <= left_high:
            continue
        output.append(
            {
                "index": idx,
                "created_time": _row_time(rows[idx]),
                "bottom": left_high,
                "top": right_low,
                # DemandZoneEngine anchors the zone to candle i-2: the candle
                # immediately before the FVG displacement candle (i-1).
                "base_index": idx - 2,
            }
        )
    return output


def _first_close_break_above(
    rows: List[Dict[str, Any]],
    pivot_index: int,
    pivot_high: float,
    end_index: int,
) -> Optional[int]:
    for idx in range(pivot_index + 1, min(end_index, len(rows) - 1) + 1):
        if _safe_float(rows[idx].get("close")) > pivot_high:
            return idx
    return None


def _is_local_swing_low(
    rows: List[Dict[str, Any]],
    index: int,
    strength: int = 2,
) -> bool:
    if index < strength or index + strength >= len(rows):
        return False
    current = _safe_float(rows[index].get("low"))
    if current <= 0:
        return False
    for offset in range(1, strength + 1):
        left = _safe_float(rows[index - offset].get("low"))
        right = _safe_float(rows[index + offset].get("low"))
        if left <= 0 or right <= 0:
            return False
        if current >= left or current > right:
            return False
    return True


def _find_latest_local_leg_base(
    rows: List[Dict[str, Any]],
    minimum_index: int,
    confirmation_index: int,
) -> int:
    """Mirror the current DemandZoneEngine local-leg-base selection."""
    safe_minimum = max(0, minimum_index)
    last_eligible = min(len(rows) - 3, confirmation_index - 2)
    for index in range(last_eligible, safe_minimum + 1, -1):
        if _is_local_swing_low(rows, index, 2):
            return index

    lowest_index = min(safe_minimum, max(0, len(rows) - 1))
    for index in range(safe_minimum + 1, min(confirmation_index, len(rows))):
        if _safe_float(rows[index].get("low")) < _safe_float(rows[lowest_index].get("low")):
            lowest_index = index
    return lowest_index


def _demand_zones_from_fvgs(
    rows: List[Dict[str, Any]],
    start: int,
    end: int,
    fvgs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Build lightweight backend demand zones using the chart's approved rule.

    The frontend DemandZoneEngine uses its full MarketStructureEngine. The scanner
    intentionally avoids importing browser code, so shadow mode uses confirmed
    local pivot highs as HH candidates, while mirroring the important price-action
    rules exactly: close above the prior high wick, latest local leg base, first
    bullish FVG in that successful leg, origin = FVG index - 2, and close-through
    invalidation.
    """
    pivots = _pivot_highs(rows, start, end)
    zones: List[Dict[str, Any]] = []
    seen: set[Tuple[int, int, int]] = set()

    for pivot_idx, pivot_high in pivots:
        break_idx = _first_close_break_above(rows, pivot_idx, pivot_high, end)
        if break_idx is None:
            continue

        structural_search_start = pivot_idx + 1
        if structural_search_start >= break_idx:
            continue
        leg_start = _find_latest_local_leg_base(
            rows, structural_search_start, break_idx
        )
        fvg_search_end = min(end, break_idx + 1, len(rows) - 1)
        selected: Optional[Dict[str, Any]] = None
        for fvg in fvgs:
            fvg_idx = int(fvg.get("index") or -1)
            if fvg_idx < max(2, leg_start + 2) or fvg_idx > fvg_search_end:
                continue
            # Only the confirming third candle may occur after breakout.
            if fvg_idx - 1 > break_idx:
                continue
            origin_idx = fvg_idx - 2
            if origin_idx < leg_start:
                continue
            selected = fvg
            break

        if not selected:
            continue

        fvg_idx = int(selected["index"])
        origin_idx = fvg_idx - 2
        origin = rows[origin_idx]
        bottom = _safe_float(origin.get("low"))
        top = _safe_float(origin.get("high"))
        if bottom <= 0 or top <= bottom:
            continue

        key = (origin_idx, break_idx, fvg_idx)
        if key in seen:
            continue
        seen.add(key)
        zones.append(
            {
                "index": origin_idx,
                "created_time": _row_time(rows[max(break_idx, fvg_idx)]),
                "bottom": bottom,
                "top": top,
                "fvg_index": fvg_idx,
                "broken_swing_high": pivot_high,
                "break_time": _row_time(rows[break_idx]),
                "confirmation_index": break_idx,
                "leg_start_index": leg_start,
            }
        )

    return zones


def _zone_was_broken_before(
    rows: List[Dict[str, Any]],
    zone: Dict[str, Any],
    end_index: int,
    *,
    wick_fill_invalidates: bool = False,
) -> bool:
    start_idx = int(zone.get("index") or 0) + 1
    bottom = _safe_float(zone.get("bottom"))
    if bottom <= 0:
        return True
    for idx in range(start_idx, min(end_index, len(rows) - 1) + 1):
        # Demand follows the chart rule: close-through invalidation. For a raw
        # FVG/imbalance, a prior wick that fully trades through the far edge
        # means the gap was already filled and should not excuse a later drop.
        if wick_fill_invalidates:
            if _safe_float(rows[idx].get("low")) <= bottom:
                return True
        elif _safe_float(rows[idx].get("close")) < bottom:
            return True
    return False


def _select_relevant_zone(
    rows: List[Dict[str, Any]],
    zones: List[Dict[str, Any]],
    invalidation_idx: int,
    test_low: float,
    reference_price: float,
    *,
    wick_fill_invalidates: bool = False,
) -> Optional[Dict[str, Any]]:
    candidates: List[Tuple[float, int, Dict[str, Any]]] = []
    for zone in zones:
        bottom = _safe_float(zone.get("bottom"))
        top = _safe_float(zone.get("top"))
        if bottom <= 0 or top <= bottom:
            continue
        if int(zone.get("index") or 0) >= invalidation_idx:
            continue
        if _zone_was_broken_before(
            rows,
            zone,
            invalidation_idx - 1,
            wick_fill_invalidates=wick_fill_invalidates,
        ):
            continue

        # Prefer an actual touch. Otherwise allow a very nearby support zone.
        touched = test_low <= top
        distance_pct = 0.0
        if not touched and reference_price > 0:
            distance_pct = max(0.0, (test_low - top) / reference_price * 100.0)
        if touched or distance_pct <= 0.75:
            candidates.append((distance_pct, -int(zone.get("index") or 0), zone))

    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    return dict(candidates[0][2])


def _reclaim_after(
    rows: List[Dict[str, Any]],
    start_idx: int,
    reclaim_level: float,
    lookahead: int = RECLAIM_LOOKAHEAD_BARS,
) -> Tuple[bool, Optional[str], Optional[int]]:
    if reclaim_level <= 0:
        return False, None, None
    end = min(len(rows) - 1, start_idx + max(0, lookahead))
    for idx in range(start_idx, end + 1):
        if _safe_float(rows[idx].get("close")) >= reclaim_level:
            return True, _row_time(rows[idx]), idx
    return False, None, None


def _liquidity_sweep(
    row: Dict[str, Any],
    sweep_level: float,
) -> Dict[str, Any]:
    open_price = _safe_float(row.get("open"))
    high = _safe_float(row.get("high"))
    low = _safe_float(row.get("low"))
    close = _safe_float(row.get("close"))
    span = max(0.0, high - low)
    body_low = min(open_price, close)
    lower_wick = max(0.0, body_low - low)
    wick_ratio = lower_wick / span if span > 0 else 0.0
    body = abs(close - open_price)
    took_level = sweep_level > 0 and low <= sweep_level
    reclaimed_level = sweep_level > 0 and close > sweep_level
    long_wick = wick_ratio >= 0.35 and lower_wick >= max(body * 1.10, span * 0.25)
    confirmed = bool(took_level and reclaimed_level and long_wick)
    return {
        "confirmed": confirmed,
        "took_level": took_level,
        "reclaimed_level": reclaimed_level,
        "long_lower_wick": long_wick,
        "lower_wick_ratio": round(wick_ratio, 3),
        "sweep_level": _round_price(sweep_level),
    }


def _support_acceptance(
    rows: List[Dict[str, Any]],
    invalidation_idx: int,
    support_level: float,
) -> Dict[str, Any]:
    if support_level <= 0:
        return {
            "support_level": None,
            "failed": False,
            "first_close_below_time": None,
            "consecutive_closes_below": 0,
            "deep_break_pct": 0.0,
        }

    threshold = support_level * (1.0 - ACCEPTANCE_BPS / 10_000.0)
    consecutive = 0
    first_close_below_time: Optional[str] = None
    max_break_pct = 0.0
    failed = False
    end = min(len(rows) - 1, invalidation_idx + RECLAIM_LOOKAHEAD_BARS)

    for idx in range(invalidation_idx, end + 1):
        close = _safe_float(rows[idx].get("close"))
        if close <= 0:
            continue
        break_pct = _pct_below(close, support_level)
        max_break_pct = max(max_break_pct, break_pct)
        if close < threshold:
            consecutive += 1
            if first_close_below_time is None:
                first_close_below_time = _row_time(rows[idx])
            if consecutive >= 2 or break_pct >= DEEP_BREAK_PCT:
                failed = True
                break
        else:
            consecutive = 0

    return {
        "support_level": _round_price(support_level),
        "failed": failed,
        "first_close_below_time": first_close_below_time,
        "consecutive_closes_below": consecutive,
        "deep_break_pct": round(max_break_pct, 3),
    }


def _latest_confirmed_swing_low(
    rows: List[Dict[str, Any]],
    start: int,
    end: int,
) -> Optional[Tuple[int, float]]:
    lows = _pivot_lows(rows, start, end)
    return lows[-1] if lows else None


def _serialize_zone(
    zone: Optional[Dict[str, Any]],
    test_low: float,
    invalidation_idx: int,
    rows: List[Dict[str, Any]],
) -> Dict[str, Any]:
    if not zone:
        return {
            "present": False,
            "touched": False,
            "reclaimed": False,
            "bottom": None,
            "top": None,
            "penetration_pct": 0.0,
            "created_time": None,
            "reclaim_time": None,
        }

    bottom = _safe_float(zone.get("bottom"))
    top = _safe_float(zone.get("top"))
    touched = test_low <= top if top > 0 else False
    reclaim_level = top if touched else 0.0
    reclaimed, reclaim_time, _ = _reclaim_after(rows, invalidation_idx, reclaim_level)
    return {
        "present": True,
        "touched": touched,
        "reclaimed": reclaimed,
        "bottom": _round_price(bottom),
        "top": _round_price(top),
        "penetration_pct": round(_zone_penetration_pct(test_low, bottom, top), 2),
        "created_time": zone.get("created_time"),
        "reclaim_time": reclaim_time,
    }


def evaluate_contextual_invalidation(
    rows: List[Dict[str, Any]],
    record: Dict[str, Any],
    freeze_idx: int,
    invalidation_time: Optional[str],
    *,
    target_hit_time: Optional[str] = None,
) -> Dict[str, Any]:
    """Evaluate whether a mechanical VWAP3 invalidation had bullish context.

    This function deliberately DOES NOT override the scanner's official invalidation.
    It records a shadow verdict that can later be validated statistically.
    """
    result: Dict[str, Any] = {
        "mode": CONTEXT_MODE,
        "mechanical_invalidation": bool(invalidation_time),
        "verdict": "MONITORING" if not invalidation_time else "MECHANICAL_INVALIDATION",
        "support_score": 0,
        "possible_premature_invalidation": False,
        "research_outcome": None,
        "fvg": {
            "present": False,
            "touched": False,
            "reclaimed": False,
            "bottom": None,
            "top": None,
            "penetration_pct": 0.0,
            "created_time": None,
            "reclaim_time": None,
        },
        "demand_zone": {
            "present": False,
            "touched": False,
            "reclaimed": False,
            "bottom": None,
            "top": None,
            "penetration_pct": 0.0,
            "created_time": None,
            "reclaim_time": None,
        },
        "fvg_demand_overlap": False,
        "liquidity_sweep": {
            "confirmed": False,
            "took_level": False,
            "reclaimed_level": False,
            "long_lower_wick": False,
            "lower_wick_ratio": 0.0,
            "sweep_level": _round_price(_safe_float(record.get("displacement_low"))),
        },
        "structure": {
            "source": "backend_5m_pivot_shadow",
            "latest_swing_low": None,
            "latest_swing_low_time": None,
            "support_level": None,
            "failed": False,
            "first_close_below_time": None,
            "consecutive_closes_below": 0,
            "deep_break_pct": 0.0,
        },
        "reclaim_time": None,
        "reason": "No mechanical invalidation has occurred.",
    }

    if not invalidation_time or not rows:
        return result

    invalidation_idx: Optional[int] = None
    for idx in range(max(0, freeze_idx + 1), len(rows)):
        if _row_time(rows[idx]) == invalidation_time:
            invalidation_idx = idx
            break
    if invalidation_idx is None:
        # Fallback to first bar whose low touched the mechanical displacement low.
        displacement_low = _safe_float(record.get("displacement_low"))
        for idx in range(max(0, freeze_idx + 1), len(rows)):
            if displacement_low > 0 and _safe_float(rows[idx].get("low")) <= displacement_low:
                invalidation_idx = idx
                break
    if invalidation_idx is None:
        result["reason"] = "Mechanical invalidation time could not be mapped to a 5-minute bar."
        return result

    invalidation_bar = rows[invalidation_idx]
    test_low = _safe_float(invalidation_bar.get("low"))
    displacement_low = _safe_float(record.get("displacement_low"))
    reference_price = _safe_float(record.get("freeze_price")) or _safe_float(invalidation_bar.get("close"))
    lookback_start = max(0, freeze_idx - FVG_LOOKBACK_BARS)

    # Only context that existed before the mechanical invalidation is eligible.
    context_end = max(0, invalidation_idx - 1)
    fvgs = _bullish_fvgs(rows, lookback_start, context_end)
    demand_zones = _demand_zones_from_fvgs(rows, lookback_start, context_end, fvgs)
    fvg_zone = _select_relevant_zone(
        rows,
        fvgs,
        invalidation_idx,
        test_low,
        reference_price,
        wick_fill_invalidates=True,
    )
    demand_zone = _select_relevant_zone(
        rows, demand_zones, invalidation_idx, test_low, reference_price
    )

    fvg_context = _serialize_zone(fvg_zone, test_low, invalidation_idx, rows)
    demand_context = _serialize_zone(demand_zone, test_low, invalidation_idx, rows)
    result["fvg"] = fvg_context
    result["demand_zone"] = demand_context

    overlap = False
    if fvg_zone and demand_zone:
        overlap_bottom = max(_safe_float(fvg_zone.get("bottom")), _safe_float(demand_zone.get("bottom")))
        overlap_top = min(_safe_float(fvg_zone.get("top")), _safe_float(demand_zone.get("top")))
        overlap = overlap_bottom <= overlap_top
    result["fvg_demand_overlap"] = overlap

    sweep = _liquidity_sweep(invalidation_bar, displacement_low)
    result["liquidity_sweep"] = sweep

    latest_swing_low = _latest_confirmed_swing_low(rows, max(freeze_idx, invalidation_idx - 24), invalidation_idx)
    structure_support_candidates = [value for value in (
        _safe_float(demand_zone.get("bottom")) if demand_zone else 0.0,
        _safe_float(fvg_zone.get("bottom")) if fvg_zone else 0.0,
        displacement_low,
        latest_swing_low[1] if latest_swing_low else 0.0,
    ) if value > 0]

    # Use the lowest nearby bullish support as the hard acceptance boundary. This
    # allows a wick through displacement low into a deeper pre-existing FVG/demand
    # zone, but still confirms failure when price accepts beneath the whole cluster.
    support_level = min(structure_support_candidates) if structure_support_candidates else displacement_low
    acceptance = _support_acceptance(rows, invalidation_idx, support_level)
    result["structure"] = {
        "source": "backend_5m_pivot_shadow",
        "latest_swing_low": _round_price(latest_swing_low[1]) if latest_swing_low else None,
        "latest_swing_low_time": _row_time(rows[latest_swing_low[0]]) if latest_swing_low else None,
        **acceptance,
    }

    score = 0
    reasons: List[str] = []
    if fvg_context["present"] and fvg_context["touched"]:
        score += 12
        reasons.append("pullback entered a pre-existing bullish FVG/imbalance")
    if demand_context["present"] and demand_context["touched"]:
        score += 20
        reasons.append("pullback entered a close-confirmed demand zone")
    if overlap and (fvg_context["touched"] or demand_context["touched"]):
        score += 16
        reasons.append("FVG and demand overlapped")
    if sweep.get("confirmed"):
        score += 20
        reasons.append("the displacement low was swept and reclaimed with a long lower wick")
    if fvg_context.get("reclaimed"):
        score += 10
        reasons.append("price reclaimed the FVG")
    if demand_context.get("reclaimed"):
        score += 14
        reasons.append("price reclaimed demand")
    if not acceptance.get("failed"):
        score += 18
        reasons.append("5-minute price did not show acceptance below the support cluster")
    else:
        score -= 45
        reasons.append("5-minute closes accepted below the support cluster")

    score = max(0, min(100, score))
    result["support_score"] = score

    reclaim_times = [
        value
        for value in (fvg_context.get("reclaim_time"), demand_context.get("reclaim_time"))
        if value
    ]
    if sweep.get("confirmed"):
        reclaim_times.append(_row_time(invalidation_bar))
    if reclaim_times:
        # ISO strings are chronologically sortable because scanner rows use one TZ.
        result["reclaim_time"] = sorted(reclaim_times)[0]

    has_zone_test = bool(
        (fvg_context.get("present") and fvg_context.get("touched"))
        or (demand_context.get("present") and demand_context.get("touched"))
    )
    reclaimed_context = bool(
        sweep.get("confirmed")
        or fvg_context.get("reclaimed")
        or demand_context.get("reclaimed")
    )

    if acceptance.get("failed"):
        verdict = "BREAKDOWN_CONFIRMED"
        possible_premature = False
    elif has_zone_test and reclaimed_context and score >= 45:
        verdict = "POSSIBLE_PREMATURE_INVALIDATION"
        possible_premature = True
    elif has_zone_test:
        verdict = "ZONE_TEST"
        possible_premature = score >= 55
    elif sweep.get("confirmed"):
        verdict = "LIQUIDITY_SWEEP_RECLAIM"
        possible_premature = True
    else:
        verdict = "MECHANICAL_INVALIDATION"
        possible_premature = False

    result["verdict"] = verdict
    result["possible_premature_invalidation"] = possible_premature

    if target_hit_time and possible_premature:
        result["research_outcome"] = "TARGET_AFTER_CONTEXT_RECLAIM"
    elif target_hit_time:
        result["research_outcome"] = "TARGET_AFTER_MECHANICAL_INVALIDATION"
    elif acceptance.get("failed"):
        result["research_outcome"] = "CONTEXT_BREAKDOWN"
    elif possible_premature:
        result["research_outcome"] = "PREMATURE_INVALIDATION_CANDIDATE"

    if reasons:
        result["reason"] = "; ".join(reasons) + "."
    else:
        result["reason"] = "Mechanical invalidation occurred without qualifying bullish support context."

    return result


def flatten_context_fields(context: Dict[str, Any]) -> Dict[str, Any]:
    """Small flat fields for the scanner table/API while keeping full nested data."""
    fvg = context.get("fvg") or {}
    demand = context.get("demand_zone") or {}
    sweep = context.get("liquidity_sweep") or {}
    structure = context.get("structure") or {}
    return {
        "invalidation_context_mode": context.get("mode", CONTEXT_MODE),
        "invalidation_context_verdict": context.get("verdict"),
        "invalidation_context_score": int(context.get("support_score") or 0),
        "possible_premature_invalidation": bool(context.get("possible_premature_invalidation")),
        "invalidation_context_reason": context.get("reason"),
        "invalidation_context_reclaim_time": context.get("reclaim_time"),
        "invalidation_context_research_outcome": context.get("research_outcome"),
        "invalidation_context_fvg": bool(fvg.get("present") and fvg.get("touched")),
        "invalidation_context_fvg_reclaimed": bool(fvg.get("reclaimed")),
        "invalidation_context_demand": bool(demand.get("present") and demand.get("touched")),
        "invalidation_context_demand_reclaimed": bool(demand.get("reclaimed")),
        "invalidation_context_overlap": bool(context.get("fvg_demand_overlap")),
        "invalidation_context_liquidity_sweep": bool(sweep.get("confirmed")),
        "invalidation_context_structure_failed": bool(structure.get("failed")),
    }


__all__ = [
    "CONTEXT_MODE",
    "evaluate_contextual_invalidation",
    "flatten_context_fields",
]
