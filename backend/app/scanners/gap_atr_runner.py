from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.scanners.base import ScannerBase
from app.services.polygon_service import PolygonService
from app.services.scanner_snapshot_store import ScannerSnapshotStore

ET = ZoneInfo("America/New_York")


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def pct_change(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0
    return ((current - previous) / previous) * 100.0


def normalize_symbol(raw: Any) -> str:
    return "".join(ch for ch in str(raw or "").upper().strip() if ch.isalpha() or ch == ".")


def bar_time_ms(bar: Dict[str, Any]) -> int:
    return int(safe_float(bar.get("time", bar.get("t", 0))))


def normalize_bar(bar: Dict[str, Any]) -> Dict[str, float]:
    return {
        "time": bar_time_ms(bar),
        "open": safe_float(bar.get("open", bar.get("o"))),
        "high": safe_float(bar.get("high", bar.get("h"))),
        "low": safe_float(bar.get("low", bar.get("l"))),
        "close": safe_float(bar.get("close", bar.get("c"))),
        "volume": safe_float(bar.get("volume", bar.get("v"))),
    }


def candle_range(bar: Dict[str, float]) -> float:
    return max(0.0, float(bar["high"]) - float(bar["low"]))


def candle_body(bar: Dict[str, float]) -> float:
    return abs(float(bar["close"]) - float(bar["open"]))


def upper_wick(bar: Dict[str, float]) -> float:
    return max(0.0, float(bar["high"]) - max(float(bar["open"]), float(bar["close"])))


def lower_wick(bar: Dict[str, float]) -> float:
    return max(0.0, min(float(bar["open"]), float(bar["close"])) - float(bar["low"]))


def average(values: List[float]) -> float:
    clean = [v for v in values if v > 0]
    return sum(clean) / len(clean) if clean else 0.0


def calc_atr(bars: List[Dict[str, float]], period: int = 14) -> float:
    if len(bars) < 2:
        return 0.0
    true_ranges: List[float] = []
    for i in range(1, len(bars)):
        high = float(bars[i]["high"])
        low = float(bars[i]["low"])
        prev_close = float(bars[i - 1]["close"])
        true_ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return average(true_ranges[-period:])


def session_kind(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ET)
    hhmm = dt.hour * 100 + dt.minute
    if 400 <= hhmm < 930:
        return "premarket"
    if 930 <= hhmm < 1600:
        return "regular"
    if 1600 <= hhmm < 2000:
        return "afterhours"
    return "closed"


def et_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ET).strftime("%Y-%m-%d")


def et_time(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ET).strftime("%H:%M")


def group_regular_bars_by_day(bars: List[Dict[str, float]]) -> "OrderedDict[str, List[Dict[str, float]]]":
    grouped: "OrderedDict[str, List[Dict[str, float]]]" = OrderedDict()
    for bar in bars:
        if session_kind(int(bar["time"])) != "regular":
            continue
        grouped.setdefault(et_date(int(bar["time"])), []).append(bar)
    return grouped


async def build_snapshot_universe(polygon: PolygonService, limit: int) -> "OrderedDict[str, Dict[str, Any]]":
    merged: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

    async def add_rows(coro: Any) -> None:
        try:
            rows = await coro
        except Exception as exc:
            print(f"[gap-atr-runner] universe source failed: {exc}", flush=True)
            return
        for row in rows or []:
            symbol = normalize_symbol(row.get("ticker") or row.get("symbol"))
            if symbol and symbol not in merged:
                merged[symbol] = row

    await asyncio.gather(
        add_rows(polygon.get_snapshot_gainers(limit=limit)),
        add_rows(polygon.get_snapshot_actives(limit=limit)),
    )
    return merged


