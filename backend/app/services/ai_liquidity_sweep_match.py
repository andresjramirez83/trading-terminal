"""Closed-candle detection of a specific saved bullish sweep/reclaim/retest pattern.

This is NOT image-based model training. The user-saved reference selects the
pattern category; observed timestamped OHLCV data must independently satisfy
these conditions before we return actual on-chart stages.
"""
from __future__ import annotations

import math
import statistics
import time
from typing import Any, Dict, List, Optional


def _clean(raw: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    by_time: Dict[int, Dict[str, float]] = {}
    for row in raw or []:
        try:
            t = int(row["time"])
            o, h, lo, c = [float(row[k]) for k in ("open", "high", "low", "close")]
            v = float(row.get("volume") or 0)
        except (KeyError, ValueError, TypeError, OverflowError):
            continue
        if t > 0 and all(math.isfinite(x) for x in (o, h, lo, c, v)) and                 0 < lo <= min(o, c) <= max(o, c) <= h and v >= 0:
            by_time[t] = {"time": t, "open": o, "high": h, "low": lo, "close": c, "volume": v}
    return [by_time[t] for t in sorted(by_time)]


def _true_range(bars: List[Dict[str, float]]) -> float:
    if len(bars) < 5:
        return 0.0
    return statistics.median(max(b["high"]-b["low"],
        abs(b["high"]-bars[i-1]["close"]), abs(b["low"]-bars[i-1]["close"]))
        for i,b in enumerate(bars) if i > 0)


def _stage(key: str, row: Dict[str, float], price: float) -> Dict[str, Any]:
    return {"stage": key, "time_ms": int(row["time"]), "price": round(price, 6)}


def _is_sweep_reference(reference: Dict[str, Any]) -> bool:
    name = str(reference.get("name") or "").lower()
    note = str(reference.get("note") or "").lower()
    return "liquidity" in name + " " + note and "sweep" in name + " " + note and         ("bull" in name + " " + note or "reclaim" in name + " " + note)


def match_saved_liquidity_sweep(
    raw: List[Dict[str, Any]], reference: Dict[str, Any],
    now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Locate bullish liquidity sweep -> quick reclaim -> support retest.

    Only closed candles, no look-ahead at analysis time. Stage timestamps are
    observed candles, and detection status is not a win probability or trade.
    """
    name = str(reference.get("name") or "Saved reference")[:100]
    tf = str(reference.get("timeframe") or "5m").lower()
    base = {"reference_name": name, "timeframe": tf, "method": "Deterministic closed-candle sweep/reclaim/retest; screenshot is a reference, not trained weights",
            "status": "not_found", "stages": [], "zone": None, "sweep_low": None,
            "last_closed_time_ms": None, "historical_only": True, "reasons": [], "matched": False}
    if not _is_sweep_reference(reference):
        return {**base, "status": "unsupported", "reasons": ["This saved example has no implemented candle-sequence detector; visual review remains separate"]}
    if tf not in ("1m", "5m"):
        return {**base, "status": "unsupported", "reasons": ["Sweep stage annotation is currently implemented for saved 1m and 5m examples only"]}
    bars = _clean(raw)
    if bars:
        base["last_closed_time_ms"] = int(bars[-1]["time"])
        age = (int(now_ms if now_ms is not None else time.time()*1000) - bars[-1]["time"] - (1 if tf == "1m" else 5)*60_000) / 60_000
        base["historical_only"] = age > 45 or age < -10
    if len(bars) < 24:
        return {**base, "status": "insufficient_data", "reasons": ["At least 24 completed candles are needed to establish an earlier liquidity area"]}
    candidates = []
    # Evaluate sweep only after there are enough earlier bars to establish a low.
    for i in range(max(14, len(bars)-100), len(bars)):
        prior = bars[i-14:i-1]
        atr = _true_range(bars[max(0, i-30):i+1])
        if atr <= 0 or len(prior) < 12:
            continue
        tolerance = max(atr*.20, bars[i]["close"]*.0015)
        # Find the nearest CLUSTER of two or more separate historical lows.
        clusters = []
        for p in prior:
            near = [x for x in prior if abs(x["low"] - p["low"]) <= tolerance]
            if len(near) >= 2 and near[-1]["time"] - near[0]["time"] >= (2 if tf == "1m" else 10)*60_000:
                level = statistics.median(x["low"] for x in near)
                clusters.append((level,len(near),near[0]))
        if not clusters:
            continue
        # Candidate must sweep BELOW the measured previous liquidity zone.
        sweep = bars[i]
        clusters = [c for c in clusters if sweep["low"] < c[0] - max(atr*.10,c[0]*.0007) and
                    sweep["low"] >= c[0]-max(atr*2.8,c[0]*.05)]
        if not clusters:
            continue
        # Prefer the nearby (most recently relevant) established liquidity zone.
        level, touches, first = min(clusters, key=lambda c: (c[0]-sweep["low"],-c[1]))
        reclaim_j = None
        for j in range(i, min(len(bars), i+3)):
            b = bars[j]
            if b["time"] - sweep["time"] > (3 if tf == "1m" else 15) * 60_000:
                break  # An overnight gap is not a quick reclaim.
            if b["close"] > level + tolerance*.10 and b["close"] >= b["open"]:
                reclaim_j = j
                break
        if reclaim_j is None:
            continue
        # Retest after the reclaim. It must touch the *reclaimed* level and
        # hold above the actual sweep low; don't infer a later rally as an entry.
        hold_j = None
        for j in range(reclaim_j+1, min(len(bars), reclaim_j+18)):
            b = bars[j]
            if b["time"] - bars[reclaim_j]["time"] > (17 if tf == "1m" else 85) * 60_000:
                break  # Require a timely retest rather than a future session.
            if b["close"] < sweep["low"] - tolerance*.1:
                break
            if b["low"] <= level + tolerance and b["low"] >= sweep["low"] + tolerance*.1 and                     b["close"] >= level + tolerance*.05 and b["close"] >= b["open"]:
                hold_j = j
                break
        breakout_j = None
        if hold_j is not None:
            # Last known local high before retest is the watch threshold.
            trigger = max(b["high"] for b in bars[reclaim_j:hold_j+1])
            for j in range(hold_j+1, min(len(bars),hold_j+21)):
                if bars[j]["time"] - bars[hold_j]["time"] > (20 if tf == "1m" else 100)*60_000:
                    break
                if bars[j]["close"] > trigger + atr*.08:
                    breakout_j = j
                    break
        stages = [_stage("liquidity", first, level), _stage("sweep", sweep, sweep["low"]),
                  _stage("reclaim", bars[reclaim_j], bars[reclaim_j]["close"])]
        if hold_j is not None:
            stages.append(_stage("hold", bars[hold_j], bars[hold_j]["low"]))
        if breakout_j is not None:
            stages.append(_stage("breakout",bars[breakout_j],bars[breakout_j]["close"]))
        latest_j = breakout_j if breakout_j is not None else hold_j if hold_j is not None else reclaim_j
        # A finished pattern becomes historically invalidated on a subsequent
        # close below the actual sweep low, not because a subsequent price fell
        # below a speculative projection.
        failure = any(b["close"] < sweep["low"]-tolerance*.1 for b in bars[latest_j+1:])
        status = "invalidated" if failure else ("continuation_observed" if breakout_j is not None else
                  "retest_held" if hold_j is not None else "reclaimed_waiting_retest")
        # Only stages actually observed in time are returned; no fabricated hold.
        observed_age_minutes = (int(now_ms if now_ms is not None else time.time()*1000)
                                - int(bars[latest_j]["time"])) / 60_000
        match = {**base, "status": status, "matched": not failure and hold_j is not None,
                 "historical_only": bool(base["historical_only"] or
                     observed_age_minutes > (20 if tf == "1m" else 90)),
                 "zone": {"low": round(level-tolerance,6), "high": round(level+tolerance,6),
                          "level":round(level,6), "start_time_ms":int(first["time"]),
                          "end_time_ms":int(bars[latest_j]["time"])},
                 "sweep_low":round(sweep["low"],6), "stages": stages,
                 "reasons": [f"Prior support near {level:.4f} formed from at least {touches} low touches",
                             "Observed closed-candle sweep and quick bullish reclaim",
                             ("Reclaimed area retested and held" if hold_j is not None else
                              "A confirmed retest/hold has NOT occurred yet"),
                             ("Observed later close above local high" if breakout_j is not None else
                              "Breakout continuation has NOT been confirmed"),
                             *( ["Subsequent close below sweep low invalidated this example"] if failure else [])]}
        # Choose the most recent non-invalidated confirmed setup, not a stale
        # sweep from a prior regime. An older valid match is historical only.
        rank = (1 if not failure else 0, 1 if breakout_j is not None else 0,
                1 if hold_j is not None else 0, latest_j,
                round((level-sweep["low"])/max(atr, 1e-8), 2))
        candidates.append((rank,match))
    if not candidates:
        return {**base, "reasons": ["No verified prior-low sweep followed by a quick bullish reclaim in the available completed candles"]}
    candidates.sort(key=lambda x:x[0],reverse=True)
    result = candidates[0][1]
    if result["status"] == "invalidated":
        result["matched"] = False
    return result
