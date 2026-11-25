
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from typing import Any, Dict, List, Sequence


@dataclass(frozen=True)
class FibSweepParams:
    min_impulse_pct: float = 20.0
    min_sweep_pct: float = 5.0
    min_wick_ratio: float = 0.45
    min_retrace: float = 0.25
    impulse_lookback: int = 30
    swing_lookback: int = 4
    confirmation_bars: int = 4
    min_volume_ratio: float = 2.0


def ema(values, length):
    result = []
    alpha = 2.0 / (length + 1)
    value = None

    for i, price in enumerate(values):
        if i == length - 1:
            value = sum(values[:length]) / length
        elif i >= length and value is not None:
            value += alpha * (price - value)

        result.append(value if i >= length - 1 else None)

    return result


def calculate_vwap(rows):
    result = []
    current_day = None
    total_pv = 0.0
    total_volume = 0.0

    for row in rows:
        day = row["trade_date"]

        if day != current_day:
            current_day = day
            total_pv = 0.0
            total_volume = 0.0

        t = datetime.fromisoformat(row["dt_et"]).time()

        if time(9, 30) <= t < time(16, 0):
            volume = float(row["volume"])
            typical = (
                float(row["high"])
                + float(row["low"])
                + float(row["close"])
            ) / 3.0

            total_pv += typical * volume
            total_volume += volume

        result.append(
            total_pv / total_volume if total_volume else None
        )

    return result


