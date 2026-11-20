from __future__ import annotations

from dataclasses import dataclass
from math import sqrt
from statistics import mean, median
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .market_cache import get_candles, normalize_symbol


@dataclass(frozen=True)
class ResistanceBreakoutParams:
    atr_length: int = 14
    expansion_range_atr: float = 1.50
    expansion_min_body_fraction: float = 0.50
    expansion_min_close_location: float = 0.65
    max_trigger_bars: int = 20
    max_outcome_bars: int = 60
    dedupe_breakout_bar: bool = True


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _wilson_interval(successes: int, total: int, z: float = 1.96) -> Tuple[Optional[float], Optional[float]]:
    if total <= 0:
        return None, None
    p = successes / total
    z2 = z * z
    denom = 1.0 + z2 / total
    center = (p + z2 / (2.0 * total)) / denom
    margin = (z / denom) * sqrt((p * (1.0 - p) / total) + (z2 / (4.0 * total * total)))
    return max(0.0, center - margin), min(1.0, center + margin)


def _percentile(values: Sequence[float], percentile: float) -> Optional[float]:
    clean = sorted(float(value) for value in values if value is not None)
    if not clean:
        return None
    if len(clean) == 1:
        return clean[0]
    pct = max(0.0, min(100.0, float(percentile)))
    position = (len(clean) - 1) * (pct / 100.0)
    lower = int(position)
    upper = min(len(clean) - 1, lower + 1)
    fraction = position - lower
    return clean[lower] + ((clean[upper] - clean[lower]) * fraction)


def _true_range(row: Dict[str, Any], previous_close: Optional[float]) -> float:
    high = _float(row.get("high"))
    low = _float(row.get("low"))
    if high <= 0 or low <= 0 or high < low:
        return 0.0
    if previous_close is None or previous_close <= 0:
        return high - low
    return max(
        high - low,
        abs(high - previous_close),
        abs(low - previous_close),
    )


def _prior_atr(rows: Sequence[Dict[str, Any]], index: int, length: int) -> Optional[float]:
    # Compare the reference candle against ATR known BEFORE that candle closes.
    # This avoids letting the reference candle inflate the denominator used to
    # decide whether it is an expansion candle.
    if length <= 0 or index < length + 1:
        return None

    values: List[float] = []
    start = index - length
    for idx in range(start, index):
        previous_close = _float(rows[idx - 1].get("close")) if idx > 0 else None
        tr = _true_range(rows[idx], previous_close)
        if tr > 0:
            values.append(tr)

    if len(values) < length:
        return None
    return sum(values) / len(values)


def _close_location(row: Dict[str, Any]) -> float:
    high = _float(row.get("high"))
    low = _float(row.get("low"))
    close = _float(row.get("close"))
    span = high - low
    if span <= 0:
        return 0.0
    return (close - low) / span


def _in_setup_date(row: Dict[str, Any], start_date: Optional[str], end_date: Optional[str]) -> bool:
    trade_date = str(row.get("trade_date") or "")[:10]
    if start_date and trade_date < str(start_date)[:10]:
        return False
    if end_date and trade_date > str(end_date)[:10]:
        return False
    return True


def _delay_bucket(delay: Any) -> str:
    value = _int(delay)
    if value <= 1:
        return "1_bar"
    if value <= 3:
        return "2_3_bars"
    if value <= 10:
        return "4_10_bars"
    return "11_plus_bars"


def _atr_bucket(value: Any) -> str:
    ratio = _float(value, -1.0)
    if ratio < 0:
        return "atr_unavailable"
    if ratio < 1.0:
        return "under_1.0_atr"
    if ratio < 1.5:
        return "1.0_1.49_atr"
    if ratio < 2.0:
        return "1.5_1.99_atr"
    return "2.0_plus_atr"


