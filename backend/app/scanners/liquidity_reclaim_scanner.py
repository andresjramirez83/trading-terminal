from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from app.scanners.base import ScannerBase
from app.scanners.scanner_engine import ScannerEngine
from app.services.market_data_provider import MarketDataProvider
from app.services.scanner_cache_service import get_scanner_recent_1m_bars
from app.services.scanner_snapshot_store import ScannerSnapshotStore


def number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def normalize_bar(raw: Dict[str, Any]) -> Dict[str, float]:
    return {
        "time": number(raw.get("time", raw.get("t"))),
        "open": number(raw.get("open", raw.get("o"))),
        "high": number(raw.get("high", raw.get("h"))),
        "low": number(raw.get("low", raw.get("l"))),
        "close": number(raw.get("close", raw.get("c"))),
        "volume": number(raw.get("volume", raw.get("v"))),
    }


def atr_at(bars: List[Dict[str, float]], end: int, length: int = 14) -> float:
    start = max(1, end - length + 1)
    values: List[float] = []
    for index in range(start, end + 1):
        bar = bars[index]
        previous_close = bars[index - 1]["close"]
        values.append(
            max(
                bar["high"] - bar["low"],
                abs(bar["high"] - previous_close),
                abs(bar["low"] - previous_close),
            )
        )
    return sum(values) / len(values) if values else 0.0


def pivot_lows(bars: List[Dict[str, float]], start: int, end: int) -> List[Tuple[int, float]]:
    pivots: List[Tuple[int, float]] = []
    for index in range(max(2, start), min(end, len(bars) - 2)):
        low = bars[index]["low"]
        if low <= bars[index - 1]["low"] and low < bars[index + 1]["low"]:
            pivots.append((index, low))
    return pivots


def pivot_highs(bars: List[Dict[str, float]], start: int, end: int) -> List[Tuple[int, float]]:
    pivots: List[Tuple[int, float]] = []
    for index in range(max(2, start), min(end, len(bars) - 2)):
        high = bars[index]["high"]
        if high >= bars[index - 1]["high"] and high > bars[index + 1]["high"]:
            pivots.append((index, high))
    return pivots


def clustered_level(
    pivots: List[Tuple[int, float]],
    tolerance: float,
    minimum_touches: int,
) -> Optional[Tuple[float, List[int]]]:
    best: Optional[Tuple[float, List[int]]] = None
    for seed_index, seed_price in pivots:
        matches = [
            (index, price)
            for index, price in pivots
            if index >= seed_index and abs(price - seed_price) <= tolerance
        ]
        separated: List[Tuple[int, float]] = []
        for match in matches:
            if not separated or match[0] - separated[-1][0] >= 2:
                separated.append(match)
        if len(separated) < minimum_touches:
            continue
        level = sum(price for _, price in separated) / len(separated)
        candidate = (level, [index for index, _ in separated])
        if best is None or len(candidate[1]) > len(best[1]) or candidate[1][-1] > best[1][-1]:
            best = candidate
    return best


def bullish_setup(
    bars: List[Dict[str, float]],
    sweep_index: int,
    lookback: int,
    minimum_touches: int,
) -> Optional[Dict[str, Any]]:
    atr = atr_at(bars, sweep_index)
    price = bars[sweep_index]["close"]
    tolerance = max(price * 0.0008, atr * 0.15, 0.0001)
    penetration = max(atr * 0.06, tolerance * 0.5)
    level_data = clustered_level(
        pivot_lows(bars, max(0, sweep_index - lookback), sweep_index),
        tolerance,
        minimum_touches,
    )
    if not level_data:
        return None
    support, touch_indices = level_data
    sweep = bars[sweep_index]
    if sweep["low"] > support - penetration:
        return None

    body_low = min(sweep["open"], sweep["close"])
    body_high = max(sweep["open"], sweep["close"])
    if sweep["close"] >= support:
        stage = "RECLAIMED"
        reclaim_index = sweep_index
    else:
        if sweep_index + 1 >= len(bars):
            stage = "SWEEPING"
            reclaim_index = -1
        else:
            reclaim = bars[sweep_index + 1]
            if reclaim["close"] <= max(support, body_high):
                return None
            stage = "RECLAIMED"
            reclaim_index = sweep_index + 1

    last_index = len(bars) - 1
    if reclaim_index >= 0 and reclaim_index < last_index:
        hold = bars[reclaim_index + 1]
        if min(hold["open"], hold["close"]) < body_low and hold["close"] < support:
            return None
        if hold["close"] >= support and min(hold["open"], hold["close"]) >= body_low:
            stage = "CONFIRMED"

    consolidation_high = max(bar["high"] for bar in bars[touch_indices[0]:sweep_index + 1])
    confirmation_start = max(reclaim_index + 1, sweep_index + 1)
    if confirmation_start <= last_index and any(
        bar["close"] > consolidation_high for bar in bars[confirmation_start:last_index + 1]
    ):
        stage = "TRIGGERED"

    return {
        "direction": "bullish",
        "stage": stage,
        "level": support,
        "touches": len(touch_indices),
        "sweep_index": sweep_index,
        "sweep_low": sweep["low"],
        "sweep_body_low": body_low,
        "trigger_level": consolidation_high,
        "atr": atr,
    }