def detect_fib_liquidity_sweeps(
    candles: Sequence[Dict[str, Any]],
    params: FibSweepParams | None = None,
) -> List[Dict[str, Any]]:

    params = params or FibSweepParams()
    rows = sorted(candles, key=lambda x: x["ts"])

    if len(rows) < 55:
        return []

    closes = [float(x["close"]) for x in rows]

    ema9 = ema(closes, 9)
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    vwap = calculate_vwap(rows)

    events = []
    prior_sweeps = []

    for i in range(50, len(rows)):
        candle = rows[i]

        low = float(candle["low"])
        high = float(candle["high"])
        op = float(candle["open"])
        close = float(candle["close"])

        span = high - low

        if span <= 0 or low <= 0:
            continue

        wick = min(op, close) - low
        wick_ratio = wick / span

        if wick_ratio < params.min_wick_ratio:
            continue

        start = max(0, i - params.impulse_lookback)

        peak_index = max(
            range(start, i),
            key=lambda j: float(rows[j]["high"])
        )

        if peak_index >= i - 1:
            continue

        peak = float(rows[peak_index]["high"])

        anchor_start = max(
            0, peak_index - params.impulse_lookback
        )

        anchor = min(
            float(rows[j]["low"])
            for j in range(anchor_start, peak_index + 1)
        )

        if anchor <= 0 or peak <= anchor:
            continue

        impulse_pct = (peak / anchor - 1) * 100

        if impulse_pct < params.min_impulse_pct:
            continue

        fib_range = peak - anchor
        retrace = (peak - low) / fib_range

        if retrace < params.min_retrace:
            continue

        fib618 = peak - fib_range * 0.618
        fib786 = peak - fib_range * 0.786

        recent_start = max(
            peak_index + 1,
            i - params.swing_lookback
        )

        if recent_start >= i:
            continue

        swing_low = min(
            float(rows[j]["low"])
            for j in range(recent_start, i)
        )

        local_low_sweep = low < swing_low and close > swing_low

        sweep_pct = (swing_low - low) / swing_low * 100

        # Volume during the preceding impulse.
        baseline_rows = rows[
            max(0, peak_index - 10):peak_index
        ]

        baseline = (
            sum(float(x["volume"]) for x in baseline_rows)
            / len(baseline_rows)
            if baseline_rows else 0
        )

        peak_volume = float(rows[peak_index]["volume"])

        volume_ratio = (
            peak_volume / baseline if baseline > 0 else 0
        )

        # Classify the sweep.
        if retrace >= 0.618:
            pattern = "GOLDEN_ZONE_SWEEP"
            if retrace > 0.786:
                pattern = "DEEP_FIB_SWEEP"
        else:
            pattern = "CONTINUATION_SWEEP"

        recent_sweep = any(
            0 < i - j <= 12 for j in prior_sweeps
        )

        if recent_sweep and retrace < 0.618:
            pattern = "REPEATED_SUPPORT_SWEEP"

        sweep_pass = sweep_pct >= params.min_sweep_pct
        volume_pass = (
            volume_ratio >= params.min_volume_ratio
        )

        confirmation_index = None

        end = min(
            len(rows),
            i + params.confirmation_bars + 1
        )

        for j in range(i, end):
            if rows[j]["trade_date"] != candle["trade_date"]:
                break

            if j == 0 or any(
                value is None for value in (
                    vwap[j],
                    vwap[j - 1],
                    ema9[j],
                    ema20[j],
                    ema50[j],
                )
            ):
                continue

            current_close = float(rows[j]["close"])
            previous_close = float(rows[j - 1]["close"])

            crossed_vwap = (
                previous_close <= vwap[j - 1]
                and current_close > vwap[j]
            )

            above_50 = current_close > ema50[j]
            bullish_ema = ema9[j] > ema20[j]

            if crossed_vwap and above_50 and bullish_ema:
                confirmation_index = j
                break

        confirmed = (
            sweep_pass
            and volume_pass
            and confirmation_index is not None
        )

        # Identify swing lows confirmed before this sweep.
        day_prior = [
            k for k in range(i)
            if rows[k]["trade_date"] == candle["trade_date"]
        ]

        pivots = []
        for p in range(2, len(day_prior) - 2):
            k = day_prior[p]
            level = float(rows[k]["low"])

            neighbors = (
                p - 2, p - 1, p + 1, p + 2
            )

            if all(
                level < float(rows[day_prior[q]]["low"])
                for q in neighbors
            ):
                pivots.append((k, level))

        higher_lows = [
            (k, level)
            for n, (k, level) in enumerate(pivots)
            if n > 0 and level > pivots[n - 1][1]
        ]

        last_hl = higher_lows[-1] if higher_lows else None

        structural_hl_sweep = bool(
            last_hl
            and low < last_hl[1]
            and close > last_hl[1]
        )

        if not (local_low_sweep or structural_hl_sweep):
            continue

        sweep_reference = swing_low if local_low_sweep else last_hl[1]
        sweep_pct = (sweep_reference - low) / sweep_reference * 100
        sweep_pass = sweep_pct >= params.min_sweep_pct
        confirmed = sweep_pass and volume_pass and confirmation_index is not None
        prior_sweeps.append(i)



        events.append({
            "pattern": pattern,
            "swept_level": round(sweep_reference, 4),
            "local_low_sweep": local_low_sweep,
            "structural_hl_sweep": structural_hl_sweep,
            "latest_confirmed_hl": (
                round(last_hl[1], 4) if last_hl else None
            ),
            "latest_hl_time": (
                rows[last_hl[0]]["dt_et"] if last_hl else None
            ),
            "trade_date": candle["trade_date"],

            "sweep_time": candle["dt_et"],
            "impulse_pct": round(impulse_pct, 2),
            "impulse_high": round(peak, 4),
            "fib618": round(fib618, 4),
            "fib786": round(fib786, 4),
            "retracement_pct": round(retrace * 100, 2),
            "swing_low": round(swing_low, 4),
            "sweep_low": round(low, 4),
            "sweep_close": round(close, 4),
            "sweep_pct": round(sweep_pct, 2),
            "wick_pct": round(wick_ratio * 100, 2),
            "sweep_volume": int(candle["volume"]),
            "impulse_volume_ratio": round(volume_ratio, 2),
            "vwap_at_sweep": (
                round(vwap[i], 4)
                if vwap[i] is not None else None
            ),
            "ema9_at_sweep": round(ema9[i], 4),
            "ema20_at_sweep": round(ema20[i], 4),
            "ema50_at_sweep": round(ema50[i], 4),
            "sweep_pass": sweep_pass,
            "volume_pass": volume_pass,
            "confirmation_time": (
                rows[confirmation_index]["dt_et"]
                if confirmation_index is not None else None
            ),
            "confirmed": confirmed,
        })

    return events

