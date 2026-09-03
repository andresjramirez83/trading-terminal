from __future__ import annotations

from dataclasses import dataclass
from math import sqrt
from statistics import mean, median
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .market_cache import get_candles, normalize_symbol


@dataclass(frozen=True)
class FibContinuationParams:
    min_range_pct: float = 12.0
    min_body_pct: float = 6.0
    min_close_location: float = 0.65
    min_volume: float = 50_000.0
    retrace_min: float = 0.50
    retrace_max: float = 0.70
    max_retrace: float = 0.786
    min_hold_bars: int = 12
    min_hold_sessions: int = 1
    max_setup_sessions: int = 6
    target_sessions: int = 5
    cooldown_bars: int = 12
    fib_lookback_bars: int = 6


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
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


def _unique_dates(rows: Sequence[Dict[str, Any]]) -> List[str]:
    out: List[str] = []
    seen = set()
    for row in rows:
        day = str(row.get("trade_date") or "")[:10]
        if day and day not in seen:
            seen.add(day)
            out.append(day)
    return out


def _session_index_map(rows: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    return {day: idx for idx, day in enumerate(_unique_dates(rows))}


def _bar_close_location(row: Dict[str, Any]) -> float:
    low = _float(row.get("low"))
    high = _float(row.get("high"))
    close = _float(row.get("close"))
    span = high - low
    if span <= 0:
        return 0.0
    return (close - low) / span


def _is_expansion(row: Dict[str, Any], params: FibContinuationParams) -> bool:
    open_price = _float(row.get("open"))
    high = _float(row.get("high"))
    low = _float(row.get("low"))
    close = _float(row.get("close"))
    volume = _float(row.get("volume"))
    if min(open_price, high, low, close) <= 0 or close <= open_price or high <= low:
        return False

    range_pct = ((high - low) / low) * 100.0
    body_pct = ((close - open_price) / open_price) * 100.0
    return (
        range_pct >= params.min_range_pct
        and body_pct >= params.min_body_pct
        and _bar_close_location(row) >= params.min_close_location
        and volume >= params.min_volume
    )


def _progress_to_target(entry: float, target: float, max_high: float) -> float:
    distance = target - entry
    if distance <= 0:
        return 1.0 if max_high >= target else 0.0
    return max(0.0, (max_high - entry) / distance)


def _summarize(rows: Sequence[Dict[str, Any]], key: str = "target_hit") -> Dict[str, Any]:
    total = len(rows)
    resolved_rows = [row for row in rows if str(row.get("outcome_status") or "").lower() != "unresolved"]
    unresolved = total - len(resolved_rows)
    resolved = len(resolved_rows)
    hits = sum(1 for row in resolved_rows if bool(row.get(key)))
    misses = max(0, resolved - hits)
    low, high = _wilson_interval(hits, resolved)
    progress_values = [
        _float(row.get("target_progress"))
        for row in resolved_rows
        if row.get("target_progress") is not None
    ]
    return {
        "setups": total,
        "resolved_setups": resolved,
        "unresolved_setups": unresolved,
        "target_hits": hits,
        "target_misses": misses,
        "hit_rate_denominator": resolved,
        "hit_rate": round(hits / resolved, 4) if resolved else None,
        "hit_rate_pct": round((hits / resolved) * 100.0, 2) if resolved else None,
        "wilson_95_low_pct": round(low * 100.0, 2) if low is not None else None,
        "wilson_95_high_pct": round(high * 100.0, 2) if high is not None else None,
        "avg_target_progress_pct": round(mean(progress_values) * 100.0, 2) if progress_values else None,
        "median_target_progress_pct": round(median(progress_values) * 100.0, 2) if progress_values else None,
    }


def _bucket_summary(rows: Sequence[Dict[str, Any]], bucket_fn) -> Dict[str, Any]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        bucket = str(bucket_fn(row))
        grouped.setdefault(bucket, []).append(row)
    return {key: _summarize(value) for key, value in sorted(grouped.items())}


def _future_window_end_index(
    rows: Sequence[Dict[str, Any]],
    start_index: int,
    session_map: Dict[str, int],
    max_sessions: int,
) -> int:
    start_day = str(rows[start_index].get("trade_date") or "")[:10]
    start_session = session_map.get(start_day, 0)
    end = start_index
    for idx in range(start_index, len(rows)):
        day = str(rows[idx].get("trade_date") or "")[:10]
        session = session_map.get(day, start_session)
        if session - start_session > max_sessions:
            break
        end = idx
    return end


def _evaluate_target(
    rows: Sequence[Dict[str, Any]],
    breakout_index: int,
    target: float,
    fib_618: float,
    fib_786: float,
    target_sessions: int,
    session_map: Dict[str, int],
) -> Dict[str, Any]:
    if breakout_index >= len(rows) - 1:
        return {
            "outcome_status": "unresolved",
            "evaluation_complete": False,
            "sessions_observed_after_breakout": 0,
            "target_hit": False,
            "target_hit_time": None,
            "target_hit_session": None,
            "target_before_close_below_618": False,
            "target_before_low_below_786": False,
            "close_below_618_time": None,
            "low_below_786_time": None,
            "max_high": _float(rows[breakout_index].get("close")),
            "target_progress": 0.0,
        }

    entry = _float(rows[breakout_index].get("close"))
    start_day = str(rows[breakout_index].get("trade_date") or "")[:10]
    start_session = session_map.get(start_day, 0)
    end_index = _future_window_end_index(rows, breakout_index + 1, session_map, target_sessions)
    last_day = str(rows[-1].get("trade_date") or "")[:10]
    last_session = session_map.get(last_day, start_session)
    sessions_observed_after_breakout = max(0, last_session - start_session)

    target_hit_time = None
    target_hit_session = None
    close_below_618_time = None
    low_below_786_time = None
    max_high = entry

    for idx in range(breakout_index + 1, end_index + 1):
        row = rows[idx]
        high = _float(row.get("high"))
        low = _float(row.get("low"))
        close = _float(row.get("close"))
        max_high = max(max_high, high)

        if close_below_618_time is None and close < fib_618:
            close_below_618_time = row.get("dt_et")
        if low_below_786_time is None and low < fib_786:
            low_below_786_time = row.get("dt_et")

        if target_hit_time is None and high >= target:
            target_hit_time = row.get("dt_et")
            day = str(row.get("trade_date") or "")[:10]
            target_hit_session = session_map.get(day, start_session) - start_session
            break

    target_hit = target_hit_time is not None
    evaluation_complete = target_hit or sessions_observed_after_breakout >= target_sessions
    outcome_status = "hit" if target_hit else ("missed" if evaluation_complete else "unresolved")
    target_ts = None
    close_fail_ts = None
    deep_fail_ts = None
    for row in rows[breakout_index + 1 : end_index + 1]:
        if target_ts is None and _float(row.get("high")) >= target:
            target_ts = int(row.get("ts") or 0)
        if close_fail_ts is None and _float(row.get("close")) < fib_618:
            close_fail_ts = int(row.get("ts") or 0)
        if deep_fail_ts is None and _float(row.get("low")) < fib_786:
            deep_fail_ts = int(row.get("ts") or 0)

    return {
        "outcome_status": outcome_status,
        "evaluation_complete": evaluation_complete,
        "sessions_observed_after_breakout": sessions_observed_after_breakout,
        "target_hit": target_hit,
        "target_hit_time": target_hit_time,
        "target_hit_session": target_hit_session,
        "target_before_close_below_618": bool(target_ts and (close_fail_ts is None or target_ts < close_fail_ts)),
        "target_before_low_below_786": bool(target_ts and (deep_fail_ts is None or target_ts < deep_fail_ts)),
        "close_below_618_time": close_below_618_time,
        "low_below_786_time": low_below_786_time,
        "max_high": round(max_high, 6),
        "target_progress": round(_progress_to_target(entry, target, max_high), 6),
    }


def _analyze_symbol(
    symbol: str,
    rows: Sequence[Dict[str, Any]],
    params: FibContinuationParams,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if len(rows) < 3:
        return [], []

    sessions = _session_index_map(rows)
    setups: List[Dict[str, Any]] = []
    baseline: List[Dict[str, Any]] = []
    next_allowed_index = 0

    for i, expansion in enumerate(rows[:-2]):
        if i < next_allowed_index or not _is_expansion(expansion, params):
            continue

        expansion_low = _float(expansion.get("low"))
        high = _float(expansion.get("high"))
        expansion_span = high - expansion_low
        if expansion_span <= 0:
            continue

        # The Fib is anchored to the start of the impulse, which can be a few bars
        # before the large expansion candle. The FX Resistance target remains based
        # only on the clicked expansion candle, exactly like the chart tool.
        fib_start_index = max(0, i - max(0, params.fib_lookback_bars))
        fib_anchor_low = min(_float(row.get("low"), high) for row in rows[fib_start_index : i + 1])
        fib_span = high - fib_anchor_low
        if fib_span <= 0:
            continue

        fib_500 = high - fib_span * 0.500
        fib_618 = high - fib_span * 0.618
        fib_786 = high - fib_span * 0.786
        target = high + expansion_span  # Exact FX Resistance: high + (high - low).

        setup_end = _future_window_end_index(rows, i + 1, sessions, params.max_setup_sessions)
        first_touch_index: Optional[int] = None
        breakout_index: Optional[int] = None
        max_retrace_fraction = 0.0
        touched_retrace_band = False
        failed_before_breakout = False

        for j in range(i + 1, setup_end + 1):
            row = rows[j]
            row_low = _float(row.get("low"))
            row_open = _float(row.get("open"))
            row_close = _float(row.get("close"))
            retrace_fraction = max(0.0, (high - row_low) / fib_span)
            max_retrace_fraction = max(max_retrace_fraction, retrace_fraction)

            if params.retrace_min <= retrace_fraction <= params.retrace_max:
                touched_retrace_band = True
                if first_touch_index is None:
                    first_touch_index = j

            if retrace_fraction > params.max_retrace:
                failed_before_breakout = True

            if row_close > high and row_close > row_open:
                breakout_index = j
                break

        if breakout_index is None:
            next_allowed_index = max(next_allowed_index, i + max(1, params.cooldown_bars))
            continue

        expansion_day = str(expansion.get("trade_date") or "")[:10]
        breakout_day = str(rows[breakout_index].get("trade_date") or "")[:10]
        expansion_session = sessions.get(expansion_day, 0)
        breakout_session = sessions.get(breakout_day, expansion_session)

        hold_bars = (breakout_index - first_touch_index) if first_touch_index is not None else 0
        hold_sessions = 0
        if first_touch_index is not None:
            touch_day = str(rows[first_touch_index].get("trade_date") or "")[:10]
            hold_sessions = max(0, sessions.get(breakout_day, 0) - sessions.get(touch_day, 0))

        target_eval = _evaluate_target(
            rows,
            breakout_index,
            target,
            fib_618,
            fib_786,
            params.target_sessions,
            sessions,
        )

        common = {
            "symbol": symbol,
            "expansion_time": expansion.get("dt_et"),
            "expansion_trade_date": expansion_day,
            "expansion_open": round(_float(expansion.get("open")), 6),
            "expansion_high": round(high, 6),
            "expansion_low": round(expansion_low, 6),
            "fib_anchor_low": round(fib_anchor_low, 6),
            "expansion_close": round(_float(expansion.get("close")), 6),
            "expansion_volume": round(_float(expansion.get("volume")), 2),
            "expansion_range_pct": round((expansion_span / expansion_low) * 100.0, 3),
            "fib_500": round(fib_500, 6),
            "fib_618": round(fib_618, 6),
            "fib_786": round(fib_786, 6),
            "max_retrace_fraction": round(max_retrace_fraction, 4),
            "max_retrace_pct": round(max_retrace_fraction * 100.0, 2),
            "breakout_time": rows[breakout_index].get("dt_et"),
            "breakout_trade_date": breakout_day,
            "breakout_close": round(_float(rows[breakout_index].get("close")), 6),
            "sessions_from_expansion_to_breakout": max(0, breakout_session - expansion_session),
            "hold_bars": hold_bars,
            "hold_sessions": hold_sessions,
            "fx_resistance_target": round(target, 6),
            "target_distance_from_breakout_pct": round(((target / _float(rows[breakout_index].get("close"))) - 1.0) * 100.0, 3),
            **target_eval,
        }
        baseline.append(common)

        pattern_valid = (
            touched_retrace_band
            and first_touch_index is not None
            and not failed_before_breakout
            and hold_bars >= params.min_hold_bars
            and hold_sessions >= params.min_hold_sessions
        )
        if pattern_valid:
            setups.append({
                **common,
                "retrace_touch_time": rows[first_touch_index].get("dt_et"),
                "retrace_touch_price_low": round(_float(rows[first_touch_index].get("low")), 6),
            })

        next_allowed_index = max(next_allowed_index, i + max(1, params.cooldown_bars))

    return setups, baseline


def run_fib_continuation_backtest(
    symbols: Iterable[str],
    *,
    timeframe: str = "5m",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    min_range_pct: float = 12.0,
    min_body_pct: float = 6.0,
    min_close_location: float = 0.65,
    min_volume: float = 50_000.0,
    retrace_min: float = 0.50,
    retrace_max: float = 0.70,
    max_retrace: float = 0.786,
    min_hold_bars: int = 12,
    min_hold_sessions: int = 1,
    max_setup_sessions: int = 6,
    target_sessions: int = 5,
    cooldown_bars: int = 12,
    fib_lookback_bars: int = 6,
    example_limit: int = 100,
) -> Dict[str, Any]:
    params = FibContinuationParams(
        min_range_pct=float(min_range_pct),
        min_body_pct=float(min_body_pct),
        min_close_location=float(min_close_location),
        min_volume=float(min_volume),
        retrace_min=float(retrace_min),
        retrace_max=float(retrace_max),
        max_retrace=float(max_retrace),
        min_hold_bars=max(0, int(min_hold_bars)),
        min_hold_sessions=max(0, int(min_hold_sessions)),
        max_setup_sessions=max(1, int(max_setup_sessions)),
        target_sessions=max(1, int(target_sessions)),
        cooldown_bars=max(1, int(cooldown_bars)),
        fib_lookback_bars=max(0, int(fib_lookback_bars)),
    )

    clean_symbols: List[str] = []
    for raw in symbols:
        symbol = normalize_symbol(raw)
        if symbol and symbol not in clean_symbols:
            clean_symbols.append(symbol)

    all_setups: List[Dict[str, Any]] = []
    all_baseline: List[Dict[str, Any]] = []
    symbols_with_data = 0
    bars_scanned = 0

    for symbol in clean_symbols:
        candles = get_candles(symbol, timeframe, start_date=start_date, end_date=end_date)
        if not candles:
            continue
        symbols_with_data += 1
        bars_scanned += len(candles)
        setups, baseline = _analyze_symbol(symbol, candles, params)
        all_setups.extend(setups)
        all_baseline.extend(baseline)

    setup_summary = _summarize(all_setups)
    baseline_summary = _summarize(all_baseline)
    lift_pp = None
    if setup_summary.get("hit_rate") is not None and baseline_summary.get("hit_rate") is not None:
        lift_pp = round((setup_summary["hit_rate"] - baseline_summary["hit_rate"]) * 100.0, 2)

    strict_618 = _summarize(all_setups, key="target_before_close_below_618")
    strict_786 = _summarize(all_setups, key="target_before_low_below_786")

    sample_size = int(setup_summary.get("resolved_setups") or 0)
    if sample_size < 30:
        verdict = "insufficient_sample"
        verdict_text = "Fewer than 30 qualifying setups. Treat the result as exploratory, not validated."
    elif lift_pp is not None and lift_pp >= 10 and (setup_summary.get("hit_rate_pct") or 0) >= 50:
        verdict = "promising"
        verdict_text = "The filtered Fib-hold setup materially outperformed the expansion-breakout baseline in this sample. Validate on a separate period before using it live."
    elif lift_pp is not None and lift_pp > 0:
        verdict = "weak_positive"
        verdict_text = "The setup showed some improvement over baseline, but the edge is not yet strong enough to call validated."
    else:
        verdict = "not_supported"
        verdict_text = "This sample did not show an improvement over the expansion-breakout baseline."

    sorted_examples = sorted(
        all_setups,
        key=lambda row: (
            bool(row.get("target_hit")),
            _float(row.get("target_progress")),
            str(row.get("expansion_time") or ""),
        ),
        reverse=True,
    )[: max(1, int(example_limit))]

    return {
        "ok": True,
        "setup": "bullish_expansion_fib_hold_rebreak_fx_resistance",
        "description": (
            "Bullish expansion candle -> retracement into configured Fib band -> hold/base -> "
            "later bullish close above the expansion high -> target = high + (high - low), matching FX Resistance. "
            "Setups without the full target evaluation window are reported as unresolved and excluded from hit-rate denominators."
        ),
        "formula": {
            "fib_retracement_price": "expansion_high - (expansion_high - impulse_anchor_low) * retracement_ratio",
            "fib_anchor": "lowest low in the configurable lookback through the expansion candle",
            "fx_resistance_target": "expansion_high + (expansion_high - expansion_candle_low)",
            "breakout_confirmation": "later bullish candle close > original expansion high",
        },
        "timeframe": timeframe,
        "start_date": start_date,
        "end_date": end_date,
        "symbols_requested": len(clean_symbols),
        "symbols_with_data": symbols_with_data,
        "bars_scanned": bars_scanned,
        "parameters": params.__dict__,
        "filtered_setup": setup_summary,
        "baseline_all_expansion_rebreaks": baseline_summary,
        "lift_vs_baseline_percentage_points": lift_pp,
        "target_before_close_below_618": strict_618,
        "target_before_low_below_786": strict_786,
        "by_max_retrace": _bucket_summary(
            all_setups,
            lambda row: (
                "50-55%" if _float(row.get("max_retrace_fraction")) < 0.55 else
                "55-62%" if _float(row.get("max_retrace_fraction")) < 0.62 else
                "62-70%" if _float(row.get("max_retrace_fraction")) <= 0.70 else
                ">70%"
            ),
        ),
        "by_hold_sessions": _bucket_summary(
            all_setups,
            lambda row: (
                "0" if int(row.get("hold_sessions") or 0) <= 0 else
                "1" if int(row.get("hold_sessions") or 0) == 1 else
                "2" if int(row.get("hold_sessions") or 0) == 2 else
                "3+"
            ),
        ),
        "verdict": verdict,
        "verdict_text": verdict_text,
        "examples": sorted_examples,
    }


__all__ = ["run_fib_continuation_backtest", "FibContinuationParams"]
