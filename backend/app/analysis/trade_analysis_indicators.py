from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from app.analysis.trade_analysis_models import TradeAnalysisBar


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def normalize_bar(row: Dict[str, Any]) -> Optional[TradeAnalysisBar]:
    time_value = int(safe_float(row.get("time", row.get("t", 0))))
    open_value = safe_float(row.get("open", row.get("o")))
    high_value = safe_float(row.get("high", row.get("h")))
    low_value = safe_float(row.get("low", row.get("l")))
    close_value = safe_float(row.get("close", row.get("c")))
    volume_value = safe_float(row.get("volume", row.get("v")))

    if time_value <= 0 or high_value <= 0 or low_value <= 0 or close_value <= 0:
        return None

    return TradeAnalysisBar(
        time=time_value,
        open=open_value,
        high=high_value,
        low=low_value,
        close=close_value,
        volume=max(0.0, volume_value),
    )


def normalize_bars(rows: Iterable[Dict[str, Any]]) -> List[TradeAnalysisBar]:
    bars: List[TradeAnalysisBar] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        bar = normalize_bar(row)
        if bar is not None:
            bars.append(bar)
    bars.sort(key=lambda item: item.time)
    return bars


def average(values: Iterable[float]) -> float:
    clean = [float(value) for value in values if float(value) > 0]
    return sum(clean) / len(clean) if clean else 0.0


def pct_change(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0
    return ((current - previous) / previous) * 100.0


def ema(values: List[float], period: int) -> Optional[float]:
    if period <= 0 or not values:
        return None
    sample = [float(value) for value in values if float(value) > 0]
    if len(sample) < period:
        return None
    multiplier = 2.0 / (period + 1.0)
    current = sum(sample[:period]) / period
    for value in sample[period:]:
        current = (value - current) * multiplier + current
    return current


def atr(bars: List[TradeAnalysisBar], period: int = 14) -> float:
    if len(bars) < 2:
        return 0.0
    true_ranges: List[float] = []
    for index in range(1, len(bars)):
        high = bars[index].high
        low = bars[index].low
        prev_close = bars[index - 1].close
        true_ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    sample = true_ranges[-period:]
    return average(sample)


def vwap(bars: List[TradeAnalysisBar]) -> Optional[float]:
    total_price_volume = 0.0
    total_volume = 0.0
    for bar in bars:
        typical_price = (bar.high + bar.low + bar.close) / 3.0
        if bar.volume > 0:
            total_price_volume += typical_price * bar.volume
            total_volume += bar.volume
    if total_volume <= 0:
        return None
    return total_price_volume / total_volume


def close_position_pct(close: float, low: float, high: float) -> float:
    if high <= low:
        return 0.0
    return max(0.0, min(100.0, ((close - low) / (high - low)) * 100.0))
