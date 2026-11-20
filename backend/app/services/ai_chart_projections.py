"""Conditional forward chart paths derived from *closed* OHLCV bars.

These are transparent, rule-based what-if sketches, NOT learned forecasts or
calibrated probabilities. Future steps are chart slots, not claimed timestamps.
Nothing in this module submits orders, changes chart data, or predicts fills.
"""
from __future__ import annotations

import math
import time
from statistics import median
from typing import Any, Dict, List, Optional


def _p(value: float) -> float:
    return round(float(value), 6)


def _valid_bars(bars: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    clean = []
    for b in bars:
        try:
            t = int(b['time'])
            o, h, l, c = (float(b[k]) for k in ('open', 'high', 'low', 'close'))
            v = float(b.get('volume', 0))
        except (ValueError, TypeError, KeyError, OverflowError):
            continue
        if t > 0 and all(map(math.isfinite, (o, h, l, c, v))) and 0 < l <= min(o, c) <= max(o, c) <= h:
            clean.append({'time': t, 'open': o, 'high': h, 'low': l, 'close': c, 'volume': max(0.0, v)})
    # Caller supplies closed bars; deduplicate and sort, never append future bars.
    return [b for _, b in sorted({b['time']: b for b in clean}.items())]


def _one_timeframe(bars: List[Dict[str, Any]], timeframe: str, now_ms: int) -> Optional[Dict[str, Any]]:
    b = _valid_bars(bars)
    if len(b) < 20:
        return None
    recent = b[-25:]
    current = recent[-1]
    previous = recent[-2]
    close = current['close']
    ranges = []
    for idx in range(1, len(recent)):
        bar = recent[idx]
        prev_close = recent[idx - 1]['close']
        ranges.append(max(bar['high']-bar['low'], abs(bar['high']-prev_close), abs(bar['low']-prev_close)))
    atr = median(ranges[-14:]) if ranges else 0.0
    # If market is absolutely flat, a projected line would be invented movement.
    if atr <= 0 or not math.isfinite(atr):
        return None
    atr = max(close * .0005, min(close * .08, atr))
    support = min(x['low'] for x in recent[-16:-1])
    resistance = max(x['high'] for x in recent[-16:-1])
    if not (0 < support < resistance):
        return None
    avg_volume = sum(x['volume'] for x in recent[-21:-1]) / 20
    rel_vol = current['volume'] / max(1, avg_volume)
    bar_range = max(1e-12, current['high'] - current['low'])
    close_location = (close-current['low'])/bar_range
    bullish_engulf = (previous['close'] < previous['open'] and close > current['open'] and
                       current['open'] <= previous['close'] and close >= previous['open'])
    bearish_engulf = (previous['close'] > previous['open'] and close < current['open'] and
                       current['open'] >= previous['close'] and close <= previous['open'])
    up = down = 0
    reasons: List[str] = []
    if close > previous['close'] + .2*atr:
        up += 1; reasons.append('Close rising versus prior candle')
    elif close < previous['close'] - .2*atr:
        down += 1; reasons.append('Close falling versus prior candle')
    if close > current['open'] and close_location >= .75:
        up += 1; reasons.append('Strong bullish close on completed candle')
    elif close < current['open'] and close_location <= .25:
        down += 1; reasons.append('Weak close near candle low')
    if bullish_engulf:
        up += 2; reasons.append('Bullish body engulf confirmed')
    if bearish_engulf:
        down += 2; reasons.append('Bearish body engulf confirmed')
    if rel_vol >= 1.3 and close > current['open']:
        up += 1; reasons.append('Above-average green-candle volume')
    elif rel_vol >= 1.3 and close < current['open']:
        down += 1; reasons.append('Above-average red-candle volume')
    if close > recent[-6]['close'] + .5*atr:
        up += 1; reasons.append('Five-bar upward price change')
    elif close < recent[-6]['close'] - .5*atr:
        down += 1; reasons.append('Five-bar downward price change')
    if close > resistance:
        up += 1; reasons.append('Closed above recent resistance')
    if close < support:
        down += 1; reasons.append('Closed below recent support')
    # This is an *evidence tally*, not a probability or model confidence.
    edge = up - down
    bias = 'bullish' if edge >= 2 else 'bearish' if edge <= -2 else 'range'
    score = min(80, 20 + abs(edge)*9 + max(up, down)*3) if edge else 20
    strength = 'medium' if abs(edge) >= 3 else 'low'
    duration = 60_000 if timeframe == '1m' else 300_000
    # Stale means a historical what-if only, never an active signal.
    age = max(0, now_ms - (current['time'] + duration))
    stale = age > (30 if timeframe == '1m' else 90) * 60_000
    if stale:
        strength = 'historical / stale'
    horizon = 12 if timeframe == '1m' else 8
    amplitude = min(close*.07, atr * math.sqrt(horizon) * .75)
    amplitude = max(amplitude, close*.0005)
    # Starting from the last *observed* close, produce three conditional paths.
    # Future bars are never added; a step is an offset along the displayed axis.
    steps = [0, max(1, horizon//4), max(2, horizon//2), horizon]
    def path(target: float, bump: float) -> List[Dict[str, Any]]:
        weights = (0.0, .22, .60, 1.0)
        values = []
        for step, w in zip(steps, weights):
            price = max(close*.01, close + (target-close)*w + bump*math.sin(math.pi*w))
            values.append({'step': step, 'price': _p(price)})
        return values
    upper = close + amplitude
    lower = max(close*.01, close - amplitude)
    cautious = close + ((.32 * amplitude) if bias == 'bullish' else (-.32 * amplitude) if bias == 'bearish' else 0.0)
    return {
        'timeframe': timeframe,
        'anchor_time_ms': current['time'],
        'anchor_price': _p(close),
        'bars_forward': horizon,
        'stale': stale,
        'age_minutes': round(age / 60_000, 1),
        'bias': bias,
        'evidence_strength': strength,
        'evidence_score': score,
        'bull_points': up,
        'bear_points': down,
        'reasons': reasons[:5] or ['No decisive closed-candle confirmation'],
        'support': _p(support),
        'resistance': _p(resistance),
        'upside_trigger': _p(max(resistance, close + .25*atr)),
        'downside_trigger': _p(min(support, close - .25*atr)),
        'bullish_path': path(upper, .12*amplitude),
        'bearish_path': path(lower, -.12*amplitude),
        'base_path': path(cautious, .03*amplitude if bias == 'bullish' else -.03*amplitude if bias == 'bearish' else 0.0),
    }


def build_ai_projections(one: List[Dict[str, Any]], five: List[Dict[str, Any]],
                         now_ms: Optional[int] = None) -> Dict[str, Any]:
    """Produce bounded, historical-bar-based scenario overlays on 1m and 5m.

    Never returns future timestamps, success probabilities or trade commands.
    Values are *illustrative volatility-derived branches*, not predicted quotes.
    """
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    timeframes: Dict[str, Any] = {}
    marks: List[Dict[str, Any]] = []
    for name, bars in (('1m', one), ('5m', five)):
        item = _one_timeframe(bars, name, now_ms)
        if not item:
            continue
        timeframes[name] = item
        for id_, tone, field, caption in (
            ('base', 'watch', 'base_path', 'Main scenario'),
            ('bull', 'confirmed', 'bullish_path', 'Upside IF resistance breaks'),
            ('bear', 'risk', 'bearish_path', 'Downside IF support fails'),
        ):
            marks.append({
                'id': f'projection-{name}-{id_}-{item["anchor_time_ms"]}',
                'kind': 'projection', 'scenario': id_, 'tone': tone, 'timeframe': name,
                'label': caption + (' · STALE' if item['stale'] else ''),
                'source': 'closed_bars', 'time_ms': item['anchor_time_ms'],
                'price': item['anchor_price'], 'points': item[field], 'stale': item['stale'],
            })
        for kind, tone, price, label in (
            ('support', 'risk', item['support'], 'Observed 15-bar support'),
            ('resistance', 'context', item['resistance'], 'Observed 15-bar resistance'),
            ('bull-trigger', 'watch', item['upside_trigger'], 'Upside confirmation watch'),
            ('bear-trigger', 'risk', item['downside_trigger'], 'Downside invalidation watch'),
        ):
            marks.append({'id': f'forecast-{name}-{kind}', 'kind': 'level', 'tone': tone,
                          'timeframe': name, 'price': price, 'label': label, 'source': 'closed_bars'})
    return {
        'method': 'Rule-based conditional scenarios from completed OHLCV candles; NOT an AI-trained forecast',
        'probability_calibrated': False,
        'note': 'Evidence score is a heuristic ranking, NOT percent confidence. Paths use volatility assumptions, not predicted prices; stale paths are historical only.',
        'timeframes': timeframes,
        'marks': marks,
    }
