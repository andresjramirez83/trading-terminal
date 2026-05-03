from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.scanners.base import ScannerBase
from app.services.polygon_service import PolygonService
from app.services.scanner_snapshot_store import ScannerSnapshotStore


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def _pct_distance(price: float, zone_low: float, zone_high: float) -> float:
    if price <= 0 or zone_low <= 0 or zone_high <= 0:
        return 999.0
    if zone_low <= price <= zone_high:
        return 0.0
    nearest = zone_low if price < zone_low else zone_high
    return abs(price - nearest) / nearest * 100.0 if nearest > 0 else 999.0


def _bar_time(bar: Dict[str, Any]) -> int:
    return int(_safe_float(bar.get("time", bar.get("t", 0))))


def _normalize_bar(bar: Dict[str, Any]) -> Dict[str, float]:
    return {
        "time": _bar_time(bar),
        "open": _safe_float(bar.get("open", bar.get("o"))),
        "high": _safe_float(bar.get("high", bar.get("h"))),
        "low": _safe_float(bar.get("low", bar.get("l"))),
        "close": _safe_float(bar.get("close", bar.get("c"))),
        "volume": _safe_float(bar.get("volume", bar.get("v"))),
    }


def _avg_volume(bars: List[Dict[str, float]], lookback: int = 20) -> float:
    recent = bars[-lookback:] if len(bars) > lookback else bars
    vols = [b["volume"] for b in recent if b.get("volume", 0) > 0]
    return sum(vols) / len(vols) if vols else 0.0


def _candidate_from_snapshot(raw: Dict[str, Any], source: str) -> Optional[Dict[str, Any]]:
    symbol = str(raw.get("ticker") or raw.get("symbol") or "").upper().strip()
    if not symbol:
        return None

    day = raw.get("day") or {}
    prev = raw.get("prevDay") or {}
    last_trade = raw.get("lastTrade") or {}
    min_bar = raw.get("min") or {}

    price = _safe_float(last_trade.get("p")) or _safe_float(day.get("c")) or _safe_float(min_bar.get("c"))
    prev_close = _safe_float(prev.get("c"))
    volume = _safe_float(day.get("v")) or _safe_float(min_bar.get("v"))
    high = _safe_float(day.get("h"))
    low = _safe_float(day.get("l"))

    change_pct = ((price - prev_close) / prev_close * 100.0) if price > 0 and prev_close > 0 else 0.0
    range_pct = ((high - low) / low * 100.0) if high > 0 and low > 0 else 0.0
    discovery_score = abs(change_pct) * 1.8 + min(volume / 1_000_000.0, 30.0) + range_pct

    return {
        "symbol": symbol,
        "price": round(price, 4) if price > 0 else None,
        "prev_close": round(prev_close, 4) if prev_close > 0 else None,
        "volume": int(volume) if volume > 0 else 0,
        "change_pct": round(change_pct, 2),
        "range_pct": round(range_pct, 2),
        "source": source,
        "discovery_score": round(discovery_score, 2),
    }


def _find_latest_ifvg(bars: List[Dict[str, float]], max_age_bars: int = 24) -> Optional[Dict[str, Any]]:
    """Find the newest inverted FVG using simple FVG flip rules.

    Bullish IFVG: a bearish FVG exists, then price closes above its zone high.
    Bearish IFVG: a bullish FVG exists, then price closes below its zone low.
    """
    if len(bars) < 8:
        return None

    raw_fvgs: List[Dict[str, Any]] = []
    for i in range(2, len(bars)):
        left = bars[i - 2]
        right = bars[i]

        # Bullish FVG / gap up.
        if left["high"] < right["low"]:
            raw_fvgs.append({
                "created_index": i,
                "created_time": int(right["time"]),
                "original_direction": "bullish_fvg",
                "zone_low": left["high"],
                "zone_high": right["low"],
            })

        # Bearish FVG / gap down.
        if left["low"] > right["high"]:
            raw_fvgs.append({
                "created_index": i,
                "created_time": int(right["time"]),
                "original_direction": "bearish_fvg",
                "zone_low": right["high"],
                "zone_high": left["low"],
            })

    latest: Optional[Dict[str, Any]] = None
    last_index = len(bars) - 1

    for fvg in raw_fvgs:
        created = int(fvg["created_index"])
        if last_index - created > max_age_bars:
            continue

        zone_low = float(fvg["zone_low"])
        zone_high = float(fvg["zone_high"])
        direction = None
        flipped_index = None

        for j in range(created + 1, len(bars)):
            close = bars[j]["close"]
            if fvg["original_direction"] == "bearish_fvg" and close > zone_high:
                direction = "bullish"
                flipped_index = j
                break
            if fvg["original_direction"] == "bullish_fvg" and close < zone_low:
                direction = "bearish"
                flipped_index = j
                break

        if not direction or flipped_index is None:
            continue

        if last_index - flipped_index > max_age_bars:
            continue

        item = {
            **fvg,
            "direction": direction,
            "flipped_index": flipped_index,
            "flipped_time": int(bars[flipped_index]["time"]),
            "age_bars": last_index - flipped_index,
        }

        if latest is None or int(item["flipped_index"]) > int(latest["flipped_index"]):
            latest = item

    return latest


