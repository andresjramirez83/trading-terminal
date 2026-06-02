from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.scanners.base import ScannerBase
from app.services.polygon_service import PolygonService
from app.services.scanner_snapshot_store import ScannerSnapshotStore


# ==================================================
# Bullish HTF IFVG scanner for higher-quality setups
# ==================================================
# What this version filters for:
# 1) Bullish IFVG only: bearish FVG -> close above zone high.
# 2) Fresh setup only: default max IFVG age = 8 bars.
# 3) Clean zone width: default 0.25% to 3.0%.
# 4) Strong flip candle / displacement.
# 5) Flip candle RVOL requirement.
# 6) Close above VWAP.
# 7) Bullish MSS: flip candle closes above prior swing/high structure.
# 8) Liquidity sweep before flip.
# 9) Setup timeframe is locked to 15m.
# 10) Entry trigger uses 5m close back above the 15m IFVG zone high.
# 11) Auto-trade fields: entry, stop, targets, ready flag.


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


def _avg_body(bars: List[Dict[str, float]], lookback: int = 10) -> float:
    recent = bars[-lookback:] if len(bars) > lookback else bars
    bodies = [abs(b["close"] - b["open"]) for b in recent if b.get("high", 0) > b.get("low", 0)]
    return sum(bodies) / len(bodies) if bodies else 0.0


def _body_pct(bar: Dict[str, float]) -> float:
    rng = float(bar["high"] - bar["low"])
    if rng <= 0:
        return 0.0
    return abs(float(bar["close"] - bar["open"])) / rng


def _vwap_at_index(bars: List[Dict[str, float]], index: int) -> float:
    pv = 0.0
    vol = 0.0
    for b in bars[: index + 1]:
        v = float(b.get("volume") or 0.0)
        if v <= 0:
            continue
        typical = (float(b["high"]) + float(b["low"]) + float(b["close"])) / 3.0
        pv += typical * v
        vol += v
    return pv / vol if vol > 0 else 0.0


def _highest_high(bars: List[Dict[str, float]]) -> float:
    highs = [float(b.get("high") or 0.0) for b in bars]
    return max(highs) if highs else 0.0


def _lowest_low(bars: List[Dict[str, float]]) -> float:
    lows = [float(b.get("low") or 0.0) for b in bars if float(b.get("low") or 0.0) > 0]
    return min(lows) if lows else 0.0


def _find_prior_swing_high(bars: List[Dict[str, float]], before_index: int, lookback: int = 12) -> float:
    start = max(0, before_index - lookback)
    prior = bars[start:before_index]
    return _highest_high(prior)


def _find_next_swing_targets(bars: List[Dict[str, float]], from_index: int, entry: float) -> Tuple[Optional[float], Optional[float]]:
    """Simple target finder using highs after the FVG was created/flipped.

    T1 = nearest meaningful high above entry.
    T2 = next higher high above T1.
    This keeps compatibility until your chart-side swing-high target logic is wired in.
    """
    highs = sorted({round(float(b["high"]), 4) for b in bars[from_index:] if float(b.get("high") or 0) > entry})
    if not highs:
        return None, None
    t1 = highs[0]
    t2 = None
    for h in highs[1:]:
        if h > t1:
            t2 = h
            break
    return t1, t2


def _find_pre_flip_sweep_low(
    bars: List[Dict[str, float]],
    flip_index: int,
    *,
    sweep_lookback_bars: int = 8,
    prior_low_lookback: int = 12,
) -> Tuple[bool, Optional[float], Optional[int]]:
    """Detect a bullish liquidity sweep before the IFVG flip.

    A sweep is counted when a candle before the flip takes a prior low and closes
    back above that prior low. This is intentionally simple and deterministic.
    """
    start = max(prior_low_lookback, flip_index - sweep_lookback_bars)
    for i in range(flip_index - 1, start - 1, -1):
        prior = bars[max(0, i - prior_low_lookback):i]
        if len(prior) < 3:
            continue
        prior_low = _lowest_low(prior)
        if prior_low <= 0:
            continue
        bar = bars[i]
        if float(bar["low"]) < prior_low and float(bar["close"]) > prior_low:
            return True, float(bar["low"]), i
    return False, None, None


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


