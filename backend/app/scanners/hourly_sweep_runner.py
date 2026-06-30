from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime, time, timezone
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from app.analysis.trade_analysis_engine import TradeAnalysisEngine
from app.scanners.base import ScannerBase
from app.services.polygon_service import PolygonService
from app.services.scanner_snapshot_store import ScannerSnapshotStore

ET = ZoneInfo("America/New_York")


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def normalize_symbol(raw: Any) -> str:
    return "".join(ch for ch in str(raw or "").upper().strip() if ch.isalpha() or ch == ".")


def normalize_bar(bar: Dict[str, Any]) -> Dict[str, float]:
    return {
        "time": int(safe_float(bar.get("time", bar.get("t", 0)))),
        "open": safe_float(bar.get("open", bar.get("o"))),
        "high": safe_float(bar.get("high", bar.get("h"))),
        "low": safe_float(bar.get("low", bar.get("l"))),
        "close": safe_float(bar.get("close", bar.get("c"))),
        "volume": safe_float(bar.get("volume", bar.get("v"))),
    }


def valid_bars(raw: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    bars = [normalize_bar(row) for row in raw or []]
    bars = [b for b in bars if b["time"] > 0 and b["high"] > 0 and b["low"] > 0 and b["close"] > 0]
    bars.sort(key=lambda b: int(b["time"]))
    return bars


def candle_range(bar: Dict[str, float]) -> float:
    return max(0.0, float(bar["high"]) - float(bar["low"]))


def candle_body(bar: Dict[str, float]) -> float:
    return abs(float(bar["close"]) - float(bar["open"]))


def upper_wick(bar: Dict[str, float]) -> float:
    return max(0.0, float(bar["high"]) - max(float(bar["open"]), float(bar["close"])))


def lower_wick(bar: Dict[str, float]) -> float:
    return max(0.0, min(float(bar["open"]), float(bar["close"])) - float(bar["low"]))


def average(values: List[float]) -> float:
    clean = [float(v) for v in values if v and v > 0]
    return sum(clean) / len(clean) if clean else 0.0


def pct_change(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0
    return ((current - previous) / previous) * 100.0


def et_dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ET)


def et_time_label(ms: int) -> str:
    return et_dt(ms).strftime("%m/%d %H:%M")


def current_trade_date() -> str:
    return datetime.now(ET).strftime("%Y-%m-%d")


def parse_target_hours(raw: Any) -> List[int]:
    if raw is None or raw == "":
        return [6, 7]

    if isinstance(raw, (list, tuple, set)):
        values = raw
    else:
        values = str(raw).replace(";", ",").split(",")

    out: List[int] = []

    for item in values:
        try:
            hour = int(str(item).strip())
        except Exception:
            continue

        if 0 <= hour <= 23 and hour not in out:
            out.append(hour)

    return sorted(out) or [6, 7]


def get_analysis_dict(analysis: Any) -> Dict[str, Any]:
    if analysis is None:
        return {}

    try:
        if hasattr(analysis, "to_dict"):
            data = analysis.to_dict()
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}

    return {}


async def build_snapshot_universe(polygon: PolygonService, limit: int) -> "OrderedDict[str, Dict[str, Any]]":
    merged: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

    async def add_rows(coro: Any) -> None:
        try:
            rows = await coro
        except Exception as exc:
            print(f"[hourly-sweep-runner] universe source failed: {exc}", flush=True)
            return

        for row in rows or []:
            symbol = normalize_symbol(row.get("ticker") or row.get("symbol"))

            if symbol and symbol not in merged:
                merged[symbol] = row

    await asyncio.gather(
        add_rows(polygon.get_snapshot_gainers(limit=limit)),
        add_rows(polygon.get_snapshot_actives(limit=limit)),
        add_rows(polygon.get_snapshot_losers(limit=limit)),
    )

    return merged


