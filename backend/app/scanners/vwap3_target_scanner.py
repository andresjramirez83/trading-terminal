from __future__ import annotations

import asyncio
import json
import math
import os
import statistics
import time as time_module
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests

from app.scanners.base import ScannerBase
from app.services.market_data_provider import MarketDataProvider
from app.services.scanner_snapshot_store import ScannerSnapshotStore

ET = ZoneInfo("America/New_York")
PT = ZoneInfo("America/Los_Angeles")

STD_LENGTH = 20
MULTIPLIER = 3.0
MIN_BODY_PCT = 3.0
MIN_RANGE_PCT = 4.0
MIN_VOLUME = 50_000.0
MIN_CLOSE_LOCATION = 0.65
A_PLUS_MAX_DISTANCE_PCT = 10.0
A_MAX_DISTANCE_PCT = 15.0

PM_RUNNER_MIN_DISTANCE_PCT = 20.0
PM_RUNNER_MAX_DISTANCE_PCT = 25.0
PM_RUNNER_MIN_RANGE_PCT = 7.0

PM_EXTREME_MIN_DISTANCE_PCT = 25.0
PM_EXTREME_MAX_DISTANCE_PCT = 30.0
PM_EXTREME_MIN_BODY_PCT = 20.0
PM_EXTREME_MIN_RANGE_PCT = 20.0
PM_EXTREME_T1_PCT = 20.0

WARMUP_CALENDAR_DAYS = 30
MAX_NATIVE_5M_BARS = 5000
TRACKED_MAX_AGE_DAYS = 14
COMPLETED_KEEP_DAYS = 1

# VWAP3 discovery is intentionally broader than the old Top-20-only gate.
# Saved AH runners are especially important because they let the scanner watch
# a symbol before it becomes a top premarket mover.
VWAP3_GAINERS_LIMIT = 50
VWAP3_ACTIVES_LIMIT = 100
VWAP3_LOSERS_LIMIT = 50
VWAP3_MAX_WATCH_SYMBOLS = 300
VWAP3_SCAN_CONCURRENCY = 10
VWAP3_PUSHOVER_MAX_DELAY_MINUTES = 10.0


def _grade_base_score(grade: str) -> int:
    return {
        "A+": 92,
        "A": 78,
        "PM RUNNER": 72,
        "PM EXTREME RUNNER WATCH": 64,
    }.get(str(grade or ""), 60)


def _grade_sort_order(grade: str) -> int:
    return {
        "A+": 0,
        "A": 1,
        "PM RUNNER": 2,
        "PM EXTREME RUNNER WATCH": 3,
    }.get(str(grade or ""), 9)