def _find_latest_bullish_ifvg(
    bars: List[Dict[str, float]],
    *,
    max_age_bars: int = 8,
    min_zone_width_pct: float = 0.25,
    max_zone_width_pct: float = 3.0,
    min_flip_rvol: float = 1.5,
    min_flip_body_pct: float = 0.60,
    require_mss: bool = True,
    require_vwap: bool = True,
    require_sweep: bool = True,
) -> Optional[Dict[str, Any]]:
    """Find newest bullish IFVG that passes auto-trade quality filters.

    Bullish IFVG only:
    - A bearish FVG exists: left.low > right.high.
    - Later, a candle closes above zone_high.
    """
    if len(bars) < 25:
        return None

    raw_bearish_fvgs: List[Dict[str, Any]] = []
    for i in range(2, len(bars)):
        left = bars[i - 2]
        right = bars[i]

        # Bearish FVG / gap down. This is the only FVG type we care about
        # because a reclaim above it creates a bullish IFVG.
        if left["low"] > right["high"]:
            zone_low = float(right["high"])
            zone_high = float(left["low"])
            width_pct = ((zone_high - zone_low) / zone_low * 100.0) if zone_low > 0 else 999.0
            if min_zone_width_pct <= width_pct <= max_zone_width_pct:
                raw_bearish_fvgs.append({
                    "created_index": i,
                    "created_time": int(right["time"]),
                    "original_direction": "bearish_fvg",
                    "direction": "bullish",
                    "zone_low": zone_low,
                    "zone_high": zone_high,
                    "zone_width_pct": width_pct,
                })

    latest: Optional[Dict[str, Any]] = None
    last_index = len(bars) - 1

    for fvg in raw_bearish_fvgs:
        created = int(fvg["created_index"])
        if last_index - created > max_age_bars:
            continue

        zone_low = float(fvg["zone_low"])
        zone_high = float(fvg["zone_high"])

        for j in range(created + 1, len(bars)):
            flip_bar = bars[j]
            flip_close = float(flip_bar["close"])
            if flip_close <= zone_high:
                continue

            if last_index - j > max_age_bars:
                continue

            avg_vol = _avg_volume(bars[max(0, j - 20):j], 20)
            flip_rvol = (float(flip_bar["volume"]) / avg_vol) if avg_vol > 0 else 0.0
            avg_body = _avg_body(bars[max(0, j - 10):j], 10)
            flip_body = abs(float(flip_bar["close"] - flip_bar["open"]))
            flip_body_pct = _body_pct(flip_bar)
            displacement_ok = (
                flip_bar["close"] > flip_bar["open"]
                and flip_body_pct >= min_flip_body_pct
                and (avg_body <= 0 or flip_body >= avg_body)
            )

            prior_swing_high = _find_prior_swing_high(bars, j, lookback=12)
            mss_ok = prior_swing_high > 0 and flip_close > prior_swing_high

            flip_vwap = _vwap_at_index(bars, j)
            vwap_ok = flip_vwap > 0 and flip_close > flip_vwap

            sweep_ok, sweep_low, sweep_index = _find_pre_flip_sweep_low(bars, j)

            if flip_rvol < min_flip_rvol:
                continue
            if not displacement_ok:
                continue
            if require_mss and not mss_ok:
                continue
            if require_vwap and not vwap_ok:
                continue
            if require_sweep and not sweep_ok:
                continue

            item = {
                **fvg,
                "flipped_index": j,
                "flipped_time": int(flip_bar["time"]),
                "age_bars": last_index - j,
                "flip_rvol": flip_rvol,
                "flip_body_pct": flip_body_pct,
                "flip_vwap": flip_vwap,
                "prior_swing_high": prior_swing_high,
                "mss_ok": mss_ok,
                "vwap_ok": vwap_ok,
                "displacement_ok": displacement_ok,
                "sweep_ok": sweep_ok,
                "sweep_low": sweep_low,
                "sweep_index": sweep_index,
            }

            if latest is None or int(item["flipped_index"]) > int(latest["flipped_index"]):
                latest = item
            break

    return latest


