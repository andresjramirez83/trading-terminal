from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.autotrade.models import AutoTradeConfig, TradeSignal
from app.services.polygon_service import PolygonService
from app.strategies.base import StrategyBase

ET = ZoneInfo("America/New_York")


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


class SixSevenSweepStrategy(StrategyBase):
    id = "six_seven_sweep"
    name = "6–7 Sweep Bullish Retest"

    async def scan(self, *, symbol: str, polygon: PolygonService, config: AutoTradeConfig) -> List[TradeSignal]:
        bars_raw = await polygon.get_bars(symbol, config.timeframe, session="extended")
        bars = [b for b in bars_raw if safe_float(b.get("high", b.get("h"))) > 0 and safe_float(b.get("close", b.get("c"))) > 0]
        bars.sort(key=bar_ms)
        signal = self._find_signal(symbol.upper(), bars, config)
        return [signal] if signal else []

    def _find_signal(self, symbol: str, bars: List[Dict[str, Any]], config: AutoTradeConfig) -> Optional[TradeSignal]:
        if len(bars) < 20:
            return None

        latest_day = et_dt(bars[-1]).date()
        day_bars = [b for b in bars if et_dt(b).date() == latest_day]
        range_bars: List[Dict[str, Any]] = []
        after_bars: List[Dict[str, Any]] = []

        # 6:00-7:00 PT equals 9:00-10:00 ET.
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
        # Target is highest body price, not wick: max(open, close) inside the 6-7 candle/range.
        target = max(max(safe_float(b.get("open", b.get("o"))), safe_float(b.get("close", b.get("c")))) for b in range_bars)
        if range_low <= 0 or target <= range_low:
            return None

        profit_range = target - range_low
        if profit_range < float(config.min_profit_range):
            return None

        threshold = range_low * (1.0 - float(config.sweep_buffer_pct))
        trigger_mode = str(getattr(config, "entry_trigger_mode", "reclaim_close") or "reclaim_close").lower().strip()
        sweep_low: Optional[float] = None
        signal_bar: Optional[Dict[str, Any]] = None
        signal_index: Optional[int] = None

        for idx, bar in enumerate(after_bars):
            low = safe_float(bar.get("low", bar.get("l")))
            close = safe_float(bar.get("close", bar.get("c")))

            swept = low < threshold
            if swept:
                sweep_low = low if sweep_low is None else min(sweep_low, low)
                if trigger_mode == "sweep_touch":
                    # Aggressive mode: signal as soon as the sweep happens.
                    # This does NOT wait for the candle to close back above range_low.
                    signal_bar = bar
                    signal_index = idx

            if trigger_mode != "sweep_touch" and sweep_low is not None and close > range_low:
                # Safer default: wait for reclaim close back above range_low.
                signal_bar = bar
                signal_index = idx

        if signal_bar is None or signal_index is None or sweep_low is None:
            return None

        bars_since = len(after_bars) - 1 - signal_index
        if bars_since > max(1, int(config.max_signal_age_bars)):
            return None

        signal_time = et_dt(signal_bar)
        signal_id = f"{self.id}::{symbol}::{latest_day.isoformat()}::{bar_ms(signal_bar)}"
        stop_price = round(float(sweep_low) * (1.0 - float(config.stop_buffer_pct)), 4)
        entry_price = round(range_low, 4)
        target_price = round(target, 4)
        score = 60.0 + min(25.0, profit_range / max(entry_price, 0.01) * 250.0) - min(10.0, bars_since * 2.0)

        return TradeSignal(
            strategy_id=self.id,
            symbol=symbol,
            side="buy",
            setup="bullish_6_7_low_sweep_touch" if trigger_mode == "sweep_touch" else "bullish_6_7_low_sweep_retest",
            signal_id=signal_id,
            timeframe=config.timeframe,
            signal_time=signal_time.isoformat(),
            entry_price=entry_price,
            target_price=target_price,
            stop_price=stop_price,
            score=round(max(0.0, min(100.0, score)), 2),
            profit_range=round(target_price - entry_price, 4),
            metadata={
                "range_low": entry_price,
                "body_target": target_price,
                "sweep_low": round(float(sweep_low), 4),
                "bars_since_signal": bars_since,
                "entry_trigger_mode": trigger_mode,
                "entry_trigger_rule": "aggressive_sweep_touch_no_reclaim_close" if trigger_mode == "sweep_touch" else "wait_for_close_back_above_range_low",
                "target_rule": "highest_body_open_or_close_no_wicks",
                "range_window_et": "09:00-10:00",
                "range_window_pt": "06:00-07:00",
            },
        )
