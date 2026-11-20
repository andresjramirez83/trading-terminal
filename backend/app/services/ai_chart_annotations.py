"""Read-only overlay suggestions grounded entirely in *completed* OHLCV bars.

This is not free-form price prediction by an LLM. Every mark contains an observed
price and/or bar start timestamp. No trading or drawing persistence is touched.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List


def _price(value: float) -> float:
    return round(float(value), 6)


def _engulfed(previous: Dict[str, Any], current: Dict[str, Any]) -> bool:
    return (previous['close'] < previous['open'] and
            current['close'] > current['open'] and
            current['open'] <= previous['close'] and
            current['close'] >= previous['open'])


def build_ai_annotations(one: List[Dict[str, Any]], five: List[Dict[str, Any]],
                         structure: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Returns a bounded set of measured marks, never an unverified entry order.

    ``one`` and ``five`` must already be filtered with ``closed_bars``.
    """
    marks: List[Dict[str, Any]] = []
    if structure.get('available'):
        try:
            low = float(structure['rally_low'])
            high = float(structure['rally_high'])
            pullback = float(structure['pullback_low'])
        except (TypeError, ValueError, KeyError):
            low = high = pullback = 0.0
        if all(map(math.isfinite, (low, high, pullback))) and 0 < low < high and 0 < pullback <= high:
            # These levels are math from observed swing extremes, not order suggestions.
            marks.append({'id':'rally-high', 'kind':'level', 'tone':'context', 'timeframe':'all',
                          'price':_price(high), 'label':'Observed rally high', 'source':'closed_bars'})
            for frac, name in ((0.5,'50%'), (0.618,'61.8%'), (0.786,'78.6%')):
                marks.append({'id':f'fib-{name}', 'kind':'level', 'tone':'watch', 'timeframe':'all',
                              'price':_price(high - frac*(high-low)), 'label':f'Measured Fib {name}', 'source':'closed_bars'})
            marks.append({'id':'pullback-low', 'kind':'level', 'tone':'risk', 'timeframe':'all',
                          'price':_price(pullback), 'label':'Pullback low · watch break', 'source':'closed_bars'})
            candles = five if len(five) >= 16 else one
            if candles:
                recent = candles[-20:]
                ranges = sorted(max(.0, float(b['high'])-float(b['low'])) for b in recent)
                typical_range = ranges[len(ranges)//2] if ranges else 0.0
                buffer = min(max(typical_range*.45, (high-low)*.015), (high-low)*.12)
                marks.append({'id':'pullback-area', 'kind':'zone', 'tone':'context', 'timeframe':'all',
                              'low':_price(pullback), 'high':_price(min(high,pullback+buffer)),
                              'label':'Observed pullback area (not proven demand)', 'source':'closed_bars'})
    # Timestamped markers: only confirmed, completed candles; no lookahead.
    if len(one) >= 2:
        for idx in range(len(one)-1, max(0,len(one)-6), -1):
            curr, prev = one[idx], one[idx-1]
            if _engulfed(prev,curr):
                marks.append({'id':f'engulf-{int(curr["time"])}','kind':'marker','tone':'confirmed',
                              'timeframe':'1m','time_ms':int(curr['time']), 'price':_price(curr['high']),
                              'label':'Closed 1m bullish engulf', 'source':'closed_bars'})
                break  # At most one most-recent nearby candidate, not a wall of labels.
    if len(one) >= 9:
        last = one[-1]
        recent_low = min(float(b['low']) for b in one[-9:-1])
        if float(last['low']) < recent_low < float(last['close']):
            marks.append({'id':f'sweep-{int(last["time"])}', 'kind':'marker','tone':'watch',
                          'timeframe':'1m','time_ms':int(last['time']), 'price':_price(last['low']),
                          'label':'Possible low sweep + reclaim (not proof of stops)', 'source':'closed_bars'})
    if five:
        last = five[-1]
        if len(five) >= 21:
            base_volume = sum(max(0, float(x.get('volume', 0))) for x in five[-21:-1]) / 20
            rel_volume = float(last.get('volume', 0))/max(base_volume, 1.0)
            if rel_volume >= 1.5:
                bullish = float(last['close']) > float(last['open'])
                marks.append({'id':f'volume-{int(last["time"])}', 'kind':'marker',
                              'tone':'confirmed' if bullish else 'risk', 'timeframe':'5m',
                              'time_ms':int(last['time']), 'price':_price(last['high'] if bullish else last['low']),
                              'label':f'5m volume {rel_volume:.1f}x mean', 'source':'closed_bars'})
        height = max(1e-9, float(last['high'])-float(last['low']))
        close_location = (float(last['close'])-float(last['low']))/height
        body = abs(float(last['close'])-float(last['open']))/height
        if last['close'] > last['open'] and close_location >= .75 and body >= .4:
            marks.append({'id':f'5m-close-{int(last["time"])}','kind':'marker','tone':'confirmed',
                          'timeframe':'5m', 'time_ms':int(last['time']), 'price':_price(last['high']),
                          'label':'Closed 5m strong candle', 'source':'closed_bars'})
    return marks[:16]