def _evaluate_setup(
    rows: Sequence[Dict[str, Any]],
    ref_index: int,
    breakout_index: int,
    params: ResistanceBreakoutParams,
) -> Dict[str, Any]:
    ref = rows[ref_index]
    breakout = rows[breakout_index]

    ref_high = _float(ref.get("high"))
    ref_low = _float(ref.get("low"))
    ref_range = ref_high - ref_low
    target = ref_high + ref_range
    breakout_close = _float(breakout.get("close"))
    breakout_high = _float(breakout.get("high"))

    target_on_trigger_bar = breakout_high >= target
    target_at_trigger_close = breakout_close >= target

    available_future_bars = max(0, len(rows) - breakout_index - 1)
    bars_to_scan = min(params.max_outcome_bars, available_future_bars)
    horizon_complete = available_future_bars >= params.max_outcome_bars

    first_target_offset: Optional[int] = None
    first_low_break_offset: Optional[int] = None
    first_target_time = None
    first_low_break_time = None
    ambiguous_same_bar = False

    max_high = breakout_close
    min_low = breakout_close
    future_lows: List[float] = []

    # 0% = reference candle high, 50% = midpoint, 100% = reference candle low.
    retracement_depths = (0.0, 0.10, 0.20, 0.25, 0.35, 0.382, 0.50, 0.618, 0.75, 1.0)
    retracement_prices = {
        depth: ref_high - (ref_range * depth)
        for depth in retracement_depths
    }
    first_retracement_touch_offset: Dict[float, Optional[int]] = {
        depth: None for depth in retracement_depths
    }

    window_sizes = [1, 3, 5, 10, 20, 40, 60]
    window_sizes = [size for size in window_sizes if size <= params.max_outcome_bars]
    hit_within: Dict[int, bool] = {size: False for size in window_sizes}

    for offset in range(1, bars_to_scan + 1):
        row = rows[breakout_index + offset]
        high = _float(row.get("high"))
        low = _float(row.get("low"))
        future_lows.append(low)
        max_high = max(max_high, high)
        min_low = min(min_low, low)

        target_here = high >= target
        low_break_here = low < ref_low

        if target_here and first_target_offset is None:
            first_target_offset = offset
            first_target_time = row.get("dt_et")
        if low_break_here and first_low_break_offset is None:
            first_low_break_offset = offset
            first_low_break_time = row.get("dt_et")

        for depth, price in retracement_prices.items():
            if first_retracement_touch_offset[depth] is None and low <= price:
                first_retracement_touch_offset[depth] = offset

        for size in window_sizes:
            if offset <= size and target_here:
                hit_within[size] = True

        if target_here and low_break_here and first_target_offset == offset and first_low_break_offset == offset:
            ambiguous_same_bar = True

    forward_target_hit = first_target_offset is not None
    low_break = first_low_break_offset is not None

    if target_on_trigger_bar:
        structural_outcome = "target_on_trigger"
    elif ambiguous_same_bar and first_target_offset == first_low_break_offset:
        structural_outcome = "ambiguous_same_bar"
    elif forward_target_hit and (first_low_break_offset is None or first_target_offset < first_low_break_offset):
        structural_outcome = "target_before_low"
    elif low_break and (first_target_offset is None or first_low_break_offset < first_target_offset):
        structural_outcome = "low_before_target"
    elif horizon_complete:
        structural_outcome = "timeout"
    else:
        structural_outcome = "unresolved"

    target_distance_from_close = max(0.0, target - breakout_close)
    target_progress = 1.0 if target_distance_from_close <= 0 else max(
        0.0,
        (max_high - breakout_close) / target_distance_from_close,
    )

    mae_pct = None
    if breakout_close > 0:
        mae_pct = max(0.0, (breakout_close - min_low) / breakout_close)

    # Completed-bars-only excludes the target-hit candle because OHLC does not
    # reveal whether that candle's low occurred before or after its high.
    pretarget_completed_min_low = None
    through_target_bar_min_low = None
    pretarget_completed_pullback_pct = None
    through_target_bar_pullback_pct = None
    pretarget_completed_retrace_into_reference_pct = None
    through_target_bar_retrace_into_reference_pct = None

    if first_target_offset is not None:
        lows_before_target_bar = future_lows[: max(0, first_target_offset - 1)]
        lows_through_target_bar = future_lows[:first_target_offset]

        pretarget_completed_min_low = min([breakout_close, *lows_before_target_bar])
        through_target_bar_min_low = min([breakout_close, *lows_through_target_bar])

        if breakout_close > 0:
            pretarget_completed_pullback_pct = max(
                0.0,
                ((breakout_close - pretarget_completed_min_low) / breakout_close) * 100.0,
            )
            through_target_bar_pullback_pct = max(
                0.0,
                ((breakout_close - through_target_bar_min_low) / breakout_close) * 100.0,
            )

        if ref_range > 0:
            pretarget_completed_retrace_into_reference_pct = max(
                0.0,
                ((ref_high - pretarget_completed_min_low) / ref_range) * 100.0,
            )
            through_target_bar_retrace_into_reference_pct = max(
                0.0,
                ((ref_high - through_target_bar_min_low) / ref_range) * 100.0,
            )

    retracement_level_first_touch_bars = {
        f"{depth * 100.0:g}": first_retracement_touch_offset[depth]
        for depth in retracement_depths
    }
    retracement_level_prices = {
        f"{depth * 100.0:g}": round(retracement_prices[depth], 6)
        for depth in retracement_depths
    }

    return {
        "target": round(target, 6),
        "breakout_close": round(breakout_close, 6),
        "target_on_trigger_bar": target_on_trigger_bar,
        "target_at_trigger_close": target_at_trigger_close,
        "forward_eligible": not target_on_trigger_bar,
        "forward_target_hit": forward_target_hit,
        "bars_to_target": first_target_offset,
        "target_hit_time": first_target_time,
        "reference_low_broken": low_break,
        "bars_to_reference_low_break": first_low_break_offset,
        "reference_low_break_time": first_low_break_time,
        "ambiguous_same_bar": ambiguous_same_bar,
        "structural_outcome": structural_outcome,
        "available_future_bars": available_future_bars,
        "evaluated_future_bars": bars_to_scan,
        "horizon_complete": horizon_complete,
        "max_high_after_breakout": round(max_high, 6),
        "min_low_after_breakout": round(min_low, 6),
        "target_progress": round(target_progress, 6),
        "mae_pct": round(mae_pct, 6) if mae_pct is not None else None,
        "pretarget_completed_min_low": round(pretarget_completed_min_low, 6) if pretarget_completed_min_low is not None else None,
        "through_target_bar_min_low": round(through_target_bar_min_low, 6) if through_target_bar_min_low is not None else None,
        "pretarget_completed_pullback_from_confirmation_pct": round(pretarget_completed_pullback_pct, 4) if pretarget_completed_pullback_pct is not None else None,
        "through_target_bar_pullback_from_confirmation_pct": round(through_target_bar_pullback_pct, 4) if through_target_bar_pullback_pct is not None else None,
        "pretarget_completed_retrace_into_reference_pct": round(pretarget_completed_retrace_into_reference_pct, 4) if pretarget_completed_retrace_into_reference_pct is not None else None,
        "through_target_bar_retrace_into_reference_pct": round(through_target_bar_retrace_into_reference_pct, 4) if through_target_bar_retrace_into_reference_pct is not None else None,
        "retracement_level_prices": retracement_level_prices,
        "retracement_level_first_touch_bars": retracement_level_first_touch_bars,
        "hit_within_bars": {str(size): hit_within[size] for size in window_sizes},
    }


