from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from .market_cache import get_candles, normalize_symbol

ET = ZoneInfo("America/New_York")


def _safe_float(value: Any) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else 0.0
    except Exception:
        return 0.0


def _hhmm(dt_et: str) -> int:
    try:
        dt = datetime.fromisoformat(dt_et)
        return dt.hour * 100 + dt.minute
    except Exception:
        return -1


def _typical_price(row: Dict[str, Any]) -> float:
    return (
        _safe_float(row.get("high"))
        + _safe_float(row.get("low"))
        + _safe_float(row.get("close"))
    ) / 3.0


def _pct(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0
    return (numerator / denominator - 1.0) * 100.0


def _close_location(row: Dict[str, Any]) -> float:
    high = _safe_float(row.get("high"))
    low = _safe_float(row.get("low"))
    close = _safe_float(row.get("close"))
    span = high - low
    if span <= 0:
        return 0.5
    return max(0.0, min(1.0, (close - low) / span))


def _qualifies_displacement(
    row: Dict[str, Any],
    *,
    min_body_pct: float,
    min_range_pct: float,
    min_volume: float,
    min_close_location: float,
) -> bool:
    open_ = _safe_float(row.get("open"))
    close = _safe_float(row.get("close"))
    high = _safe_float(row.get("high"))
    low = _safe_float(row.get("low"))
    volume = _safe_float(row.get("volume"))

    if open_ <= 0 or close <= open_ or low <= 0:
        return False
    body_pct = _pct(close, open_)
    range_pct = _pct(high, low)
    if body_pct < min_body_pct:
        return False
    if range_pct < min_range_pct:
        return False
    if volume < min_volume:
        return False
    if _close_location(row) < min_close_location:
        return False
    return True


def _rolling_std(values: List[float], end_idx: int, length: int) -> Optional[float]:
    if length <= 1 or end_idx + 1 < length:
        return None
    window = values[end_idx - length + 1 : end_idx + 1]
    if len(window) < length:
        return None
    # thinkScript StDev behaves as a population-style rolling standard deviation.
    return float(statistics.pstdev(window))


def _continuous_vwap(rows: List[Dict[str, Any]]) -> List[float]:
    cum_volume = 0.0
    cum_pv = 0.0
    out: List[float] = []
    for row in rows:
        volume = max(0.0, _safe_float(row.get("volume")))
        tp = _typical_price(row)
        cum_volume += volume
        cum_pv += tp * volume
        out.append(cum_pv / cum_volume if cum_volume > 0 else tp)
    return out


def _daily_vwap(rows: List[Dict[str, Any]]) -> List[float]:
    cum_volume = 0.0
    cum_pv = 0.0
    current_date: Optional[str] = None
    out: List[float] = []
    for row in rows:
        trade_date = str(row.get("trade_date") or "")
        if trade_date != current_date:
            current_date = trade_date
            cum_volume = 0.0
            cum_pv = 0.0
        volume = max(0.0, _safe_float(row.get("volume")))
        tp = _typical_price(row)
        cum_volume += volume
        cum_pv += tp * volume
        out.append(cum_pv / cum_volume if cum_volume > 0 else tp)
    return out


def _future_date_limit(rows: List[Dict[str, Any]], event_idx: int, future_trading_days: int) -> str:
    event_date = str(rows[event_idx].get("trade_date") or "")
    dates: List[str] = []
    seen = set()
    for row in rows[event_idx:]:
        date = str(row.get("trade_date") or "")
        if not date or date in seen:
            continue
        seen.add(date)
        dates.append(date)
        if len(dates) >= future_trading_days + 1:
            break
    if not dates:
        return event_date
    return dates[-1]


def _trading_day_index(rows: List[Dict[str, Any]], event_idx: int, hit_idx: int) -> int:
    dates: List[str] = []
    seen = set()
    for row in rows[event_idx : hit_idx + 1]:
        date = str(row.get("trade_date") or "")
        if date and date not in seen:
            seen.add(date)
            dates.append(date)
    return max(0, len(dates) - 1)


def _minutes_between(a_ms: int, b_ms: int) -> Optional[float]:
    if a_ms <= 0 or b_ms <= 0 or b_ms < a_ms:
        return None
    return round((b_ms - a_ms) / 60000.0, 2)


def _event_path(
    rows: List[Dict[str, Any]],
    event_idx: int,
    target: float,
    *,
    future_trading_days: int,
) -> Dict[str, Any]:
    event = rows[event_idx]
    initial_high = _safe_float(event.get("high"))
    initial_low = _safe_float(event.get("low"))
    initial_open = _safe_float(event.get("open"))
    initial_close = _safe_float(event.get("close"))
    body_top = max(initial_open, initial_close)
    event_ts = int(event.get("ts") or 0)
    max_date = _future_date_limit(rows, event_idx, future_trading_days)

    target_idx: Optional[int] = None
    close_above_high_idx: Optional[int] = None
    high_break_idx: Optional[int] = None
    close_above_body_idx: Optional[int] = None
    close_above_initial_close_idx: Optional[int] = None
    wick_below_low_idx: Optional[int] = None
    same_bar_wick_reclaim_idx: Optional[int] = None
    close_below_low_idx: Optional[int] = None
    reclaim_after_wick_idx: Optional[int] = None
    reclaim_after_close_idx: Optional[int] = None
    max_low_below = initial_low

    had_wick_below = False
    had_close_below = False

    for idx in range(event_idx + 1, len(rows)):
        row = rows[idx]
        trade_date = str(row.get("trade_date") or "")
        if trade_date > max_date:
            break

        high = _safe_float(row.get("high"))
        low = _safe_float(row.get("low"))
        close = _safe_float(row.get("close"))

        if high_break_idx is None and high > initial_high:
            high_break_idx = idx
        if close_above_high_idx is None and close > initial_high:
            close_above_high_idx = idx
        if close_above_body_idx is None and close > body_top:
            close_above_body_idx = idx
        if close_above_initial_close_idx is None and close > initial_close:
            close_above_initial_close_idx = idx

        if low < initial_low:
            if wick_below_low_idx is None:
                wick_below_low_idx = idx
            had_wick_below = True
            max_low_below = min(max_low_below, low)
            if close >= initial_low and same_bar_wick_reclaim_idx is None:
                same_bar_wick_reclaim_idx = idx

        if close < initial_low:
            if close_below_low_idx is None:
                close_below_low_idx = idx
            had_close_below = True

        if had_wick_below and reclaim_after_wick_idx is None and close >= initial_low:
            reclaim_after_wick_idx = idx
        if had_close_below and reclaim_after_close_idx is None and close >= initial_low:
            reclaim_after_close_idx = idx

        if target_idx is None and high >= target:
            target_idx = idx
            # Keep scanning only if reclaim state needs later classification.

    def dt_for(idx: Optional[int]) -> Optional[str]:
        return str(rows[idx].get("dt_et")) if idx is not None else None

    target_hit = target_idx is not None
    target_day_index = _trading_day_index(rows, event_idx, target_idx) if target_idx is not None else None
    target_minutes = _minutes_between(event_ts, int(rows[target_idx].get("ts") or 0)) if target_idx is not None else None

    depth_below_low_pct = 0.0
    if initial_low > 0 and max_low_below < initial_low:
        depth_below_low_pct = round((initial_low - max_low_below) / initial_low * 100.0, 3)

    return {
        "target_hit": target_hit,
        "target_time": dt_for(target_idx),
        "target_trade_date": str(rows[target_idx].get("trade_date")) if target_idx is not None else None,
        "target_trading_day": target_day_index,
        "target_minutes": target_minutes,
        "high_broke": high_break_idx is not None,
        "high_break_time": dt_for(high_break_idx),
        "close_above_high": close_above_high_idx is not None,
        "close_above_high_time": dt_for(close_above_high_idx),
        "close_above_body_top": close_above_body_idx is not None,
        "close_above_body_top_time": dt_for(close_above_body_idx),
        "close_above_initial_close": close_above_initial_close_idx is not None,
        "close_above_initial_close_time": dt_for(close_above_initial_close_idx),
        "wick_below_low": wick_below_low_idx is not None,
        "wick_below_low_time": dt_for(wick_below_low_idx),
        "same_bar_wick_reclaim": same_bar_wick_reclaim_idx is not None,
        "same_bar_wick_reclaim_time": dt_for(same_bar_wick_reclaim_idx),
        "close_below_low": close_below_low_idx is not None,
        "close_below_low_time": dt_for(close_below_low_idx),
        "reclaim_after_wick": reclaim_after_wick_idx is not None,
        "reclaim_after_wick_time": dt_for(reclaim_after_wick_idx),
        "reclaim_after_close": reclaim_after_close_idx is not None,
        "reclaim_after_close_time": dt_for(reclaim_after_close_idx),
        "max_depth_below_low_pct": depth_below_low_pct,
        "target_before_close_above_high": bool(
            target_idx is not None and (close_above_high_idx is None or target_idx <= close_above_high_idx)
        ),
        "target_after_close_above_high": bool(
            target_idx is not None and close_above_high_idx is not None and target_idx > close_above_high_idx
        ),
        "target_after_wick_reclaim": bool(
            target_idx is not None and reclaim_after_wick_idx is not None and target_idx > reclaim_after_wick_idx
        ),
        "target_after_close_reclaim": bool(
            target_idx is not None and reclaim_after_close_idx is not None and target_idx > reclaim_after_close_idx
        ),
    }


def _rate(events: Iterable[Dict[str, Any]], predicate) -> Dict[str, Any]:
    rows = list(events)
    total = len(rows)
    hits = sum(1 for row in rows if predicate(row))
    return {
        "events": total,
        "hits": hits,
        "hit_rate_pct": round(hits / total * 100.0, 2) if total else None,
    }


def summarize_vwap3_events(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    eligible = [row for row in events if not row.get("target_already_reached_on_displacement")]
    hits = [row for row in eligible if row.get("target_hit")]

    summary: Dict[str, Any] = {
        "events_total": len(events),
        "events_eligible_future_target": len(eligible),
        "target_already_reached_on_displacement": sum(
            1 for row in events if row.get("target_already_reached_on_displacement")
        ),
        "overall": _rate(eligible, lambda row: bool(row.get("target_hit"))),
        "no_close_above_initial_high": _rate(
            [row for row in eligible if not row.get("close_above_high")],
            lambda row: bool(row.get("target_hit")),
        ),
        "close_above_initial_high": _rate(
            [row for row in eligible if row.get("close_above_high")],
            lambda row: bool(row.get("target_hit")),
        ),
        "target_before_close_above_high": _rate(
            eligible,
            lambda row: bool(row.get("target_before_close_above_high")),
        ),
        "low_held": _rate(
            [row for row in eligible if not row.get("wick_below_low")],
            lambda row: bool(row.get("target_hit")),
        ),
        "wick_below_low_reclaimed": _rate(
            [row for row in eligible if row.get("wick_below_low") and row.get("reclaim_after_wick")],
            lambda row: bool(row.get("target_hit")),
        ),
        "closed_below_low_reclaimed": _rate(
            [row for row in eligible if row.get("close_below_low") and row.get("reclaim_after_close")],
            lambda row: bool(row.get("target_hit")),
        ),
        "closed_below_low_no_reclaim": _rate(
            [row for row in eligible if row.get("close_below_low") and not row.get("reclaim_after_close")],
            lambda row: bool(row.get("target_hit")),
        ),
        "hit_by_trading_day": {},
        "median_minutes_to_target": None,
    }

    for day in range(0, 6):
        count = sum(
            1
            for row in hits
            if row.get("target_trading_day") is not None and int(row["target_trading_day"]) <= day
        )
        summary["hit_by_trading_day"][f"within_day_{day}"] = {
            "hits": count,
            "eligible_events": len(eligible),
            "hit_rate_pct": round(count / len(eligible) * 100.0, 2) if eligible else None,
        }

    minutes = [float(row["target_minutes"]) for row in hits if row.get("target_minutes") is not None]
    if minutes:
        summary["median_minutes_to_target"] = round(float(statistics.median(minutes)), 2)

    return summary


def run_vwap3_backtest(
    candidate_by_date: Dict[str, List[str]],
    *,
    timeframe: str = "5m",
    std_length: int = 20,
    multiplier: float = 3.0,
    future_trading_days: int = 5,
    premarket_start_hhmm: int = 400,
    premarket_end_hhmm: int = 930,
    min_body_pct: float = 3.0,
    min_range_pct: float = 4.0,
    min_volume: float = 50_000.0,
    min_close_location: float = 0.65,
    vwap_mode: str = "continuous",
) -> Dict[str, Any]:
    tf = str(timeframe or "5m").lower().strip()
    if tf != "5m":
        raise ValueError("VWAP +3 STD backtest currently requires 5m candles")
    if std_length < 2:
        raise ValueError("std_length must be at least 2")
    mode = str(vwap_mode or "continuous").lower().strip()
    if mode not in {"continuous", "daily"}:
        raise ValueError("vwap_mode must be continuous or daily")

    symbol_dates: Dict[str, set[str]] = defaultdict(set)
    for trade_date, symbols in (candidate_by_date or {}).items():
        for raw_symbol in symbols or []:
            symbol = normalize_symbol(raw_symbol)
            if symbol:
                symbol_dates[symbol].add(str(trade_date)[:10])

    events: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for symbol, dates in sorted(symbol_dates.items()):
        rows = get_candles(symbol, tf)
        if not rows:
            for trade_date in sorted(dates):
                skipped.append({"symbol": symbol, "trade_date": trade_date, "reason": "no_cached_candles"})
            continue

        tps = [_typical_price(row) for row in rows]
        vwap_values = _continuous_vwap(rows) if mode == "continuous" else _daily_vwap(rows)

        indexes_by_date: Dict[str, List[int]] = defaultdict(list)
        for idx, row in enumerate(rows):
            indexes_by_date[str(row.get("trade_date") or "")].append(idx)

        for trade_date in sorted(dates):
            date_indexes = indexes_by_date.get(trade_date) or []
            premarket_indexes = [
                idx
                for idx in date_indexes
                if premarket_start_hhmm <= _hhmm(str(rows[idx].get("dt_et") or "")) < premarket_end_hhmm
            ]
            if not premarket_indexes:
                skipped.append({"symbol": symbol, "trade_date": trade_date, "reason": "no_premarket_bars"})
                continue

            event_idx: Optional[int] = None
            for idx in premarket_indexes:
                if not _qualifies_displacement(
                    rows[idx],
                    min_body_pct=min_body_pct,
                    min_range_pct=min_range_pct,
                    min_volume=min_volume,
                    min_close_location=min_close_location,
                ):
                    continue
                if _rolling_std(tps, idx, std_length) is None:
                    continue
                event_idx = idx
                break

            if event_idx is None:
                skipped.append({"symbol": symbol, "trade_date": trade_date, "reason": "no_qualifying_displacement"})
                continue

            event = rows[event_idx]
            deviation = _rolling_std(tps, event_idx, std_length)
            assert deviation is not None
            vwap = vwap_values[event_idx]
            target = vwap + float(multiplier) * deviation
            event_high = _safe_float(event.get("high"))
            event_low = _safe_float(event.get("low"))
            event_open = _safe_float(event.get("open"))
            event_close = _safe_float(event.get("close"))

            path = _event_path(
                rows,
                event_idx,
                target,
                future_trading_days=future_trading_days,
            )

            events.append({
                "symbol": symbol,
                "trade_date": trade_date,
                "displacement_time": event.get("dt_et"),
                "displacement_open": round(event_open, 6),
                "displacement_high": round(event_high, 6),
                "displacement_low": round(event_low, 6),
                "displacement_close": round(event_close, 6),
                "displacement_volume": int(_safe_float(event.get("volume"))),
                "displacement_body_pct": round(_pct(event_close, event_open), 3),
                "displacement_range_pct": round(_pct(event_high, event_low), 3),
                "displacement_close_location": round(_close_location(event), 3),
                "vwap_at_displacement": round(vwap, 6),
                "std_at_displacement": round(deviation, 6),
                "std_length": std_length,
                "multiplier": multiplier,
                "frozen_target": round(target, 6),
                "target_distance_from_close_pct": round(_pct(target, event_close), 3),
                "target_already_reached_on_displacement": bool(event_high >= target),
                "vwap_mode": mode,
                **path,
            })

    return {
        "ok": True,
        "strategy": "initial_displacement_frozen_vwap_plus_std",
        "parameters": {
            "timeframe": tf,
            "std_length": std_length,
            "multiplier": multiplier,
            "future_trading_days": future_trading_days,
            "premarket_start_hhmm": premarket_start_hhmm,
            "premarket_end_hhmm": premarket_end_hhmm,
            "min_body_pct": min_body_pct,
            "min_range_pct": min_range_pct,
            "min_volume": min_volume,
            "min_close_location": min_close_location,
            "vwap_mode": mode,
        },
        "candidate_dates": len(candidate_by_date or {}),
        "candidate_symbol_dates": sum(len(v or []) for v in (candidate_by_date or {}).values()),
        "summary": summarize_vwap3_events(events),
        "events": events,
        "skipped": skipped,
    }


__all__ = ["run_vwap3_backtest", "summarize_vwap3_events"]