def measure_sweep_outcomes(candles, events, horizon_bars=4):
    """Evaluate hypothetical next-bar-open entries, not executed trades."""
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")

    rows = sorted(candles, key=lambda x: x["ts"])
    by_time = {
        str(row["dt_et"]): i
        for i, row in enumerate(rows)
    }
    outcomes = []

    for event in events:
        signals = [
            ("sweep", event["sweep_time"]),
        ]

        if event.get("confirmed") and event.get("confirmation_time"):
            signals.append(
                ("confirmed", event["confirmation_time"])
            )

        for entry_type, signal_time in signals:
            signal_index = by_time.get(str(signal_time))

            if signal_index is None:
                continue

            entry_index = signal_index + 1
            future = rows[
                entry_index:entry_index + horizon_bars
            ]

            if len(future) != horizon_bars:
                continue

            entry = float(future[0]["open"])

            if entry <= 0:
                continue

            highest = max(float(x["high"]) for x in future)
            lowest = min(float(x["low"]) for x in future)
            last_close = float(future[-1]["close"])

            extended_hours = any(
                not (
                    time(9, 30)
                    <= datetime.fromisoformat(x["dt_et"]).time()
                    < time(16, 0)
                )
                for x in future
            )

            outcomes.append({
                "trade_date": event["trade_date"],
                "pattern": event["pattern"],
                "sweep_time": event["sweep_time"],
                "entry_type": entry_type,
                "signal_time": signal_time,
                "entry_time": future[0]["dt_et"],
                "entry_price": round(entry, 5),
                "horizon_bars": horizon_bars,
                "max_favorable_pct": round(
                    (highest / entry - 1) * 100, 2
                ),
                "max_adverse_pct": round(
                    (lowest / entry - 1) * 100, 2
                ),
                "closing_return_pct": round(
                    (last_close / entry - 1) * 100, 2
                ),
                "extended_hours_included": extended_hours,
            })

    return outcomes

def detect_fib_hl_reclaims(
    candles,
    *,
    min_impulse_pct=20.0,
    zone_min=0.45,
    zone_max=0.75,
    impulse_lookback=30,
    local_lookback=4,
    reclaim_bars=4,
    candle_ms=900000,
    app_hls=None,
):
    """Detect Fibonacci-zone HL/local-low sweeps and reclaims."""

    if not 0 <= zone_min < zone_max <= 1:
        raise ValueError("Invalid Fibonacci zone")

    if reclaim_bars < 1 or impulse_lookback < 3 or local_lookback < 1:
        raise ValueError("Invalid bar settings")

    rows = sorted(candles, key=lambda r: int(r["ts"]))

    app_hls_by_day = {}
    for p in app_hls or []:
        k = p['index']
        if 0 <= k < len(rows):
            app_hls_by_day.setdefault(rows[k]['trade_date'], []).append(p)

    # Find confirmed 2-left / 2-right swing lows.
    pivots_by_day = {}

    for k in range(2, len(rows) - 2):
        day = rows[k]["trade_date"]

        if (
            rows[k - 2]["trade_date"] != day
            or rows[k + 2]["trade_date"] != day
        ):
            continue

        if any(
            int(rows[j + 1]["ts"]) - int(rows[j]["ts"]) != candle_ms
            for j in range(k - 2, k + 2)
        ):
            continue

        pivot_low = float(rows[k]["low"])

        if all(
            pivot_low < float(rows[j]["low"])
            for j in (k - 2, k - 1, k + 1, k + 2)
        ):
            pivots_by_day.setdefault(day, []).append(k)

    events = []

    for i in range(max(50, impulse_lookback + 2), len(rows)):
        bar = rows[i]
        day = bar["trade_date"]

        start = i - impulse_lookback

        peak_i = max(
            range(start, i),
            key=lambda j: float(rows[j]["high"])
        )

        if peak_i >= i - 1:
            continue

        high = float(rows[peak_i]["high"])

        low_i = min(
            range(max(0, peak_i - impulse_lookback), peak_i + 1),
            key=lambda j: float(rows[j]["low"])
        )

        anchor = float(rows[low_i]["low"])

        if (
            anchor <= 0
            or high <= anchor
            or (high / anchor - 1) * 100 < min_impulse_pct
        ):
            continue

        span = high - anchor
        sweep_low = float(bar["low"])
        sweep_close = float(bar["close"])

        if sweep_low <= 0:
            continue

        candidates = []

        for p in app_hls_by_day.get(day, []):
            k = p['index']
            if (p['confirmationIndex'] < i and rows[i - 1]['trade_date'] == day and
                    int(bar['ts']) - int(rows[i - 1]['ts']) == candle_ms and
                    float(rows[i - 1]['close']) > float(p['price'])):
                candidates.append(('APP_CONFIRMED_HL', k))

        # Confirmed HL must be higher than the preceding pivot.
        pivots = [
            k for k in pivots_by_day.get(day, [])
            if k + 2 < i
        ]

        for n in range(1, len(pivots)):
            k = pivots[n]

            if (
                k <= peak_i
                or float(rows[k]["low"])
                <= float(rows[pivots[n - 1]]["low"])
            ):
                continue

            candidates.append(("CONFIRMED_HL", k))

        # Recent lows are separate from confirmed structural HLs.
        local_indices = [
            k for k in range(
                max(peak_i + 1, i - local_lookback), i
            )
            if rows[k]["trade_date"] == day
        ]

        if local_indices:
            local_i = min(
                local_indices,
                key=lambda k: float(rows[k]["low"])
            )
            earlier = [k for k in pivots_by_day.get(day, []) if k + 2 <= peak_i]
            if earlier and float(rows[local_i]['low']) > float(rows[earlier[-1]]['low']):
                candidates.append(('UNCONFIRMED_LOCAL_LOW', local_i))

        seen_levels = set()

        for level_type, k in candidates:
            level = float(rows[k]["low"])
            retrace_at_level = (high - level) / span

            # The swept reference level must be near golden zone.
            if not zone_min <= retrace_at_level <= zone_max:
                continue

            # Any break below the level counts, regardless of depth.
            if sweep_low >= level:
                continue

            if level_type == 'CONFIRMED_HL' and any(
                float(rows[t]['low']) < level for t in range(k + 3, i)
            ):
                continue

            key = round(level, 6)

            if key in seen_levels:
                continue

            seen_levels.add(key)

            reclaim_i = i if sweep_close > level else None
            checked = 0
            last_i = i

            # Search for a delayed reclaim using consecutive bars.
            if reclaim_i is None:
                for j in range(
                    i + 1,
                    min(len(rows), i + reclaim_bars + 1)
                ):
                    if (
                        rows[j]["trade_date"] != day
                        or int(rows[j]["ts"])
                        - int(rows[j - 1]["ts"]) != candle_ms
                    ):
                        break

                    checked += 1
                    last_i = j

                    if float(rows[j]["close"]) > level:
                        reclaim_i = j
                        break

            if reclaim_i == i:
                status = "IMMEDIATE_RECLAIM"
            elif reclaim_i is not None:
                status = "DELAYED_RECLAIM"
            elif checked == reclaim_bars:
                status = "NO_RECLAIM"
            else:
                status = "INCOMPLETE_WINDOW"

            height = float(bar["high"]) - sweep_low

            wick_pct = (
                100 * max(
                    0.0,
                    min(float(bar["open"]), sweep_close)
                    - sweep_low
                ) / height
                if height > 0 else 0.0
            )

            events.append({
                "trade_date": day,
                "sweep_time": bar["dt_et"],
                "level_type": level_type,
                "reference_time": rows[k]["dt_et"],
                "reference_low": round(level, 5),
                "reference_fib_fraction": round(
                    retrace_at_level, 4
                ),
                "fib50": round(high - 0.5 * span, 5),
                "fib70": round(high - 0.7 * span, 5),
                "impulse_high": round(high, 5),
                "impulse_low": round(anchor, 5),
                "sweep_low": round(sweep_low, 5),
                "sweep_close": round(sweep_close, 5),
                "sweep_depth_pct": round(
                    100 * (level - sweep_low) / level, 2
                ),
                "lower_wick_pct": round(wick_pct, 2),
                "status": status,
                "signal_time": (
                    rows[reclaim_i]["dt_et"]
                    if reclaim_i is not None else None
                ),
                "bars_to_reclaim": (
                    reclaim_i - i
                    if reclaim_i is not None else None
                ),
                "decision_time": rows[
                    reclaim_i if reclaim_i is not None else last_i
                ]["dt_et"],
            })

    return events