def _build_symbol_setups(
    symbol: str,
    timeframe: str,
    rows: Sequence[Dict[str, Any]],
    params: ResistanceBreakoutParams,
    start_date: Optional[str],
    end_date: Optional[str],
) -> List[Dict[str, Any]]:
    if len(rows) < max(params.atr_length + 2, 4):
        return []

    candidates: List[Dict[str, Any]] = []

    for ref_index, ref in enumerate(rows[:-1]):
        if not _in_setup_date(ref, start_date, end_date):
            continue

        open_price = _float(ref.get("open"))
        close = _float(ref.get("close"))
        high = _float(ref.get("high"))
        low = _float(ref.get("low"))
        if min(open_price, close, high, low) <= 0 or high <= low or close <= open_price:
            continue

        span = high - low
        body = close - open_price
        body_fraction = body / span if span > 0 else 0.0
        close_location = _close_location(ref)
        atr = _prior_atr(rows, ref_index, params.atr_length)
        range_atr = (span / atr) if atr and atr > 0 else None
        is_expansion = bool(
            range_atr is not None
            and range_atr >= params.expansion_range_atr
            and body_fraction >= params.expansion_min_body_fraction
            and close_location >= params.expansion_min_close_location
        )

        breakout_index: Optional[int] = None
        low_broken_before_trigger = False
        trigger_end = min(len(rows) - 1, ref_index + params.max_trigger_bars)

        for idx in range(ref_index + 1, trigger_end + 1):
            row = rows[idx]
            if _float(row.get("low")) < low:
                low_broken_before_trigger = True
            if _float(row.get("close")) > high:
                breakout_index = idx
                break

        if breakout_index is None:
            continue

        breakout = rows[breakout_index]
        evaluated = _evaluate_setup(rows, ref_index, breakout_index, params)
        setup = {
            "symbol": normalize_symbol(symbol),
            "timeframe": timeframe.lower(),
            "reference_index": ref_index,
            "reference_time": ref.get("dt_et"),
            "reference_trade_date": str(ref.get("trade_date") or "")[:10],
            "reference_open": round(open_price, 6),
            "reference_high": round(high, 6),
            "reference_low": round(low, 6),
            "reference_close": round(close, 6),
            "reference_volume": round(_float(ref.get("volume")), 2),
            "reference_range": round(span, 6),
            "reference_range_pct": round((span / low) * 100.0, 4) if low > 0 else None,
            "reference_body_fraction": round(body_fraction, 6),
            "reference_close_location": round(close_location, 6),
            "prior_atr": round(atr, 6) if atr is not None else None,
            "reference_range_atr": round(range_atr, 6) if range_atr is not None else None,
            "is_expansion": is_expansion,
            "breakout_index": breakout_index,
            "breakout_time": breakout.get("dt_et"),
            "breakout_trade_date": str(breakout.get("trade_date") or "")[:10],
            "breakout_delay_bars": breakout_index - ref_index,
            "breakout_open": round(_float(breakout.get("open")), 6),
            "breakout_high": round(_float(breakout.get("high")), 6),
            "breakout_low": round(_float(breakout.get("low")), 6),
            "breakout_close": round(_float(breakout.get("close")), 6),
            "low_broken_before_trigger": low_broken_before_trigger,
            **evaluated,
        }
        candidates.append(setup)

    if not params.dedupe_breakout_bar:
        return candidates

    # A single confirmation bar can close above several older green candles.
    # To avoid counting that one market event many times, keep only the newest
    # reference candle for each confirmation bar.
    newest_by_breakout: Dict[int, Dict[str, Any]] = {}
    for row in candidates:
        breakout_index = _int(row.get("breakout_index"))
        existing = newest_by_breakout.get(breakout_index)
        if existing is None or _int(row.get("reference_index")) > _int(existing.get("reference_index")):
            newest_by_breakout[breakout_index] = row

    return [newest_by_breakout[key] for key in sorted(newest_by_breakout)]


