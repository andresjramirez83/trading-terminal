from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

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


def lower_wick(bar: Dict[str, float]) -> float:
    return max(0.0, min(float(bar["open"]), float(bar["close"])) - float(bar["low"]))


def average(values: List[float]) -> float:
    clean = [float(v) for v in values if v and v > 0]
    return sum(clean) / len(clean) if clean else 0.0


def pct_change(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0
    return ((current - previous) / previous) * 100.0


def calc_atr(bars: List[Dict[str, float]], period: int = 14) -> float:
    if len(bars) < 2:
        return 0.0
    trs: List[float] = []
    for i in range(1, len(bars)):
        high = float(bars[i]["high"])
        low = float(bars[i]["low"])
        prev_close = float(bars[i - 1]["close"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return average(trs[-period:])


def ms_to_iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def ms_to_et_label(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ET).strftime("%m/%d %H:%M")


def iso_to_dt(value: Any) -> Optional[datetime]:
    try:
        text = str(value or "")
        if not text:
            return None
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None


def current_trade_date() -> str:
    return datetime.now(ET).strftime("%Y-%m-%d")


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
    name = "1H Expansion Sweep Runner"
    description = "Remembers strong 1H upside runners, then tracks pullback-low sweeps and reclaim continuation setups."

    async def run(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = int(kwargs.get("max_symbols", 30))
        min_price = float(kwargs.get("min_price", 0.5))
        max_price = float(kwargs.get("max_price", 20.0))
        min_volume = int(kwargs.get("min_volume", 150_000))
        min_expansion_score = float(kwargs.get("min_expansion_score", 66.0))
        min_atr_mult = float(kwargs.get("min_atr_mult", 1.45))
        min_rvol = float(kwargs.get("min_rvol", 1.35))
        min_body_pct = float(kwargs.get("min_body_pct", 0.55))
        min_close_position_pct = float(kwargs.get("min_close_position_pct", 0.66))
        structure_lookback = int(kwargs.get("structure_lookback", 12))
        expansion_lookback_bars = int(kwargs.get("expansion_lookback_bars", 10))
        memory_hours = int(kwargs.get("memory_hours", 36))
        confirm_timeframe = str(kwargs.get("confirm_timeframe", "5m") or "5m").lower().strip()
        if confirm_timeframe not in {"1m", "5m", "15m"}:
            confirm_timeframe = "5m"
        extra_symbols = [normalize_symbol(x) for x in kwargs.get("extra_symbols", []) or []]
        extra_symbols = [x for x in extra_symbols if x]

        memory = self._load_memory(snapshot_store)
        memory = self._prune_memory(memory, memory_hours=memory_hours)

        universe = await build_snapshot_universe(polygon, limit=max(80, max_symbols * 6))
        candidate_symbols = list(OrderedDict((s, None) for s in list(memory.keys()) + extra_symbols + list(universe.keys())).keys())

        rows: List[Dict[str, Any]] = []
        checked = 0
        remembered_count_before = len(memory)

        for symbol in candidate_symbols[: max_symbols * 10]:
            checked += 1
            row, remembered = await self._scan_symbol(
                polygon,
                symbol,
                memory.get(symbol),
                min_price=min_price,
                max_price=max_price,
                min_volume=min_volume,
                min_expansion_score=min_expansion_score,
                min_atr_mult=min_atr_mult,
                min_rvol=min_rvol,
                min_body_pct=min_body_pct,
                min_close_position_pct=min_close_position_pct,
                structure_lookback=structure_lookback,
                expansion_lookback_bars=expansion_lookback_bars,
                memory_hours=memory_hours,
                confirm_timeframe=confirm_timeframe,
            )
            if remembered is not None:
                memory[symbol] = remembered
            if row is not None:
                rows.append(row)

        memory = self._prune_memory(memory, memory_hours=memory_hours)
        self._save_memory(snapshot_store, memory)

        rows.sort(
            key=lambda item: (
                safe_float(item.get("runner_score")),
                safe_float(item.get("sweep_score")),
                safe_float(item.get("expansion_score")),
                safe_float(item.get("rvol")),
            ),
            reverse=True,
        )
        rows = rows[:max_symbols]

        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "remembered_1h_expansion_sweep",
            "timeframe": "1h",
            "confirm_timeframe": confirm_timeframe,
            "trade_day": current_trade_date(),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "checked": checked,
                "remembered_before": remembered_count_before,
                "remembered_after": len(memory),
                "memory_hours": memory_hours,
                "active_filters": {
                    "max_symbols": max_symbols,
                    "min_price": min_price,
                    "max_price": max_price,
                    "min_volume": min_volume,
                    "min_expansion_score": min_expansion_score,
                    "min_atr_mult": min_atr_mult,
                    "min_rvol": min_rvol,
                    "min_body_pct": min_body_pct,
                    "min_close_position_pct": min_close_position_pct,
                    "structure_lookback": structure_lookback,
                    "expansion_lookback_bars": expansion_lookback_bars,
                    "confirm_timeframe": confirm_timeframe,
                },
            },
        }

    def _load_memory(self, snapshot_store: ScannerSnapshotStore) -> Dict[str, Dict[str, Any]]:
        payload = snapshot_store.load_latest_snapshot(self.id, "memory") or {}
        rows = payload.get("rows") if isinstance(payload, dict) else None
        memory: Dict[str, Dict[str, Any]] = {}
        for item in rows or []:
            symbol = normalize_symbol(item.get("symbol"))
            if symbol:
                memory[symbol] = dict(item)
        return memory

    def _save_memory(self, snapshot_store: ScannerSnapshotStore, memory: Dict[str, Dict[str, Any]]) -> None:
        payload = {
            "scanner_id": self.id,
            "session": "memory",
            "trade_date": current_trade_date(),
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "count": len(memory),
            "rows": list(memory.values()),
        }
        snapshot_store.save_snapshot(self.id, "memory", current_trade_date(), payload)

    def _prune_memory(self, memory: Dict[str, Dict[str, Any]], *, memory_hours: int) -> Dict[str, Dict[str, Any]]:
        now = datetime.now(timezone.utc)
        out: Dict[str, Dict[str, Any]] = {}
        for symbol, item in memory.items():
            detected = iso_to_dt(item.get("detected_at")) or iso_to_dt(item.get("updated_at"))
            if detected is None:
                continue
            if detected.tzinfo is None:
                detected = detected.replace(tzinfo=timezone.utc)
            if now - detected <= timedelta(hours=max(1, memory_hours)):
                out[symbol] = item
        return out

    async def _scan_symbol(
        self,
        polygon: PolygonService,
        symbol: str,
        memory_item: Optional[Dict[str, Any]],
        *,
        min_price: float,
        max_price: float,
        min_volume: int,
        min_expansion_score: float,
        min_atr_mult: float,
        min_rvol: float,
        min_body_pct: float,
        min_close_position_pct: float,
        structure_lookback: int,
        expansion_lookback_bars: int,
        memory_hours: int,
        confirm_timeframe: str,
    ) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        try:
            hourly_raw = await polygon.get_bars(symbol, "1h")
        except Exception as exc:
            print(f"[hourly-sweep-runner] 1h bars failed {symbol}: {exc}", flush=True)
            return None, None

        hourly = valid_bars(hourly_raw)
        if len(hourly) < 25:
            return None, None

        expansion = self._find_recent_expansion(
            hourly,
            min_price=min_price,
            max_price=max_price,
            min_volume=min_volume,
            min_expansion_score=min_expansion_score,
            min_atr_mult=min_atr_mult,
            min_rvol=min_rvol,
            min_body_pct=min_body_pct,
            min_close_position_pct=min_close_position_pct,
            structure_lookback=structure_lookback,
            expansion_lookback_bars=expansion_lookback_bars,
        )

        remembered: Optional[Dict[str, Any]] = None
        if expansion is not None:
            remembered = {
                "symbol": symbol,
                "detected_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "memory_hours": memory_hours,
                "expansion_time": expansion["expansion_time"],
                "expansion_time_label": expansion["expansion_time_label"],
                "expansion_high": expansion["expansion_high"],
                "expansion_low": expansion["expansion_low"],
                "expansion_mid": expansion["expansion_mid"],
                "expansion_close": expansion["expansion_close"],
                "expansion_score": expansion["expansion_score"],
                "atr_mult": expansion["atr_mult"],
                "rvol": expansion["rvol"],
                "body_pct": expansion["body_pct"],
                "close_position_pct": expansion["close_position_pct"],
                "structure_break": expansion["structure_break"],
            }
        elif memory_item is not None:
            remembered = dict(memory_item)
            remembered["updated_at"] = datetime.now(timezone.utc).isoformat()
        else:
            return None, None

        try:
            confirm_raw = await polygon.get_bars(symbol, confirm_timeframe)
        except Exception as exc:
            print(f"[hourly-sweep-runner] confirm bars failed {symbol} {confirm_timeframe}: {exc}", flush=True)
            confirm_raw = []

        confirm_bars = valid_bars(confirm_raw)
        state = self._classify_sweep_state(remembered, confirm_bars)

        row = {
            "symbol": symbol,
            "timeframe": "1h",
            "confirm_timeframe": confirm_timeframe,
            "last_price": state["last_price"],
            "price": state["last_price"],
            "runner_type": "hourly_sweep",
            "setup_state": state["setup_state"],
            "phase": state["phase"],
            "runner_score": state["runner_score"],
            "sweep_score": state["sweep_score"],
            "expansion_score": remembered.get("expansion_score"),
            "atr_mult": remembered.get("atr_mult"),
            "rvol": remembered.get("rvol"),
            "body_pct": remembered.get("body_pct"),
            "close_position_pct": remembered.get("close_position_pct"),
            "structure_break": remembered.get("structure_break"),
            "expansion_time": remembered.get("expansion_time"),
            "expansion_time_label": remembered.get("expansion_time_label"),
            "expansion_high": remembered.get("expansion_high"),
            "expansion_low": remembered.get("expansion_low"),
            "expansion_mid": remembered.get("expansion_mid"),
            "pullback_low": state.get("pullback_low"),
            "pullback_high": state.get("pullback_high"),
            "sweep_low": state.get("sweep_low"),
            "sweep_depth_pct": state.get("sweep_depth_pct"),
            "reclaim_close": state.get("reclaim_close"),
            "bars_since_expansion": state.get("bars_since_expansion"),
            "bars_since_sweep": state.get("bars_since_sweep"),
            "notes": state["notes"],
            "source": "remembered" if expansion is None else "fresh_expansion",
            "extra": {
                "remembered": True,
                "detected_at": remembered.get("detected_at"),
                "updated_at": remembered.get("updated_at"),
            },
        }
        return row, remembered

    def _find_recent_expansion(
        self,
        bars: List[Dict[str, float]],
        *,
        min_price: float,
        max_price: float,
        min_volume: int,
        min_expansion_score: float,
        min_atr_mult: float,
        min_rvol: float,
        min_body_pct: float,
        min_close_position_pct: float,
        structure_lookback: int,
        expansion_lookback_bars: int,
    ) -> Optional[Dict[str, Any]]:
        best: Optional[Dict[str, Any]] = None
        start_index = max(20, len(bars) - max(1, expansion_lookback_bars))

        for i in range(start_index, len(bars)):
            bar = bars[i]
            prior = bars[max(0, i - 30):i]
            if len(prior) < 14:
                continue

            close = safe_float(bar["close"])
            open_price = safe_float(bar["open"])
            high = safe_float(bar["high"])
            low = safe_float(bar["low"])
            volume = safe_float(bar["volume"])
            if close < min_price or (max_price > 0 and close > max_price):
                continue
            if volume < min_volume:
                continue
            if close <= open_price:
                continue

            rng = candle_range(bar)
            body = candle_body(bar)
            if rng <= 0 or body <= 0:
                continue

            atr = calc_atr(prior, 14)
            avg_volume = average([safe_float(item["volume"]) for item in prior[-20:]])
            atr_mult = rng / atr if atr > 0 else 0.0
            rvol = volume / avg_volume if avg_volume > 0 else 0.0
            body_pct = body / rng if rng > 0 else 0.0
            close_position_pct = (close - low) / rng if rng > 0 else 0.0
            prior_high = max(safe_float(item["high"]) for item in prior[-max(2, structure_lookback):])
            structure_break = high > prior_high and close >= prior_high * 0.998

            if atr_mult < min_atr_mult:
                continue
            if rvol < min_rvol:
                continue
            if body_pct < min_body_pct:
                continue
            if close_position_pct < min_close_position_pct:
                continue

            score = 0.0
            score += min((atr_mult - 1.0) * 28.0, 28.0)
            score += min((rvol - 1.0) * 18.0, 22.0)
            score += min(body_pct * 26.0, 22.0)
            score += min(close_position_pct * 18.0, 16.0)
            if structure_break:
                score += 12.0
            score = round(max(0.0, min(100.0, score)), 2)

            if score < min_expansion_score:
                continue

            item = {
                "expansion_time": int(bar["time"]),
                "expansion_time_label": ms_to_et_label(int(bar["time"])),
                "expansion_high": round(high, 4),
                "expansion_low": round(low, 4),
                "expansion_mid": round((high + low) / 2.0, 4),
                "expansion_close": round(close, 4),
                "expansion_score": score,
                "atr_mult": round(atr_mult, 2),
                "rvol": round(rvol, 2),
                "body_pct": round(body_pct, 2),
                "close_position_pct": round(close_position_pct, 2),
                "structure_break": structure_break,
            }
            if best is None or score > safe_float(best.get("expansion_score")):
                best = item

        return best

    def _classify_sweep_state(self, memory: Dict[str, Any], bars: List[Dict[str, float]]) -> Dict[str, Any]:
        expansion_time = int(safe_float(memory.get("expansion_time")))
        expansion_high = safe_float(memory.get("expansion_high"))
        expansion_low = safe_float(memory.get("expansion_low"))
        expansion_mid = safe_float(memory.get("expansion_mid")) or ((expansion_high + expansion_low) / 2.0)
        expansion_score = safe_float(memory.get("expansion_score"))

        after = [b for b in bars if int(b["time"]) > expansion_time]
        last = bars[-1] if bars else None
        last_price = round(safe_float(last.get("close") if last else memory.get("expansion_close")), 4)
        notes: List[str] = []

        if not after:
            return {
                "setup_state": "EXPANSION",
                "phase": "WATCH",
                "last_price": last_price,
                "runner_score": round(expansion_score, 2),
                "sweep_score": 0.0,
                "notes": ["remembered 1H expansion; waiting for lower-timeframe pullback"],
                "bars_since_expansion": 0,
                "bars_since_sweep": None,
            }

        # Pullback anchor: lowest low after the expansion while price holds above the expansion midpoint.
        protected_after = [b for b in after if safe_float(b["low"]) >= expansion_mid * 0.985]
        search = protected_after or after
        pullback_bar = min(search, key=lambda b: safe_float(b["low"]))
        pullback_low = safe_float(pullback_bar["low"])
        pullback_high = safe_float(pullback_bar["high"])
        pullback_index = after.index(pullback_bar) if pullback_bar in after else 0

        post_pullback = after[pullback_index + 1:]
        setup_state = "PULLBACK_BUILDING"
        phase = "WATCH"
        sweep_low: Optional[float] = None
        sweep_depth_pct: Optional[float] = None
        reclaim_close: Optional[float] = None
        bars_since_sweep: Optional[int] = None
        sweep_score = 0.0

        if pullback_low > 0:
            retrace_pct = pct_change(expansion_high, pullback_low)
            notes.append(f"pullback low {pullback_low:.4f}")
            if pullback_low >= expansion_mid:
                notes.append("holding expansion midpoint")
                sweep_score += 8
            elif pullback_low >= expansion_low:
                notes.append("deep pullback but still above expansion low")
                sweep_score += 3
            else:
                notes.append("below expansion low - weaker")
                sweep_score -= 12
            if retrace_pct > 0:
                notes.append(f"pullback range {retrace_pct:.1f}% from 1H high")

        sweep_candidates: List[Tuple[int, Dict[str, float]]] = []
        for j, bar in enumerate(post_pullback):
            low = safe_float(bar["low"])
            close = safe_float(bar["close"])
            if pullback_low > 0 and low < pullback_low and close > pullback_low:
                sweep_candidates.append((j, bar))

        if not post_pullback:
            setup_state = "SWEEP_READY"
            phase = "READY"
            notes.append("pullback formed; waiting for sweep below pullback low")
            sweep_score += 10
        elif sweep_candidates:
            sweep_local_index, sweep_bar = sweep_candidates[-1]
            sweep_low = safe_float(sweep_bar["low"])
            reclaim_close = safe_float(sweep_bar["close"])
            bars_since_sweep = len(post_pullback) - 1 - sweep_local_index
            sweep_depth_pct = abs(pct_change(sweep_low, pullback_low)) if pullback_low > 0 else 0.0
            low_wick_pct = lower_wick(sweep_bar) / max(candle_range(sweep_bar), 0.000001)

            setup_state = "SWEEP_TRIGGERED"
            phase = "PREALERT"
            notes.append("swept pullback low and reclaimed")
            sweep_score += 30
            sweep_score += min(sweep_depth_pct * 18.0, 14.0)
            sweep_score += min(low_wick_pct * 18.0, 12.0)

            current = after[-1]
            if safe_float(current["close"]) > pullback_high:
                setup_state = "CONTINUATION_ACTIVE"
                phase = "CONFIRMED"
                notes.append("continuation above pullback high")
                sweep_score += 28
            elif safe_float(current["close"]) > safe_float(sweep_bar["high"]):
                setup_state = "RECLAIM_CONFIRMED"
                phase = "CONFIRMED"
                notes.append("reclaim confirmed above sweep candle high")
                sweep_score += 20
            elif bars_since_sweep is not None and bars_since_sweep <= 2:
                setup_state = "SWEEP_TRIGGERED"
                phase = "PREALERT"
                notes.append("fresh sweep; watch for reclaim candle")
                sweep_score += 8
        else:
            latest = after[-1]
            if safe_float(latest["low"]) <= pullback_low * 1.002 and safe_float(latest["close"]) >= pullback_low:
                setup_state = "SWEEP_READY"
                phase = "READY"
                notes.append("near pullback-low sweep level")
                sweep_score += 18
            else:
                notes.append("waiting for pullback low sweep")
                sweep_score += 5

        runner_score = round(max(0.0, min(100.0, expansion_score * 0.55 + sweep_score * 0.45)), 2)
        return {
            "setup_state": setup_state,
            "phase": phase,
            "last_price": last_price,
            "runner_score": runner_score,
            "sweep_score": round(max(0.0, min(100.0, sweep_score)), 2),
            "pullback_low": round(pullback_low, 4) if pullback_low > 0 else None,
            "pullback_high": round(pullback_high, 4) if pullback_high > 0 else None,
            "sweep_low": round(sweep_low, 4) if sweep_low is not None else None,
            "sweep_depth_pct": round(sweep_depth_pct, 2) if sweep_depth_pct is not None else None,
            "reclaim_close": round(reclaim_close, 4) if reclaim_close is not None else None,
            "bars_since_expansion": len(after),
            "bars_since_sweep": bars_since_sweep,
            "notes": notes,
        }
