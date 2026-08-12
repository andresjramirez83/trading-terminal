from __future__ import annotations

import asyncio
import json
import math
import os
import statistics
import time as time_module
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from app.scanners.base import ScannerBase
from app.services.market_data_provider import MarketDataProvider
from app.services.scanner_snapshot_store import ScannerSnapshotStore

ET = ZoneInfo("America/New_York")

STD_LENGTH = 20
MULTIPLIER = 3.0
PROJECTION_CONTRACTION_BARS = 3
PROJECTION_MAX_BARS = 36
MIN_BODY_PCT = 3.0
MIN_RANGE_PCT = 4.0
MIN_VOLUME = 50_000.0
MIN_CLOSE_LOCATION = 0.65
A_PLUS_MAX_DISTANCE_PCT = 10.0
A_MAX_DISTANCE_PCT = 15.0
WARMUP_CALENDAR_DAYS = 30
MAX_NATIVE_5M_BARS = 5000
TRACKED_MAX_AGE_DAYS = 14
COMPLETED_KEEP_DAYS = 1


def _state_path() -> Path:
    raw = os.getenv("VWAP3_SCANNER_STATE_PATH", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return Path(__file__).resolve().parents[1] / "data" / "scanner_state" / "vwap3_target.json"


def _safe_float(value: Any) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else 0.0
    except Exception:
        return 0.0


def _pct(value: float, base: float) -> float:
    if base <= 0:
        return 0.0
    return (value / base - 1.0) * 100.0


def _close_location(row: Dict[str, Any]) -> float:
    high = _safe_float(row.get("high"))
    low = _safe_float(row.get("low"))
    close = _safe_float(row.get("close"))
    span = high - low
    if span <= 0:
        return 0.5
    return max(0.0, min(1.0, (close - low) / span))


def _typical_price(row: Dict[str, Any]) -> float:
    return (
        _safe_float(row.get("high"))
        + _safe_float(row.get("low"))
        + _safe_float(row.get("close"))
    ) / 3.0


def _qualifies_displacement(row: Dict[str, Any]) -> bool:
    open_price = _safe_float(row.get("open"))
    close = _safe_float(row.get("close"))
    high = _safe_float(row.get("high"))
    low = _safe_float(row.get("low"))
    volume = _safe_float(row.get("volume"))

    if open_price <= 0 or close <= open_price or low <= 0:
        return False
    if _pct(close, open_price) < MIN_BODY_PCT:
        return False
    if _pct(high, low) < MIN_RANGE_PCT:
        return False
    if volume < MIN_VOLUME:
        return False
    if _close_location(row) < MIN_CLOSE_LOCATION:
        return False
    return True


def _rolling_std(values: List[float], end_idx: int, length: int) -> Optional[float]:
    if length <= 1 or end_idx + 1 < length:
        return None
    window = values[end_idx - length + 1 : end_idx + 1]
    if len(window) < length:
        return None
    return float(statistics.pstdev(window))


def _continuous_vwap(rows: List[Dict[str, Any]]) -> List[float]:
    cumulative_volume = 0.0
    cumulative_pv = 0.0
    values: List[float] = []

    for row in rows:
        volume = max(0.0, _safe_float(row.get("volume")))
        typical = _typical_price(row)
        cumulative_volume += volume
        cumulative_pv += typical * volume
        values.append(
            cumulative_pv / cumulative_volume
            if cumulative_volume > 0
            else typical
        )

    return values


def _normalize_bar(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        ts = int(raw.get("time", raw.get("t", 0)) or 0)
    except Exception:
        return None

    if 0 < ts < 10_000_000_000:
        ts *= 1000
    if ts <= 0:
        return None

    open_price = _safe_float(raw.get("open", raw.get("o")))
    high = _safe_float(raw.get("high", raw.get("h")))
    low = _safe_float(raw.get("low", raw.get("l")))
    close = _safe_float(raw.get("close", raw.get("c")))
    volume = _safe_float(raw.get("volume", raw.get("v")))

    if high <= 0 or low <= 0 or close <= 0:
        return None

    dt_et = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc).astimezone(ET)
    hhmm = dt_et.hour * 100 + dt_et.minute

    # The historical validation cache was SIP-only. Keeping 04:00-20:00 ET
    # removes optional BOATS overnight bars and preserves the same loaded-row
    # concept used by validation.
    if not (400 <= hhmm < 2000):
        return None

    return {
        "ts": ts,
        "time": ts,
        "dt_et": dt_et.isoformat(),
        "trade_date": dt_et.date().isoformat(),
        "hhmm": hhmm,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
    }


def _completed_rows(raw_rows: List[Dict[str, Any]], now_et: datetime) -> List[Dict[str, Any]]:
    now_ms = int(now_et.timestamp() * 1000)
    five_minutes_ms = 5 * 60 * 1000
    normalized: Dict[int, Dict[str, Any]] = {}

    for raw in raw_rows or []:
        row = _normalize_bar(raw)
        if row is None:
            continue
        # Only use completed five-minute bars for displacement, freeze, and
        # confirmation decisions.
        if int(row["ts"]) + five_minutes_ms > now_ms:
            continue
        normalized[int(row["ts"])] = row

    return [normalized[key] for key in sorted(normalized)]


def _session_for_now(now_et: datetime) -> Optional[Tuple[str, int, int]]:
    hhmm = now_et.hour * 100 + now_et.minute
    # Five-minute grace after the session boundary lets a window_end freeze be
    # recognized from the final completed 5m candle without scanning for new
    # setups later in RTH/overnight.
    if 400 <= hhmm < 935:
        return ("premarket", 400, 930)
    if 1600 <= hhmm < 2005:
        return ("afterhours", 1600, 2000)
    return None


def _session_indexes(
    rows: List[Dict[str, Any]],
    trade_date: str,
    start_hhmm: int,
    end_hhmm: int,
) -> List[int]:
    return [
        index
        for index, row in enumerate(rows)
        if str(row.get("trade_date")) == trade_date
        and start_hhmm <= int(row.get("hhmm") or -1) < end_hhmm
    ]


def _find_projection(
    rows: List[Dict[str, Any]],
    tps: List[float],
    vwaps: List[float],
    event_idx: int,
    session_end_idx: int,
    *,
    session_has_ended: bool,
) -> Optional[Dict[str, Any]]:
    stop_idx = min(session_end_idx, event_idx + PROJECTION_MAX_BARS - 1)
    peak_idx: Optional[int] = None
    peak_target = -math.inf
    peak_vwap = 0.0
    peak_std = 0.0
    previous_target: Optional[float] = None
    consecutive_lower = 0
    last_examined_idx: Optional[int] = None
    freeze_idx: Optional[int] = None
    freeze_reason: Optional[str] = None

    for idx in range(event_idx, stop_idx + 1):
        deviation = _rolling_std(tps, idx, STD_LENGTH)
        if deviation is None:
            continue

        target = vwaps[idx] + MULTIPLIER * deviation
        last_examined_idx = idx

        if target > peak_target:
            peak_target = target
            peak_idx = idx
            peak_vwap = vwaps[idx]
            peak_std = deviation

        if previous_target is not None and target < previous_target:
            consecutive_lower += 1
        else:
            consecutive_lower = 0
        previous_target = target

        if (
            peak_idx is not None
            and idx > peak_idx
            and consecutive_lower >= PROJECTION_CONTRACTION_BARS
        ):
            freeze_idx = idx
            freeze_reason = "3_contractions"
            break

    if peak_idx is None or last_examined_idx is None or not math.isfinite(peak_target):
        return None

    reached_max_window = last_examined_idx >= event_idx + PROJECTION_MAX_BARS - 1
    if freeze_idx is None:
        if session_has_ended or reached_max_window:
            freeze_idx = last_examined_idx
            freeze_reason = "window_end"
        else:
            # The projection is still expanding live. Do not freeze early.
            return None

    max_high_before_freeze = max(
        _safe_float(rows[idx].get("high"))
        for idx in range(event_idx, freeze_idx + 1)
    )

    return {
        "peak_idx": peak_idx,
        "freeze_idx": freeze_idx,
        "target": peak_target,
        "peak_vwap": peak_vwap,
        "peak_std": peak_std,
        "freeze_reason": freeze_reason,
        "bars_to_freeze": freeze_idx - event_idx,
        "max_high_before_freeze": max_high_before_freeze,
        "already_reached_before_freeze": max_high_before_freeze >= peak_target,
    }


def _first_index_at_or_after(rows: List[Dict[str, Any]], iso_time: str) -> Optional[int]:
    try:
        target_ms = int(datetime.fromisoformat(iso_time).timestamp() * 1000)
    except Exception:
        return None

    for index, row in enumerate(rows):
        if int(row.get("ts") or 0) >= target_ms:
            return index
    return None


def _status_from_rows(rows: List[Dict[str, Any]], record: Dict[str, Any]) -> Dict[str, Any]:
    freeze_idx = _first_index_at_or_after(rows, str(record.get("freeze_time") or ""))
    if freeze_idx is None:
        return record

    target = _safe_float(record.get("target_price"))
    displacement_close = _safe_float(record.get("displacement_close"))
    displacement_high = _safe_float(record.get("displacement_high"))

    confirmation_time: Optional[str] = None
    strong_confirmation_time: Optional[str] = None
    target_hit_time: Optional[str] = None

    for idx in range(freeze_idx, len(rows)):
        row = rows[idx]
        close = _safe_float(row.get("close"))
        high = _safe_float(row.get("high"))

        if confirmation_time is None and close > displacement_close:
            confirmation_time = str(row.get("dt_et") or "") or None
        if strong_confirmation_time is None and close > displacement_high:
            strong_confirmation_time = str(row.get("dt_et") or "") or None

        # Target was not allowed to count until after the freeze confirmation.
        if idx > freeze_idx and target_hit_time is None and high >= target:
            target_hit_time = str(row.get("dt_et") or "") or None
            break

    if target_hit_time:
        status = "TARGET HIT"
    elif strong_confirmation_time:
        status = "STRONG CONFIRMED"
    elif confirmation_time:
        status = "CONFIRMED"
    else:
        status = "WAITING"

    record.update(
        {
            "confirmation_status": status,
            "setup_stage": status,
            "confirmation_time": confirmation_time,
            "strong_confirmation_time": strong_confirmation_time,
            "target_hit_time": target_hit_time,
            "confirmed": bool(confirmation_time),
            "strong_confirmed": bool(strong_confirmation_time),
            "target_hit": bool(target_hit_time),
        }
    )
    return record


class VWAP3TargetScanner(ScannerBase):
    id = "vwap3_target"
    name = "VWAP +3 Target"
    description = (
        "Live Top-20 displacement scanner using the validated continuous VWAP + 20-bar STD projection. "
        "A+ target distance is under 10%; A is 10-15%."
    )

    def __init__(self) -> None:
        self._tracked: Dict[str, Dict[str, Any]] = {}
        self._bars_cache: Dict[str, Tuple[int, List[Dict[str, Any]]]] = {}
        self._load_state()

    def _load_state(self) -> None:
        path = _state_path()
        try:
            if not path.exists():
                return
            payload = json.loads(path.read_text())
            rows = payload.get("tracked") or []
            if isinstance(rows, list):
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    key = str(row.get("setup_key") or "")
                    if key:
                        self._tracked[key] = dict(row)
        except Exception as exc:
            print(f"[vwap3-target] state load failed: {exc}", flush=True)

    def _save_state(self) -> None:
        path = _state_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "tracked": list(self._tracked.values()),
            }
            path.write_text(json.dumps(payload, indent=2, sort_keys=True))
        except Exception as exc:
            print(f"[vwap3-target] state save failed: {exc}", flush=True)

    def _cleanup_state(self, now_et: datetime) -> None:
        remove: List[str] = []
        for key, row in self._tracked.items():
            raw = str(row.get("freeze_time") or "")
            try:
                freeze_dt = datetime.fromisoformat(raw).astimezone(ET)
            except Exception:
                remove.append(key)
                continue

            age = now_et - freeze_dt
            max_days = COMPLETED_KEEP_DAYS if row.get("target_hit") else TRACKED_MAX_AGE_DAYS
            if age > timedelta(days=max_days):
                remove.append(key)

        for key in remove:
            self._tracked.pop(key, None)

    async def _load_native_5m(
        self,
        market: MarketDataProvider,
        symbol: str,
        now_et: datetime,
    ) -> List[Dict[str, Any]]:
        # The strategy only changes on a completed 5-minute bar. Reuse the full
        # warmup history until a new five-minute bucket begins.
        bucket = int(now_et.timestamp() // 300)
        cached = self._bars_cache.get(symbol)
        if cached is not None and cached[0] == bucket:
            return [dict(row) for row in cached[1]]

        now_utc = now_et.astimezone(timezone.utc)
        start = now_utc - timedelta(days=WARMUP_CALENDAR_DAYS)
        raw_rows: List[Dict[str, Any]] = []

        native_loader = getattr(market, "_historical_bars", None)
        feed = getattr(market, "feed", None)

        if callable(native_loader) and feed:
            raw_rows = await native_loader(
                symbol=symbol,
                timeframe="5Min",
                start=start,
                end=now_utc,
                feed=feed,
                adjustment="all",
            )
        else:
            raw_rows = await market.get_bars(
                symbol,
                timeframe="5m",
                session="extended",
                lookback=f"{WARMUP_CALENDAR_DAYS}d",
                limit=MAX_NATIVE_5M_BARS,
            )

        rows = _completed_rows(raw_rows, now_et)
        if len(rows) > MAX_NATIVE_5M_BARS:
            rows = rows[-MAX_NATIVE_5M_BARS:]

        self._bars_cache[symbol] = (bucket, [dict(row) for row in rows])
        return rows

    def _analyze_candidate(
        self,
        symbol: str,
        rows: List[Dict[str, Any]],
        *,
        pool: str,
        trade_date: str,
        live_rank: int,
        change_pct: float,
        last_price: float,
        now_et: datetime,
        session_start: int,
        session_end: int,
    ) -> Optional[Dict[str, Any]]:
        indexes = _session_indexes(rows, trade_date, session_start, session_end)
        if not indexes:
            return None

        tps = [_typical_price(row) for row in rows]
        vwaps = _continuous_vwap(rows)

        event_idx: Optional[int] = None
        for idx in indexes:
            if not _qualifies_displacement(rows[idx]):
                continue
            if _rolling_std(tps, idx, STD_LENGTH) is None:
                continue
            event_idx = idx
            break

        if event_idx is None:
            return None

        last_session_idx = indexes[-1]
        hhmm_now = now_et.hour * 100 + now_et.minute
        session_has_ended = hhmm_now >= session_end or str(now_et.date()) > trade_date

        projection = _find_projection(
            rows,
            tps,
            vwaps,
            event_idx,
            last_session_idx,
            session_has_ended=session_has_ended,
        )
        if projection is None or projection["already_reached_before_freeze"]:
            return None

        freeze_idx = int(projection["freeze_idx"])
        event = rows[event_idx]
        freeze = rows[freeze_idx]
        target = float(projection["target"])
        freeze_close = _safe_float(freeze.get("close"))
        if freeze_close <= 0:
            return None

        target_distance_pct = _pct(target, freeze_close)
        if target_distance_pct < 0 or target_distance_pct >= A_MAX_DISTANCE_PCT:
            return None

        grade = "A+" if target_distance_pct < A_PLUS_MAX_DISTANCE_PCT else "A"
        displacement_open = _safe_float(event.get("open"))
        displacement_close = _safe_float(event.get("close"))
        displacement_high = _safe_float(event.get("high"))
        displacement_low = _safe_float(event.get("low"))
        displacement_pct = _pct(displacement_close, displacement_open)
        freeze_time = str(freeze.get("dt_et") or "")
        setup_key = f"{symbol}|{pool}|{freeze_time}"

        row: Dict[str, Any] = {
            "setup_key": setup_key,
            "symbol": symbol,
            "scanner_id": self.id,
            "runner_type": "vwap3",
            "source": "vwap3_target",
            "direction": "bullish",
            "grade": grade,
            "live_rank": live_rank,
            "rank_at_freeze": live_rank,
            "rank_source": "alpaca_live_movers",
            "session": "PM" if pool == "premarket" else "AH",
            "pool": pool,
            "trade_date": trade_date,
            "last_price": round(last_price or _safe_float(rows[-1].get("close")), 6),
            "price": round(last_price or _safe_float(rows[-1].get("close")), 6),
            "change_pct": round(change_pct, 3),
            "pm_gap_pct": round(change_pct, 3),
            "freeze_price": round(freeze_close, 6),
            "target_price": round(target, 6),
            "frozen_target": round(target, 6),
            "target_distance_pct": round(target_distance_pct, 3),
            "displacement_pct": round(displacement_pct, 3),
            "displacement_open": round(displacement_open, 6),
            "displacement_high": round(displacement_high, 6),
            "displacement_low": round(displacement_low, 6),
            "displacement_close": round(displacement_close, 6),
            "displacement_volume": int(_safe_float(event.get("volume"))),
            "displacement_time": event.get("dt_et"),
            "freeze_time": freeze_time,
            "projection_peak_time": rows[int(projection["peak_idx"])].get("dt_et"),
            "freeze_reason": projection.get("freeze_reason"),
            "bars_to_freeze": int(projection.get("bars_to_freeze") or 0),
            "score": 92 if grade == "A+" else 78,
            "runner_score": 92 if grade == "A+" else 78,
            "notes": [
                f"Target ${target:.4f}" if target < 1 else f"Target ${target:.2f}",
                f"Target distance {target_distance_pct:.2f}%",
            ],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        return _status_from_rows(rows, row)

    async def run(
        self,
        market: MarketDataProvider,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        del snapshot_store  # This scanner keeps its own tiny persistent signal state.
        started = time_module.perf_counter()
        now_et = datetime.now(ET)
        self._cleanup_state(now_et)

        movers = await market.get_snapshot_gainers(limit=50)
        top20: List[Dict[str, Any]] = []
        seen = set()
        for raw in movers or []:
            symbol = str(raw.get("symbol") or raw.get("ticker") or "").upper().strip()
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            top20.append(dict(raw))
            if len(top20) >= 20:
                break

        rank_map = {
            str(row.get("symbol") or row.get("ticker") or "").upper().strip(): index + 1
            for index, row in enumerate(top20)
        }

        session = _session_for_now(now_et)
        scan_errors: List[Dict[str, str]] = []
        newly_qualified = 0

        if session is not None and top20:
            pool, session_start, session_end = session
            trade_date = now_et.date().isoformat()
            semaphore = asyncio.Semaphore(5)

            async def inspect(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
                symbol = str(raw.get("symbol") or raw.get("ticker") or "").upper().strip()
                if not symbol:
                    return None
                async with semaphore:
                    try:
                        rows = await self._load_native_5m(market, symbol, now_et)
                        return self._analyze_candidate(
                            symbol,
                            rows,
                            pool=pool,
                            trade_date=trade_date,
                            live_rank=rank_map.get(symbol, 999),
                            change_pct=_safe_float(
                                raw.get("percent_change", raw.get("todaysChangePerc"))
                            ),
                            last_price=_safe_float(
                                raw.get("price", (raw.get("lastTrade") or {}).get("p"))
                            ),
                            now_et=now_et,
                            session_start=session_start,
                            session_end=session_end,
                        )
                    except Exception as exc:
                        scan_errors.append({"symbol": symbol, "error": str(exc)})
                        return None

            candidates = await asyncio.gather(*(inspect(row) for row in top20))
            for candidate in candidates:
                if candidate is None:
                    continue
                key = str(candidate.get("setup_key") or "")
                if not key:
                    continue
                existing = self._tracked.get(key)
                if existing is None:
                    newly_qualified += 1
                else:
                    # Rank@Freeze is historical context. Once captured, never
                    # rewrite it with a later scan's live rank.
                    candidate["rank_at_freeze"] = existing.get(
                        "rank_at_freeze", candidate.get("rank_at_freeze")
                    )
                    candidate["created_at"] = existing.get(
                        "created_at", candidate.get("created_at")
                    )
                self._tracked[key] = candidate

        # Refresh existing signals even when they have left the live Top-20 or
        # the market has moved into RTH. This prevents a valid signal from
        # disappearing before its target/confirmation resolves.
        tracked_symbols = sorted(
            {
                str(row.get("symbol") or "").upper().strip()
                for row in self._tracked.values()
                if row.get("symbol")
            }
        )
        tracked_rows_by_symbol: Dict[str, List[Dict[str, Any]]] = {}
        if tracked_symbols:
            semaphore = asyncio.Semaphore(5)

            async def refresh_symbol(symbol: str) -> None:
                async with semaphore:
                    try:
                        tracked_rows_by_symbol[symbol] = await self._load_native_5m(
                            market, symbol, now_et
                        )
                    except Exception as exc:
                        scan_errors.append({"symbol": symbol, "error": str(exc)})

            await asyncio.gather(*(refresh_symbol(symbol) for symbol in tracked_symbols))

        for key, row in list(self._tracked.items()):
            symbol = str(row.get("symbol") or "").upper().strip()
            rows = tracked_rows_by_symbol.get(symbol)
            if rows:
                _status_from_rows(rows, row)
                row["last_price"] = round(_safe_float(rows[-1].get("close")), 6)
                row["price"] = row["last_price"]

            current_rank = rank_map.get(symbol)
            row["live_rank"] = current_rank
            row["is_live_top20_now"] = current_rank is not None
            base_score = 92 if row.get("grade") == "A+" else 78
            if row.get("confirmation_status") == "CONFIRMED":
                base_score += 3
            elif row.get("confirmation_status") == "STRONG CONFIRMED":
                base_score += 6
            elif row.get("confirmation_status") == "TARGET HIT":
                base_score = 100
            row["score"] = min(100, base_score)
            row["runner_score"] = row["score"]
            self._tracked[key] = row

        self._cleanup_state(now_et)
        self._save_state()

        rows = list(self._tracked.values())
        status_order = {
            "STRONG CONFIRMED": 0,
            "CONFIRMED": 1,
            "WAITING": 2,
            "TARGET HIT": 3,
        }
        rows.sort(
            key=lambda row: (
                0 if row.get("grade") == "A+" else 1,
                status_order.get(str(row.get("confirmation_status") or ""), 9),
                _safe_float(row.get("target_distance_pct")),
                int(row.get("rank_at_freeze") or 999),
            )
        )

        max_rows = max(20, min(100, int(kwargs.get("max_symbols", 25) or 25)))
        rows = rows[:max_rows]
        elapsed_ms = round((time_module.perf_counter() - started) * 1000.0, 1)

        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "live",
            "trade_day": now_et.date().isoformat(),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "live_top20_count": len(top20),
                "newly_qualified": newly_qualified,
                "tracked_count": len(self._tracked),
                "scan_errors": scan_errors[:10],
                "elapsed_ms": elapsed_ms,
                "strategy": {
                    "timeframe": "5m",
                    "std_length": STD_LENGTH,
                    "multiplier": MULTIPLIER,
                    "vwap_mode": "continuous",
                    "warmup_calendar_days": WARMUP_CALENDAR_DAYS,
                    "projection_contraction_bars": PROJECTION_CONTRACTION_BARS,
                    "projection_max_bars": PROJECTION_MAX_BARS,
                    "a_plus_target_distance_lt_pct": A_PLUS_MAX_DISTANCE_PCT,
                    "a_target_distance_range_pct": [
                        A_PLUS_MAX_DISTANCE_PCT,
                        A_MAX_DISTANCE_PCT,
                    ],
                    "confirmation": "5m close above displacement close/body",
                    "strong_confirmation": "5m close above displacement high/wick",
                },
                "ranking_source": "Alpaca live movers Top-20 at scan/freeze detection",
            },
        }


__all__ = ["VWAP3TargetScanner"]
