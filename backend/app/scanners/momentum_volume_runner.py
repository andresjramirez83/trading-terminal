from __future__ import annotations

import math
import time
from datetime import date
from statistics import median
from typing import Any

from app.scanners.base import ScannerBase
from app.scanners.scanner_engine import ScannerEngine
from app.services.scanner_cache_service import get_scanner_recent_1m_bars
from app.services.scanner_universe_service import get_scanner_universe


def num(value: Any) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else 0.0
    except (TypeError, ValueError):
        return 0.0


class MomentumVolumeRunnerScanner(ScannerBase):
    id = "momentum_volume_runner"
    name = "MVR - Momentum & Volume Runner"
    description = "All-session low-price momentum scanner; rejects thin, erratic candles and flags data-backed SS candidates."

    async def run(self, market, snapshot_store, **kwargs):
        cap = max(1, min(100, int(kwargs.get("max_symbols") or 30)))
        universe = await get_scanner_universe(market=market, limit=1000, min_limit=1000)
        items = list(universe.items())[:min(180, max(80, cap * 5))]
        engine = ScannerEngine(concurrency=10)

        async def evaluate(item):
            symbol, snapshot = item
            raw = await get_scanner_recent_1m_bars(market, symbol, hours_back=24)
            bars = [{"t": num(b.get("time", b.get("t"))), "o": num(b.get("open", b.get("o"))), "h": num(b.get("high", b.get("h"))), "l": num(b.get("low", b.get("l"))), "c": num(b.get("close", b.get("c"))), "v": num(b.get("volume", b.get("v"))), "n": num(b.get("trade_count", b.get("n")))} for b in raw if isinstance(b, dict)]
            bars = sorted((b for b in bars if b["t"] > 0 and b["c"] > 0 and b["h"] >= b["l"]), key=lambda b: b["t"])
            if len(bars) < 30:
                return None
            recent, previous = bars[-5:], bars[-25:-5]
            price = recent[-1]["c"]
            if not 0.5 <= price <= 20:
                return None
            times = [b["t"] / 1000 if b["t"] > 1e11 else b["t"] for b in recent]
            if time.time() - times[-1] > 12 * 60 or times[-1] - times[0] > 7 * 60:
                return None
            participation = sum(b["v"] >= 1000 and b["v"] * b["c"] >= 2500 for b in recent)
            dollars = sum(b["v"] * b["c"] for b in recent)
            if participation < 4 or dollars < 50000:
                return None
            volume_ratio = (sum(b["v"] for b in recent) / 5) / max(1, median(b["v"] for b in previous))
            change = (price / recent[0]["o"] - 1) * 100 if recent[0]["o"] > 0 else 0
            bar_range = (max(b["h"] for b in recent) / min(b["l"] for b in recent) - 1) * 100 if min(b["l"] for b in recent) > 0 else 0
            travel = sum(abs(recent[i]["c"] - recent[i-1]["c"]) for i in range(1, 5))
            efficiency = abs(price - recent[0]["o"]) / max(travel + abs(recent[0]["c"] - recent[0]["o"]), 0.000001)
            if volume_ratio < 1.3 or (abs(change) < 2 and bar_range < 4) or efficiency < 0.30:
                return None
            trades = sum(b["n"] for b in recent)
            if trades > 0 and trades < 40:
                return None
            bid = num(snapshot.get("bid_price", snapshot.get("bid")))
            ask = num(snapshot.get("ask_price", snapshot.get("ask")))
            spread = 100 * (ask - bid) / price if ask > bid > 0 else None
            if spread is not None and spread > 2.5:
                return None
            resistance = max(b["h"] for b in previous)
            breakout = change > 0 and price > resistance
            score = round(min(35, 14 + 7 * min(volume_ratio, 3)) + min(25, abs(change) * 3 + bar_range) + min(20, 20 * min(efficiency, 1)) + min(15, dollars / 12000) + (5 if breakout else 0))
            if score < 60:
                return None
            stage = "SELLING PRESSURE" if change <= -2 else "ACTIVE RUNNER" if change >= 3 and volume_ratio >= 2 and dollars >= 100000 else "WAKING UP" if change > 0 else "HIGH VOLATILITY"
            short_pct = num(snapshot.get("short_interest_pct", snapshot.get("shortInterestPercent")))
            if 0 < short_pct < 1:
                short_pct *= 100
            as_of = str(snapshot.get("short_interest_asof") or snapshot.get("short_interest_date") or "")[:10]
            try:
                short_current = 0 <= (date.today() - date.fromisoformat(as_of)).days <= 35
            except ValueError:
                short_current = False
            squeeze = short_current and short_pct >= 15 and breakout and volume_ratio >= 2
            if squeeze:
                stage += " SS"
            return {"symbol": symbol, "signal_time": recent[-1]["t"], "scanner_id": self.id, "scanner_name": self.name, "source": self.id, "runner_type": "momentum_volume", "setup_stage": stage, "last_price": round(price, 4), "price": round(price, 4), "volume": int(sum(b["v"] for b in recent)), "pm_volume": int(sum(b["v"] for b in recent)), "dollar_volume_5m": round(dollars), "change_5m_pct": round(change, 2), "range_5m_pct": round(bar_range, 2), "relative_volume_5m": round(volume_ratio, 2), "active_candles_5m": participation, "trade_count_5m": int(trades) if trades else None, "spread_pct": round(spread, 2) if spread is not None else None, "resistance_level": round(resistance, 4), "short_squeeze_label": "SS" if squeeze else None, "short_interest_pct": round(short_pct, 2) if short_current else None, "runner_score": score, "score": score, "notes": [stage, f"5m {change:+.1f}%", f"Volume {volume_ratio:.1f}x", f"{participation}/5 active candles", "SS data verified" if squeeze else "Short interest unverified"]}

        rows, elapsed_ms = await engine.scan(items=items, worker=evaluate)
        rows.sort(key=lambda row: row["runner_score"], reverse=True)
        rows = rows[:cap]
        return {"scanner_id": self.id, "scanner_name": self.name, "description": self.description, "workflow": self.id, "timeframe": "1m", "count": len(rows), "rows": rows, "meta": {"checked": len(items), "passed": len(rows), "elapsed_ms": round(elapsed_ms, 1), "short_interest": "SS only when dated short interest is provided"}}