def _find_bars_since_zone_touch(bars: List[Dict[str, float]], zone_low: float, zone_high: float) -> Optional[int]:
    for offset, bar in enumerate(reversed(bars)):
        if bar["low"] <= zone_high and bar["high"] >= zone_low:
            return offset
    return None



def _find_5m_entry_confirmation(
    trigger_bars: List[Dict[str, float]],
    *,
    zone_low: float,
    zone_high: float,
    flipped_time: int,
    max_trigger_age_bars: int = 6,
    setup_bar_ms: int = 15 * 60 * 1000,
) -> Dict[str, Any]:
    """Confirm a 15m bullish IFVG with a 5m close trigger.

    Rule:
    - Only look at 5m candles after the 15m IFVG flip time.
    - Price must retest/touch the 15m IFVG zone.
    - Then a 5m candle must close back above zone_high.

    This prevents the bot from buying the 15m flip candle. It only fires
    after the lower-timeframe reclaim confirms buyers defended the IFVG.
    """
    # Polygon aggregate timestamps are normally bar start times. For a 15m
    # setup candle, the earliest valid 5m trigger should begin after that 15m
    # flip candle has closed, so we do not accidentally enter on the flip itself.
    earliest_trigger_time = int(flipped_time or 0) + int(setup_bar_ms or 0)
    usable = [b for b in trigger_bars if int(b.get("time") or 0) >= earliest_trigger_time]
    if not usable:
        return {
            "trigger_confirmed": False,
            "trigger_status": "waiting_for_5m_data",
            "trigger_close": None,
            "trigger_time": None,
            "trigger_bars_since_touch": None,
            "trigger_touched_zone": False,
        }

    touched_index: Optional[int] = None
    for i, bar in enumerate(usable):
        if float(bar["low"]) <= zone_high and float(bar["high"]) >= zone_low:
            touched_index = i

    if touched_index is None:
        return {
            "trigger_confirmed": False,
            "trigger_status": "waiting_for_5m_retest",
            "trigger_close": round(float(usable[-1]["close"]), 4),
            "trigger_time": int(usable[-1]["time"]),
            "trigger_bars_since_touch": None,
            "trigger_touched_zone": False,
        }

    last_index = len(usable) - 1
    last = usable[-1]
    bars_since_touch = last_index - touched_index

    # Keep the trigger fresh. If the retest happened too long ago and did not
    # confirm, the setup remains armed but should not auto-fire.
    if bars_since_touch > max_trigger_age_bars:
        return {
            "trigger_confirmed": False,
            "trigger_status": "5m_retest_stale",
            "trigger_close": round(float(last["close"]), 4),
            "trigger_time": int(last["time"]),
            "trigger_bars_since_touch": bars_since_touch,
            "trigger_touched_zone": True,
        }

    # Entry trigger: latest 5m candle closes back above the 15m IFVG zone high.
    confirmed = bool(float(last["close"]) > zone_high and float(last["close"]) >= float(last["open"]))
    return {
        "trigger_confirmed": confirmed,
        "trigger_status": "5m_close_confirmed" if confirmed else "waiting_for_5m_close_above_zone",
        "trigger_close": round(float(last["close"]), 4),
        "trigger_time": int(last["time"]),
        "trigger_bars_since_touch": bars_since_touch,
        "trigger_touched_zone": True,
    }