def get_app_confirmed_hls(rows):
    import json, subprocess
    from pathlib import Path
    js = '''const fs=require('fs'),e=require('../frontend/node_modules/esbuild'),M=require('module');const c=e.buildSync({entryPoints:['../frontend/src/components/chart/analysis/MarketStructureEngine.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;const m=new M('chart');m._compile(c,'chart');const b=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(m.exports.buildMarketStructure(b,3).points.filter(x=>x.type==='HL').map(x=>({index:x.index,price:x.price,confirmationIndex:x.confirmationIndex}))));'''
    bars = [dict(time=int(r['ts'])/1000,open=float(r['open']),high=float(r['high']),low=float(r['low']),close=float(r['close']),volume=float(r.get('volume') or 0)) for r in rows]
    out = subprocess.run(['node','-e',js],input=json.dumps(bars),text=True,capture_output=True,check=True,cwd=str(Path(__file__).resolve().parents[2]))
    return json.loads(out.stdout)


def detect_app_hl_fib_reclaims(candles, **kwargs):
    rows = sorted(candles, key=lambda r: int(r['ts']))
    points = get_app_confirmed_hls(rows)
    events = detect_fib_hl_reclaims(rows, app_hls=points, **kwargs)
    return [e for e in events if e['level_type'] == 'APP_CONFIRMED_HL']