def _classify_ifvg(ifvg: Dict[str, Any], bars: List[Dict[str, float]]) -> Dict[str, Any]:
    last = bars[-1]
    prev = bars[-2] if len(bars) >= 2 else last
    zone_low = float(ifvg["zone_low"])
    zone_high = float(ifvg["zone_high"])
    direction = str(ifvg["direction"])
    price = float(last["close"])
    avg_vol = _avg_volume(bars[:-1] or bars, 20)
    rvol = (last["volume"] / avg_vol) if avg_vol > 0 else 0.0

    touched = bool(last["low"] <= zone_high and last["high"] >= zone_low)
    distance_pct = _pct_distance(price, zone_low, zone_high)
    status = "fresh"
    phase = "watch"
    score = 45.0
    notes: List[str] = []

    age = int(ifvg.get("age_bars") or 0)
    if age <= 6:
        score += 12
        notes.append("fresh inversion")
    elif age <= 14:
        score += 6
        notes.append("still relevant")
    else:
        score -= 8
        notes.append("aging zone")

    if distance_pct <= 0.0:
        status = "retest"
        phase = "prealert"
        score += 18
        notes.append("price inside IFVG zone")
    elif distance_pct <= 1.0:
        status = "approaching"
        phase = "watch"
        score += 10
        notes.append("within 1% of zone")
    elif distance_pct <= 2.0:
        status = "approaching"
        phase = "watch"
        score += 5
        notes.append("within 2% of zone")

    if direction == "bullish":
        bounce = touched and price > zone_high and price > last["open"] and price >= prev["close"]
        failure = price < zone_low
    else:
        bounce = touched and price < zone_low and price < last["open"] and price <= prev["close"]
        failure = price > zone_high

    if bounce:
        status = "bounce_confirmed"
        phase = "confirmed"
        score += 24
        notes.append("reaction confirmed")
    elif failure:
        status = "failure"
        phase = "confirmed"
        score += 16
        notes.append("zone failed")

    if rvol >= 2.0:
        score += 12
        notes.append("high relative volume")
    elif rvol >= 1.25:
        score += 6
        notes.append("volume above average")

    zone_width_pct = ((zone_high - zone_low) / zone_low * 100.0) if zone_low > 0 else 0.0
    if 0.15 <= zone_width_pct <= 4.5:
        score += 7
        notes.append("clean zone width")
    elif zone_width_pct > 8:
        score -= 12
        notes.append("wide/risky zone")

    return {
        "status": status,
        "phase": phase,
        "score": round(max(0.0, min(100.0, score)), 2),
        "last_price": round(price, 4),
        "distance_to_zone_pct": round(distance_pct, 2),
        "rvol": round(rvol, 2),
        "zone_width_pct": round(zone_width_pct, 2),
        "notes": notes,
    }


