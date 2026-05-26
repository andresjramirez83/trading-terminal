from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.autotrade.models import AutoTradeConfig, TradeSignal

ET = ZoneInfo("America/New_York")


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        out = float(value)
        return out if out > 0 else default
    except Exception:
        return default


def _bar_ms(bar: Dict[str, Any]) -> int:
    raw = bar.get("time", bar.get("t", 0))
    try:
        value = int(float(raw))
    except Exception:
        return 0
    if value < 10_000_000_000:
        value *= 1000
    return value


def _bar_et_datetime(bar: Dict[str, Any]) -> datetime:
    return datetime.fromtimestamp(_bar_ms(bar) / 1000, ET)


class FiveAmSweepStrategy:
    """5AM Pacific low-sweep reclaim strategy.

    Rules:
    - Build the 5:00-6:00 AM Pacific range, which is 8:00-9:00 AM Eastern.
    - Watch bars after 9:00 AM Eastern.
    - Long signal when price sweeps below the range low and closes back above it.
    - Entry is the reclaim candle close.
    - Stop is the sweep low minus stop_buffer_pct.
    - Target is entry + target_r * risk.
    """

    id = "five_am_sweep"
    label = "5AM Sweep"

    async def scan(self, *, symbol: str, polygon: Any, config: AutoTradeConfig) -> List[TradeSignal]:
        symbol_u = symbol.upper().strip()
        timeframe = "15m"

        try:
            raw_bars = await polygon.get_bars(symbol_u, timeframe, session="extended")
        except TypeError:
            raw_bars = await polygon.get_bars(symbol_u, timeframe)

        signal = self._find_signal(symbol_u, timeframe, raw_bars or [], config)
        return [signal] if signal is not None else []

    def _find_signal(
        self,
        symbol: str,
        timeframe: str,
        bars: List[Dict[str, Any]],
        config: AutoTradeConfig,
    ) -> Optional[TradeSignal]:
        clean_bars = [b for b in bars if _bar_ms(b) > 0]
        if len(clean_bars) < 20:
            return None

        clean_bars.sort(key=_bar_ms)
        latest_day = _bar_et_datetime(clean_bars[-1]).date()
        day_bars = [b for b in clean_bars if _bar_et_datetime(b).date() == latest_day]
        if not day_bars:
            return None

        range_bars: List[Dict[str, Any]] = []
        after_bars: List[Dict[str, Any]] = []
        for bar in day_bars:
            dt = _bar_et_datetime(bar)
            hhmm = dt.hour * 100 + dt.minute
            if 800 <= hhmm < 900:
                range_bars.append(bar)
            elif hhmm >= 900:
                after_bars.append(bar)

        if not range_bars or not after_bars:
            return None

        range_low = min(_safe_float(b.get("low", b.get("l"))) for b in range_bars)
        range_high = max(_safe_float(b.get("high", b.get("h"))) for b in range_bars)
        if range_low <= 0 or range_high <= 0 or range_high <= range_low:
            return None

        sweep_buffer_pct = float(getattr(config, "sweep_buffer_pct", 0.001) or 0.001)
        stop_buffer_pct = float(getattr(config, "stop_buffer_pct", 0.002) or 0.002)
        max_age = max(1, int(getattr(config, "max_signal_age_bars", 3) or 3))
        target_r = max(0.25, float(getattr(config, "target_r", 2.0) or 2.0))

        threshold = range_low * (1.0 - sweep_buffer_pct)
        sweep_low: Optional[float] = None
        signal_index: Optional[int] = None
        signal_bar: Optional[Dict[str, Any]] = None

        for idx, bar in enumerate(after_bars):
            low = _safe_float(bar.get("low", bar.get("l")))
            close = _safe_float(bar.get("close", bar.get("c")))
            if low < threshold:
                sweep_low = low if sweep_low is None else min(sweep_low, low)

            if sweep_low is not None and close > range_low:
                signal_index = idx
                signal_bar = bar
                break

        if signal_bar is None or signal_index is None or sweep_low is None:
            return None

        bars_since = len(after_bars) - 1 - signal_index
        if bars_since > max_age:
            return None

        entry_price = _safe_float(signal_bar.get("close", signal_bar.get("c")))
        stop_price = float(sweep_low) * (1.0 - stop_buffer_pct)
        risk = entry_price - stop_price
        if entry_price <= 0 or stop_price <= 0 or risk <= 0:
            return None

        target_price = entry_price + risk * target_r
        profit_range = target_price - entry_price
        if profit_range <= 0:
            return None

        signal_dt = _bar_et_datetime(signal_bar)
        signal_id = f"five_am_sweep::{symbol}::{latest_day.isoformat()}::{_bar_ms(signal_bar)}"

        score = 72.0
        # Small quality bump for reclaiming closer to/above the 5AM range high.
        if entry_price >= range_high:
            score = 82.0
        elif entry_price > (range_low + range_high) / 2.0:
            score = 76.0

        return TradeSignal(
            strategy_id=self.id,
            symbol=symbol,
            side="buy",
            setup="bullish_5am_low_sweep_reclaim",
            signal_id=signal_id,
            timeframe=timeframe,
            signal_time=signal_dt.isoformat(),
            entry_price=round(entry_price, 4),
            target_price=round(target_price, 4),
            stop_price=round(stop_price, 4),
            score=score,
            profit_range=round(profit_range, 4),
            metadata={
                "range_low": round(range_low, 4),
                "range_high": round(range_high, 4),
                "sweep_low": round(float(sweep_low), 4),
                "risk": round(risk, 4),
                "target_r": target_r,
                "bars_since_signal": bars_since,
                "session": "5:00-6:00 AM Pacific / 8:00-9:00 AM Eastern",
                "extended_hours": True,
            },
        )


# Extra aliases make this file compatible with different registry naming styles.
Strategy = FiveAmSweepStrategy
FiveAMSweepStrategy = FiveAmSweepStrategy