class HourlySweepRunnerScanner(ScannerBase):
    id = "hourly_sweep_runner"
    name = "6/7 Hour Liquidity Sweep Scanner"
    description = "Scans active stocks for liquidity sweeps of the 6:00 and 7:00 ET hour range."

    def __init__(self) -> None:
        self.trade_analysis_engine = TradeAnalysisEngine()

    async def run(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = int(kwargs.get("max_symbols", 40))
        min_price = float(kwargs.get("min_price", 0.5))
        max_price = float(kwargs.get("max_price", 20.0))
        min_volume = int(kwargs.get("min_volume", 150_000))
        min_sweep_score = float(kwargs.get("min_sweep_score", 55.0))
        min_rvol = float(kwargs.get("min_rvol", 1.0))
        sweep_buffer_pct = float(kwargs.get("sweep_buffer_pct", 0.001))
        recent_bars = int(kwargs.get("recent_bars", 36))
        include_ready = str(kwargs.get("include_ready", "false")).lower() in {"1", "true", "yes", "on"}

        timeframe = str(kwargs.get("timeframe", kwargs.get("confirm_timeframe", "5m")) or "5m").lower().strip()

        if timeframe not in {"1m", "5m", "15m"}:
            timeframe = "5m"

        target_hours = parse_target_hours(kwargs.get("target_hours", kwargs.get("hours", "6,7")))

        extra_symbols = [normalize_symbol(x) for x in kwargs.get("extra_symbols", []) or []]
        extra_symbols = [x for x in extra_symbols if x]

        universe = await build_snapshot_universe(polygon, limit=max(100, max_symbols * 6))
        candidate_symbols = list(OrderedDict((s, None) for s in extra_symbols + list(universe.keys())).keys())

        rows: List[Dict[str, Any]] = []
        checked = 0

        reject_counts: Dict[str, int] = {
            "no_bars": 0,
            "no_hour_range": 0,
            "price": 0,
            "volume": 0,
            "no_sweep": 0,
            "score": 0,
            "passed": 0,
        }

        for symbol in candidate_symbols[: max_symbols * 8]:
            checked += 1

            row, reject_reason = await self._scan_symbol(
                polygon,
                symbol,
                snapshot=universe.get(symbol, {}),
                timeframe=timeframe,
                target_hours=target_hours,
                min_price=min_price,
                max_price=max_price,
                min_volume=min_volume,
                min_sweep_score=min_sweep_score,
                min_rvol=min_rvol,
                sweep_buffer_pct=sweep_buffer_pct,
                recent_bars=recent_bars,
                include_ready=include_ready,
            )

            if row is not None:
                rows.append(row)
                reject_counts["passed"] += 1
            elif reject_reason in reject_counts:
                reject_counts[reject_reason] += 1

        rows.sort(
            key=lambda item: (
                safe_float(item.get("runner_score")),
                safe_float(item.get("trade_readiness_score")),
                1 if item.get("phase") == "CONFIRMED" else 0,
                safe_float(item.get("rvol")),
                safe_float(item.get("volume")),
            ),
            reverse=True,
        )

        rows = rows[:max_symbols]

        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "hour_range_liquidity_sweep",
            "timeframe": timeframe,
            "confirm_timeframe": timeframe,
            "trade_day": current_trade_date(),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "checked": checked,
                "target_hours_et": target_hours,
                "range_window_et": f"{min(target_hours):02d}:00-{max(target_hours) + 1:02d}:00",
                "uses_trade_analysis": True,
                "reject_counts": reject_counts,
                "active_filters": {
                    "max_symbols": max_symbols,
                    "min_price": min_price,
                    "max_price": max_price,
                    "min_volume": min_volume,
                    "min_sweep_score": min_sweep_score,
                    "min_rvol": min_rvol,
                    "sweep_buffer_pct": sweep_buffer_pct,
                    "recent_bars": recent_bars,
                    "include_ready": include_ready,
                    "timeframe": timeframe,
                    "target_hours": target_hours,
                },
            },
        }

    async def _scan_symbol(
        self,
        polygon: PolygonService,
        symbol: str,
        *,
        snapshot: Dict[str, Any],
        timeframe: str,
        target_hours: List[int],
        min_price: float,
        max_price: float,
        min_volume: int,
        min_sweep_score: float,
        min_rvol: float,
        sweep_buffer_pct: float,
        recent_bars: int,
        include_ready: bool,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        symbol = normalize_symbol(symbol)

        if not symbol:
            return None, "no_bars"

        try:
            trade_analysis = await self.trade_analysis_engine.analyze_symbol(
                polygon,
                symbol,
                snapshot=snapshot,
                timeframe=timeframe,
            )
        except Exception as exc:
            print(f"[hourly-sweep-runner] trade analysis failed {symbol}: {exc}", flush=True)
            trade_analysis = None

        analysis_data = get_analysis_dict(trade_analysis)

        try:
            raw = await polygon.get_bars(symbol, timeframe)
        except Exception as exc:
            print(f"[hourly-sweep-runner] bars failed {symbol} {timeframe}: {exc}", flush=True)
            return None, "no_bars"

        bars = valid_bars(raw)

        if len(bars) < 20:
            return None, "no_bars"

        hour_range = self._build_target_hour_range(bars, target_hours)

        if hour_range is None:
            return None, "no_hour_range"

        last = bars[-1]
        last_price = safe_float(last["close"])
        total_volume = int(sum(safe_float(b["volume"]) for b in self._todays_bars(bars)))

        if last_price < min_price or (max_price > 0 and last_price > max_price):
            return None, "price"

        if total_volume < min_volume:
            return None, "volume"

        state = self._detect_hour_sweep(
            bars,
            hour_range,
            min_rvol=min_rvol,
            sweep_buffer_pct=sweep_buffer_pct,
            recent_bars=recent_bars,
            include_ready=include_ready,
        )

        if state is None:
            return None, "no_sweep"

        trade_readiness_score = safe_float(analysis_data.get("readiness_score"))
        trade_readiness_grade = str(
            ((analysis_data.get("readiness") or {}).get("grade"))
            if isinstance(analysis_data.get("readiness"), dict)
            else ""
        )

        if trade_readiness_score > 0:
            state["runner_score"] = round(
                max(0.0, min(100.0, safe_float(state.get("runner_score")) + min(trade_readiness_score * 0.06, 6.0))),
                2,
            )
            state["sweep_score"] = round(
                max(0.0, min(100.0, safe_float(state.get("sweep_score")) + min(trade_readiness_score * 0.04, 4.0))),
                2,
            )

        if state is None:
            return None, "no_sweep"

        if safe_float(state.get("runner_score")) < min_sweep_score and state.get("phase") != "READY":
            return None, "score"

        notes = list(state["notes"])

        if trade_readiness_grade:
            notes.append(f"readiness: {trade_readiness_grade}")

        row = {
            "symbol": symbol,
            "timeframe": timeframe,
            "confirm_timeframe": timeframe,
            "last_price": state["last_price"],
            "price": state["last_price"],
            "volume": total_volume,
            "runner_type": "six_seven_hour_sweep",
            "setup": state["setup"],
            "setup_state": state["setup_state"],
            "phase": state["phase"],
            "direction": state["direction"],
            "runner_score": state["runner_score"],
            "sweep_score": state["sweep_score"],
            "rvol": state["rvol"],
            "range_high": hour_range["range_high"],
            "range_low": hour_range["range_low"],
            "range_mid": hour_range["range_mid"],
            "range_pct": hour_range["range_pct"],
            "range_start_time": hour_range["range_start_time"],
            "range_end_time": hour_range["range_end_time"],
            "range_label": hour_range["range_label"],
            "sweep_time": state.get("sweep_time"),
            "sweep_time_label": state.get("sweep_time_label"),
            "sweep_price": state.get("sweep_price"),
            "sweep_depth_pct": state.get("sweep_depth_pct"),
            "reclaim_close": state.get("reclaim_close"),
            "reject_close": state.get("reject_close"),
            "bars_since_sweep": state.get("bars_since_sweep"),
            "uses_trade_analysis": True,
            "trade_readiness_score": round(trade_readiness_score, 2),
            "trade_readiness_grade": trade_readiness_grade or None,
            "trade_analysis_signals": analysis_data.get("signals", []),
            "trade_analysis_warnings": analysis_data.get("warnings", []),
            "notes": notes,
            "source": "live_hour_range_sweep",
            "extra": {
                "target_hours_et": target_hours,
                "sweep_buffer_pct": sweep_buffer_pct,
                "range_bar_count": hour_range["bar_count"],
                "trade_analysis": analysis_data,
            },
        }

        return row, "passed"

    def _todays_bars(self, bars: List[Dict[str, float]]) -> List[Dict[str, float]]:
        today = current_trade_date()
        return [b for b in bars if et_dt(int(b["time"])).strftime("%Y-%m-%d") == today]

    def _build_target_hour_range(
        self,
        bars: List[Dict[str, float]],
        target_hours: List[int],
    ) -> Optional[Dict[str, Any]]:
        today = current_trade_date()
        target_set = set(target_hours)
        range_bars: List[Dict[str, float]] = []

        for bar in bars:
            dt = et_dt(int(bar["time"]))

            if dt.strftime("%Y-%m-%d") != today:
                continue

            if dt.hour in target_set:
                range_bars.append(bar)

        if not range_bars:
            return None

        range_high = max(safe_float(b["high"]) for b in range_bars)
        range_low = min(safe_float(b["low"]) for b in range_bars)

        if range_high <= 0 or range_low <= 0 or range_high <= range_low:
            return None

        range_start = min(int(b["time"]) for b in range_bars)
        range_end_hour = max(target_hours) + 1
        last_dt = et_dt(max(int(b["time"]) for b in range_bars))
        range_end_dt = datetime.combine(last_dt.date(), time(hour=min(range_end_hour, 23), minute=0), tzinfo=ET)

        if range_end_hour >= 24:
            range_end_dt = datetime.combine(last_dt.date(), time(hour=23, minute=59), tzinfo=ET)

        range_end_ms = int(range_end_dt.astimezone(timezone.utc).timestamp() * 1000)
        range_pct = pct_change(range_high, range_low)

        return {
            "range_high": round(range_high, 4),
            "range_low": round(range_low, 4),
            "range_mid": round((range_high + range_low) / 2.0, 4),
            "range_pct": round(range_pct, 2),
            "range_start_time": range_start,
            "range_end_time": range_end_ms,
            "range_label": f"{min(target_hours):02d}:00-{max(target_hours) + 1:02d}:00 ET",
            "bar_count": len(range_bars),
        }

    def _detect_hour_sweep(
        self,
        bars: List[Dict[str, float]],
        hour_range: Dict[str, Any],
        *,
        min_rvol: float,
        sweep_buffer_pct: float,
        recent_bars: int,
        include_ready: bool,
    ) -> Optional[Dict[str, Any]]:
        range_high = safe_float(hour_range.get("range_high"))
        range_low = safe_float(hour_range.get("range_low"))
        range_end_time = int(safe_float(hour_range.get("range_end_time")))

        after = [b for b in bars if int(b["time"]) >= range_end_time]

        if not after:
            return None

        avg_volume = average([safe_float(b["volume"]) for b in bars[-60:-1]]) or average(
            [safe_float(b["volume"]) for b in bars[:-1]]
        )

        candidates: List[Dict[str, Any]] = []

        for index, bar in enumerate(after):
            high = safe_float(bar["high"])
            low = safe_float(bar["low"])
            close = safe_float(bar["close"])
            volume = safe_float(bar["volume"])
            rvol = volume / avg_volume if avg_volume > 0 else 0.0
            rng = max(candle_range(bar), 0.000001)
            body = candle_body(bar)

            swept_low = low < range_low * (1.0 - sweep_buffer_pct) and close > range_low
            swept_high = high > range_high * (1.0 + sweep_buffer_pct) and close < range_high

            if not swept_low and not swept_high:
                continue

            if swept_low:
                sweep_depth_pct = abs(pct_change(low, range_low))
                wick_pct = lower_wick(bar) / rng
                continuation = close > max(safe_float(b["high"]) for b in after[max(0, index - 4):index] or [bar])

                score = self._score_sweep(
                    sweep_depth_pct=sweep_depth_pct,
                    wick_pct=wick_pct,
                    rvol=rvol,
                    body=body,
                    rng=rng,
                    continuation=continuation,
                    bars_since=len(after) - 1 - index,
                )

                candidates.append(
                    {
                        "setup": "6/7 LOW SWEEP RECLAIM",
                        "setup_state": "LOW_SWEEP_RECLAIM",
                        "phase": "CONFIRMED" if len(after) - 1 - index <= recent_bars else "WATCH",
                        "direction": "bullish",
                        "runner_score": score,
                        "sweep_score": score,
                        "last_price": round(safe_float(bars[-1]["close"]), 4),
                        "rvol": round(rvol, 2),
                        "sweep_time": int(bar["time"]),
                        "sweep_time_label": et_time_label(int(bar["time"])),
                        "sweep_price": round(low, 4),
                        "sweep_depth_pct": round(sweep_depth_pct, 2),
                        "reclaim_close": round(close, 4),
                        "reject_close": None,
                        "bars_since_sweep": len(after) - 1 - index,
                        "notes": [
                            f"swept below {hour_range['range_label']} low {range_low:.4f}",
                            f"closed back above range low at {close:.4f}",
                            f"sweep rvol {rvol:.2f}",
                        ],
                    }
                )

            if swept_high:
                sweep_depth_pct = abs(pct_change(high, range_high))
                wick_pct = upper_wick(bar) / rng
                continuation = close < min(safe_float(b["low"]) for b in after[max(0, index - 4):index] or [bar])

                score = self._score_sweep(
                    sweep_depth_pct=sweep_depth_pct,
                    wick_pct=wick_pct,
                    rvol=rvol,
                    body=body,
                    rng=rng,
                    continuation=continuation,
                    bars_since=len(after) - 1 - index,
                )

                candidates.append(
                    {
                        "setup": "6/7 HIGH SWEEP REJECT",
                        "setup_state": "HIGH_SWEEP_REJECT",
                        "phase": "CONFIRMED" if len(after) - 1 - index <= recent_bars else "WATCH",
                        "direction": "bearish",
                        "runner_score": score,
                        "sweep_score": score,
                        "last_price": round(safe_float(bars[-1]["close"]), 4),
                        "rvol": round(rvol, 2),
                        "sweep_time": int(bar["time"]),
                        "sweep_time_label": et_time_label(int(bar["time"])),
                        "sweep_price": round(high, 4),
                        "sweep_depth_pct": round(sweep_depth_pct, 2),
                        "reclaim_close": None,
                        "reject_close": round(close, 4),
                        "bars_since_sweep": len(after) - 1 - index,
                        "notes": [
                            f"swept above {hour_range['range_label']} high {range_high:.4f}",
                            f"closed back below range high at {close:.4f}",
                            f"sweep rvol {rvol:.2f}",
                        ],
                    }
                )

        fresh_candidates = [c for c in candidates if int(c.get("bars_since_sweep") or 999999) <= recent_bars]
        usable = fresh_candidates or candidates

        if usable:
            best = max(
                usable,
                key=lambda item: (
                    safe_float(item.get("runner_score")),
                    -safe_float(item.get("bars_since_sweep")),
                ),
            )

            if safe_float(best.get("rvol")) < min_rvol:
                best["notes"].append(f"below preferred rvol filter {min_rvol:.2f}")

            return best

        if not include_ready:
            return None

        last = bars[-1]
        last_close = safe_float(last["close"])
        near_low = abs(last_close - range_low) / range_low <= 0.012 if range_low > 0 else False
        near_high = abs(last_close - range_high) / range_high <= 0.012 if range_high > 0 else False

        if near_low or near_high:
            direction = "bullish" if near_low else "bearish"
            setup = "6/7 LOW SWEEP WATCH" if near_low else "6/7 HIGH SWEEP WATCH"
            level = range_low if near_low else range_high

            return {
                "setup": setup,
                "setup_state": "SWEEP_READY",
                "phase": "READY",
                "direction": direction,
                "runner_score": 45.0,
                "sweep_score": 45.0,
                "last_price": round(last_close, 4),
                "rvol": 0.0,
                "sweep_time": None,
                "sweep_time_label": None,
                "sweep_price": None,
                "sweep_depth_pct": None,
                "reclaim_close": None,
                "reject_close": None,
                "bars_since_sweep": None,
                "notes": [f"price is near {hour_range['range_label']} sweep level {level:.4f}"],
            }

        return None

    def _score_sweep(
        self,
        *,
        sweep_depth_pct: float,
        wick_pct: float,
        rvol: float,
        body: float,
        rng: float,
        continuation: bool,
        bars_since: int,
    ) -> float:
        body_pct = body / max(rng, 0.000001)

        score = 35.0
        score += min(max(sweep_depth_pct, 0.0) * 8.0, 18.0)
        score += min(max(wick_pct, 0.0) * 22.0, 18.0)
        score += min(max(rvol - 1.0, 0.0) * 12.0, 16.0)
        score += min(max(body_pct, 0.0) * 10.0, 8.0)

        if continuation:
            score += 10.0

        if bars_since <= 2:
            score += 8.0
        elif bars_since <= 6:
            score += 4.0
        elif bars_since > 36:
            score -= 8.0

        return round(max(0.0, min(100.0, score)), 2)