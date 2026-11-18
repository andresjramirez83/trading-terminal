"""Read-only, closed-candle technical pattern observations.

This engine is deliberately *not* a trading signal or an execution interface.
It uses no future candles and reports measurements rather than probabilities.
"""
from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _num(value: Any) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _time_ms(bar: Dict[str, Any]) -> int:
    value = bar.get("time", bar.get("t", 0))
    if isinstance(value, str) and not value.isdigit():
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0
    raw = int(_num(value))
    return raw * 1000 if 0 < raw < 10_000_000_000 else raw


def closed_bars(bars: List[Dict[str, Any]], timeframe_minutes: int, now_ms: Optional[int] = None) -> List[Dict[str, float]]:
    """Exclude the currently forming bar. Assumes timestamps are BAR START times."""
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    duration = timeframe_minutes * 60_000
    out = []
    for item in bars:
        if not isinstance(item, dict):
            continue
        timestamp = _time_ms(item)
        o = _num(item.get("open", item.get("o")))
        h = _num(item.get("high", item.get("h")))
        l = _num(item.get("low", item.get("l")))
        c = _num(item.get("close", item.get("c")))
        v = max(0.0, _num(item.get("volume", item.get("v"))))
        if timestamp <= 0 or timestamp + duration > now_ms or not (l > 0 and l <= min(o, c) <= max(o, c) <= h):
            continue
        out.append({"time": timestamp, "open": o, "high": h, "low": l, "close": c, "volume": v})
    return [dict(row) for _, row in sorted({int(row["time"]): row for row in out}.items())]


def _last_bearish(bars: List[Dict[str, float]], lookback: int = 5):
    for idx in range(len(bars) - 1, max(-1, len(bars) - lookback - 1), -1):
        b = bars[idx]
        if b["close"] < b["open"]:
            return idx, b
    return None, None


def candle_evidence(bars: List[Dict[str, float]]) -> Dict[str, Any]:
    if not bars:
        return {"available": False}
    curr = bars[-1]
    prev = bars[-2] if len(bars) > 1 else None
    rng = max(1e-9, curr["high"] - curr["low"])
    body = abs(curr["close"] - curr["open"])
    bullish = curr["close"] > curr["open"]
    close_location = (curr["close"] - curr["low"]) / rng
    upper_wick = (curr["high"] - max(curr["open"], curr["close"])) / rng
    engulf = bool(prev and bullish and prev["close"] < prev["open"] and
                  curr["open"] <= prev["close"] and curr["close"] >= prev["open"])
    recovery_pct = None
    volume_ratio = None
    if prev and prev["close"] < prev["open"] and bullish:
        red_body = prev["open"] - prev["close"]
        recovery_pct = max(0.0, (curr["close"] - prev["close"]) / max(red_body, 1e-9) * 100)
        volume_ratio = curr["volume"] / max(prev["volume"], 1.0)
    avg_volume = sum(b["volume"] for b in bars[-21:-1]) / max(1, len(bars[-21:-1]))
    # A potential downside liquidity sweep: price briefly undercuts a visible
    # preceding low, then closes back above it. This is not a verified stop hunt.
    previous_lows = [b["low"] for b in bars[-9:-1]]
    prior_low = min(previous_lows) if previous_lows else None
    potential_low_sweep = bool(prior_low is not None and curr["low"] < prior_low
                               and curr["close"] > prior_low)
    recent_engulf = any(
        bars[i]["close"] > bars[i]["open"] and bars[i-1]["close"] < bars[i-1]["open"]
        and bars[i]["open"] <= bars[i-1]["close"] and bars[i]["close"] >= bars[i-1]["open"]
        for i in range(max(1, len(bars)-5), len(bars))
    )
    return {
        "available": True, "time": int(curr["time"]), "bullish": bullish,
        "engulfing_now": engulf, "engulfing_recent_5": recent_engulf,
        "potential_low_sweep": potential_low_sweep,
        "red_body_recovery_pct": round(recovery_pct, 1) if recovery_pct is not None else None,
        "green_to_prev_red_volume": round(volume_ratio, 2) if volume_ratio is not None else None,
        "relative_volume_20": round(curr["volume"] / max(avg_volume, 1.0), 2),
        "close_location": round(close_location, 3),
        "upper_wick_fraction": round(upper_wick, 3),
        "body_fraction": round(body / rng, 3),
        "strong_bullish_close": bullish and close_location >= .75 and upper_wick <= .25 and body / rng >= .40,
    }