def _retracement_summary(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    forward_rows = [row for row in rows if bool(row.get("forward_eligible"))]
    structural_winners = [
        row for row in forward_rows
        if row.get("structural_outcome") == "target_before_low"
        and row.get("bars_to_target") is not None
    ]

    completed_ref_depths = [
        _float(row.get("pretarget_completed_retrace_into_reference_pct"))
        for row in structural_winners
        if row.get("pretarget_completed_retrace_into_reference_pct") is not None
    ]
    through_ref_depths = [
        _float(row.get("through_target_bar_retrace_into_reference_pct"))
        for row in structural_winners
        if row.get("through_target_bar_retrace_into_reference_pct") is not None
    ]
    completed_pullbacks = [
        _float(row.get("pretarget_completed_pullback_from_confirmation_pct"))
        for row in structural_winners
        if row.get("pretarget_completed_pullback_from_confirmation_pct") is not None
    ]
    through_pullbacks = [
        _float(row.get("through_target_bar_pullback_from_confirmation_pct"))
        for row in structural_winners
        if row.get("through_target_bar_pullback_from_confirmation_pct") is not None
    ]

    thresholds = (0.0, 25.0, 38.2, 50.0, 61.8, 75.0, 100.0)
    winner_depth_distribution: Dict[str, Dict[str, Any]] = {}
    for threshold in thresholds:
        count = sum(1 for value in completed_ref_depths if value <= threshold + 1e-9)
        winner_depth_distribution[f"{threshold:g}"] = {
            "max_retracement_depth_pct": threshold,
            "winners_within_depth": count,
            "winner_count": len(completed_ref_depths),
            "pct_of_winners": round((count / len(completed_ref_depths)) * 100.0, 2) if completed_ref_depths else None,
        }

    stop_tests: Dict[str, Dict[str, Any]] = {}
    for threshold in thresholds:
        key = f"{threshold:g}"
        target_first = 0
        retracement_first = 0
        ambiguous = 0
        timeout = 0
        unresolved = 0

        for row in forward_rows:
            target_offset = row.get("bars_to_target")
            touch_offset = (row.get("retracement_level_first_touch_bars") or {}).get(key)
            horizon_complete = bool(row.get("horizon_complete"))

            if target_offset is not None and (touch_offset is None or _int(target_offset) < _int(touch_offset)):
                target_first += 1
            elif touch_offset is not None and (target_offset is None or _int(touch_offset) < _int(target_offset)):
                retracement_first += 1
            elif target_offset is not None and touch_offset is not None and _int(target_offset) == _int(touch_offset):
                ambiguous += 1
            elif horizon_complete:
                timeout += 1
            else:
                unresolved += 1

        resolved = target_first + retracement_first
        low, high = _wilson_interval(target_first, resolved)
        stop_tests[key] = {
            "retracement_depth_pct": threshold,
            "level_definition": "reference_high - (reference_high - reference_low) * depth",
            "target_before_retracement_level": target_first,
            "retracement_level_before_target": retracement_first,
            "ambiguous_same_bar": ambiguous,
            "timeouts": timeout,
            "unresolved": unresolved,
            "resolved": resolved,
            "target_before_level_rate": round(target_first / resolved, 4) if resolved else None,
            "target_before_level_rate_pct": round((target_first / resolved) * 100.0, 2) if resolved else None,
            "wilson_95_low_pct": round(low * 100.0, 2) if low is not None else None,
            "wilson_95_high_pct": round(high * 100.0, 2) if high is not None else None,
        }

    def distribution(values: Sequence[float]) -> Dict[str, Any]:
        return {
            "count": len(values),
            "average": round(mean(values), 2) if values else None,
            "median": round(median(values), 2) if values else None,
            "p25": round(_percentile(values, 25.0), 2) if values else None,
            "p75": round(_percentile(values, 75.0), 2) if values else None,
            "p90": round(_percentile(values, 90.0), 2) if values else None,
            "p95": round(_percentile(values, 95.0), 2) if values else None,
        }

    invalidated_rows = [
        row for row in forward_rows if row.get("structural_outcome") == "low_before_target"
    ]
    bars_to_invalidation = [
        _int(row.get("bars_to_reference_low_break"))
        for row in invalidated_rows
        if row.get("bars_to_reference_low_break") is not None
    ]

    return {
        "definition": {
            "reference_candle_depth": "0% = reference high, 50% = midpoint of reference candle range, 100% = reference low.",
            "completed_bars_only": "Measures lows only on fully completed bars before the target-hit bar; avoids assuming intrabar order from OHLC.",
            "through_target_bar": "Includes the target-hit bar low; conservative upper bound because OHLC cannot reveal whether low occurred before or after target.",
            "stop_test": "Compares which occurs first after confirmation close: target or retracement depth. Same-bar events are excluded from resolved rate.",
        },
        "forward_eligible_setups": len(forward_rows),
        "target_before_reference_low_winners": len(structural_winners),
        "winner_retracement_into_reference_completed_bars_pct": distribution(completed_ref_depths),
        "winner_retracement_into_reference_through_target_bar_pct": distribution(through_ref_depths),
        "winner_pullback_from_confirmation_close_completed_bars_pct": distribution(completed_pullbacks),
        "winner_pullback_from_confirmation_close_through_target_bar_pct": distribution(through_pullbacks),
        "winner_completed_bar_depth_distribution": winner_depth_distribution,
        "target_before_retracement_level": stop_tests,
        "invalidations": {
            "low_before_target_count": len(invalidated_rows),
            "avg_bars_to_reference_low_break": round(mean(bars_to_invalidation), 2) if bars_to_invalidation else None,
            "median_bars_to_reference_low_break": round(median(bars_to_invalidation), 2) if bars_to_invalidation else None,
        },
    }


def _entry_rr_summary(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Evaluate pullback-limit entries and stop depths after confirmation.

    Entry and stop depths are percentages of the original bullish reference
    candle range measured down from its high. 0% = reference high and
    100% = reference low. Only bars AFTER the confirmation candle are used.
    Same-bar ordering that cannot be known from OHLC is kept ambiguous.
    """
    forward_rows = [row for row in rows if bool(row.get("forward_eligible"))]
    entry_depths = (0.0, 10.0, 20.0, 25.0, 35.0, 38.2, 50.0, 61.8, 75.0)
    stop_depths = (25.0, 35.0, 38.2, 50.0, 61.8, 75.0, 100.0)

    entry_fill: Dict[str, Dict[str, Any]] = {}
    pair_results: List[Dict[str, Any]] = []

    def _touch(row: Dict[str, Any], depth: float) -> Optional[int]:
        value = (row.get("retracement_level_first_touch_bars") or {}).get(f"{depth:g}")
        return _int(value) if value is not None else None

    for entry_depth in entry_depths:
        key = f"{entry_depth:g}"
        filled_before_target = 0
        target_before_fill = 0
        ambiguous_same_bar = 0
        no_fill_no_target = 0
        fill_bars: List[int] = []

        for row in forward_rows:
            entry_offset = _touch(row, entry_depth)
            target_raw = row.get("bars_to_target")
            target_offset = _int(target_raw) if target_raw is not None else None

            if entry_offset is not None and (target_offset is None or entry_offset < target_offset):
                filled_before_target += 1
                fill_bars.append(entry_offset)
            elif target_offset is not None and (entry_offset is None or target_offset < entry_offset):
                target_before_fill += 1
            elif entry_offset is not None and target_offset is not None and entry_offset == target_offset:
                ambiguous_same_bar += 1
            else:
                no_fill_no_target += 1

        total = len(forward_rows)
        entry_fill[key] = {
            "entry_depth_pct": entry_depth,
            "entry_definition": "reference_high - reference_range * entry_depth",
            "forward_eligible_setups": total,
            "filled_before_target": filled_before_target,
            "fill_rate_pct": round((filled_before_target / total) * 100.0, 2) if total else None,
            "target_before_fill": target_before_fill,
            "target_before_fill_pct": round((target_before_fill / total) * 100.0, 2) if total else None,
            "ambiguous_fill_and_target_same_bar": ambiguous_same_bar,
            "no_fill_and_no_target_within_horizon": no_fill_no_target,
            "avg_bars_to_fill": round(mean(fill_bars), 2) if fill_bars else None,
            "median_bars_to_fill": round(median(fill_bars), 2) if fill_bars else None,
        }

        for stop_depth in stop_depths:
            if stop_depth <= entry_depth:
                continue

            # Because target = high + one reference range, entry = high - E*range,
            # and stop = high - S*range, R:R depends only on E and S.
            reward_units = 1.0 + (entry_depth / 100.0)
            risk_units = (stop_depth - entry_depth) / 100.0
            rr = reward_units / risk_units if risk_units > 0 else None
            breakeven = (1.0 / (1.0 + rr)) if rr and rr > 0 else None

            filled = 0
            wins = 0
            losses = 0
            ambiguous_entry_stop = 0
            ambiguous_target_stop = 0
            timeouts = 0
            unresolved = 0
            bars_held_wins: List[int] = []
            bars_held_losses: List[int] = []

            for row in forward_rows:
                entry_offset = _touch(row, entry_depth)
                stop_offset = _touch(row, stop_depth)
                target_raw = row.get("bars_to_target")
                target_offset = _int(target_raw) if target_raw is not None else None

                # A target before the limit entry means the trade was missed.
                # Same-bar target+entry is not assumed filled first.
                if entry_offset is None:
                    continue
                if target_offset is not None and target_offset <= entry_offset:
                    continue

                filled += 1

                # If entry and deeper stop were both touched on the entry bar,
                # OHLC cannot prove whether the limit filled before the stop.
                if stop_offset is not None and stop_offset == entry_offset:
                    ambiguous_entry_stop += 1
                    continue

                if target_offset is not None and stop_offset is not None:
                    if target_offset < stop_offset:
                        wins += 1
                        bars_held_wins.append(max(0, target_offset - entry_offset))
                    elif stop_offset < target_offset:
                        losses += 1
                        bars_held_losses.append(max(0, stop_offset - entry_offset))
                    else:
                        ambiguous_target_stop += 1
                elif target_offset is not None:
                    wins += 1
                    bars_held_wins.append(max(0, target_offset - entry_offset))
                elif stop_offset is not None:
                    losses += 1
                    bars_held_losses.append(max(0, stop_offset - entry_offset))
                elif bool(row.get("horizon_complete")):
                    timeouts += 1
                else:
                    unresolved += 1

            resolved = wins + losses
            win_rate = (wins / resolved) if resolved else None
            wilson_low, wilson_high = _wilson_interval(wins, resolved)
            expectancy_r = ((wins * rr) - losses) / resolved if resolved and rr is not None else None
            expectancy_per_filled = ((wins * rr) - losses) / filled if filled and rr is not None else None
            expectancy_per_setup = ((wins * rr) - losses) / len(forward_rows) if forward_rows and rr is not None else None
            profit_factor = (wins * rr) / losses if losses > 0 and rr is not None else (None if wins == 0 else float("inf"))

            pair_results.append({
                "entry_depth_pct": entry_depth,
                "stop_depth_pct": stop_depth,
                "theoretical_reward_risk": round(rr, 3) if rr is not None else None,
                "breakeven_win_rate_pct": round(breakeven * 100.0, 2) if breakeven is not None else None,
                "filled_setups": filled,
                "wins": wins,
                "losses": losses,
                "resolved_trades": resolved,
                "win_rate_pct": round(win_rate * 100.0, 2) if win_rate is not None else None,
                "wilson_95_low_pct": round(wilson_low * 100.0, 2) if wilson_low is not None else None,
                "wilson_95_high_pct": round(wilson_high * 100.0, 2) if wilson_high is not None else None,
                "expectancy_r_per_resolved_trade": round(expectancy_r, 3) if expectancy_r is not None else None,
                "expectancy_r_per_filled_setup_unresolved_zero": round(expectancy_per_filled, 3) if expectancy_per_filled is not None else None,
                "expectancy_r_per_forward_setup_unfilled_zero": round(expectancy_per_setup, 3) if expectancy_per_setup is not None else None,
                "profit_factor_r": round(profit_factor, 3) if profit_factor is not None and profit_factor != float("inf") else ("inf" if profit_factor == float("inf") else None),
                "ambiguous_entry_and_stop_same_bar": ambiguous_entry_stop,
                "ambiguous_target_and_stop_same_bar": ambiguous_target_stop,
                "timeouts_after_fill": timeouts,
                "unresolved_after_fill": unresolved,
                "avg_bars_held_winners": round(mean(bars_held_wins), 2) if bars_held_wins else None,
                "median_bars_held_winners": round(median(bars_held_wins), 2) if bars_held_wins else None,
                "avg_bars_held_losses": round(mean(bars_held_losses), 2) if bars_held_losses else None,
                "median_bars_held_losses": round(median(bars_held_losses), 2) if bars_held_losses else None,
            })

    ranked = [
        row for row in pair_results
        if _int(row.get("resolved_trades")) >= 30
        and row.get("expectancy_r_per_forward_setup_unfilled_zero") is not None
    ]
    ranked.sort(
        key=lambda row: (
            _float(row.get("expectancy_r_per_forward_setup_unfilled_zero"), -999.0),
            _float(row.get("expectancy_r_per_resolved_trade"), -999.0),
            _int(row.get("resolved_trades")),
        ),
        reverse=True,
    )

    return {
        "definition": {
            "entry": "After confirmation closes, place a limit entry at reference_high - reference_range * entry_depth.",
            "fill_rate": "Definite entry touches that occur on a bar before the FX target bar, divided by all forward-eligible setups. Same-bar entry+target events are ambiguous and not counted as fills.",
            "stop": "Stop is reference_high - reference_range * stop_depth and must be deeper than the entry.",
            "reward_risk": "Target is the FX Resistance target. One loss is -1R; a target win earns the theoretical target-to-stop R multiple.",
            "expectancy": "Resolved-trade expectancy excludes ambiguous/timeouts. Per-forward-setup expectancy treats unfilled, ambiguous, timeout, and unresolved cases as 0R. Fees, slippage, gaps, and partial fills are not modeled.",
        },
        "forward_eligible_setups": len(forward_rows),
        "entry_fill_rates": entry_fill,
        "entry_stop_matrix": pair_results,
        "top_by_expectancy_per_forward_setup_min_30_resolved": ranked[:10],
    }


def _summarize(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    setups = len(rows)
    on_trigger = sum(1 for row in rows if bool(row.get("target_on_trigger_bar")))
    forward_rows = [row for row in rows if bool(row.get("forward_eligible"))]

    forward_hits = sum(1 for row in forward_rows if bool(row.get("forward_target_hit")))
    complete_forward = [
        row for row in forward_rows
        if bool(row.get("forward_target_hit")) or bool(row.get("horizon_complete"))
    ]
    forward_misses = sum(1 for row in complete_forward if not bool(row.get("forward_target_hit")))
    forward_total = len(complete_forward)
    forward_low, forward_high = _wilson_interval(forward_hits, forward_total)

    structural_hits = sum(1 for row in forward_rows if row.get("structural_outcome") == "target_before_low")
    structural_fails = sum(1 for row in forward_rows if row.get("structural_outcome") == "low_before_target")
    structural_ambiguous = sum(1 for row in forward_rows if row.get("structural_outcome") == "ambiguous_same_bar")
    structural_timeouts = sum(1 for row in forward_rows if row.get("structural_outcome") == "timeout")
    structural_unresolved = sum(1 for row in forward_rows if row.get("structural_outcome") == "unresolved")
    structural_total = structural_hits + structural_fails
    structural_low, structural_high = _wilson_interval(structural_hits, structural_total)

    bars_to_target = [
        _int(row.get("bars_to_target"))
        for row in forward_rows
        if row.get("bars_to_target") is not None
    ]
    target_progress_values = [
        _float(row.get("target_progress"))
        for row in forward_rows
        if row.get("target_progress") is not None
    ]
    mae_values = [
        _float(row.get("mae_pct"))
        for row in forward_rows
        if row.get("mae_pct") is not None
    ]

    window_sizes = sorted({
        int(size)
        for row in forward_rows
        for size in (row.get("hit_within_bars") or {}).keys()
    })
    hit_within_summary: Dict[str, Dict[str, Any]] = {}
    for size in window_sizes:
        eligible = [
            row for row in forward_rows
            if bool((row.get("hit_within_bars") or {}).get(str(size)))
            or _int(row.get("available_future_bars")) >= size
        ]
        hits = sum(1 for row in eligible if bool((row.get("hit_within_bars") or {}).get(str(size))))
        low, high = _wilson_interval(hits, len(eligible))
        hit_within_summary[str(size)] = {
            "eligible_setups": len(eligible),
            "target_hits": hits,
            "hit_rate": round(hits / len(eligible), 4) if eligible else None,
            "hit_rate_pct": round((hits / len(eligible)) * 100.0, 2) if eligible else None,
            "wilson_95_low_pct": round(low * 100.0, 2) if low is not None else None,
            "wilson_95_high_pct": round(high * 100.0, 2) if high is not None else None,
        }

    return {
        "setups": setups,
        "target_already_hit_on_confirmation_bar": on_trigger,
        "forward_eligible_setups": len(forward_rows),
        "forward_horizon_resolved": forward_total,
        "forward_target_hits": forward_hits,
        "forward_target_misses": forward_misses,
        "forward_hit_rate": round(forward_hits / forward_total, 4) if forward_total else None,
        "forward_hit_rate_pct": round((forward_hits / forward_total) * 100.0, 2) if forward_total else None,
        "forward_wilson_95_low_pct": round(forward_low * 100.0, 2) if forward_low is not None else None,
        "forward_wilson_95_high_pct": round(forward_high * 100.0, 2) if forward_high is not None else None,
        "target_before_reference_low": structural_hits,
        "reference_low_before_target": structural_fails,
        "ambiguous_same_bar": structural_ambiguous,
        "structural_timeouts": structural_timeouts,
        "structural_unresolved": structural_unresolved,
        "structural_resolved": structural_total,
        "target_before_low_rate": round(structural_hits / structural_total, 4) if structural_total else None,
        "target_before_low_rate_pct": round((structural_hits / structural_total) * 100.0, 2) if structural_total else None,
        "structural_wilson_95_low_pct": round(structural_low * 100.0, 2) if structural_low is not None else None,
        "structural_wilson_95_high_pct": round(structural_high * 100.0, 2) if structural_high is not None else None,
        "avg_bars_to_target": round(mean(bars_to_target), 2) if bars_to_target else None,
        "median_bars_to_target": round(median(bars_to_target), 2) if bars_to_target else None,
        "avg_target_progress_pct": round(mean(target_progress_values) * 100.0, 2) if target_progress_values else None,
        "median_target_progress_pct": round(median(target_progress_values) * 100.0, 2) if target_progress_values else None,
        "avg_mae_pct": round(mean(mae_values) * 100.0, 2) if mae_values else None,
        "retracement": _retracement_summary(rows),
        "hit_within_bars": hit_within_summary,
    }


def _bucket_summary(
    rows: Sequence[Dict[str, Any]],
    bucket_fn: Callable[[Dict[str, Any]], str],
) -> Dict[str, Any]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        key = str(bucket_fn(row))
        grouped.setdefault(key, []).append(row)
    return {key: _summarize(value) for key, value in sorted(grouped.items())}


def run_resistance_breakout_backtest(
    symbols: Sequence[str],
    *,
    timeframe: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    atr_length: int = 14,
    expansion_range_atr: float = 1.50,
    expansion_min_body_fraction: float = 0.50,
    expansion_min_close_location: float = 0.65,
    max_trigger_bars: int = 20,
    max_outcome_bars: int = 60,
    dedupe_breakout_bar: bool = True,
    example_limit: int = 100,
) -> Dict[str, Any]:
    params = ResistanceBreakoutParams(
        atr_length=max(2, int(atr_length)),
        expansion_range_atr=max(0.0, float(expansion_range_atr)),
        expansion_min_body_fraction=max(0.0, min(1.0, float(expansion_min_body_fraction))),
        expansion_min_close_location=max(0.0, min(1.0, float(expansion_min_close_location))),
        max_trigger_bars=max(1, int(max_trigger_bars)),
        max_outcome_bars=max(1, int(max_outcome_bars)),
        dedupe_breakout_bar=bool(dedupe_breakout_bar),
    )

    clean_symbols: List[str] = []
    for raw in symbols or []:
        symbol = normalize_symbol(raw)
        if symbol and symbol not in clean_symbols:
            clean_symbols.append(symbol)

    all_setups: List[Dict[str, Any]] = []
    symbol_stats: Dict[str, Dict[str, Any]] = {}
    symbols_with_data = 0

    for symbol in clean_symbols:
        # Load all cached rows so warmup bars before start_date and outcome bars
        # after end_date remain available. setup-date filtering is applied below.
        rows = get_candles(symbol, timeframe)
        if not rows:
            symbol_stats[symbol] = {"bars": 0, "setups": 0}
            continue
        symbols_with_data += 1
        setups = _build_symbol_setups(
            symbol,
            timeframe,
            rows,
            params,
            start_date,
            end_date,
        )
        all_setups.extend(setups)
        symbol_stats[symbol] = {
            "bars": len(rows),
            "first_date": str(rows[0].get("trade_date") or "")[:10],
            "last_date": str(rows[-1].get("trade_date") or "")[:10],
            "setups": len(setups),
            "expansion_setups": sum(1 for row in setups if bool(row.get("is_expansion"))),
        }

    all_setups.sort(key=lambda row: (_int(row.get("breakout_index")), str(row.get("breakout_time") or ""), str(row.get("symbol") or "")))
    expansion_setups = [row for row in all_setups if bool(row.get("is_expansion"))]
    low_intact_setups = [row for row in all_setups if not bool(row.get("low_broken_before_trigger"))]

    examples = sorted(
        all_setups,
        key=lambda row: str(row.get("breakout_time") or ""),
        reverse=True,
    )[: max(1, int(example_limit))]

    return {
        "ok": True,
        "study": "bullish_candle_close_above_high_to_fx_resistance",
        "definition": {
            "reference_candle": "Bullish candle where close > open.",
            "confirmation": "First later candle within max_trigger_bars whose CLOSE is above the reference candle HIGH.",
            "fx_resistance_target": "reference_high + (reference_high - reference_low)",
            "forward_test": "Target must trade after the confirmation candle closes; target touches on the confirmation candle are reported separately.",
            "structural_failure": "Reference candle low trades below before the target. Same-bar target+low touches are ambiguous and excluded from the structural win-rate denominator.",
            "retracement_measurement": "0% = reference high, 50% = midpoint, 100% = reference low. Target-vs-retracement tests begin only after the confirmation candle closes.",
            "expansion_variant": "Reference range >= expansion_range_atr x prior ATR, body/range >= expansion_min_body_fraction, and close location >= expansion_min_close_location.",
        },
        "timeframe": timeframe.lower(),
        "start_date": str(start_date)[:10] if start_date else None,
        "end_date": str(end_date)[:10] if end_date else None,
        "parameters": {
            "atr_length": params.atr_length,
            "expansion_range_atr": params.expansion_range_atr,
            "expansion_min_body_fraction": params.expansion_min_body_fraction,
            "expansion_min_close_location": params.expansion_min_close_location,
            "max_trigger_bars": params.max_trigger_bars,
            "max_outcome_bars": params.max_outcome_bars,
            "dedupe_breakout_bar": params.dedupe_breakout_bar,
        },
        "universe": {
            "symbols_requested": len(clean_symbols),
            "symbols_with_cached_data": symbols_with_data,
            "symbols_without_cached_data": len(clean_symbols) - symbols_with_data,
        },
        "summary": {
            "all_green": _summarize(all_setups),
            "expansion_green": _summarize(expansion_setups),
            "low_intact_before_breakout": _summarize(low_intact_setups),
        },
        "entry_rr": {
            "all_green": _entry_rr_summary(all_setups),
            "expansion_green": _entry_rr_summary(expansion_setups),
            "low_intact_before_breakout": _entry_rr_summary(low_intact_setups),
        },
        "breakdowns": {
            "all_green_by_breakout_delay": _bucket_summary(all_setups, lambda row: _delay_bucket(row.get("breakout_delay_bars"))),
            "all_green_by_reference_range_atr": _bucket_summary(all_setups, lambda row: _atr_bucket(row.get("reference_range_atr"))),
            "all_green_by_pretrigger_low_status": _bucket_summary(
                all_setups,
                lambda row: "low_broken_before_trigger" if bool(row.get("low_broken_before_trigger")) else "low_intact_before_trigger",
            ),
            "expansion_by_breakout_delay": _bucket_summary(expansion_setups, lambda row: _delay_bucket(row.get("breakout_delay_bars"))),
        },
        "symbol_stats": symbol_stats,
        "examples": examples,
    }


__all__ = [
    "ResistanceBreakoutParams",
    "run_resistance_breakout_backtest",
]
