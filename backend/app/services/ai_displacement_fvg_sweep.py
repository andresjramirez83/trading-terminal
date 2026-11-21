"""Closed-candle, causal displacement -> bearish FVG -> range sweep/reclaim research.

No brokers, orders, model calls, Pushover, or implied outcome probabilities.
Every target was already formed and remained unfilled AT THE SWEEP candle.
"""
from __future__ import annotations

from statistics import median
from typing import Any, Dict, List, Optional
from app.services.ai_mtf_fvg_respect import _bars as normalize, _fvg_inventory

FIVE_MS = 300_000


def _r(x: float) -> float:
    return round(float(x), 5)


def _tr(bars: List[Dict[str, float]]) -> float:
    if len(bars) < 6:
        return 0.0
    values = [max(bars[k]['high'] - bars[k]['low'],
                  abs(bars[k]['high'] - bars[k-1]['close']),
                  abs(bars[k]['low'] - bars[k-1]['close']))
              for k in range(max(1, len(bars)-25), len(bars))]
    return median(values) if values else 0.0


def _target_at(bars: List[Dict[str, float]], sweep_i: int, support: float, atr: float) -> Optional[dict]:
    """Snapshot gaps using ONLY bars <= sweep_i-1. No future fill/target bias."""
    preceding = bars[:sweep_i]
    if len(preceding) < 25:
        return None
    open_gaps = _fvg_inventory('5m', preceding)
    eligible = []
    for gap in open_gaps:
        if gap['direction'] != 'bearish' or gap['status'] not in ('untouched', 'partially_filled', 'retested'):
            continue
        if gap['remaining_low'] <= support * 1.004 or gap['remaining_low'] > support * 1.36:
            continue
        if gap['middle_displacement_atr'] < 0.6 or gap['remaining_fraction'] < 0.12:
            continue
        formation_i = next((k for k, bar in enumerate(preceding) if bar['time'] == gap['formed_time_ms']), -1)
        if not (4 <= formation_i < sweep_i - 5):
            continue
        # A significant rally must lead INTO the bearish displacement, rather
        # than selecting unrelated old gaps above the current market.
        before = preceding[max(0, formation_i-48):formation_i]
        highs = [b['high'] for b in before]
        lows = [b['low'] for b in before]
        if not highs or not lows:
            continue
        peak_i = max(range(len(before)), key=lambda k: highs[k])
        peak = highs[peak_i]
        prior_low = min(lows[:peak_i+1]) if peak_i >= 2 else min(lows)
        if peak < prior_low * 1.085 or (peak - prior_low) < atr * 3:
            continue
        if peak < gap['original_high'] * .995:
            continue
        # The candidate gap must be part of the subsequent retracement.
        if formation_i <= (max(0, formation_i-48) + peak_i):
            continue
        eligible.append((gap['remaining_low'] - support, -gap['formed_time_ms'], gap, prior_low, peak))
    if not eligible:
        return None
    _, _, gap, rally_low, rally_high = min(eligible, key=lambda item: (item[0], item[1]))
    return {
        'id': gap['id'], 'formed_time_ms': gap['formed_time_ms'],
        'low': gap['remaining_low'], 'high': gap['remaining_high'],
        'original_low': gap['original_low'], 'original_high': gap['original_high'],
        'timeframe': '5m', 'status_at_sweep': gap['status'],
        'rally_low': _r(rally_low), 'rally_high': _r(rally_high),
    }


