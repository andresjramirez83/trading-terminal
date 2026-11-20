"""Five-timeframe FVG inventory and *observed* zone-reaction evidence.

Pure, read-only research calculations from completed OHLCV candles.
No broker calls, order actions, model probabilities, or future price labels.
Do not interpret a gap as a required future price destination.
"""
from __future__ import annotations

from collections import defaultdict
import math
from statistics import median
import time
from typing import Any, Dict, List, Optional, Tuple

TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h")
MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}


def _round(value: float) -> float:
    return round(float(value), 6)


def _bars(raw: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    clean: Dict[int, Dict[str, float]] = {}
    for bar in raw or []:
        try:
            ts = int(bar["time"])
            o, h, lo, c = (float(bar[k]) for k in ("open", "high", "low", "close"))
            vol = float(bar.get("volume") or 0)
        except (TypeError, KeyError, ValueError, OverflowError):
            continue
        if ts > 0 and all(math.isfinite(v) for v in (o, h, lo, c, vol)) and 0 < lo <= min(o, c) <= max(o, c) <= h:
            clean[ts] = {"time": ts, "open": o, "high": h, "low": lo, "close": c, "volume": max(0, vol)}
    return [clean[k] for k in sorted(clean)]


def _typical_range(bars: List[Dict[str, float]]) -> float:
    if len(bars) < 5:
        return 0.0
    ranges = []
    for index in range(max(1, len(bars) - 50), len(bars)):
        cur, prev = bars[index], bars[index - 1]
        ranges.append(max(cur["high"] - cur["low"], abs(cur["high"] - prev["close"]), abs(cur["low"] - prev["close"])))
    return median(ranges) if ranges else 0.0


def _fvg_inventory(tf: str, bars: List[Dict[str, float]]) -> List[Dict[str, Any]]:
    """Three-closed-bar FVGs, with subsequent penetration tracked causally.

    Bullish original gap: candle i-2 high < candle i low.
    Bearish original gap: candle i high < candle i-2 low.
    Remaining open bounds shrink from the edge subsequent candles penetrate.
    """
    if len(bars) < 5:
        return []
    atr = _typical_range(bars)
    last_close = bars[-1]["close"]
    gaps = []
    for i in range(2, len(bars)):
        first, middle, third = bars[i-2], bars[i-1], bars[i]
        direction: Optional[str] = None
        if third["low"] > first["high"]:
            direction = "bullish"; lo = first["high"]; hi = third["low"]
        elif third["high"] < first["low"]:
            direction = "bearish"; lo = third["high"]; hi = first["low"]
        else:
            continue
        width = hi - lo
        # Filter micro-noise; do not make a fabricated exact-tick assumption.
        if width <= max(last_close * 0.00015, atr * 0.09, 1e-8):
            continue
        typical = max(atr, 1e-8)
        mid_body = abs(middle["close"] - middle["open"])
        low_remaining, high_remaining = lo, hi
        touched = False; filled = False; invalidated = False
        rejections = 0; last_touch = None
        for j in range(i + 1, len(bars)):
            follow = bars[j]
            if direction == "bullish":
                if follow["low"] < hi:
                    touched = True; last_touch = int(follow["time"])
                    high_remaining = min(high_remaining, max(lo, follow["low"]))
                    if follow["close"] > hi and follow["close"] > follow["open"]:
                        rejections += 1
                if follow["low"] <= lo:
                    filled = True
                if follow["close"] < lo:
                    invalidated = True
            else:
                if follow["high"] > lo:
                    touched = True; last_touch = int(follow["time"])
                    low_remaining = max(low_remaining, min(hi, follow["high"]))
                    if follow["close"] < lo and follow["close"] < follow["open"]:
                        rejections += 1
                if follow["high"] >= hi:
                    filled = True
                if follow["close"] > hi:
                    invalidated = True
        if invalidated:
            status = "invalidated"
        elif filled:
            status = "filled"
        elif touched:
            status = "partially_filled" if (high_remaining - low_remaining) < width - 1e-9 else "retested"
        else:
            status = "untouched"
        remaining_width = max(0.0, high_remaining-low_remaining) if not filled else 0.0
        # Use the *remaining* gap for destination/overlay; retain original bounds for audit.
        gap = {
            "id": f"{tf}-{direction}-{int(third['time'])}",
            "timeframe": tf, "direction": direction, "status": status,
            "formed_time_ms": int(third["time"]),
            "original_low": _round(lo), "original_high": _round(hi),
            "remaining_low": _round(low_remaining), "remaining_high": _round(high_remaining),
            "remaining_fraction": round(min(1.0, remaining_width/width), 3),
            "rejection_count": min(9, rejections),
            "last_touch_ms": last_touch,
            "gap_atr": round(width/typical, 2),
            "middle_displacement_atr": round(mid_body/typical, 2),
            "bars_old": len(bars)-1-i,
        }
        gaps.append(gap)
    return gaps


def _reaction_evidence(tf: str, bars: List[Dict[str, float]], gaps: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Historical confirmed swing retests plus completed FVG rejections.

    A pivot isn't a usable level until *two subsequent candles* have closed.
    A rejection is judged only on the completed testing candle, never a later one.
    Counts are evidence of reactions, not win probabilities.
    """
    results: Dict[str, Any] = {
        "timeframe": tf, "closed_candles": len(bars), "positive_reactions": 0,
        "broken_zones": 0, "fvg_rejections": 0, "swing_rejections": 0,
        "quality": "insufficient", "respect_ratio": None, "evidence": [],
        "latest_closed_time_ms": int(bars[-1]["time"]) if bars else None,
    }
    if len(bars) < 20:
        return results
    typical = _typical_range(bars)
    if typical <= 0:
        return results
    # Only sample a bounded recent window, not every reaction over months.
    min_j = max(0, len(bars)-85)
    events: List[Tuple[int, str, str, float]] = []
    # Confirmed swing pivots. The right two bars exist before any retest bar.
    pivots: List[Tuple[int, str, float]] = []
    for i in range(2, len(bars)-3):
        if bars[i]["low"] < min(x["low"] for x in bars[i-2:i]) and bars[i]["low"] < min(x["low"] for x in bars[i+1:i+3]):
            pivots.append((i+2, "support", bars[i]["low"]))
        if bars[i]["high"] > max(x["high"] for x in bars[i-2:i]) and bars[i]["high"] > max(x["high"] for x in bars[i+1:i+3]):
            pivots.append((i+2, "resistance", bars[i]["high"]))
    # At most two distinct retests per confirmed pivot, spaced by >=3 bars.
    for known_at, kind, level in pivots:
        last_j = -10; count = 0
        for j in range(max(min_j, known_at+1), len(bars)):
            if j - last_j < 3 or count >= 2:
                continue
            candle = bars[j]
            tol = max(level * .0006, typical*.22)
            if not (candle["low"] <= level+tol and candle["high"] >= level-tol):
                continue
            if kind == "support":
                good = candle["close"] > level + .15*typical and candle["close"] > candle["open"]
                bad = candle["close"] < level - tol
            else:
                good = candle["close"] < level - .15*typical and candle["close"] < candle["open"]
                bad = candle["close"] > level + tol
            if good or bad:
                events.append((int(candle["time"]), "swing_rejection" if good else "break", kind, level))
                last_j = j; count += 1
    # FVG rejection evidence is limited to a per-gap maximum; no double count
    # the same gap merely because hundreds of 1-minute bars touched it.
    for gap in gaps:
        if gap["rejection_count"] and gap["last_touch_ms"] and gap["last_touch_ms"] >= bars[min_j]["time"]:
            events.append((gap["last_touch_ms"], "fvg_rejection", gap["direction"],
                           (gap["original_low"] + gap["original_high"])/2))
        if gap["status"] == "invalidated" and gap["formed_time_ms"] >= bars[min_j]["time"]:
            # Do not double penalize all intrabar tests on one old gap.
            events.append((gap["formed_time_ms"], "break", "fvg", gap["original_low"]))
    # Dedupe same timestamp/kind/level from adjacent almost-equal pivots.
    seen = set(); unique = []
    for stamp, event, zone, level in sorted(events, reverse=True):
        key = (stamp, event, zone, round(level/max(typical*.1, 1e-6)))
        if key not in seen:
            seen.add(key); unique.append((stamp, event, zone, level))
    positive = sum(1 for _,k,_,_ in unique if k != "break")
    broken = sum(1 for _,k,_,_ in unique if k == "break")
    n = positive + broken
    ratio = (positive/n) if n else None
    quality = "insufficient"
    if n >= 2:
        if positive >= 3 and ratio >= .72:
            quality = "strong"
        elif positive >= 2 and ratio >= .62:
            quality = "moderate"
        else:
            quality = "mixed"
    results.update({
        "positive_reactions": positive, "broken_zones": broken,
        "fvg_rejections": sum(1 for _,k,_,_ in unique if k == "fvg_rejection"),
        "swing_rejections": sum(1 for _,k,_,_ in unique if k == "swing_rejection"),
        "respect_ratio": round(ratio, 2) if ratio is not None else None,
        "quality": quality,
        "evidence": [
            {"time_ms": stamp, "type": event, "zone": zone, "price": _round(level)}
            for stamp,event,zone,level in unique[:5]
        ],
    })
    return results


def build_mtf_fvg_respect(frames: Dict[str, List[Dict[str, Any]]], now_ms: Optional[int] = None) -> Dict[str, Any]:
    """Rank open FVG zones and explain observed timeframe reactions.

    Missing or old timeframe data cannot be called "respected" or "live".
    """
    now_ms = int(now_ms if now_ms is not None else time.time()*1000)
    per_tf: Dict[str, Dict[str, Any]] = {}
    available = []
    all_gaps: List[Dict[str, Any]] = []
    for tf in TIMEFRAMES:
        bars = _bars(frames.get(tf, []))
        gaps = _fvg_inventory(tf, bars)
        data = _reaction_evidence(tf, bars, gaps)
        if bars:
            age_minutes = max(0, (now_ms - (int(bars[-1]["time"]) + MINUTES[tf]*60_000))/60_000)
            # A closed last candle older than a trading session is historical.
            data["age_minutes"] = round(age_minutes, 1)
            data["stale"] = age_minutes > max(45, MINUTES[tf]*6)
        else:
            data["age_minutes"] = None; data["stale"] = True
        open_gaps = [g for g in gaps if g["status"] in ("untouched", "retested", "partially_filled") and g["remaining_fraction"] > 0]
        data["open_fvgs"] = len(open_gaps)
        data["open_fvg_by_direction"] = {d: sum(g["direction"] == d for g in open_gaps) for d in ("bullish", "bearish")}
        per_tf[tf] = data
        if bars and not data["stale"]:
            quality = data["quality"]
            if quality in ("moderate", "strong"):
                ratio = data["respect_ratio"] or 0
                # Evidence-based selection with a modest timeframe tie-break.
                raw_score = 60*ratio + 8*min(5,data["positive_reactions"]) - 5*data["broken_zones"]
                raw_score += {"1m":0,"5m":2,"15m":4,"30m":5,"1h":6}[tf]
                available.append((raw_score, tf))
        if not bars:
            continue
        last_price = bars[-1]["close"]
        atr = max(_typical_range(bars), last_price * .001)
        for g in open_gaps:
            # Distance from current price to the closest unfilled gap boundary.
            gap_low, gap_high = g["remaining_low"], g["remaining_high"]
            dist = max(gap_low-last_price, last_price-gap_high, 0.0)
            dist_atr = dist/atr
            # Beware comparisons of ATR across different timeframes: only a ranking heuristic.
            rank = (
                24 if g["status"] == "untouched" else 18
            ) + {"1m":0,"5m":3,"15m":6,"30m":8,"1h":10}[tf]
            rank += min(12, g["middle_displacement_atr"]*4)
            rank += min(12, g["rejection_count"]*5)
            rank -= min(25, dist_atr*4)
            rank -= min(12, g["bars_old"]*.16)
            g = dict(g)
            g["distance_atr"] = round(dist_atr, 2)
            g["rank_points"] = round(rank, 1)  # not odds of fill
            g["data_stale"] = data["stale"]
            all_gaps.append(g)
    # On stale data, still report historical inventory, but never name a live dominant TF.
    all_gaps.sort(key=lambda g: (-g["rank_points"], g["distance_atr"], g["bars_old"]))
    available.sort(reverse=True)
    dominant = available[0][1] if available else None
    return {
        "method": "Closed-candle 3-bar FVG inventory and observed historical swing/FVG reactions; not a trained AI model",
        "timeframes": per_tf,
        "dominant_timeframe": dominant,
        "dominant_reason": (
            f"{dominant} has the strongest observed recent rejection/retest evidence among qualifying fresh timeframes"
            if dominant else "No timeframe has enough fresh, consistent reaction evidence to establish which is currently respected"
        ),
        "ranked_open_gaps": all_gaps[:14],
        "selected_gap": next((g for g in all_gaps if not g["data_stale"] and g["distance_atr"] <= 4), None),
        "notes": [
            "A gap may never fill. FVG rank points and respect ratio are retrospective heuristics, not probabilities or proven support/resistance.",
            "Higher timeframe zones are context; selection considers actual observed reactions rather than timeframe alone.",
            "Incomplete data, extended hours, and insufficient historical touches limit conclusions.",
        ],
    }