def _classify_bullish_ifvg(
    ifvg: Dict[str, Any],
    bars: List[Dict[str, float]],
    *,
    trigger_state: Optional[Dict[str, Any]] = None,
    max_distance_to_zone_pct: float = 1.0,
    stop_buffer_pct: float = 0.002,
) -> Dict[str, Any]:
    last = bars[-1]
    prev = bars[-2] if len(bars) >= 2 else last
    zone_low = float(ifvg["zone_low"])
    zone_high = float(ifvg["zone_high"])
    price = float(last["close"])
    open_price = float(last["open"])
    avg_vol = _avg_volume(bars[:-1] or bars, 20)
    rvol = (last["volume"] / avg_vol) if avg_vol > 0 else 0.0

    touched = bool(last["low"] <= zone_high and last["high"] >= zone_low)
    bars_since_touch = _find_bars_since_zone_touch(bars, zone_low, zone_high)
    distance_pct = _pct_distance(price, zone_low, zone_high)
    age = int(ifvg.get("age_bars") or 0)

    failure = price < zone_low
    bounce = touched and price > zone_high and price > open_price and price >= prev["close"]

    status = "fresh"
    phase = "ARMED"
    alert_phase = "watch"
    notes: List[str] = []
    score = 0.0
    trigger_state = trigger_state or {}
    trigger_confirmed = bool(trigger_state.get("trigger_confirmed"))
    trigger_status = str(trigger_state.get("trigger_status") or "waiting_for_5m_retest")
    trigger_close = _safe_float(trigger_state.get("trigger_close"), 0.0)

    # Hard quality criteria already passed in _find_latest_bullish_ifvg.
    score += 30
    notes.append("bullish MSS confirmed")
    score += 20
    notes.append("liquidity sweep before flip")
    score += 15
    notes.append("flip RVOL passed")
    score += 10
    notes.append("flip closed above VWAP")
    score += 10
    notes.append("strong displacement flip")
    score += 10
    notes.append("clean IFVG zone")

    if age <= 4:
        score += 5
        notes.append("very fresh")
    elif age <= 8:
        notes.append("fresh")
    else:
        score -= 20
        notes.append("aging setup")

    if failure:
        status = "failure"
        phase = "FAILED"
        alert_phase = "confirmed"
        score -= 35
        notes.append("closed below IFVG zone")
    elif trigger_confirmed:
        status = "5m_entry_confirmed"
        phase = "TRIGGERED"
        alert_phase = "confirmed"
        score += 12
        notes.append("5m close confirmed above 15m IFVG zone")
    elif touched and zone_low <= price <= zone_high:
        status = "retest"
        phase = "READY"
        alert_phase = "prealert"
        score += 8
        notes.append("15m price retesting IFVG zone; waiting for 5m close")
    elif bounce:
        status = "bounce_confirmed"
        phase = "CONFIRMED"
        alert_phase = "confirmed"
        score += 3
        notes.append("15m reaction confirmed; waiting for 5m trigger")
    elif distance_pct <= 0.5:
        status = "approaching"
        phase = "ARMED"
        alert_phase = "watch"
        score += 5
        notes.append("within 0.5% of zone")
    elif distance_pct <= max_distance_to_zone_pct:
        status = "approaching"
        phase = "ARMED"
        alert_phase = "watch"
        notes.append("within max distance of zone")
    else:
        status = "extended"
        phase = "EXTENDED"
        score -= 25
        notes.append("too far from IFVG zone")

    if trigger_status:
        notes.append(trigger_status.replace("_", " "))

    entry_price = trigger_close if trigger_confirmed and trigger_close > 0 else (zone_low + zone_high) / 2.0
    sweep_low = _safe_float(ifvg.get("sweep_low"), 0.0)
    stop_basis = sweep_low if sweep_low > 0 else zone_low
    stop_loss = stop_basis * (1.0 - stop_buffer_pct)
    t1, t2 = _find_next_swing_targets(bars, int(ifvg.get("flipped_index") or 0), entry_price)

    # Auto trade fires only after the 15m setup retests and the 5m candle
    # closes back above the 15m IFVG zone high.
    auto_trade_ready = (
        phase == "TRIGGERED"
        and trigger_confirmed
        and not failure
        and stop_loss > 0
        and entry_price > stop_loss
    )

    return {
        "status": status,
        "phase": phase,
        "alert_phase": alert_phase,
        "score": round(max(0.0, min(100.0, score)), 2),
        "last_price": round(price, 4),
        "distance_to_zone_pct": round(distance_pct, 2),
        "rvol": round(rvol, 2),
        "zone_width_pct": round(float(ifvg.get("zone_width_pct") or 0.0), 2),
        "bars_since_touch": bars_since_touch,
        "notes": notes,
        "entry_price": round(entry_price, 4),
        "stop_loss": round(stop_loss, 4),
        "target_1": round(t1, 4) if t1 else None,
        "target_2": round(t2, 4) if t2 else None,
        "auto_trade_ready": auto_trade_ready,
        "entry_trigger_timeframe": "5m",
        "entry_trigger_rule": "5m_close_above_15m_ifvg_zone_high_after_retest",
        "trigger_confirmed": trigger_confirmed,
        "trigger_status": trigger_status,
        "trigger_close": round(trigger_close, 4) if trigger_close > 0 else None,
        "trigger_time": trigger_state.get("trigger_time"),
        "trigger_bars_since_touch": trigger_state.get("trigger_bars_since_touch"),
    }