def _range_at(bars: List[Dict[str, float]], i: int) -> Optional[dict]:
    """At least ten completed pre-sweep candles with repeated, separated lows."""
    for length in (32, 28, 24, 20, 16, 12, 10):
        if i < length:
            continue
        sample = bars[i-length:i]
        atr = _tr(bars[:i]); base = min(b['low'] for b in sample)
        top = max(b['high'] for b in sample)
        if atr <= 0 or base <= 0 or top-base > max(atr*6.5, base*.20):
            continue
        tol = max(base*.0015, atr*.40)
        touches = [k for k, b in enumerate(sample) if b['low'] <= base + tol]
        separated = []
        for k in touches:
            if not separated or k-separated[-1] >= 2:
                separated.append(k)
        if len(separated) < 3 or separated[-1] < length - 9:
            continue
        # Consolidation is supposed to be horizontal, not a steep staircase lower.
        first_median = median(b['close'] for b in sample[:length//2])
        last_median = median(b['close'] for b in sample[length//2:])
        if abs(first_median-last_median) > max(atr*2.6, base*.065):
            continue
        return {
            'low': _r(base), 'high': _r(top), 'touches': len(separated),
            'candles': length, 'start_time_ms': int(sample[0]['time']),
            'end_time_ms': int(sample[-1]['time']),
            'atr': atr,
        }
    return None


def _evaluate_at(bars: List[Dict[str, float]], i: int) -> Optional[dict]:
    zone = _range_at(bars, i)
    if not zone:
        return None
    target = _target_at(bars, i, zone['low'], zone['atr'])
    if not target:
        return None
    candle = bars[i]
    support, atr = zone['low'], zone['atr']
    penetration = max(atr*.075, support*.0004)
    if candle['low'] >= support - penetration:
        return None
    # A wick rejection matters more than an arbitrary undercut on a red trend bar.
    candle_range = max(candle['high'] - candle['low'], 1e-8)
    lower_wick = (min(candle['open'], candle['close']) - candle['low']) / candle_range
    close_location = (candle['close'] - candle['low']) / candle_range
    same_bar = candle['close'] > support and lower_wick >= .32 and close_location >= .62
    reclaim_idx = i if same_bar else None
    for k in range(i+1, min(i+3, len(bars))):
        if reclaim_idx is None and bars[k]['close'] > support and bars[k]['close'] > bars[k]['open']:
            reclaim_idx = k
            break
    quality = 'fast_wick' if same_bar else 'two_bar_reclaim' if reclaim_idx is not None else 'unconfirmed'
    events = [{'stage': 'sweep', 'time_ms': int(candle['time']), 'price': _r(candle['low'])}]
    if reclaim_idx is not None:
        events.append({'stage': 'reclaim', 'time_ms': int(bars[reclaim_idx]['time']),
                       'price': _r(bars[reclaim_idx]['close'])})
    invalidation = min(candle['low'], support - max(atr*.18, support*.002))
    return {
        'id': f"5m-{int(candle['time'])}", 'timeframe': '5m',
        'sweep_time_ms': int(candle['time']), 'sweep_low': _r(candle['low']),
        'zone': {k: zone[k] for k in ('low','high','touches','candles','start_time_ms','end_time_ms')},
        'gap': target, 'invalidation': _r(invalidation),
        'reclaim_time_ms': int(bars[reclaim_idx]['time']) if reclaim_idx is not None else None,
        'reclaim_quality': quality, 'lower_wick_fraction': round(lower_wick, 3),
        'close_location': round(close_location, 3), 'stages': events,
    }


def build_displacement_fvg_sweep(raw_five: List[Dict[str, Any]], *, now_ms: Optional[int] = None) -> Dict[str, Any]:
    """Analyze supplied completed 5m candles. No target may originate after sweep.

    At historical replay snapshots pass only bars available up to that time.
    """
    bars = normalize(raw_five)
    result = {'status': 'not_found', 'matched': False, 'timeframe': '5m',
              'setup': None, 'watch': None, 'historical_only': True,
              'method': 'Deterministic closed-bar rally / bearish displacement FVG / range sweep / reclaim; not a probability'}
    if len(bars) < 38:
        result['status'] = 'insufficient_data'
        return result
    import time
    now_ms = int(now_ms if now_ms is not None else time.time()*1000)
    latest = int(bars[-1]['time']) + FIVE_MS
    result['last_closed_time_ms'] = int(bars[-1]['time'])
    result['historical_only'] = latest > now_ms + 1_000 or now_ms-latest > 12*60_000
    # Scan recent sessions, not a fixed global low across a multi-day chart.
    valid = []
    for i in range(max(30, len(bars)-85), len(bars)):
        candidate = _evaluate_at(bars[:i+1], i)
        if candidate:
            valid.append(candidate)
    if valid:
        # Most recent qualified sweep, not whichever later reached a target.
        found = valid[-1]
        sweep_i = next(j for j,b in enumerate(bars) if b['time'] == found['sweep_time_ms'])
        # Re-evaluate with up to two additional known candles so the event can
        # transition to a confirmed reclaim without using any later future bars.
        found = _evaluate_at(bars[:min(len(bars), sweep_i+3)], sweep_i) or found
        follow_from = sweep_i+1
        target_low = found['gap']['low']; target_high = found['gap']['high']
        reclaim_ms = found['reclaim_time_ms']
        reclaim_i = next((j for j,b in enumerate(bars) if b['time'] == reclaim_ms), -1)
        status = 'swept_waiting_reclaim' if reclaim_i < 0 else 'reclaimed'
        stage_time = found['sweep_time_ms'] if reclaim_i < 0 else reclaim_ms
        gap_inverted = None
        for j in range(follow_from, len(bars)):
            candle = bars[j]
            # A loss of the sweep low before the FVG target = invalidation.
            if status in ('swept_waiting_reclaim', 'reclaimed') and candle['close'] < found['sweep_low']:
                status = 'invalidated'; stage_time = int(candle['time']); break
            if status in ('swept_waiting_reclaim','reclaimed') and reclaim_i >= 0 and j >= reclaim_i and candle['high'] >= target_low:
                status = 'target_touched'; stage_time = int(candle['time'])
            if gap_inverted is not None and j > gap_inverted:
                if candle['close'] < target_low:
                    status = 'inversion_failed'; stage_time = int(candle['time']); break
                if candle['low'] <= target_high and candle['close'] > target_high:
                    status = 'inversion_held'; stage_time = int(candle['time'])
            elif reclaim_i >= 0 and j >= reclaim_i and candle['close'] > target_high:
                gap_inverted = j
                status = 'inverted'; stage_time = int(candle['time'])
        found['status'] = status
        found['stage_time_ms'] = stage_time
        found['target_touched'] = status in ('target_touched','inverted','inversion_held','inversion_failed')
        result.update(status=status, matched=reclaim_i >= 0, setup=found)
        return result
    # Pre-sweep watch: only mark a pre-existing range + target, no fabricated signal.
    zone = _range_at(bars, len(bars))
    if zone:
        gap = _target_at(bars, len(bars), zone['low'], zone['atr'])
        if gap:
            result.update(status='watching_range', watch={
                'zone': {k: zone[k] for k in ('low','high','touches','candles','start_time_ms','end_time_ms')},
                'gap': gap,
            })
    return result


def early_one_minute_hint(raw_one: List[Dict[str, Any]], report: Dict[str, Any],
                          *, now_ms: Optional[int] = None) -> Optional[dict]:
    """CLOSED 1m candle watch; not a live intrabar snap. Only around a 5m watch range."""
    import time
    if report.get('status') != 'watching_range' or report.get('historical_only'):
        return None
    watch = report.get('watch') or {}
    zone = watch.get('zone') or {}
    support = zone.get('low')
    if not support:
        return None
    bars = normalize(raw_one)
    if len(bars) < 3:
        return None
    now_ms = int(now_ms if now_ms is not None else time.time()*1000)
    last5 = report.get('last_closed_time_ms', 0) + FIVE_MS
    recent = [b for b in bars[-6:] if b['time'] >= last5 and
              0 <= now_ms-(b['time']+60_000) <= 180_000]
    if not recent:
        return None
    low = min(b['low'] for b in recent)
    if low >= support * .9995:
        return None
    last = recent[-1]
    status = 'early_reclaim' if last['close'] > support and last['close'] > last['low'] + .5*(last['high']-last['low']) else 'early_sweep'
    return {'status': status, 'time_ms': int(last['time']), 'sweep_low': _r(low),
            'support': support, 'gap_low': watch['gap']['low'], 'gap_high': watch['gap']['high'],
            'confirmed': False}
