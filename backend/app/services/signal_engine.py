from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class SignalEngineConfig:
    lookback_bars: int = 8
    min_score_confirmed: float = 72.0
    min_score_prealert: float = 58.0
    min_rvol: float = 1.35
    require_vwap_reclaim: bool = False
    breakout_buffer_pct: float = 0.0005
    structure_window: int = 12


@dataclass
class SignalState:
    symbol: str
    timeframe: str
    last_setup: Optional[str] = None
    last_phase: Optional[str] = None
    last_score: float = 0.0
    last_zone_high: Optional[float] = None
    last_zone_low: Optional[float] = None
    last_close: Optional[float] = None
    updated_at: Optional[str] = None


# -----------------------------
# Numeric helpers
# -----------------------------

def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def pct_change(current: float, prev: float) -> float:
    if prev <= 0:
        return 0.0
    return ((current - prev) / prev) * 100.0


def mean(values: List[float]) -> float:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else 0.0


# -----------------------------
# Bar normalization
# -----------------------------

def normalize_bars(raw_bars: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    bars: List[Dict[str, float]] = []
    for row in raw_bars:
        t = row.get("time", row.get("t"))
        o = safe_float(row.get("open", row.get("o")))
        h = safe_float(row.get("high", row.get("h")))
        l = safe_float(row.get("low", row.get("l")))
        c = safe_float(row.get("close", row.get("c")))
        v = safe_float(row.get("volume", row.get("v")))
        if h <= 0 or c <= 0:
            continue
        bars.append({"t": t, "o": o, "h": h, "l": l, "c": c, "v": v})
    return bars


def candle_range(bar: Dict[str, float]) -> float:
    return max(0.0, bar["h"] - bar["l"])


def candle_body(bar: Dict[str, float]) -> float:
    return abs(bar["c"] - bar["o"])


def upper_wick(bar: Dict[str, float]) -> float:
    return max(0.0, bar["h"] - max(bar["o"], bar["c"]))


def lower_wick(bar: Dict[str, float]) -> float:
    return max(0.0, min(bar["o"], bar["c"]) - bar["l"])


def typical_price(bar: Dict[str, float]) -> float:
    return (bar["h"] + bar["l"] + bar["c"]) / 3.0


def rolling_vwap(bars: List[Dict[str, float]], window: int) -> float:
    recent = bars[-window:] if len(bars) >= window else bars
    pv = sum(typical_price(b) * b["v"] for b in recent if b["v"] > 0)
    vol = sum(b["v"] for b in recent if b["v"] > 0)
    return pv / vol if vol > 0 else 0.0


# -----------------------------
# Feature extraction
# -----------------------------

def compression_features(bars: List[Dict[str, float]], lookback_bars: int) -> Dict[str, Any]:
    if len(bars) < lookback_bars + 2:
        return {
            "valid": False,
            "score": 0.0,
            "zone_high": None,
            "zone_low": None,
            "recent_range_avg": 0.0,
            "prior_range_avg": 0.0,
            "higher_lows": False,
            "tightening": False,
        }

    recent = bars[-lookback_bars:]
    prior = bars[-(lookback_bars * 2):-lookback_bars] or bars[:lookback_bars]

    recent_ranges = [candle_range(b) for b in recent]
    prior_ranges = [candle_range(b) for b in prior]
    recent_avg = mean(recent_ranges)
    prior_avg = mean(prior_ranges)

    higher_lows_count = sum(1 for i in range(1, len(recent)) if recent[i]["l"] >= recent[i - 1]["l"])
    higher_lows_ratio = higher_lows_count / max(1, len(recent) - 1)
    higher_lows = higher_lows_ratio >= 0.7

    tightening_ratio = (recent_avg / prior_avg) if prior_avg > 0 else 1.0
    tightening = tightening_ratio <= 0.92

    zone_high = max(b["h"] for b in recent[:-1]) if len(recent) > 1 else max(b["h"] for b in recent)
    zone_low = min(b["l"] for b in recent)

    close_position_pct = 0.0
    if zone_high > 0:
        close_position_pct = 100.0 - abs((zone_high - recent[-1]["c"]) / zone_high) * 100.0
    close_position_pct = clamp(close_position_pct, 0.0, 100.0)

    range_tight_score = 0.0
    if prior_avg > 0:
        range_tight_score = clamp(100.0 - ((recent_avg / prior_avg) * 100.0 - 60.0) * 2.0, 0.0, 100.0)

    score = (
        higher_lows_ratio * 100.0 * 0.40
        + range_tight_score * 0.35
        + close_position_pct * 0.25
    )

    return {
        "valid": higher_lows or tightening,
        "score": round(score, 2),
        "zone_high": zone_high,
        "zone_low": zone_low,
        "recent_range_avg": recent_avg,
        "prior_range_avg": prior_avg,
        "higher_lows": higher_lows,
        "tightening": tightening,
        "higher_lows_ratio": round(higher_lows_ratio, 3),
        "tightening_ratio": round(tightening_ratio, 3),
    }


def absorption_features(bars: List[Dict[str, float]], lookback_bars: int) -> Dict[str, Any]:
    if len(bars) < lookback_bars:
        return {"valid": False, "score": 0.0, "count": 0}

    recent = bars[-lookback_bars:]
    rejection_count = 0
    body_small_count = 0
    hold_green_count = 0

    for bar in recent:
        body = candle_body(bar)
        rng = candle_range(bar)
        low_wick = lower_wick(bar)
        if low_wick > max(body * 1.5, 0.0001):
            rejection_count += 1
        if rng > 0 and body / rng <= 0.38:
            body_small_count += 1
        if bar["c"] >= bar["o"]:
            hold_green_count += 1

    rejection_score = clamp((rejection_count / lookback_bars) * 100.0 * 1.6, 0.0, 100.0)
    body_score = clamp((body_small_count / lookback_bars) * 100.0, 0.0, 100.0)
    hold_score = clamp((hold_green_count / lookback_bars) * 100.0, 0.0, 100.0)

    score = rejection_score * 0.55 + body_score * 0.20 + hold_score * 0.25
    return {
        "valid": rejection_count >= 3,
        "score": round(score, 2),
        "count": rejection_count,
        "small_body_count": body_small_count,
        "hold_green_count": hold_green_count,
    }


def rvol_features(bars: List[Dict[str, float]], lookback_bars: int) -> Dict[str, Any]:
    if len(bars) < max(lookback_bars * 2, 10):
        return {"valid": False, "rvol": 0.0, "score": 0.0}

    recent = bars[-lookback_bars:]
    prior = bars[-(lookback_bars * 2):-lookback_bars]
    recent_avg = mean([b["v"] for b in recent])
    prior_avg = mean([b["v"] for b in prior])
    rvol = recent_avg / prior_avg if prior_avg > 0 else 0.0
    score = clamp((rvol - 1.0) * 110.0, 0.0, 100.0)
    return {"valid": rvol > 0, "rvol": round(rvol, 3), "score": round(score, 2)}


def vwap_features(bars: List[Dict[str, float]], lookback_bars: int) -> Dict[str, Any]:
    if len(bars) < max(lookback_bars, 5):
        return {"valid": False, "vwap": 0.0, "reclaimed": False, "score": 0.0}

    vwap = rolling_vwap(bars, max(lookback_bars * 3, 12))
    last = bars[-1]
    prev = bars[-2]
    reclaimed = prev["c"] <= vwap < last["c"] if vwap > 0 else False
    distance_pct = pct_change(last["c"], vwap) if vwap > 0 else 0.0
    close_above = last["c"] > vwap if vwap > 0 else False

    score = 0.0
    if close_above:
        score += 55.0
    if reclaimed:
        score += 30.0
    if distance_pct > 0:
        score += clamp(distance_pct * 8.0, 0.0, 15.0)

    return {
        "valid": vwap > 0,
        "vwap": round(vwap, 4),
        "reclaimed": reclaimed,
        "close_above": close_above,
        "score": round(clamp(score, 0.0, 100.0), 2),
    }


def structure_features(bars: List[Dict[str, float]], structure_window: int) -> Dict[str, Any]:
    if len(bars) < max(structure_window, 8):
        return {"valid": False, "score": 0.0, "bullish_shift": False}

    window = bars[-structure_window:]
    recent_high = max(b["h"] for b in window[:-1])
    recent_low = min(b["l"] for b in window[:-1])
    last = window[-1]
    prev = window[-2]

    bullish_shift = last["c"] > recent_high and prev["c"] <= recent_high
    hold_above_mid = last["c"] > ((recent_high + recent_low) / 2.0)

    score = 0.0
    if bullish_shift:
        score += 70.0
    if hold_above_mid:
        score += 20.0
    if last["c"] > prev["c"]:
        score += 10.0

    return {
        "valid": True,
        "score": round(clamp(score, 0.0, 100.0), 2),
        "bullish_shift": bullish_shift,
        "recent_high": recent_high,
        "recent_low": recent_low,
    }


def breakout_features(
    bars: List[Dict[str, float]],
    zone_high: Optional[float],
    breakout_buffer_pct: float,
) -> Dict[str, Any]:
    if len(bars) < 2 or zone_high is None or zone_high <= 0:
        return {"valid": False, "triggered": False, "score": 0.0}

    last = bars[-1]
    prev = bars[-2]
    trigger_level = zone_high * (1.0 + breakout_buffer_pct)
    triggered = last["c"] > trigger_level and prev["c"] <= trigger_level
    high_break = last["h"] > trigger_level
    close_near_high = 0.0
    rng = candle_range(last)
    if rng > 0:
        close_near_high = clamp(100.0 - ((last["h"] - last["c"]) / rng) * 100.0, 0.0, 100.0)

    score = 0.0
    if triggered:
        score += 70.0
    elif high_break:
        score += 35.0
    score += close_near_high * 0.30

    return {
        "valid": True,
        "triggered": triggered,
        "score": round(clamp(score, 0.0, 100.0), 2),
        "trigger_level": round(trigger_level, 4),
        "close_near_high": round(close_near_high, 2),
    }


def failed_breakdown_features(bars: List[Dict[str, float]], lookback_bars: int) -> Dict[str, Any]:
    if len(bars) < lookback_bars + 2:
        return {"valid": False, "triggered": False, "score": 0.0}

    recent = bars[-lookback_bars:]
    support = min(b["l"] for b in recent[:-1]) if len(recent) > 1 else min(b["l"] for b in recent)
    last = bars[-1]
    prev = bars[-2]

    flushed = prev["l"] < support and prev["c"] <= support
    reclaimed = last["c"] > support and last["c"] > prev["c"]
    triggered = flushed and reclaimed

    score = 0.0
    if flushed:
        score += 40.0
    if reclaimed:
        score += 40.0
    if last["c"] > last["o"]:
        score += 20.0

    return {
        "valid": True,
        "triggered": triggered,
        "score": round(clamp(score, 0.0, 100.0), 2),
        "support": round(support, 4),
    }


def aggressive_buyers_features(bars: List[Dict[str, float]], lookback_bars: int) -> Dict[str, Any]:
    if len(bars) < lookback_bars:
        return {"valid": False, "triggered": False, "score": 0.0}

    recent = bars[-lookback_bars:]
    green_body_sum = sum(max(0.0, b["c"] - b["o"]) for b in recent)
    red_body_sum = sum(max(0.0, b["o"] - b["c"]) for b in recent)
    volume_bias = mean([b["v"] for b in recent[-3:]]) - mean([b["v"] for b in recent[:3]]) if len(recent) >= 6 else 0.0

    dominance = green_body_sum / max(red_body_sum, 0.0001)
    triggered = dominance >= 1.8 and volume_bias > 0
    score = clamp((dominance - 1.0) * 45.0 + (20.0 if volume_bias > 0 else 0.0), 0.0, 100.0)

    return {
        "valid": True,
        "triggered": triggered,
        "score": round(score, 2),
        "dominance": round(dominance, 3),
    }


# -----------------------------
# Main evaluator
# -----------------------------

def evaluate_symbol_signal(
    symbol: str,
    timeframe: str,
    raw_bars: List[Dict[str, Any]],
    previous_state: Optional[SignalState] = None,
    config: Optional[SignalEngineConfig] = None,
) -> Dict[str, Any]:
    cfg = config or SignalEngineConfig()
    bars = normalize_bars(raw_bars)

    if len(bars) < max(cfg.lookback_bars * 2, cfg.structure_window + 2):
        return {
            "symbol": symbol.upper(),
            "timeframe": timeframe,
            "triggered": False,
            "phase": "none",
            "setup": None,
            "score": 0.0,
            "reason": "Not enough bars",
            "state": SignalState(symbol=symbol.upper(), timeframe=timeframe),
        }

    comp = compression_features(bars, cfg.lookback_bars)
    absf = absorption_features(bars, cfg.lookback_bars)
    rvol = rvol_features(bars, cfg.lookback_bars)
    vwapf = vwap_features(bars, cfg.lookback_bars)
    structure = structure_features(bars, cfg.structure_window)
    breakout = breakout_features(bars, comp.get("zone_high"), cfg.breakout_buffer_pct)
    fdb = failed_breakdown_features(bars, cfg.lookback_bars)
    buyers = aggressive_buyers_features(bars, cfg.lookback_bars)

    setup_scores: Dict[str, float] = {
        "compression_abs_breakout": (
            comp["score"] * 0.26
            + absf["score"] * 0.18
            + breakout["score"] * 0.24
            + rvol["score"] * 0.14
            + vwapf["score"] * 0.08
            + structure["score"] * 0.10
        ),
        "failed_breakdown_reclaim": (
            fdb["score"] * 0.42
            + absf["score"] * 0.18
            + buyers["score"] * 0.16
            + rvol["score"] * 0.12
            + vwapf["score"] * 0.12
        ),
        "aggressive_buyers_reclaim": (
            buyers["score"] * 0.38
            + vwapf["score"] * 0.18
            + rvol["score"] * 0.18
            + structure["score"] * 0.14
            + absf["score"] * 0.12
        ),
        "bullish_structure_shift": (
            structure["score"] * 0.42
            + breakout["score"] * 0.18
            + rvol["score"] * 0.15
            + vwapf["score"] * 0.15
            + buyers["score"] * 0.10
        ),
    }

    if cfg.require_vwap_reclaim:
        for k in setup_scores:
            if not vwapf.get("reclaimed"):
                setup_scores[k] *= 0.82

    best_setup, best_score = max(setup_scores.items(), key=lambda kv: kv[1])
    best_score = round(clamp(best_score, 0.0, 100.0), 2)

    raw_triggers = {
        "compression_abs_breakout": comp.get("valid") and absf.get("valid") and breakout.get("triggered"),
        "failed_breakdown_reclaim": fdb.get("triggered"),
        "aggressive_buyers_reclaim": buyers.get("triggered") and bool(vwapf.get("close_above")),
        "bullish_structure_shift": structure.get("bullish_shift") and bool(vwapf.get("close_above")),
    }

    confirmed = best_score >= cfg.min_score_confirmed and raw_triggers.get(best_setup, False)
    prealert = (not confirmed) and best_score >= cfg.min_score_prealert

    # guardrails to reduce noise
    if rvol.get("rvol", 0.0) < cfg.min_rvol and best_setup in {"compression_abs_breakout", "bullish_structure_shift"}:
        confirmed = False
        prealert = False

    if best_setup == "compression_abs_breakout" and not comp.get("higher_lows"):
        confirmed = False

    phase = "confirmed" if confirmed else "prealert" if prealert else "none"
    triggered = phase in {"confirmed", "prealert"}

    reason_parts = [
        f"setup={best_setup}",
        f"score={best_score:.1f}",
        f"compression={comp['score']:.1f}",
        f"abs={absf['score']:.1f}",
        f"rvol={rvol.get('rvol', 0.0):.2f}",
        f"vwap={'yes' if vwapf.get('reclaimed') else 'no'}",
    ]

    signal_time = datetime.now(timezone.utc).isoformat()
    state = SignalState(
        symbol=symbol.upper(),
        timeframe=timeframe,
        last_setup=best_setup if triggered else None,
        last_phase=phase,
        last_score=best_score,
        last_zone_high=comp.get("zone_high"),
        last_zone_low=comp.get("zone_low"),
        last_close=bars[-1]["c"],
        updated_at=signal_time,
    )

    became_new = False
    if previous_state is None:
        became_new = triggered
    else:
        became_new = (
            triggered
            and (previous_state.last_setup != state.last_setup or previous_state.last_phase != state.last_phase)
        )

    return {
        "symbol": symbol.upper(),
        "timeframe": timeframe,
        "triggered": triggered,
        "phase": phase,
        "setup": best_setup if triggered else None,
        "score": best_score,
        "became_new": became_new,
        "reason": " | ".join(reason_parts),
        "features": {
            "compression": comp,
            "absorption": absf,
            "rvol": rvol,
            "vwap": vwapf,
            "structure": structure,
            "breakout": breakout,
            "failed_breakdown": fdb,
            "aggressive_buyers": buyers,
        },
        "state": state,
        "message": build_alert_message(symbol, timeframe, best_setup if triggered else None, phase, best_score, bars[-1]["c"]),
    }


def build_alert_message(
    symbol: str,
    timeframe: str,
    setup: Optional[str],
    phase: str,
    score: float,
    last_close: float,
) -> str:
    if not setup or phase == "none":
        return f"{symbol.upper()} no active setup on {timeframe}"

    title_map = {
        "compression_abs_breakout": "Compression + ABS breakout",
        "failed_breakdown_reclaim": "Failed breakdown reclaim",
        "aggressive_buyers_reclaim": "Aggressive buyers reclaim",
        "bullish_structure_shift": "Bullish structure shift",
    }
    pretty = title_map.get(setup, setup)
    return (
        f"{symbol.upper()} {pretty} {phase.upper()} on {timeframe} | "
        f"score {score:.1f} | close {last_close:.4f}"
    )


def signal_state_to_dict(state: SignalState) -> Dict[str, Any]:
    return {
        "symbol": state.symbol,
        "timeframe": state.timeframe,
        "last_setup": state.last_setup,
        "last_phase": state.last_phase,
        "last_score": state.last_score,
        "last_zone_high": state.last_zone_high,
        "last_zone_low": state.last_zone_low,
        "last_close": state.last_close,
        "updated_at": state.updated_at,
    }


def signal_state_from_dict(data: Optional[Dict[str, Any]]) -> Optional[SignalState]:
    if not data:
        return None
    return SignalState(
        symbol=str(data.get("symbol", "")).upper(),
        timeframe=str(data.get("timeframe", "1m")),
        last_setup=data.get("last_setup"),
        last_phase=data.get("last_phase"),
        last_score=safe_float(data.get("last_score")),
        last_zone_high=safe_float(data.get("last_zone_high"), default=0.0) or None,
        last_zone_low=safe_float(data.get("last_zone_low"), default=0.0) or None,
        last_close=safe_float(data.get("last_close"), default=0.0) or None,
        updated_at=data.get("updated_at"),
    )