class GapAtrRunnerScanner(ScannerBase):
    id = "gap_atr_runner"
    name = "15m Gap ATR Runner"
    description = "Scans the last 3 trading days for clean gap-up 15m ATR expansion candles."

    async def run(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = int(kwargs.get("max_symbols", 30))
        min_price = float(kwargs.get("min_price", 0.5))
        max_price = float(kwargs.get("max_price", 20.0))
        min_volume = int(kwargs.get("min_volume", 150_000))
        min_gap_pct = float(kwargs.get("min_gap_pct", 3.0))
        min_atr_mult = float(kwargs.get("min_atr_mult", 1.5))
        min_body_pct = float(kwargs.get("min_body_pct", 0.62))
        max_upper_wick_pct = float(kwargs.get("max_upper_wick_pct", 0.28))
        min_close_position_pct = float(kwargs.get("min_close_position_pct", 0.68))
        min_volume_mult = float(kwargs.get("min_volume_mult", 1.25))
        lookback_days = int(kwargs.get("lookback_days", 3))

        universe = await build_snapshot_universe(polygon, limit=max(80, max_symbols * 6))
        rows: List[Dict[str, Any]] = []
        checked = 0

        for symbol, snapshot in list(universe.items())[: max_symbols * 10]:
            checked += 1
            row = await self._scan_symbol(
                polygon,
                symbol,
                snapshot,
                min_price=min_price,
                max_price=max_price,
                min_volume=min_volume,
                min_gap_pct=min_gap_pct,
                min_atr_mult=min_atr_mult,
                min_body_pct=min_body_pct,
                max_upper_wick_pct=max_upper_wick_pct,
                min_close_position_pct=min_close_position_pct,
                min_volume_mult=min_volume_mult,
                lookback_days=lookback_days,
            )
            if row is not None:
                rows.append(row)

        rows.sort(
            key=lambda item: (
                safe_float(item.get("runner_score")),
                safe_float(item.get("atr_mult")),
                safe_float(item.get("gap_pct")),
                safe_float(item.get("volume_mult")),
            ),
            reverse=True,
        )
        rows = rows[:max_symbols]

        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "gap_atr_15m",
            "timeframe": "15m",
            "lookback_days": lookback_days,
            "trade_day": datetime.now(ET).strftime("%Y-%m-%d"),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "checked": checked,
                "active_filters": {
                    "max_symbols": max_symbols,
                    "min_price": min_price,
                    "max_price": max_price,
                    "min_volume": min_volume,
                    "min_gap_pct": min_gap_pct,
                    "min_atr_mult": min_atr_mult,
                    "min_body_pct": min_body_pct,
                    "max_upper_wick_pct": max_upper_wick_pct,
                    "min_close_position_pct": min_close_position_pct,
                    "min_volume_mult": min_volume_mult,
                    "lookback_days": lookback_days,
                    "timeframe": "15m",
                },
            },
        }

    async def _scan_symbol(
        self,
        polygon: PolygonService,
        symbol: str,
        snapshot: Dict[str, Any],
        *,
        min_price: float,
        max_price: float,
        min_volume: int,
        min_gap_pct: float,
        min_atr_mult: float,
        min_body_pct: float,
        max_upper_wick_pct: float,
        min_close_position_pct: float,
        min_volume_mult: float,
        lookback_days: int,
    ) -> Optional[Dict[str, Any]]:
        try:
            bars_raw = await polygon.get_bars(symbol, "15m")
        except Exception as exc:
            print(f"[gap-atr-runner] bars failed {symbol}: {exc}", flush=True)
            return None

        bars = [normalize_bar(bar) for bar in bars_raw]
        bars = [bar for bar in bars if bar["time"] > 0 and bar["high"] > 0 and bar["low"] > 0 and bar["close"] > 0]
        if len(bars) < 35:
            return None

        days = group_regular_bars_by_day(bars)
        day_items = list(days.items())
        if len(day_items) < 2:
            return None

        best: Optional[Dict[str, Any]] = None
        recent_days = day_items[-max(1, lookback_days):]
        all_day_keys = [key for key, _ in day_items]

        for day_key, day_bars in recent_days:
            day_index = all_day_keys.index(day_key)
            if day_index <= 0 or not day_bars:
                continue
            prev_day_key, prev_day_bars = day_items[day_index - 1]
            if not prev_day_bars:
                continue

            prev_close = safe_float(prev_day_bars[-1].get("close"))
            day_open = safe_float(day_bars[0].get("open"))
            gap_pct = pct_change(day_open, prev_close)
            if gap_pct < min_gap_pct:
                continue

            context_before_day = [bar for key, rows in day_items[:day_index] for bar in rows]
            combined = context_before_day + day_bars

            for local_index, bar in enumerate(day_bars):
                global_index = len(context_before_day) + local_index
                prior = combined[max(0, global_index - 30):global_index]
                if len(prior) < 14:
                    continue

                price = safe_float(bar.get("close"))
                if price < min_price or (max_price > 0 and price > max_price):
                    continue

                rng = candle_range(bar)
                body = candle_body(bar)
                if rng <= 0 or body <= 0:
                    continue

                atr = calc_atr(prior, 14)
                avg_volume = average([safe_float(item.get("volume")) for item in prior[-20:]])
                volume = safe_float(bar.get("volume"))
                atr_mult = (rng / atr) if atr > 0 else 0.0
                body_pct = body / rng if rng > 0 else 0.0
                upper_pct = upper_wick(bar) / rng if rng > 0 else 0.0
                lower_pct = lower_wick(bar) / rng if rng > 0 else 0.0
                close_position_pct = (price - safe_float(bar.get("low"))) / rng if rng > 0 else 0.0
                volume_mult = (volume / avg_volume) if avg_volume > 0 else 0.0

                if safe_float(bar.get("close")) <= safe_float(bar.get("open")):
                    continue
                if volume < min_volume:
                    continue
                if atr_mult < min_atr_mult:
                    continue
                if body_pct < min_body_pct:
                    continue
                if upper_pct > max_upper_wick_pct:
                    continue
                if close_position_pct < min_close_position_pct:
                    continue
                if volume_mult < min_volume_mult:
                    continue

                score = 0.0
                score += min(gap_pct * 4.0, 30.0)
                score += min((atr_mult - 1.0) * 24.0, 28.0)
                score += min(body_pct * 24.0, 20.0)
                score += min(close_position_pct * 16.0, 14.0)
                score += min(volume_mult * 4.0, 18.0)
                score -= max(0.0, upper_pct - 0.15) * 20.0
                score = max(0.0, min(100.0, score))

                notes = ["15m gap-up", "ATR expansion", "clean green body"]
                if close_position_pct >= 0.82:
                    notes.append("closed near high")
                if volume_mult >= 2.0:
                    notes.append("volume expansion")

                candidate = {
                    "symbol": symbol,
                    "timeframe": "15m",
                    "runner_type": "gap_atr",
                    "source": "gap_atr_runner",
                    "scan_date": day_key,
                    "trigger_time": int(bar["time"]),
                    "trigger_time_et": f"{day_key} {et_time(int(bar['time']))} ET",
                    "last_price": round(price, 4),
                    "price": round(price, 4),
                    "prev_close": round(prev_close, 4),
                    "day_open": round(day_open, 4),
                    "gap_pct": round(gap_pct, 2),
                    "pm_gap_pct": round(gap_pct, 2),
                    "range_pct": round(pct_change(safe_float(bar.get("high")), safe_float(bar.get("low"))), 2),
                    "pm_range_pct": round(pct_change(safe_float(bar.get("high")), safe_float(bar.get("low"))), 2),
                    "volume": int(volume),
                    "pm_volume": int(volume),
                    "avg_15m_volume": int(avg_volume),
                    "volume_mult": round(volume_mult, 2),
                    "volume_accel_pct": round(max(0.0, (volume_mult - 1.0) * 100.0), 2),
                    "atr": round(atr, 4),
                    "atr_mult": round(atr_mult, 2),
                    "body_pct": round(body_pct * 100.0, 1),
                    "upper_wick_pct": round(upper_pct * 100.0, 1),
                    "lower_wick_pct": round(lower_pct * 100.0, 1),
                    "close_position_pct": round(close_position_pct * 100.0, 1),
                    "runner_score": round(score, 2),
                    "score": round(score, 2),
                    "notes": notes,
                    "extra": {
                        "bar_open": round(safe_float(bar.get("open")), 4),
                        "bar_high": round(safe_float(bar.get("high")), 4),
                        "bar_low": round(safe_float(bar.get("low")), 4),
                        "bar_close": round(price, 4),
                        "previous_regular_day": prev_day_key,
                    },
                }

                if best is None or safe_float(candidate.get("runner_score")) > safe_float(best.get("runner_score")):
                    best = candidate

        return best