class IFVGHTFScanner(ScannerBase):
    id = "ifvg_htf"
    name = "Bullish HTF IFVG Scanner"
    description = "Strict bullish 15m IFVG scanner with 5m close entry confirmation for Alpaca."

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

    async def _scan_symbol_timeframe(
        self,
        polygon: PolygonService,
        candidate: Dict[str, Any],
        timeframe: str,
        *,
        trigger_timeframe: str,
        max_ifvg_age_bars: int,
        min_zone_width_pct: float,
        max_zone_width_pct: float,
        min_flip_rvol: float,
        min_flip_body_pct: float,
        max_distance_to_zone_pct: float,
        require_mss: bool,
        require_vwap: bool,
        require_sweep: bool,
        min_auto_score: float,
        stop_buffer_pct: float,
        max_trigger_age_bars: int,
    ) -> Optional[Dict[str, Any]]:
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
        if len(bars) < 30:
            return None

        ifvg = _find_latest_bullish_ifvg(
            bars,
            max_age_bars=max_ifvg_age_bars,
            min_zone_width_pct=min_zone_width_pct,
            max_zone_width_pct=max_zone_width_pct,
            min_flip_rvol=min_flip_rvol,
            min_flip_body_pct=min_flip_body_pct,
            require_mss=require_mss,
            require_vwap=require_vwap,
            require_sweep=require_sweep,
        )
        if not ifvg:
            return None

        try:
            trigger_raw = await polygon.get_bars(symbol, trigger_timeframe)
        except Exception as exc:
            print(f"[ifvg-htf] trigger bars failed {symbol} {trigger_timeframe}: {exc}", flush=True)
            return None

        trigger_bars = [_normalize_bar(bar) for bar in trigger_raw]
        trigger_bars = [bar for bar in trigger_bars if bar["time"] > 0 and bar["high"] > 0 and bar["low"] > 0 and bar["close"] > 0]
        trigger_state = _find_5m_entry_confirmation(
            trigger_bars,
            zone_low=float(ifvg["zone_low"]),
            zone_high=float(ifvg["zone_high"]),
            flipped_time=int(ifvg.get("flipped_time") or 0),
            max_trigger_age_bars=max_trigger_age_bars,
            setup_bar_ms=15 * 60 * 1000,
        )

        state = _classify_bullish_ifvg(
            ifvg,
            bars,
            trigger_state=trigger_state,
            max_distance_to_zone_pct=max_distance_to_zone_pct,
            stop_buffer_pct=stop_buffer_pct,
        )

        # Keep only high-quality candidates that are close enough to become trades.
        if state["score"] < min_auto_score:
            return None
        if state["status"] in {"failure", "extended"}:
            return None
        if state["distance_to_zone_pct"] > max_distance_to_zone_pct:
            return None

        row = {
            "symbol": symbol,
            "timeframe": timeframe,
            "setup_timeframe": timeframe,
            "entry_trigger_timeframe": state["entry_trigger_timeframe"],
            "entry_trigger_rule": state["entry_trigger_rule"],
            "last_price": state["last_price"],
            "price": state["last_price"],
            "score": state["score"],
            "ifvg_score": state["score"],
            "ifvg_status": state["status"],
            "ifvg_phase": state["phase"],
            "ifvg_alert_phase": state.get("alert_phase"),
            "ifvg_direction": "bullish",
            "zone_low": round(float(ifvg["zone_low"]), 4),
            "zone_high": round(float(ifvg["zone_high"]), 4),
            "distance_to_zone_pct": state["distance_to_zone_pct"],
            "rvol": state["rvol"],
            "zone_width_pct": state["zone_width_pct"],
            "age_bars": int(ifvg.get("age_bars") or 0),
            "bars_since_touch": state.get("bars_since_touch"),
            "volume": int(_safe_float(bars[-1].get("volume"), 0.0)),
            "source": candidate.get("source"),
            "notes": state["notes"],

            # New auto-trade fields. Existing UI can ignore these safely.
            "auto_trade_ready": state["auto_trade_ready"],
            "trigger_confirmed": state["trigger_confirmed"],
            "trigger_status": state["trigger_status"],
            "trigger_close": state["trigger_close"],
            "trigger_time": state["trigger_time"],
            "trigger_bars_since_touch": state["trigger_bars_since_touch"],
            "entry_price": state["entry_price"],
            "stop_loss": state["stop_loss"],
            "target_1": state["target_1"],
            "target_2": state["target_2"],
            "flip_rvol": round(float(ifvg.get("flip_rvol") or 0.0), 2),
            "flip_body_pct": round(float(ifvg.get("flip_body_pct") or 0.0) * 100.0, 1),
            "prior_swing_high": round(float(ifvg.get("prior_swing_high") or 0.0), 4),
            "sweep_low": round(float(ifvg.get("sweep_low") or 0.0), 4) if ifvg.get("sweep_low") else None,
            "above_vwap": bool(ifvg.get("vwap_ok")),
            "mss_confirmed": bool(ifvg.get("mss_ok")),
            "sweep_confirmed": bool(ifvg.get("sweep_ok")),
            "displacement_confirmed": bool(ifvg.get("displacement_ok")),
            "extra": {
                "created_time": ifvg.get("created_time"),
                "flipped_time": ifvg.get("flipped_time"),
                "original_direction": ifvg.get("original_direction"),
                "discovery_score": candidate.get("discovery_score"),
                "flip_vwap": round(float(ifvg.get("flip_vwap") or 0.0), 4),
                "sweep_index": ifvg.get("sweep_index"),
                "flipped_index": ifvg.get("flipped_index"),
                "setup_timeframe": timeframe,
                "entry_trigger_timeframe": state["entry_trigger_timeframe"],
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

        # Strict auto-trade defaults. These can be overridden from the API/UI later.
        max_ifvg_age_bars = int(kwargs.get("max_ifvg_age_bars") or 8)
        min_zone_width_pct = float(kwargs.get("min_zone_width_pct") if kwargs.get("min_zone_width_pct") is not None else 0.25)
        max_zone_width_pct = float(kwargs.get("max_zone_width_pct") if kwargs.get("max_zone_width_pct") is not None else 3.0)
        min_flip_rvol = float(kwargs.get("min_flip_rvol") if kwargs.get("min_flip_rvol") is not None else 1.5)
        min_flip_body_pct = float(kwargs.get("min_flip_body_pct") if kwargs.get("min_flip_body_pct") is not None else 0.60)
        max_distance_to_zone_pct = float(kwargs.get("max_distance_to_zone_pct") if kwargs.get("max_distance_to_zone_pct") is not None else 1.0)
        min_auto_score = float(kwargs.get("min_auto_score") if kwargs.get("min_auto_score") is not None else 80.0)
        stop_buffer_pct = float(kwargs.get("stop_buffer_pct") if kwargs.get("stop_buffer_pct") is not None else 0.002)
        trigger_timeframe = str(kwargs.get("trigger_timeframe") or "5m").strip().lower()
        if trigger_timeframe != "5m":
            trigger_timeframe = "5m"
        max_trigger_age_bars = int(kwargs.get("max_trigger_age_bars") or 6)
        require_mss = bool(kwargs.get("require_mss", True))
        require_vwap = bool(kwargs.get("require_vwap", True))
        require_sweep = bool(kwargs.get("require_sweep", True))

        raw_timeframes = kwargs.get("timeframes") or ["15m"]
        if isinstance(raw_timeframes, str):
            raw_timeframes = [part.strip().lower() for part in raw_timeframes.split(",")]
        timeframes = [tf for tf in raw_timeframes if tf == "15m"] or ["15m"]

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
                return await self._scan_symbol_timeframe(
                    polygon,
                    candidate,
                    tf,
                    trigger_timeframe=trigger_timeframe,
                    max_ifvg_age_bars=max_ifvg_age_bars,
                    min_zone_width_pct=min_zone_width_pct,
                    max_zone_width_pct=max_zone_width_pct,
                    min_flip_rvol=min_flip_rvol,
                    min_flip_body_pct=min_flip_body_pct,
                    max_distance_to_zone_pct=max_distance_to_zone_pct,
                    require_mss=require_mss,
                    require_vwap=require_vwap,
                    require_sweep=require_sweep,
                    min_auto_score=min_auto_score,
                    stop_buffer_pct=stop_buffer_pct,
                    max_trigger_age_bars=max_trigger_age_bars,
                )

        tasks = [guarded(candidate, tf) for candidate in candidates for tf in timeframes]
        raw_results = await asyncio.gather(*tasks) if tasks else []
        rows = [row for row in raw_results if row]

        phase_rank = {
            "TRIGGERED": 7,
            "READY": 6,
            "ARMED": 5,
            "CONFIRMED": 4,
            "EXTENDED": 2,
            "FAILED": 1,
        }
        status_rank = {
            "retest": 5,
            "bounce_confirmed": 4,
            "approaching": 3,
            "fresh": 2,
            "failure": 1,
        }
        rows.sort(
            key=lambda row: (
                1 if row.get("auto_trade_ready") else 0,
                phase_rank.get(str(row.get("ifvg_phase")), 0),
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
            "workflow": "strict_bullish_15m_ifvg_5m_entry_auto_trade",
            "trade_day": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "universe_mode": "broad_snapshot_gainers_actives_losers",
                "candidate_count": len(candidates),
                "setup_timeframes": timeframes,
                "entry_trigger_timeframe": trigger_timeframe,
                "max_candidates": max_candidates,
                "filters": {
                    "direction": "bullish_only",
                    "min_price": min_price,
                    "max_price": max_price,
                    "min_volume": min_volume,
                    "max_symbols": max_symbols,
                    "max_ifvg_age_bars": max_ifvg_age_bars,
                    "min_zone_width_pct": min_zone_width_pct,
                    "max_zone_width_pct": max_zone_width_pct,
                    "min_flip_rvol": min_flip_rvol,
                    "min_flip_body_pct": min_flip_body_pct,
                    "max_distance_to_zone_pct": max_distance_to_zone_pct,
                    "min_auto_score": min_auto_score,
                    "require_mss": require_mss,
                    "require_vwap": require_vwap,
                    "require_sweep": require_sweep,
                    "entry_rule": "5m_close_above_15m_ifvg_zone_high_after_retest",
                    "max_trigger_age_bars": max_trigger_age_bars,
                    "stop_rule": "sweep_low_minus_buffer_else_zone_low_minus_buffer",
                },
            },
        }