def bearish_setup(
    bars: List[Dict[str, float]],
    sweep_index: int,
    lookback: int,
    minimum_touches: int,
) -> Optional[Dict[str, Any]]:
    mirrored = [
        {**bar, "open": -bar["open"], "high": -bar["low"], "low": -bar["high"], "close": -bar["close"]}
        for bar in bars
    ]
    setup = bullish_setup(mirrored, sweep_index, lookback, minimum_touches)
    if not setup:
        return None
    return {
        **setup,
        "direction": "bearish",
        "level": -setup["level"],
        "sweep_low": -setup["sweep_low"],
        "sweep_body_low": -setup["sweep_body_low"],
        "trigger_level": -setup["trigger_level"],
    }


class LiquidityReclaimScanner(ScannerBase):
    id = "liquidity_reclaim"
    name = "Liquidity Sweep Reclaim"
    description = "Finds repeated support/resistance, a wick sweep, body reclaim, hold, and breakout trigger."

    async def run(
        self,
        market: MarketDataProvider,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = max(1, int(kwargs.get("max_symbols", 30)))
        min_price = number(kwargs.get("min_price"), 0.5)
        max_price = number(kwargs.get("max_price"), 20.0)
        minimum_touches = max(2, int(kwargs.get("min_touches", 3)))
        lookback = max(15, int(kwargs.get("touch_lookback", 40)))
        hours_back = max(8, int(kwargs.get("hours_back", 48)))
        concurrency = max(1, int(kwargs.get("concurrency", 20)))
        engine = ScannerEngine(concurrency=concurrency)
        universe = await engine.get_universe(market=market, limit=max(1000, max_symbols * 10), min_limit=1000)
        items = list(universe.items())[: max_symbols * 10]

        async def worker(item: Tuple[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
            symbol, snapshot = item
            raw = await get_scanner_recent_1m_bars(market, symbol, hours_back=hours_back)
            bars = [normalize_bar(bar) for bar in raw]
            bars = [bar for bar in bars if bar["time"] > 0 and bar["high"] > 0 and bar["low"] > 0]
            if len(bars) < lookback + 5:
                return None
            last_price = bars[-1]["close"]
            if last_price < min_price or (max_price > 0 and last_price > max_price):
                return None

            best: Optional[Dict[str, Any]] = None
            start = max(lookback, len(bars) - 12)
            for index in range(start, len(bars)):
                for detector in (bullish_setup, bearish_setup):
                    setup = detector(bars, index, lookback, minimum_touches)
                    if setup and (best is None or index > best["sweep_index"]):
                        best = setup
            if not best:
                return None

            stage_points = {"SWEEPING": 45, "RECLAIMED": 65, "CONFIRMED": 82, "TRIGGERED": 95}
            score = min(100, stage_points[best["stage"]] + min(5, best["touches"] - minimum_touches) * 2)
            volume = int(number(snapshot.get("volume", snapshot.get("v"))))
            direction = best["direction"]
            notes = [
                f"{best['touches']} level touches",
                f"{direction} sweep",
                best["stage"].lower(),
                "body hold valid",
            ]
            return {
                "symbol": symbol,
                "runner_type": f"{direction}_liquidity_sweep",
                "source": self.id,
                "scanner_id": self.id,
                "scanner_name": self.name,
                "timeframe": "1m",
                "setup_stage": best["stage"],
                "direction": direction,
                "liquidity_level": round(best["level"], 4),
                "support_level": round(best["level"], 4) if direction == "bullish" else None,
                "resistance_level": round(best["level"], 4) if direction == "bearish" else None,
                "touch_count": best["touches"],
                "sweep_price": round(best["sweep_low"], 4),
                "body_invalidation": round(best["sweep_body_low"], 4),
                "trigger_level": round(best["trigger_level"], 4),
                "trigger_time": int(bars[best["sweep_index"]]["time"]),
                "last_price": round(last_price, 4),
                "price": round(last_price, 4),
                "volume": volume,
                "pm_volume": volume,
                "runner_score": score,
                "score": score,
                "notes": notes,
            }

        rows, elapsed_ms = await engine.scan(items=items, worker=worker)
        rows.sort(key=lambda row: (number(row.get("runner_score")), number(row.get("touch_count"))), reverse=True)
        rows = rows[:max_symbols]
        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "liquidity_reclaim_1m",
            "timeframe": "1m",
            "count": len(rows),
            "rows": rows,
            "meta": {
                "checked": len(items),
                "passed": len(rows),
                "elapsed_ms": round(elapsed_ms, 1),
                "active_filters": {
                    "min_touches": minimum_touches,
                    "touch_lookback": lookback,
                    "hours_back": hours_back,
                },
            },
        }


__all__ = ["LiquidityReclaimScanner"]