class IFVGHTFScanner(ScannerBase):
    id = "ifvg_htf"
    name = "HTF IFVG Scanner"
    description = "Broad 15m/30m IFVG scanner with fresh, retest, bounce, and failure states."

    async def _discover_candidates(
        self,
        polygon: PolygonService,
        *,
        max_candidates: int,
        min_price: float,
        max_price: float,
        min_volume: int,
        extra_symbols: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        merged: Dict[str, Dict[str, Any]] = {}

        async def add_snapshot_rows(coro: Any, source: str) -> None:
            try:
                rows = await coro
            except Exception as exc:
                print(f"[ifvg-htf] discovery source failed {source}: {exc}", flush=True)
                return
            for raw in rows or []:
                item = _candidate_from_snapshot(raw, source)
                if not item:
                    continue
                symbol = item["symbol"]
                if symbol in merged:
                    merged[symbol]["discovery_score"] = max(
                        float(merged[symbol].get("discovery_score") or 0),
                        float(item.get("discovery_score") or 0),
                    ) + 3.0
                    merged[symbol]["source"] = f"{merged[symbol].get('source')}+{source}"
                    merged[symbol]["volume"] = max(int(merged[symbol].get("volume") or 0), int(item.get("volume") or 0))
                else:
                    merged[symbol] = item

        # Option B: broad discovery, but capped for server safety.
        request_limit = max(50, min(max_candidates * 2, 250))
        await asyncio.gather(
            add_snapshot_rows(polygon.get_snapshot_gainers(limit=request_limit), "gainers"),
            add_snapshot_rows(polygon.get_snapshot_actives(limit=request_limit), "active"),
            add_snapshot_rows(polygon.get_snapshot_losers(limit=request_limit), "losers"),
        )

        for raw_symbol in extra_symbols or []:
            symbol = "".join(ch for ch in str(raw_symbol).upper().strip() if ch.isalpha() or ch == ".")
            if symbol and symbol not in merged:
                merged[symbol] = {"symbol": symbol, "price": None, "volume": 0, "source": "manual", "discovery_score": 100.0}

        rows = []
        for item in merged.values():
            price = _safe_float(item.get("price"), 0.0)
            volume = int(_safe_float(item.get("volume"), 0.0))
            if price > 0 and price < min_price:
                continue
            if price > 0 and max_price > 0 and price > max_price:
                continue
            if volume and volume < min_volume:
                continue
            rows.append(item)

        rows.sort(key=lambda row: float(row.get("discovery_score") or 0), reverse=True)
        return rows[:max_candidates]

    async def _scan_symbol_timeframe(self, polygon: PolygonService, candidate: Dict[str, Any], timeframe: str) -> Optional[Dict[str, Any]]:
        symbol = str(candidate.get("symbol") or "").upper().strip()
        if not symbol:
            return None

        try:
            bars_raw = await polygon.get_bars(symbol, timeframe)
        except Exception as exc:
            print(f"[ifvg-htf] bars failed {symbol} {timeframe}: {exc}", flush=True)
            return None

        bars = [_normalize_bar(bar) for bar in bars_raw]
        bars = [bar for bar in bars if bar["high"] > 0 and bar["low"] > 0 and bar["close"] > 0]
        if len(bars) < 20:
            return None

        ifvg = _find_latest_ifvg(bars, max_age_bars=28)
        if not ifvg:
            return None

        state = _classify_ifvg(ifvg, bars)
        if state["status"] == "fresh" and state["distance_to_zone_pct"] > 3.0:
            return None

        row = {
            "symbol": symbol,
            "timeframe": timeframe,
            "last_price": state["last_price"],
            "price": state["last_price"],
            "score": state["score"],
            "ifvg_score": state["score"],
            "ifvg_status": state["status"],
            "ifvg_phase": state["phase"],
            "ifvg_direction": ifvg["direction"],
            "zone_low": round(float(ifvg["zone_low"]), 4),
            "zone_high": round(float(ifvg["zone_high"]), 4),
            "distance_to_zone_pct": state["distance_to_zone_pct"],
            "rvol": state["rvol"],
            "zone_width_pct": state["zone_width_pct"],
            "age_bars": int(ifvg.get("age_bars") or 0),
            "volume": int(_safe_float(bars[-1].get("volume"), 0.0)),
            "source": candidate.get("source"),
            "notes": state["notes"],
            "extra": {
                "created_time": ifvg.get("created_time"),
                "flipped_time": ifvg.get("flipped_time"),
                "original_direction": ifvg.get("original_direction"),
                "discovery_score": candidate.get("discovery_score"),
            },
        }
        return row

    async def run(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = max(1, min(int(kwargs.get("max_symbols") or 25), 100))
        min_price = float(kwargs.get("min_price") if kwargs.get("min_price") is not None else 0.5)
        max_price = float(kwargs.get("max_price") if kwargs.get("max_price") is not None else 20.0)
        min_volume = int(kwargs.get("min_volume") if kwargs.get("min_volume") is not None else 250_000)
        max_candidates = max(max_symbols * 4, int(kwargs.get("max_candidates") or 80))
        max_candidates = max(20, min(max_candidates, 160))

        raw_timeframes = kwargs.get("timeframes") or ["15m", "30m"]
        if isinstance(raw_timeframes, str):
            raw_timeframes = [part.strip() for part in raw_timeframes.split(",")]
        timeframes = [tf for tf in raw_timeframes if tf in {"15m", "30m"}] or ["15m", "30m"]

        extra_symbols = kwargs.get("symbols") or []
        if isinstance(extra_symbols, str):
            extra_symbols = [part.strip() for part in extra_symbols.split(",")]

        candidates = await self._discover_candidates(
            polygon,
            max_candidates=max_candidates,
            min_price=min_price,
            max_price=max_price,
            min_volume=min_volume,
            extra_symbols=extra_symbols,
        )

        sem = asyncio.Semaphore(8)

        async def guarded(candidate: Dict[str, Any], tf: str) -> Optional[Dict[str, Any]]:
            async with sem:
                return await self._scan_symbol_timeframe(polygon, candidate, tf)

        tasks = [guarded(candidate, tf) for candidate in candidates for tf in timeframes]
        raw_results = await asyncio.gather(*tasks) if tasks else []
        rows = [row for row in raw_results if row]

        status_rank = {
            "bounce_confirmed": 5,
            "retest": 4,
            "approaching": 3,
            "fresh": 2,
            "failure": 1,
        }
        rows.sort(
            key=lambda row: (
                float(row.get("score") or 0),
                status_rank.get(str(row.get("ifvg_status")), 0),
                -float(row.get("distance_to_zone_pct") or 999),
            ),
            reverse=True,
        )
        rows = rows[:max_symbols]

        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "broad_htf_ifvg",
            "trade_day": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "universe_mode": "broad_snapshot_gainers_actives_losers",
                "candidate_count": len(candidates),
                "timeframes": timeframes,
                "max_candidates": max_candidates,
                "filters": {
                    "min_price": min_price,
                    "max_price": max_price,
                    "min_volume": min_volume,
                    "max_symbols": max_symbols,
                },
            },
        }
