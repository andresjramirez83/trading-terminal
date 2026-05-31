from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.autotrade.models import AutoTradeConfig, TradeSignal
from app.services.polygon_service import PolygonService
from app.strategies.base import StrategyBase

ET = ZoneInfo("America/New_York")


ENTRY_TIMEFRAME = "5m"
DEFAULT_ENTRY_OFFSET = 0.03


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        out = float(value)
        return out if out > 0 else default
    except Exception:
        return default


def bar_ms(row: Dict[str, Any]) -> int:
    raw = int(safe_float(row.get("time", row.get("t", 0))))
    if raw < 10_000_000_000:
        raw *= 1000
    return raw


def et_dt(row: Dict[str, Any]) -> datetime:
    return datetime.fromtimestamp(bar_ms(row) / 1000, tz=timezone.utc).astimezone(ET)


def entry_offset(config: AutoTradeConfig) -> float:
    """Price offset above sweep low. Default is $0.03."""
    for name in ("entry_offset", "entry_offset_dollars", "entry_offset_price", "sweep_entry_offset"):
        raw = getattr(config, name, None)
        value = safe_float(raw, 0.0)
        if value > 0:
            return value
    cents = safe_float(getattr(config, "entry_offset_cents", None), 0.0)
    if cents > 0:
        return cents / 100.0
    return DEFAULT_ENTRY_OFFSET


class SixSevenSweepStrategy(StrategyBase):
    id = "six_seven_sweep"
    name = "6–7 Sweep Bullish Retest"

    async def scan(self, *, symbol: str, polygon: PolygonService, config: AutoTradeConfig) -> List[TradeSignal]:
        timeframe = ENTRY_TIMEFRAME
        bars_raw = await polygon.get_bars(symbol, timeframe, session="extended")
        bars = [
            b for b in bars_raw
            if bar_ms(b) > 0
            and safe_float(b.get("high", b.get("h"))) > 0
            and safe_float(b.get("close", b.get("c"))) > 0
        ]
        bars.sort(key=bar_ms)
        signal = self._find_signal(symbol.upper(), timeframe, bars, config)
        return [signal] if signal else []

    def _find_signal(
        self,
        symbol: str,
        timeframe: str,
        bars: List[Dict[str, Any]],
        config: AutoTradeConfig,
    ) -> Optional[TradeSignal]:
        if len(bars) < 20:
            return None

        latest_day = et_dt(bars[-1]).date()
        day_bars = [b for b in bars if et_dt(b).date() == latest_day]
        range_bars: List[Dict[str, Any]] = []
        after_bars: List[Dict[str, Any]] = []

        # 6:00-7:00 PT equals 9:00-10:00 ET.
        # At 7:00 PT / 10:00 ET, the range is complete and the strategy starts looking for sweeps.
        for bar in day_bars:
            dt = et_dt(bar)
            hhmm = dt.hour * 100 + dt.minute
            if 900 <= hhmm < 1000:
                range_bars.append(bar)
            elif hhmm >= 1000:
                after_bars.append(bar)

        if not range_bars or not after_bars:
            return None

        range_low = min(safe_float(b.get("low", b.get("l"))) for b in range_bars)
        body_target = max(
            max(safe_float(b.get("open", b.get("o"))), safe_float(b.get("close", b.get("c"))))
            for b in range_bars
        )
        if range_low <= 0 or body_target <= range_low:
            return None

        offset = entry_offset(config)
        sweep_buffer_pct = float(getattr(config, "sweep_buffer_pct", 0.001) or 0.001)
        stop_buffer_pct = float(getattr(config, "stop_buffer_pct", 0.002) or 0.002)
        min_profit_range = float(getattr(config, "min_profit_range", 0.0) or 0.0)
        max_age = max(1, int(getattr(config, "max_signal_age_bars", 3) or 3))
        trigger_mode = str(getattr(config, "entry_trigger_mode", "reclaim_retest") or "reclaim_retest").lower().strip()

        threshold = range_low * (1.0 - sweep_buffer_pct)
        sweep_low: Optional[float] = None
        validation_index: Optional[int] = None
        signal_bar: Optional[Dict[str, Any]] = None
        signal_index: Optional[int] = None

        for idx, bar in enumerate(after_bars):
            low = safe_float(bar.get("low", bar.get("l")))
            high = safe_float(bar.get("high", bar.get("h")))
            close = safe_float(bar.get("close", bar.get("c")))

            if low < threshold:
                sweep_low = low if sweep_low is None else min(float(sweep_low), low)
                if trigger_mode == "sweep_touch":
                    signal_bar = bar
                    signal_index = idx
                    break

            if sweep_low is None:
                continue

            entry_price_raw = float(sweep_low) + offset
            closed_inside_sweep_zone = float(sweep_low) <= close <= range_low
            if validation_index is None and closed_inside_sweep_zone:
                validation_index = idx
                continue

            # Default rule: after a 5m close inside the sweep zone, wait for price to retest entry.
            if validation_index is not None and idx > validation_index and low <= entry_price_raw <= high:
                signal_bar = bar
                signal_index = idx
                break

        if signal_bar is None or signal_index is None or sweep_low is None:
            return None

        bars_since = len(after_bars) - 1 - signal_index
        if bars_since > max_age:
            return None

        signal_time = et_dt(signal_bar)
        signal_id = f"{self.id}::{symbol}::{latest_day.isoformat()}::{bar_ms(signal_bar)}"
        entry_price = round(float(sweep_low) + offset, 4)
        target_price = round(body_target, 4)
        stop_price = round(float(sweep_low) * (1.0 - stop_buffer_pct), 4)
        risk = entry_price - stop_price
        profit_range = target_price - entry_price
        if entry_price <= 0 or stop_price <= 0 or target_price <= entry_price or risk <= 0:
            return None
        if profit_range < min_profit_range:
            return None

        score = 60.0 + min(25.0, profit_range / max(entry_price, 0.01) * 250.0) - min(10.0, bars_since * 2.0)

        return TradeSignal(
            strategy_id=self.id,
            symbol=symbol,
            side="buy",
            setup="bullish_6_7_low_sweep_touch" if trigger_mode == "sweep_touch" else "bullish_6_7_low_sweep_zone_retest",
            signal_id=signal_id,
            timeframe=timeframe,
            signal_time=signal_time.isoformat(),
            entry_price=entry_price,
            target_price=target_price,
            stop_price=stop_price,
            score=round(max(0.0, min(100.0, score)), 2),
            profit_range=round(profit_range, 4),
            metadata={
                "range_low": round(range_low, 4),
                "body_target": target_price,
                "sweep_low": round(float(sweep_low), 4),
                "entry_offset": round(offset, 4),
                "risk": round(risk, 4),
                "bars_since_signal": bars_since,
                "entry_trigger_mode": trigger_mode,
                "entry_trigger_rule": "aggressive_sweep_touch_no_close_confirmation" if trigger_mode == "sweep_touch" else "5m_close_inside_sweep_zone_then_retest_entry",
                "target_rule": "highest_body_open_or_close_no_wicks",
                "range_window_et": "09:00-10:00",
                "range_window_pt": "06:00-07:00",
            },
        )


Strategy = SixSevenSweepStrategy