def analyze_structure(bars: List[Dict[str, float]]) -> Dict[str, Any]:
    """Find an already-observed rally peak / pullback. Labels describe, not predict."""
    if len(bars) < 16:
        return {"available": False, "reason": "Need at least 16 closed candles"}
    sample = bars[-90:]
    best = None
    # Candidate peak must have at least one known candle following it.
    for peak in range(7, len(sample) - 1):
        left = sample[max(0, peak-35):peak]
        if not left:
            continue
        rally_low = min(b["low"] for b in left)
        rally_high = sample[peak]["high"]
        rally_range = rally_high - rally_low
        if rally_range <= 0 or rally_range / rally_low < .045:
            continue
        # Only count pullbacks that follow an earlier rally, never later bars as the peak.
        tail = sample[peak+1:]
        if not tail:
            continue
        pullback_low = min(b["low"] for b in tail)
        depth = (rally_high - pullback_low) / rally_range * 100
        if not 5 <= depth <= 140:
            continue
        age = len(sample) - 1 - peak
        if age > 44:
            continue
        # Prefer a recent, meaningful rise; avoid anchoring to old highs forever.
        score = (rally_range / rally_low) / (1 + age / 24.0)
        if best is None or score > best[0]:
            best = (score, rally_low, rally_high, pullback_low, depth, age)
    if best is None:
        return {"available": False, "reason": "No clear rally/pullback in the analysis window"}
    _, low, high, pullback_low, depth, age = best
    last_close = sample[-1]["close"]
    recovered = (last_close - pullback_low) / max(high - pullback_low, 1e-9) * 100
    phase = "rally"
    if depth >= 100:
        phase = "rally_low_broken"
    elif recovered > 65 and last_close >= high * .98:
        phase = "continuation_near_high"
    elif recovered > 20 and last_close > pullback_low:
        phase = "recovery_attempt"
    else:
        phase = "pullback"
    return {
        "available": True, "phase": phase, "rally_low": round(low, 5),
        "rally_high": round(high, 5), "pullback_low": round(pullback_low, 5),
        "retracement_pct": round(depth, 1), "recovery_from_pullback_pct": round(recovered, 1),
        "peak_age_bars": age,
    }


def summarize_pattern(symbol: str, one_min: List[Dict[str, Any]], five_min: List[Dict[str, Any]],
                      now_ms: Optional[int] = None) -> Dict[str, Any]:
    b1 = closed_bars(one_min, 1, now_ms)
    b5 = closed_bars(five_min, 5, now_ms)
    c1, c5 = candle_evidence(b1), candle_evidence(b5)
    structure = analyze_structure(b5) if len(b5) >= 16 else analyze_structure(b1)
    notes: List[str] = []
    caveats: List[str] = []
    phase = structure.get("phase", "insufficient_data")
    if structure.get("available"):
        notes.append(f"Observed {structure['retracement_pct']}% pullback from a measured rally (not a prediction).")
    if c1.get("engulfing_recent_5"):
        notes.append("A completed 1-minute bullish engulfing occurred within the last five 1-minute candles.")
    if c1.get("potential_low_sweep"):
        notes.append("Last completed 1-minute candle undercut and reclaimed a recent low (possible sweep, not proof of stops triggered).")
    if c5.get("red_body_recovery_pct") is not None and c5["red_body_recovery_pct"] >= 50:
        notes.append("Last completed 5-minute green candle recovered >=50% of the previous red body.")
    if c5.get("strong_bullish_close"):
        notes.append("Last completed 5-minute candle closed in its upper quartile with a substantial body.")
    if c1.get("engulfing_recent_5") and c5.get("strong_bullish_close"):
        phase = "multi_timeframe_reversal_attempt"
    elif c1.get("engulfing_recent_5"):
        phase = "early_reversal_watch"
    if c5.get("upper_wick_fraction", 0) > .40:
        caveats.append("5-minute candle has a large upper wick; potential price rejection.")
    if c5.get("available") and not c5.get("strong_bullish_close"):
        caveats.append("No strong-close confirmation on the last completed 5-minute candle.")
    if structure.get("phase") == "rally_low_broken":
        caveats.append("Measured rally low was breached; original pullback hypothesis is weakened.")
    return {
        "symbol": symbol, "as_of": datetime.now(timezone.utc).isoformat(),
        "phase": phase, "structure": structure,
        "one_minute": c1, "five_minute": c5,
        "notes": notes, "caveats": caveats,
        "candle_counts": {"1m": len(b1), "5m": len(b5)},
        "data_cutoff": {"1m": b1[-1]["time"] if b1 else None, "5m": b5[-1]["time"] if b5 else None},
    }