def _state_path() -> Path:
    raw = os.getenv("VWAP3_SCANNER_STATE_PATH", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return Path(__file__).resolve().parents[1] / "data" / "scanner_state" / "vwap3_target.json"


def _hit_archive_dir() -> Path:
    raw = os.getenv("VWAP3_TARGET_HIT_ARCHIVE_DIR", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return (
        Path(__file__).resolve().parents[1]
        / "data"
        / "scanner_history"
        / "vwap3_target_hits"
    )


def _setup_archive_dir() -> Path:
    """Permanent, unbiased archive of every qualified VWAP3 setup.

    The live state can be pruned aggressively for scanner performance, but the
    coach needs winners, failures, and unresolved/expired setups so its entry
    statistics are not trained only on target hits.
    """
    raw = os.getenv("VWAP3_SETUP_ARCHIVE_DIR", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return (
        Path(__file__).resolve().parents[1]
        / "data"
        / "scanner_history"
        / "vwap3_setups"
    )


def _format_pt_time(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "-"
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(PT)
        return dt.strftime("%-m/%-d %-I:%M %p PT")
    except Exception:
        return raw


def _format_price(value: Any) -> str:
    number = _safe_float(value)
    if number <= 0:
        return "-"
    return f"${number:.4f}" if number < 1 else f"${number:.2f}"


async def _send_pushover_setup_alert(record: Dict[str, Any]) -> Optional[str]:
    user_key = os.getenv("PUSHOVER_USER_KEY", "").strip()
    app_token = os.getenv("PUSHOVER_APP_TOKEN", "").strip()
    if not user_key or not app_token:
        print("[vwap3-pushover] skipped reason=not_configured", flush=True)
        return None

    delay = _safe_float(record.get("detection_delay_minutes"))
    if delay > VWAP3_PUSHOVER_MAX_DELAY_MINUTES:
        print(
            f"[vwap3-pushover] {record.get('symbol')} skipped=stale delay_min={delay:.2f}",
            flush=True,
        )
        return None

    symbol = str(record.get("symbol") or "").upper().strip()
    grade = str(record.get("grade") or "SETUP")
    title = f"VWAP +3 DISPLACEMENT {grade} - {symbol}"
    message = (
        f"{symbol} {grade} displacement detected\n"
        f"Disp {_format_pt_time(record.get('displacement_time'))} | "
        f"Close {_format_price(record.get('displacement_close'))} | "
        f"High {_format_price(record.get('displacement_high'))}\n"
        f"Frozen +3 {_format_price(record.get('frozen_target') or record.get('target_price'))} | "
        f"Dist {_safe_float(record.get('target_distance_pct')):.2f}%\n"
        f"Frozen -3 {_format_price(record.get('lower_3std_price'))} | "
        f"Down {_safe_float(record.get('lower_3std_distance_pct')):.2f}% | "
        f"Band {_safe_float(record.get('std_band_width_pct')):.2f}%\n"
        f"Last {_format_price(record.get('last_price') or record.get('price'))} | "
        f"Rank@Disp {record.get('rank_at_freeze') or '-'}"
    )

    def _post() -> bool:
        response = requests.post(
            "https://api.pushover.net/1/messages.json",
            data={
                "token": app_token,
                "user": user_key,
                "title": title,
                "message": message,
                "priority": 1,
            },
            timeout=8,
        )
        response.raise_for_status()
        return True

    try:
        await asyncio.to_thread(_post)
        sent_at = datetime.now(timezone.utc).isoformat()
        print(
            f"[vwap3-pushover] sent symbol={symbol} grade={grade} delay_min={delay:.2f}",
            flush=True,
        )
        return sent_at
    except Exception as exc:
        print(f"[vwap3-pushover] failed symbol={symbol} error={exc}", flush=True)
        return None


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


def _freeze_target_on_displacement(
    tps: List[float],
    vwaps: List[float],
    event_idx: int,
) -> Optional[Dict[str, float]]:
    """Freeze the +3 STD target on the completed displacement candle itself."""
    deviation = _rolling_std(tps, event_idx, STD_LENGTH)
    if deviation is None:
        return None

    vwap = float(vwaps[event_idx])
    target = vwap + MULTIPLIER * deviation
    lower_target = vwap - MULTIPLIER * deviation
    if not math.isfinite(target) or target <= 0:
        return None
    if not math.isfinite(lower_target):
        lower_target = 0.0

    return {
        "target": float(target),
        "lower_target": float(lower_target),
        "vwap": vwap,
        "std": float(deviation),
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
    freeze_price = _safe_float(record.get("freeze_price"))
    displacement_close = _safe_float(record.get("displacement_close"))
    displacement_high = _safe_float(record.get("displacement_high"))
    displacement_low = _safe_float(record.get("displacement_low"))

    confirmation_time: Optional[str] = None
    strong_confirmation_time: Optional[str] = None
    target_hit_time: Optional[str] = None
    invalidation_time: Optional[str] = None
    min_low_after_freeze: Optional[float] = None
    min_low_before_target: Optional[float] = None
    min_low_before_target_time: Optional[str] = None
    max_high_after_freeze: Optional[float] = None
    bars_to_target: Optional[int] = None

    for idx in range(freeze_idx, len(rows)):
        row = rows[idx]
        close = _safe_float(row.get("close"))
        high = _safe_float(row.get("high"))
        low = _safe_float(row.get("low"))
        row_time = str(row.get("dt_et") or "") or None

        # Entry-study path begins only AFTER the displacement/freeze candle has
        # completed. The scanner cannot offer an entry inside the candle that
        # created the signal, so including that candle's low would introduce
        # hindsight into pullback statistics.
        if idx > freeze_idx and low > 0:
            min_low_after_freeze = low if min_low_after_freeze is None else min(min_low_after_freeze, low)
            if target_hit_time is None and (min_low_before_target is None or low < min_low_before_target):
                min_low_before_target = low
                min_low_before_target_time = row_time
        if idx > freeze_idx and high > 0:
            max_high_after_freeze = high if max_high_after_freeze is None else max(max_high_after_freeze, high)

        if confirmation_time is None and close > displacement_close:
            confirmation_time = row_time
        if strong_confirmation_time is None and close > displacement_high:
            strong_confirmation_time = row_time
        if invalidation_time is None and idx > freeze_idx and displacement_low > 0 and low <= displacement_low:
            invalidation_time = row_time

        # Target was not allowed to count until after the freeze confirmation.
        if idx > freeze_idx and target_hit_time is None and high >= target:
            target_hit_time = row_time
            bars_to_target = idx - freeze_idx
            break

    if target_hit_time:
        status = "TARGET HIT"
    elif strong_confirmation_time:
        status = "STRONG CONFIRMED"
    elif confirmation_time:
        status = "CONFIRMED"
    else:
        status = "WAITING"

    pullback_pct = 0.0
    if freeze_price > 0 and min_low_before_target and min_low_before_target > 0:
        pullback_pct = max(0.0, (freeze_price - min_low_before_target) / freeze_price * 100.0)
    max_drawdown_pct = 0.0
    if freeze_price > 0 and min_low_after_freeze and min_low_after_freeze > 0:
        max_drawdown_pct = max(0.0, (freeze_price - min_low_after_freeze) / freeze_price * 100.0)
    max_runup_pct = 0.0
    if freeze_price > 0 and max_high_after_freeze and max_high_after_freeze > 0:
        max_runup_pct = max(0.0, (max_high_after_freeze - freeze_price) / freeze_price * 100.0)

    minutes_to_target: Optional[float] = None
    if target_hit_time:
        try:
            freeze_dt = datetime.fromisoformat(str(record.get("freeze_time"))).astimezone(ET)
            hit_dt = datetime.fromisoformat(target_hit_time).astimezone(ET)
            minutes_to_target = round(max(0.0, (hit_dt - freeze_dt).total_seconds() / 60.0), 2)
        except Exception:
            minutes_to_target = None

    if target_hit_time:
        outcome = "target_hit"
    elif invalidation_time:
        outcome = "invalidated"
    else:
        try:
            freeze_dt = datetime.fromisoformat(str(record.get("freeze_time"))).astimezone(ET)
            outcome = "expired" if datetime.now(ET).date() > freeze_dt.date() else "active"
        except Exception:
            outcome = "active"

    record.update(
        {
            "confirmation_status": status,
            "setup_stage": status,
            "confirmation_time": confirmation_time,
            "strong_confirmation_time": strong_confirmation_time,
            "target_hit_time": target_hit_time,
            "invalidation_time": invalidation_time,
            "outcome": outcome,
            "confirmed": bool(confirmation_time),
            "strong_confirmed": bool(strong_confirmation_time),
            "target_hit": bool(target_hit_time),
            "min_low_after_freeze": round(min_low_after_freeze, 6) if min_low_after_freeze else None,
            "min_low_before_target": round(min_low_before_target, 6) if min_low_before_target else None,
            "min_low_before_target_time": min_low_before_target_time,
            "max_high_after_freeze": round(max_high_after_freeze, 6) if max_high_after_freeze else None,
            "pullback_before_target_pct": round(pullback_pct, 3),
            "max_drawdown_from_freeze_pct": round(max_drawdown_pct, 3),
            "max_runup_from_freeze_pct": round(max_runup_pct, 3),
            "bars_to_target": bars_to_target,
            "minutes_to_target": minutes_to_target,
        }
    )
    return record


class VWAP3TargetScanner(ScannerBase):
    id = "vwap3_target"
    name = "VWAP +3 Target"
    description = (
        "Persistent hot-universe displacement scanner using continuous VWAP + 20-bar STD. "
        "The +3 STD target is frozen on the completed displacement candle and alerted immediately. "
        "The matching -3 STD level from that same candle is frozen as a downside reference/range, not an execution stop. "
        "Watches saved AH runners plus live gainers/actives/losers and pins symbols after displacement. "
        "A+ is under 10%; A is 10-15%; validated premarket Runner classes are tracked separately."
    )

    def __init__(self) -> None:
        self._tracked: Dict[str, Dict[str, Any]] = {}
        self._watch_pool: Dict[str, Dict[str, Any]] = {}
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

            watch_pool = payload.get("watch_pool") or []
            if isinstance(watch_pool, dict):
                watch_pool = list(watch_pool.values())
            if isinstance(watch_pool, list):
                for row in watch_pool:
                    if not isinstance(row, dict):
                        continue
                    symbol = str(row.get("symbol") or "").upper().strip()
                    if symbol:
                        self._watch_pool[symbol] = dict(row)
        except Exception as exc:
            print(f"[vwap3-target] state load failed: {exc}", flush=True)

    def _save_state(self) -> None:
        path = _state_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "tracked": list(self._tracked.values()),
                "watch_pool": list(self._watch_pool.values()),
            }
            path.write_text(json.dumps(payload, indent=2, sort_keys=True))
        except Exception as exc:
            print(f"[vwap3-target] state save failed: {exc}", flush=True)

    def _archive_target_hits(self) -> None:
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for row in self._tracked.values():
            if not row.get("target_hit"):
                continue
            trade_date = str(row.get("trade_date") or "").strip()
            setup_key = str(row.get("setup_key") or "").strip()
            if not trade_date or not setup_key:
                continue
            groups.setdefault(trade_date, []).append(dict(row))

        archive_dir = _hit_archive_dir()
        for trade_date, rows in groups.items():
            path = archive_dir / f"{trade_date}.json"
            merged: Dict[str, Dict[str, Any]] = {}
            try:
                if path.exists():
                    existing = json.loads(path.read_text())
                    for old in existing.get("rows") or []:
                        if isinstance(old, dict):
                            key = str(old.get("setup_key") or "")
                            if key:
                                merged[key] = dict(old)
            except Exception as exc:
                print(
                    f"[vwap3-hit-archive] existing load failed date={trade_date} error={exc}",
                    flush=True,
                )

            for row in rows:
                key = str(row.get("setup_key") or "")
                if key:
                    merged[key] = row

            archived_rows = list(merged.values())
            archived_rows.sort(
                key=lambda row: str(row.get("target_hit_time") or row.get("freeze_time") or "")
            )
            try:
                archive_dir.mkdir(parents=True, exist_ok=True)
                payload = {
                    "scanner_id": self.id,
                    "trade_date": trade_date,
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                    "count": len(archived_rows),
                    "rows": archived_rows,
                }
                path.write_text(json.dumps(payload, indent=2, sort_keys=True))
            except Exception as exc:
                print(
                    f"[vwap3-hit-archive] save failed date={trade_date} error={exc}",
                    flush=True,
                )

    def _archive_all_setups(self) -> None:
        """Persist every qualified setup, not only winners.

        Records are upserted by setup_key on every scanner cycle so outcome and
        post-freeze path statistics continue to improve as more bars arrive.
        """
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for row in self._tracked.values():
            trade_date = str(row.get("trade_date") or "").strip()
            setup_key = str(row.get("setup_key") or "").strip()
            if trade_date and setup_key:
                groups.setdefault(trade_date, []).append(dict(row))

        archive_dir = _setup_archive_dir()
        for trade_date, rows in groups.items():
            path = archive_dir / f"{trade_date}.json"
            merged: Dict[str, Dict[str, Any]] = {}
            try:
                if path.exists():
                    existing = json.loads(path.read_text())
                    for old in existing.get("rows") or []:
                        if isinstance(old, dict):
                            key = str(old.get("setup_key") or "")
                            if key:
                                merged[key] = dict(old)
            except Exception as exc:
                print(f"[vwap3-setup-archive] existing load failed date={trade_date} error={exc}", flush=True)

            for row in rows:
                key = str(row.get("setup_key") or "")
                if key:
                    merged[key] = row

            archived_rows = sorted(merged.values(), key=lambda row: str(row.get("freeze_time") or ""))
            try:
                archive_dir.mkdir(parents=True, exist_ok=True)
                payload = {
                    "scanner_id": self.id,
                    "trade_date": trade_date,
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                    "count": len(archived_rows),
                    "rows": archived_rows,
                }
                path.write_text(json.dumps(payload, indent=2, sort_keys=True))
            except Exception as exc:
                print(f"[vwap3-setup-archive] save failed date={trade_date} error={exc}", flush=True)

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

        # A pin is a same-trading-day monitoring aid, not a permanent watchlist.
        trade_date = now_et.date().isoformat()
        self._watch_pool = {
            symbol: row
            for symbol, row in self._watch_pool.items()
            if str(row.get("trade_date") or "") == trade_date
        }

    @staticmethod
    def _row_symbol(row: Dict[str, Any]) -> str:
        return str(row.get("symbol") or row.get("ticker") or "").upper().strip()

    @staticmethod
    def _snapshot_price(row: Dict[str, Any]) -> float:
        return _safe_float(
            row.get("price", (row.get("lastTrade") or {}).get("p"))
        )

    @staticmethod
    def _snapshot_change_pct(row: Dict[str, Any]) -> float:
        return _safe_float(row.get("percent_change", row.get("todaysChangePerc")))

    @staticmethod
    def _session_has_displacement(
        rows: List[Dict[str, Any]],
        trade_date: str,
        session_start: int,
        session_end: int,
    ) -> Optional[str]:
        indexes = _session_indexes(rows, trade_date, session_start, session_end)
        for idx in reversed(indexes):
            if _qualifies_displacement(rows[idx]):
                return str(rows[idx].get("dt_et") or "")
        return None

    async def _build_watch_universe(
        self,
        market: MarketDataProvider,
        snapshot_store: ScannerSnapshotStore,
        now_et: datetime,
    ) -> Tuple[List[Dict[str, Any]], Dict[str, int], Dict[str, List[str]]]:
        async def safe_call(name: str, limit: int) -> List[Dict[str, Any]]:
            fn = getattr(market, name, None)
            if not callable(fn):
                return []
            try:
                rows = await fn(limit=limit)
                return [dict(row) for row in rows or [] if isinstance(row, dict)]
            except Exception as exc:
                print(f"[vwap3-universe] {name} failed: {exc}", flush=True)
                return []

        gainers, actives, losers = await asyncio.gather(
            safe_call("get_snapshot_gainers", VWAP3_GAINERS_LIMIT),
            safe_call("get_snapshot_actives", VWAP3_ACTIVES_LIMIT),
            safe_call("get_snapshot_losers", VWAP3_LOSERS_LIMIT),
        )

        rank_map: Dict[str, int] = {}
        for index, row in enumerate(gainers):
            symbol = self._row_symbol(row)
            if symbol and symbol not in rank_map:
                rank_map[symbol] = index + 1

        merged: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        sources: Dict[str, List[str]] = {}

        def add(symbol: str, source: str, row: Optional[Dict[str, Any]] = None) -> None:
            symbol = str(symbol or "").upper().strip()
            if not symbol:
                return
            sources.setdefault(symbol, [])
            if source not in sources[symbol]:
                sources[symbol].append(source)
            if symbol not in merged:
                merged[symbol] = dict(row or {})
                merged[symbol]["symbol"] = symbol
            elif row:
                # Prefer live snapshot fields when they become available.
                for key, value in row.items():
                    if value not in (None, ""):
                        merged[symbol][key] = value

        # The prior evening AH snapshot is the critical early-discovery source.
        try:
            ah_snapshot = snapshot_store.load_latest_snapshot("overnight_runner", "ah")
            for row in (ah_snapshot or {}).get("rows") or []:
                if isinstance(row, dict):
                    add(self._row_symbol(row), "saved_ah", row)
        except Exception as exc:
            print(f"[vwap3-universe] saved AH load failed: {exc}", flush=True)

        # Persistent symbols are added before the live lists so a hard universe cap
        # can never push out a displacement we already committed to monitoring.
        for symbol, pin in self._watch_pool.items():
            add(symbol, "pinned_displacement", pin)

        for row in self._tracked.values():
            symbol = self._row_symbol(row)
            if symbol:
                add(symbol, "tracked_setup", row)

        for row in gainers:
            add(self._row_symbol(row), "gainers", row)
        for row in actives:
            add(self._row_symbol(row), "actives", row)
        for row in losers:
            add(self._row_symbol(row), "losers", row)

        items = list(merged.values())[:VWAP3_MAX_WATCH_SYMBOLS]
        return items, rank_map, sources

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
        live_rank: Optional[int],
        change_pct: float,
        last_price: float,
        now_et: datetime,
        discovery_sources: Optional[List[str]] = None,
        session_start: int,
        session_end: int,
    ) -> List[Dict[str, Any]]:
        indexes = _session_indexes(rows, trade_date, session_start, session_end)
        if not indexes:
            return []

        tps = [_typical_price(row) for row in rows]
        vwaps = _continuous_vwap(rows)

        qualified: List[Dict[str, Any]] = []
        seen_setup_keys = set()

        # Evaluate every qualifying displacement in the session.
        # An earlier failed displacement must not block a later valid leg.
        for event_idx in indexes:
            event = rows[event_idx]

            if not _qualifies_displacement(event):
                continue

            displacement_open = _safe_float(event.get("open"))
            displacement_close = _safe_float(event.get("close"))
            displacement_high = _safe_float(event.get("high"))
            displacement_low = _safe_float(event.get("low"))

            frozen = _freeze_target_on_displacement(tps, vwaps, event_idx)
            if frozen is None:
                continue

            # New live rule: the completed displacement candle itself is the
            # freeze candle. No 3-contraction wait. The +3 target is calculated
            # from continuous VWAP + 3 x 20-bar STD on this exact candle.
            freeze_idx = event_idx
            freeze = event
            freeze_close = displacement_close
            full_target = float(frozen["target"])
            lower_3std = float(frozen.get("lower_target", 0.0))

            if freeze_close <= 0:
                continue

            # Preserve the original "untouched +3" requirement. The target must
            # still be above the displacement candle high when it is frozen.
            if displacement_high >= full_target:
                continue

            target_distance_pct = _pct(full_target, freeze_close)
            if target_distance_pct < 0:
                continue

            lower_3std_distance_pct = (
                ((freeze_close - lower_3std) / freeze_close) * 100.0
                if freeze_close > 0
                else 0.0
            )
            std_band_width = full_target - lower_3std
            std_band_width_pct = (
                (std_band_width / freeze_close) * 100.0
                if freeze_close > 0
                else 0.0
            )

            displacement_pct = _pct(displacement_close, displacement_open)
            displacement_range_pct = _pct(displacement_high, displacement_low)

            grade: Optional[str] = None
            actionable_target = full_target
            t1_target: Optional[float] = None
            actionable_distance_pct = target_distance_pct

            # Existing validated A+/A behavior stays unchanged.
            if target_distance_pct < A_PLUS_MAX_DISTANCE_PCT:
                grade = "A+"

            elif target_distance_pct < A_MAX_DISTANCE_PCT:
                grade = "A"

            # 15-20% remains rejected for now.

            # Validated PM Runner:
            # 20-25% full +3 projection + displacement range >= 7%.
            elif (
                pool == "premarket"
                and PM_RUNNER_MIN_DISTANCE_PCT
                <= target_distance_pct
                < PM_RUNNER_MAX_DISTANCE_PCT
                and displacement_range_pct >= PM_RUNNER_MIN_RANGE_PCT
            ):
                grade = "PM RUNNER"

            # BOXL-type extreme displacement:
            # 25-30% full +3 projection,
            # body >=20%, range >=20%.
            # Actionable T1 is +20% from freeze; full +3 remains T2.
            elif (
                pool == "premarket"
                and PM_EXTREME_MIN_DISTANCE_PCT
                <= target_distance_pct
                < PM_EXTREME_MAX_DISTANCE_PCT
                and displacement_pct >= PM_EXTREME_MIN_BODY_PCT
                and displacement_range_pct >= PM_EXTREME_MIN_RANGE_PCT
            ):
                grade = "PM EXTREME RUNNER WATCH"
                t1_target = freeze_close * (1.0 + PM_EXTREME_T1_PCT / 100.0)
                actionable_target = t1_target
                actionable_distance_pct = PM_EXTREME_T1_PCT

            else:
                continue

            freeze_time = str(freeze.get("dt_et") or "")
            setup_key = f"{symbol}|{pool}|{freeze_time}"

            # Each qualifying displacement candle gets its own frozen +3 target.
            # This preserves multiple independent targets for the same symbol/day.
            if setup_key in seen_setup_keys:
                continue

            seen_setup_keys.add(setup_key)

            base_score = _grade_base_score(grade)

            notes: List[str] = []

            if grade == "PM EXTREME RUNNER WATCH":
                notes.extend(
                    [
                        (
                            f"T1 ${actionable_target:.4f}"
                            if actionable_target < 1
                            else f"T1 ${actionable_target:.2f}"
                        ),
                        (
                            f"T2 +3 ${full_target:.4f}"
                            if full_target < 1
                            else f"T2 +3 ${full_target:.2f}"
                        ),
                        f"Full +3 distance {target_distance_pct:.2f}%",
                        (
                            f"-3 STD ${lower_3std:.4f}"
                            if 0 < lower_3std < 1
                            else (f"-3 STD ${lower_3std:.2f}" if lower_3std > 0 else "-3 STD below $0")
                        ),
                        f"+3/-3 band {std_band_width_pct:.2f}%",
                        (
                            f"Extreme displacement: body {displacement_pct:.2f}% "
                            f"| range {displacement_range_pct:.2f}%"
                        ),
                    ]
                )
            else:
                notes.extend(
                    [
                        (
                            f"Target ${full_target:.4f}"
                            if full_target < 1
                            else f"Target ${full_target:.2f}"
                        ),
                        f"Target distance {target_distance_pct:.2f}%",
                        (
                            f"-3 STD ${lower_3std:.4f}"
                            if 0 < lower_3std < 1
                            else (f"-3 STD ${lower_3std:.2f}" if lower_3std > 0 else "-3 STD below $0")
                        ),
                        f"+3/-3 band {std_band_width_pct:.2f}%",
                    ]
                )

                if grade == "PM RUNNER":
                    notes.append(
                        f"PM Runner range {displacement_range_pct:.2f}%"
                    )

            row: Dict[str, Any] = {
                "setup_key": setup_key,
                "symbol": symbol,
                "scanner_id": self.id,
                "runner_type": "vwap3",
                "source": "vwap3_target",
                "direction": "bullish",
                "grade": grade,
                "setup_class": grade,
                "live_rank": live_rank,
                "rank_at_freeze": live_rank,
                "rank_source": "alpaca_gainers_top50",
                "discovery_sources": list(discovery_sources or []),
                "session": "PM" if pool == "premarket" else "AH",
                "pool": pool,
                "trade_date": trade_date,
                "last_price": round(
                    last_price or _safe_float(rows[-1].get("close")), 6
                ),
                "price": round(
                    last_price or _safe_float(rows[-1].get("close")), 6
                ),

                "change_pct": round(change_pct, 3),
                "pm_gap_pct": round(change_pct, 3),

                "freeze_price": round(freeze_close, 6),

                # target_price is the level used for live TARGET HIT status.
                "target_price": round(actionable_target, 6),

                # frozen_target always preserves the actual +3 projection.
                "frozen_target": round(full_target, 6),
                "full_target_price": round(full_target, 6),

                # Matching lower band frozen from the same displacement candle.
                # Display/reference only for now; it is not an execution stop.
                "lower_3std_price": round(lower_3std, 6),
                "lower_3std_distance_pct": round(lower_3std_distance_pct, 3),
                "std_band_width": round(std_band_width, 6),
                "std_band_width_pct": round(std_band_width_pct, 3),
                "target_method": "displacement_candle_vwap_plus_minus_3std",

                "t1_target_price": (
                    round(t1_target, 6)
                    if t1_target is not None
                    else None
                ),

                "target_distance_pct": round(target_distance_pct, 3),
                "action_target_distance_pct": round(
                    actionable_distance_pct, 3
                ),

                "displacement_pct": round(displacement_pct, 3),
                "displacement_range_pct": round(
                    displacement_range_pct, 3
                ),
                "displacement_open": round(displacement_open, 6),
                "displacement_high": round(displacement_high, 6),
                "displacement_low": round(displacement_low, 6),
                "displacement_close": round(displacement_close, 6),
                "displacement_volume": int(
                    _safe_float(event.get("volume"))
                ),
                "displacement_time": event.get("dt_et"),

                "freeze_time": freeze_time,
                "projection_peak_time": freeze_time,
                "freeze_reason": "displacement_candle",
                "bars_to_freeze": 0,
                "freeze_vwap": round(float(frozen["vwap"]), 6),
                "freeze_std": round(float(frozen["std"]), 6),
                "freeze_upper_3std": round(full_target, 6),
                "freeze_lower_3std": round(lower_3std, 6),

                "score": base_score,
                "runner_score": base_score,
                "notes": notes,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "scanner_detected_at": datetime.now(timezone.utc).isoformat(),
            }

            try:
                freeze_dt = datetime.fromisoformat(freeze_time).astimezone(ET)
                displacement_completed_at = freeze_dt + timedelta(minutes=5)
                row["displacement_completed_at"] = displacement_completed_at.isoformat()
                row["detection_delay_minutes"] = round(
                    max(0.0, (now_et - displacement_completed_at).total_seconds() / 60.0), 2
                )
            except Exception:
                row["displacement_completed_at"] = None
                row["detection_delay_minutes"] = None

            qualified.append(_status_from_rows(rows, row))

        return qualified

    async def run(
        self,
        market: MarketDataProvider,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        started = time_module.perf_counter()
        now_et = datetime.now(ET)
        now_pt = now_et.astimezone(PT)
        self._cleanup_state(now_et)

        watch_items, rank_map, source_map = await self._build_watch_universe(
            market, snapshot_store, now_et
        )

        session = _session_for_now(now_et)
        scan_errors: List[Dict[str, str]] = []
        newly_qualified = 0
        scanned_count = 0

        if session is not None and watch_items:
            pool, session_start, session_end = session
            trade_date = now_et.date().isoformat()
            semaphore = asyncio.Semaphore(VWAP3_SCAN_CONCURRENCY)

            async def inspect(raw: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
                nonlocal scanned_count
                symbol = self._row_symbol(raw)
                if not symbol:
                    return None
                async with semaphore:
                    try:
                        rows = await self._load_native_5m(market, symbol, now_et)
                        scanned_count += 1

                        displacement_time = self._session_has_displacement(
                            rows, trade_date, session_start, session_end
                        )
                        if displacement_time:
                            existing_pin = self._watch_pool.get(symbol)
                            if existing_pin is None:
                                self._watch_pool[symbol] = {
                                    "symbol": symbol,
                                    "trade_date": trade_date,
                                    "pinned_at": datetime.now(timezone.utc).isoformat(),
                                    "displacement_time": displacement_time,
                                    "source": "qualifying_displacement",
                                }
                                print(
                                    f"[vwap3-watch] {symbol} pinned=true "
                                    f"displacement={displacement_time} "
                                    f"pt={now_pt.strftime('%H:%M:%S')}",
                                    flush=True,
                                )

                        return self._analyze_candidate(
                            symbol,
                            rows,
                            pool=pool,
                            trade_date=trade_date,
                            live_rank=rank_map.get(symbol),
                            change_pct=self._snapshot_change_pct(raw),
                            last_price=self._snapshot_price(raw),
                            now_et=now_et,
                            session_start=session_start,
                            session_end=session_end,
                            discovery_sources=source_map.get(symbol, []),
                        )
                    except Exception as exc:
                        scan_errors.append({"symbol": symbol, "error": str(exc)})
                        return None

            candidate_groups = await asyncio.gather(*(inspect(row) for row in watch_items))

            for candidate_group in candidate_groups:
                if not candidate_group:
                    continue

                for candidate in candidate_group:
                    key = str(candidate.get("setup_key") or "")
                    if not key:
                        continue

                    existing = self._tracked.get(key)

                    if existing is None:
                        newly_qualified += 1
                        print(
                            f"[vwap3-published] {candidate.get('symbol')} "
                            f"grade={candidate.get('grade')} "
                            f"displacement={candidate.get('displacement_time')} "
                            f"freeze_price={candidate.get('freeze_price')} "
                            f"target={candidate.get('target_price')} "
                            f"delay_min={candidate.get('detection_delay_minutes')} "
                            f"sources={','.join(candidate.get('discovery_sources') or [])}",
                            flush=True,
                        )
                        sent_at = await _send_pushover_setup_alert(candidate)
                        if sent_at:
                            candidate["pushover_notified_at"] = sent_at
                    else:
                        # Historical context is captured at first scanner detection.
                        for field in (
                            "rank_at_freeze",
                            "created_at",
                            "scanner_detected_at",
                            "detection_delay_minutes",
                            "discovery_sources",
                            "pushover_notified_at",
                        ):
                            if field in existing:
                                candidate[field] = existing.get(field)

                    self._tracked[key] = candidate

        # Refresh existing signals even when they have left the discovery universe
        # or the market has moved into RTH.
        tracked_symbols = sorted(
            {
                str(row.get("symbol") or "").upper().strip()
                for row in self._tracked.values()
                if row.get("symbol")
            }
        )
        tracked_rows_by_symbol: Dict[str, List[Dict[str, Any]]] = {}
        if tracked_symbols:
            semaphore = asyncio.Semaphore(VWAP3_SCAN_CONCURRENCY)

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
            row["is_live_top20_now"] = current_rank is not None and current_rank <= 20
            row["is_live_top50_now"] = current_rank is not None and current_rank <= 50
            row["last_updated_at"] = datetime.now(timezone.utc).isoformat()
            base_score = _grade_base_score(str(row.get("grade") or ""))
            if row.get("confirmation_status") == "CONFIRMED":
                base_score += 3
            elif row.get("confirmation_status") == "STRONG CONFIRMED":
                base_score += 6
            elif row.get("confirmation_status") == "TARGET HIT":
                base_score = 100
            row["score"] = min(100, base_score)
            row["runner_score"] = row["score"]
            self._tracked[key] = row

        self._archive_target_hits()
        self._archive_all_setups()
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
                _grade_sort_order(str(row.get("grade") or "")),
                status_order.get(str(row.get("confirmation_status") or ""), 9),
                _safe_float(row.get("target_distance_pct")),
                int(row.get("rank_at_freeze") or 999),
            )
        )

        max_rows = max(20, min(100, int(kwargs.get("max_symbols", 25) or 25)))
        current_trade_date = now_et.date().isoformat()
        current_rows = [
            row for row in rows
            if str(row.get("trade_date") or "") == current_trade_date
        ]
        active_rows = [row for row in current_rows if not row.get("target_hit")]
        target_hit_rows = [row for row in current_rows if row.get("target_hit")]
        # The live scanner list contains active setups only. Completed targets are
        # returned separately for the Target Hits review tab.
        rows = active_rows[:max_rows]
        elapsed_ms = round((time_module.perf_counter() - started) * 1000.0, 1)

        source_counts: Dict[str, int] = {}
        for symbol, sources in source_map.items():
            for source in sources:
                source_counts[source] = source_counts.get(source, 0) + 1

        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "live",
            "trade_day": now_et.date().isoformat(),
            "count": len(rows),
            "rows": rows,
            "target_hits": target_hit_rows,
            "meta": {
                "watch_universe_count": len(watch_items),
                "watch_source_counts": source_counts,
                "pinned_displacement_count": len(self._watch_pool),
                "gainers_ranked_count": len(rank_map),
                "scanned_count": scanned_count,
                "newly_qualified": newly_qualified,
                "tracked_count": len(self._tracked),
                "active_count": len(active_rows),
                "target_hit_count": len(target_hit_rows),
                "target_hit_archive_dir": str(_hit_archive_dir()),
                "setup_archive_dir": str(_setup_archive_dir()),
                "pushover_configured": bool(
                    os.getenv("PUSHOVER_USER_KEY", "").strip()
                    and os.getenv("PUSHOVER_APP_TOKEN", "").strip()
                ),
                "scan_errors": scan_errors[:10],
                "elapsed_ms": elapsed_ms,
                "display_timezone": "America/Los_Angeles",
                "strategy": {
                    "timeframe": "5m",
                    "std_length": STD_LENGTH,
                    "multiplier": MULTIPLIER,
                    "vwap_mode": "continuous",
                    "warmup_calendar_days": WARMUP_CALENDAR_DAYS,
                    "target_freeze_mode": "displacement_candle",
                    "target_freeze_rule": "continuous VWAP + 3 x 20-bar STD on completed displacement candle",
                    "alert_timing": "first scanner cycle after completed displacement candle qualifies",
                    "requires_3_contractions": False,
                    "a_plus_target_distance_lt_pct": A_PLUS_MAX_DISTANCE_PCT,
                    "a_target_distance_range_pct": [
                        A_PLUS_MAX_DISTANCE_PCT,
                        A_MAX_DISTANCE_PCT,
                    ],
                    "pm_runner": {
                        "target_distance_range_pct": [
                            PM_RUNNER_MIN_DISTANCE_PCT,
                            PM_RUNNER_MAX_DISTANCE_PCT,
                        ],
                        "min_displacement_range_pct": PM_RUNNER_MIN_RANGE_PCT,
                    },
                    "pm_extreme_runner_watch": {
                        "target_distance_range_pct": [
                            PM_EXTREME_MIN_DISTANCE_PCT,
                            PM_EXTREME_MAX_DISTANCE_PCT,
                        ],
                        "min_displacement_body_pct": PM_EXTREME_MIN_BODY_PCT,
                        "min_displacement_range_pct": PM_EXTREME_MIN_RANGE_PCT,
                        "t1_from_freeze_pct": PM_EXTREME_T1_PCT,
                        "t2": "actual frozen +3 projection",
                    },
                    "confirmation": "5m close above displacement close/body",
                    "strong_confirmation": "5m close above displacement high/wick",
                },
                "discovery": (
                    "saved AH + live gainers + live actives + live losers + "
                    "pinned displacement symbols + tracked setups"
                ),
                "ranking_source": "Alpaca gainers Top-50 for context only; rank is not a discovery gate",
            },
        }


__all__ = ["VWAP3TargetScanner"]
