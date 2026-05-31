from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.autotrade.models import AutoTradeConfig, TradeSignal

ET = ZoneInfo("America/New_York")


ENTRY_TIMEFRAME = "5m"
DEFAULT_ENTRY_OFFSET = 0.03


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
    return datetime.fromtimestamp(_bar_ms(bar) / 1000, tz=timezone.utc).astimezone(ET)


def _entry_offset(config: AutoTradeConfig) -> float:
    """Price offset above sweep low. Default is $0.03."""
    for name in ("entry_offset", "entry_offset_dollars", "entry_offset_price", "sweep_entry_offset"):
        raw = getattr(config, name, None)
        value = _safe_float(raw, 0.0)
        if value > 0:
            return value
    cents = _safe_float(getattr(config, "entry_offset_cents", None), 0.0)
    if cents > 0:
        return cents / 100.0
    return DEFAULT_ENTRY_OFFSET


class FiveAmSweepStrategy:
    """5AM Pacific low-sweep retest strategy.

    Rules:
    - Build the 5:00-6:00 AM Pacific range, which is 8:00-9:00 AM Eastern.
    - Use 5-minute bars so validation is based on a 5m candle close.
    - Target is the highest body price inside the range: max(open, close), not the wick.
    - Watch after 6:00 AM Pacific / 9:00 AM Eastern.
    - Sweep: price trades below the range low by sweep_buffer_pct.
    - Default mode: wait for a 5m candle to close inside the sweep zone, then wait for a retest.
      Sweep zone = sweep_low through range_low.
    - Entry is sweep_low + entry offset, default $0.03.
    - Aggressive mode: entry can trigger immediately on sweep touch.
    - Stop is below sweep_low by stop_buffer_pct.
    """

    id = "five_am_sweep"
    label = "5AM Sweep"

    async def scan(self, *, symbol: str, polygon: Any, config: AutoTradeConfig) -> List[TradeSignal]:
        symbol_u = symbol.upper().strip()
        timeframe = ENTRY_TIMEFRAME

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
        clean_bars = [
            b for b in bars
            if _bar_ms(b) > 0
            and _safe_float(b.get("high", b.get("h"))) > 0
            and _safe_float(b.get("close", b.get("c"))) > 0
        ]
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
        body_target = max(
            max(_safe_float(b.get("open", b.get("o"))), _safe_float(b.get("close", b.get("c"))))
            for b in range_bars
        )
        if range_low <= 0 or body_target <= range_low:
            return None

        entry_offset = _entry_offset(config)
        sweep_buffer_pct = float(getattr(config, "sweep_buffer_pct", 0.001) or 0.001)
        stop_buffer_pct = float(getattr(config, "stop_buffer_pct", 0.002) or 0.002)
        max_age = max(1, int(getattr(config, "max_signal_age_bars", 3) or 3))
        min_profit_range = float(getattr(config, "min_profit_range", 0.0) or 0.0)
        trigger_mode = str(getattr(config, "entry_trigger_mode", "reclaim_retest") or "reclaim_retest").lower().strip()

        threshold = range_low * (1.0 - sweep_buffer_pct)
        sweep_low: Optional[float] = None
        validation_index: Optional[int] = None
        signal_index: Optional[int] = None
        signal_bar: Optional[Dict[str, Any]] = None

        for idx, bar in enumerate(after_bars):
            low = _safe_float(bar.get("low", bar.get("l")))
            high = _safe_float(bar.get("high", bar.get("h")))
            close = _safe_float(bar.get("close", bar.get("c")))

            if low < threshold:
                sweep_low = low if sweep_low is None else min(float(sweep_low), low)
                if trigger_mode == "sweep_touch":
                    signal_index = idx
                    signal_bar = bar
                    break

            if sweep_low is None:
                continue

            entry_price_raw = float(sweep_low) + entry_offset
            closed_inside_sweep_zone = float(sweep_low) <= close <= range_low
            if validation_index is None and closed_inside_sweep_zone:
                validation_index = idx
                continue

            # Default rule: after a 5m close inside the sweep zone, wait for price to retest entry.
            if validation_index is not None and idx > validation_index and low <= entry_price_raw <= high:
                signal_index = idx
                signal_bar = bar
                break

        if signal_bar is None or signal_index is None or sweep_low is None:
            return None

        bars_since = len(after_bars) - 1 - signal_index
        if bars_since > max_age:
            return None

        entry_price = round(float(sweep_low) + entry_offset, 4)
        target_price = round(body_target, 4)
        stop_price = round(float(sweep_low) * (1.0 - stop_buffer_pct), 4)
        risk = entry_price - stop_price
        profit_range = target_price - entry_price
        if entry_price <= 0 or stop_price <= 0 or target_price <= entry_price or risk <= 0:
            return None
        if profit_range < min_profit_range:
            return None

        signal_dt = _bar_et_datetime(signal_bar)
        signal_id = f"five_am_sweep::{symbol}::{latest_day.isoformat()}::{_bar_ms(signal_bar)}"
        score = 60.0 + min(25.0, profit_range / max(entry_price, 0.01) * 250.0) - min(10.0, bars_since * 2.0)

        return TradeSignal(
            strategy_id=self.id,
            symbol=symbol,
            side="buy",
            setup="bullish_5am_low_sweep_touch" if trigger_mode == "sweep_touch" else "bullish_5am_low_sweep_zone_retest",
            signal_id=signal_id,
            timeframe=timeframe,
            signal_time=signal_dt.isoformat(),
            entry_price=entry_price,
            target_price=target_price,
            stop_price=stop_price,
            score=round(max(0.0, min(100.0, score)), 2),
            profit_range=round(profit_range, 4),
            metadata={
                "range_low": round(range_low, 4),
                "body_target": target_price,
                "sweep_low": round(float(sweep_low), 4),
                "entry_offset": round(entry_offset, 4),
                "risk": round(risk, 4),
                "bars_since_signal": bars_since,
                "entry_trigger_mode": trigger_mode,
                "entry_trigger_rule": "aggressive_sweep_touch_no_close_confirmation" if trigger_mode == "sweep_touch" else "5m_close_inside_sweep_zone_then_retest_entry",
                "target_rule": "highest_body_open_or_close_no_wicks",
                "range_window_et": "08:00-09:00",
                "range_window_pt": "05:00-06:00",
                "extended_hours": True,
            },
        )


# Extra aliases make this file compatible with different registry naming styles.
Strategy = FiveAmSweepStrategy
FiveAMSweepStrategy = FiveAmSweepStrategy
