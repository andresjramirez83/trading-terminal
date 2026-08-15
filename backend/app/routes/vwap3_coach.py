from __future__ import annotations

import json
import math
import os
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services.market_data_provider import get_market_data_provider

ET = ZoneInfo("America/New_York")
PT = ZoneInfo("America/Los_Angeles")

router = APIRouter(prefix="/trading-coach/vwap3", tags=["trading-coach"])


def _app_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def _setup_archive_dir() -> Path:
    raw = os.getenv("VWAP3_SETUP_ARCHIVE_DIR", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return _app_dir() / "data" / "scanner_history" / "vwap3_setups"


def _hit_archive_dir() -> Path:
    raw = os.getenv("VWAP3_TARGET_HIT_ARCHIVE_DIR", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return _app_dir() / "data" / "scanner_history" / "vwap3_target_hits"


def _state_path() -> Path:
    raw = os.getenv("VWAP3_SCANNER_STATE_PATH", "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else Path.cwd() / path
    return _app_dir() / "data" / "scanner_state" / "vwap3_target.json"


def _safe_float(value: Any) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else 0.0
    except Exception:
        return 0.0


def _parse_dt(value: Any) -> Optional[datetime]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=PT)
        return parsed
    except Exception:
        return None



def _effective_outcome(row: Dict[str, Any]) -> str:
    """Normalize old/new archive rows into mutually exclusive research outcomes."""
    target_dt = _parse_dt(row.get("target_hit_time"))
    invalidation_dt = _parse_dt(row.get("invalidation_time"))

    if target_dt is not None:
        if (
            invalidation_dt is not None
            and invalidation_dt.astimezone(timezone.utc) < target_dt.astimezone(timezone.utc)
        ):
            return "target_hit_after_invalidation"
        return "target_hit"

    if invalidation_dt is not None:
        return "invalidated"

    existing = str(row.get("outcome") or "").strip().lower()
    if existing in {"expired", "active"}:
        return existing
    return existing or "active"


def _normalize_setup_row(row: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row)
    outcome = _effective_outcome(normalized)
    normalized["outcome"] = outcome
    normalized["valid_target_hit"] = outcome == "target_hit"
    normalized["target_hit_after_invalidation"] = outcome == "target_hit_after_invalidation"
    # target_hit means the price eventually touched the frozen target. Keep it
    # true for the after-invalidation bucket while valid_target_hit identifies
    # actual setup wins.
    normalized["target_hit"] = outcome in {"target_hit", "target_hit_after_invalidation"}
    if outcome == "target_hit_after_invalidation":
        normalized["confirmation_status"] = "TARGET HIT AFTER INVALIDATION"
        normalized["setup_stage"] = "TARGET HIT AFTER INVALIDATION"
    return normalized


def _bar_dt(row: Dict[str, Any]) -> Optional[datetime]:
    raw = row.get("time", row.get("t"))
    try:
        ts = int(raw or 0)
        if 0 < ts < 10_000_000_000:
            ts *= 1000
        if ts > 0:
            return datetime.fromtimestamp(ts / 1000.0, timezone.utc)
    except Exception:
        pass
    return _parse_dt(row.get("dt_et") or row.get("timestamp"))


def _load_json_rows(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
    except Exception:
        return []
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []
    return [dict(row) for row in rows if isinstance(row, dict)]


def _load_state_rows() -> List[Dict[str, Any]]:
    path = _state_path()
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
        rows = payload.get("tracked") or []
        return [dict(row) for row in rows if isinstance(row, dict)]
    except Exception:
        return []


def _load_setups_for_date(trade_date: str) -> List[Dict[str, Any]]:
    # Prefer the unbiased all-setup archive. The target-hit archive is included
    # only as a backward-compatible source for dates recorded before this upgrade.
    merged: Dict[str, Dict[str, Any]] = {}
    for path in (
        _setup_archive_dir() / f"{trade_date}.json",
        _hit_archive_dir() / f"{trade_date}.json",
    ):
        for row in _load_json_rows(path):
            key = str(row.get("setup_key") or "").strip()
            if key:
                merged[key] = row
    for row in _load_state_rows():
        if str(row.get("trade_date") or "") != trade_date:
            continue
        key = str(row.get("setup_key") or "").strip()
        if key:
            merged[key] = row
    return [_normalize_setup_row(row) for row in merged.values()]


def _normalize_date(value: Optional[str]) -> str:
    if not value:
        return datetime.now(PT).date().isoformat()
    try:
        return date.fromisoformat(value).isoformat()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="trade_date must be YYYY-MM-DD") from exc


def _setup_detection_dt(row: Dict[str, Any]) -> Optional[datetime]:
    return (
        _parse_dt(row.get("scanner_detected_at"))
        or _parse_dt(row.get("displacement_completed_at"))
        or _parse_dt(row.get("freeze_time"))
    )


def _match_setup(
    symbol: str,
    entry_dt: datetime,
    candidates: Iterable[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    symbol = symbol.upper().strip()
    ranked: List[Tuple[Tuple[int, float], Dict[str, Any]]] = []
    for row in candidates:
        if str(row.get("symbol") or "").upper().strip() != symbol:
            continue
        detected = _setup_detection_dt(row)
        if detected is None:
            continue
        delta_min = (entry_dt.astimezone(timezone.utc) - detected.astimezone(timezone.utc)).total_seconds() / 60.0
        # Prefer setups already known when the entry occurred. If none exist,
        # keep a same-day future detection so the coach can explicitly say the
        # trade preceded the scanner rather than falsely linking it.
        bucket = 0 if delta_min >= 0 else 1
        ranked.append(((bucket, abs(delta_min)), row))
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[0])
    return dict(ranked[0][1])


def _pct_change(value: float, base: float) -> float:
    if base <= 0:
        return 0.0
    return (value / base - 1.0) * 100.0


def _median(values: Iterable[float]) -> Optional[float]:
    clean = [float(v) for v in values if math.isfinite(float(v))]
    return round(float(statistics.median(clean)), 3) if clean else None


class Vwap3TradeReviewRequest(BaseModel):
    trade_id: str = Field(min_length=1)
    symbol: str = Field(min_length=1)
    side: str = "buy"
    shares: float = 0
    entry_price: float
    exit_price: float
    entry_time: str
    exit_time: str
    planned_target: Optional[float] = None
    planned_stop: Optional[float] = None
    strategy: Optional[str] = None
    realized_pnl: Optional[float] = None
    r_multiple: Optional[float] = None


async def _load_trade_day_bars(symbol: str, trade_date: str) -> List[Dict[str, Any]]:
    market = get_market_data_provider()
    try:
        return await market.get_bars(
            symbol=symbol,
            timeframe="1m",
            session="extended",
            date=trade_date,
            limit=5000,
        )
    except Exception as exc:
        print(f"[vwap3-coach] bars unavailable symbol={symbol} date={trade_date}: {exc}", flush=True)
        return []


def _path_stats(
    bars: List[Dict[str, Any]],
    entry_dt: datetime,
    exit_dt: datetime,
    target: float,
    invalidation: float,
) -> Dict[str, Any]:
    entry_utc = entry_dt.astimezone(timezone.utc)
    exit_utc = exit_dt.astimezone(timezone.utc)
    after_entry: List[Tuple[datetime, Dict[str, Any]]] = []
    after_exit: List[Tuple[datetime, Dict[str, Any]]] = []
    through_exit: List[Tuple[datetime, Dict[str, Any]]] = []

    for row in bars:
        dt = _bar_dt(row)
        if dt is None:
            continue
        dt = dt.astimezone(timezone.utc)
        if dt >= entry_utc:
            after_entry.append((dt, row))
        if entry_utc <= dt <= exit_utc:
            through_exit.append((dt, row))
        if dt > exit_utc:
            after_exit.append((dt, row))

    def max_high(items: List[Tuple[datetime, Dict[str, Any]]]) -> float:
        values = [_safe_float(row.get("high", row.get("h"))) for _, row in items]
        return max(values, default=0.0)

    def min_low(items: List[Tuple[datetime, Dict[str, Any]]]) -> float:
        values = [v for v in (_safe_float(row.get("low", row.get("l"))) for _, row in items) if v > 0]
        return min(values, default=0.0)

    def first_hit(items: List[Tuple[datetime, Dict[str, Any]]], level: float, side: str) -> Optional[datetime]:
        if level <= 0:
            return None
        for dt, row in items:
            high = _safe_float(row.get("high", row.get("h")))
            low = _safe_float(row.get("low", row.get("l")))
            if side == "high" and high >= level:
                return dt
            if side == "low" and low <= level:
                return dt
        return None

    target_before_exit = first_hit(through_exit, target, "high")
    target_after_exit = first_hit(after_exit, target, "high")
    invalidation_before_exit = first_hit(through_exit, invalidation, "low")
    invalidation_after_exit = first_hit(after_exit, invalidation, "low")

    return {
        "max_high_after_entry": max_high(after_entry),
        "min_low_after_entry": min_low(after_entry),
        "max_high_after_exit": max_high(after_exit),
        "min_low_after_exit": min_low(after_exit),
        "target_hit_before_exit_time": target_before_exit.isoformat() if target_before_exit else None,
        "target_hit_after_exit_time": target_after_exit.isoformat() if target_after_exit else None,
        "invalidation_hit_before_exit_time": invalidation_before_exit.isoformat() if invalidation_before_exit else None,
        "invalidation_hit_after_exit_time": invalidation_after_exit.isoformat() if invalidation_after_exit else None,
    }


def _review_classification(
    entry: float,
    exit_price: float,
    target: float,
    invalidation: float,
    path: Dict[str, Any],
) -> Tuple[str, str, int]:
    if target > 0 and exit_price >= target * 0.995:
        return "target_exit", "Target exit", 95
    if invalidation > 0 and exit_price <= invalidation * 1.005:
        return "stop_or_invalidation_exit", "Invalidation/stop exit", 82

    target_after_time = _parse_dt(path.get("target_hit_after_exit_time"))
    invalid_after_time = _parse_dt(path.get("invalidation_hit_after_exit_time"))
    target_after = target_after_time is not None
    invalid_before = bool(path.get("invalidation_hit_before_exit_time"))
    invalid_after = invalid_after_time is not None
    target_won_race = target_after and (
        invalid_after_time is None
        or target_after_time.astimezone(timezone.utc) <= invalid_after_time.astimezone(timezone.utc)
    )

    if target > exit_price > 0 and not invalid_before and target_won_race:
        return (
            "likely_early_exit",
            "Likely early exit",
            91,
        )
    if target > exit_price > 0 and invalid_before:
        return "defensive_exit", "Justified defensive exit", 88
    if target > exit_price > 0 and invalid_after and not target_won_race:
        return "defensive_exit", "Good defensive exit", 84
    if target > exit_price > 0:
        return "early_exit_unresolved", "Early exit — outcome unresolved", 68
    return "neutral_exit", "Exit review", 60


def _entry_quality(entry: float, setup: Dict[str, Any], detected_dt: Optional[datetime], entry_dt: datetime) -> Dict[str, Any]:
    freeze = _safe_float(setup.get("freeze_price"))
    disp_low = _safe_float(setup.get("displacement_low"))
    disp_high = _safe_float(setup.get("displacement_high"))
    target = _safe_float(setup.get("frozen_target") or setup.get("target_price"))
    delay = None
    if detected_dt:
        delay = round((entry_dt.astimezone(timezone.utc) - detected_dt.astimezone(timezone.utc)).total_seconds() / 60.0, 2)

    entry_vs_freeze = round(_pct_change(entry, freeze), 3) if freeze > 0 else None
    target_remaining = round((target - entry) / entry * 100.0, 3) if entry > 0 and target > 0 else None
    risk_to_disp_low = round((entry - disp_low) / entry * 100.0, 3) if entry > 0 and disp_low > 0 else None

    score = 70.0
    if entry_vs_freeze is not None:
        if -7 <= entry_vs_freeze <= 2:
            score += 18
        elif 2 < entry_vs_freeze <= 5:
            score += 5
        elif entry_vs_freeze > 8:
            score -= 22
        elif entry_vs_freeze < -12:
            score -= 10
    if target_remaining is not None and target_remaining >= 8:
        score += 6
    if disp_high > 0 and entry > disp_high * 1.03:
        score -= 12
    score = int(max(0, min(100, round(score))))

    if entry_vs_freeze is None:
        label = "Unknown"
    elif entry_vs_freeze > 8:
        label = "Chased"
    elif entry_vs_freeze > 3:
        label = "Slightly extended"
    elif entry_vs_freeze >= -1:
        label = "Near scanner/freeze"
    elif entry_vs_freeze >= -8:
        label = "Pullback entry"
    else:
        label = "Deep pullback"

    return {
        "score": score,
        "label": label,
        "delay_minutes": delay,
        "entry_vs_freeze_pct": entry_vs_freeze,
        "target_remaining_pct_at_entry": target_remaining,
        "risk_to_displacement_low_pct": risk_to_disp_low,
    }


@router.post("/review-trade")
async def review_vwap3_trade(payload: Vwap3TradeReviewRequest):
    entry_dt = _parse_dt(payload.entry_time)
    exit_dt = _parse_dt(payload.exit_time)
    if entry_dt is None or exit_dt is None:
        raise HTTPException(status_code=400, detail="entry_time and exit_time must be ISO timestamps")
    if payload.entry_price <= 0 or payload.exit_price <= 0:
        raise HTTPException(status_code=400, detail="entry_price and exit_price must be positive")

    trade_date = entry_dt.astimezone(ET).date().isoformat()
    setups = _load_setups_for_date(trade_date)
    matched = _match_setup(payload.symbol, entry_dt, setups)

    if not matched:
        return {
            "trade_id": payload.trade_id,
            "symbol": payload.symbol.upper(),
            "reviewed_at": datetime.now(timezone.utc).isoformat(),
            "scanner_match": False,
            "headline": "No 3-VWAP scanner match",
            "summary": "No archived 3-VWAP setup for this symbol was found on the trade date.",
            "classification": "not_vwap3",
            "confidence": 1.0,
        }

    detected_dt = _setup_detection_dt(matched)
    entry_after_scanner = bool(detected_dt and entry_dt.astimezone(timezone.utc) >= detected_dt.astimezone(timezone.utc))
    scanner_target = _safe_float(matched.get("frozen_target") or matched.get("target_price"))
    planned_target = _safe_float(payload.planned_target)
    target = scanner_target if scanner_target > 0 else planned_target
    planned_stop = _safe_float(payload.planned_stop)
    displacement_low = _safe_float(matched.get("displacement_low"))
    invalidation = planned_stop if planned_stop > 0 else displacement_low

    bars = await _load_trade_day_bars(payload.symbol, trade_date)
    path = _path_stats(bars, entry_dt, exit_dt, target, invalidation)

    # Scanner tracking can continue across sessions/days. Prefer its durable
    # target/invalidation timestamps when they extend beyond the single-day bar
    # window used for detailed MFE calculations.
    archived_target_hit = _parse_dt(matched.get("target_hit_time"))
    if (
        not path.get("target_hit_after_exit_time")
        and archived_target_hit
        and archived_target_hit.astimezone(timezone.utc) > exit_dt.astimezone(timezone.utc)
    ):
        path["target_hit_after_exit_time"] = archived_target_hit.isoformat()
    archived_invalidation = (
        _parse_dt(matched.get("invalidation_time")) if planned_stop <= 0 else None
    )
    if archived_invalidation:
        invalidation_utc = archived_invalidation.astimezone(timezone.utc)
        if invalidation_utc <= exit_dt.astimezone(timezone.utc):
            path["invalidation_hit_before_exit_time"] = archived_invalidation.isoformat()
        elif not path.get("invalidation_hit_after_exit_time"):
            path["invalidation_hit_after_exit_time"] = archived_invalidation.isoformat()

    classification, classification_label, confidence_score = _review_classification(
        payload.entry_price,
        payload.exit_price,
        target,
        invalidation,
        path,
    )
    entry_quality = _entry_quality(payload.entry_price, matched, detected_dt, entry_dt)

    historical_rows = _study_rows(60)
    pullback_tests = _pullback_tests(historical_rows)
    historical_candidates = [
        item
        for item in pullback_tests
        if item["opportunities"] >= 5 and item["hit_rate_pct"] is not None
    ]
    best_historical_pullback = (
        max(
            historical_candidates,
            key=lambda item: (item["hit_rate_pct"], item["opportunities"]),
        )
        if historical_candidates
        else None
    )

    missed_per_share = (
        max(0.0, target - payload.exit_price)
        if target > 0 and classification == "likely_early_exit"
        else 0.0
    )
    missed_pnl = missed_per_share * max(0.0, payload.shares)
    target_after_exit = _parse_dt(path.get("target_hit_after_exit_time"))
    minutes_exit_to_target = None
    if target_after_exit:
        minutes_exit_to_target = round(
            max(0.0, (target_after_exit.astimezone(timezone.utc) - exit_dt.astimezone(timezone.utc)).total_seconds() / 60.0),
            2,
        )

    max_high_after_exit = _safe_float(path.get("max_high_after_exit"))
    mfe_after_exit_pct = (
        round((max_high_after_exit - payload.exit_price) / payload.exit_price * 100.0, 3)
        if payload.exit_price > 0 and max_high_after_exit > 0
        else 0.0
    )
    setup_valid_at_exit = not bool(path.get("invalidation_hit_before_exit_time"))

    if classification == "likely_early_exit":
        summary = (
            f"You exited before the frozen +3 target while the setup was still valid. "
            f"Price later reached the target{f' {minutes_exit_to_target:.0f} minutes after your exit' if minutes_exit_to_target is not None else ''}. "
            "This is consistent with protecting open profit too early; it does not prove an emotion, but it is a repeatable behavior the coach can track."
        )
    elif classification == "defensive_exit":
        summary = (
            "You exited before the +3 target, but the price path reached or threatened the trade invalidation before a later target. "
            "The early exit was technically defensible rather than automatically being treated as fear."
        )
    elif classification == "target_exit":
        summary = "The exit captured the scanner's frozen +3 target area."
    else:
        summary = "The trade is linked to a 3-VWAP setup and the coach recorded the entry/exit path for ongoing study."

    return {
        "trade_id": payload.trade_id,
        "symbol": payload.symbol.upper(),
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "scanner_match": True,
        "setup_key": matched.get("setup_key"),
        "scanner_grade": matched.get("grade"),
        "scanner_status": matched.get("confirmation_status"),
        "scanner_detected_at": matched.get("scanner_detected_at"),
        "freeze_time": matched.get("freeze_time"),
        "freeze_price": _safe_float(matched.get("freeze_price")),
        "frozen_target": scanner_target,
        "displacement_low": displacement_low,
        "displacement_high": _safe_float(matched.get("displacement_high")),
        "entry_after_scanner": entry_after_scanner,
        "entry_quality": entry_quality,
        "classification": classification,
        "classification_label": classification_label,
        "confidence": confidence_score / 100.0,
        "headline": f"{classification_label} · {matched.get('grade') or '3-VWAP'}",
        "summary": summary,
        "setup_valid_at_exit": setup_valid_at_exit,
        "target_hit_after_exit": bool(path.get("target_hit_after_exit_time")),
        "target_hit_after_exit_time": path.get("target_hit_after_exit_time"),
        "minutes_exit_to_target": minutes_exit_to_target,
        "missed_upside_per_share": round(missed_per_share, 6),
        "estimated_missed_pnl_to_target": round(missed_pnl, 2),
        "mfe_after_exit_pct": mfe_after_exit_pct,
        "path": path,
        "historical_context": {
            "study_days": 60,
            "sample_size": len(historical_rows),
            "best_observed_pullback": best_historical_pullback,
        },
        "scanner_setup": matched,
    }


def _study_rows(days: int) -> List[Dict[str, Any]]:
    archive_dir = _setup_archive_dir()
    today = datetime.now(ET).date()
    earliest = today - timedelta(days=max(1, days) - 1)
    merged: Dict[str, Dict[str, Any]] = {}

    if archive_dir.exists():
        for path in sorted(archive_dir.glob("*.json")):
            try:
                trade_date = date.fromisoformat(path.stem)
            except Exception:
                continue
            if trade_date < earliest or trade_date > today:
                continue
            for row in _load_json_rows(path):
                key = str(row.get("setup_key") or "").strip()
                if key:
                    merged[key] = _normalize_setup_row(row)

    # Include live/current rows even before the first permanent archive file exists.
    for row in _load_state_rows():
        key = str(row.get("setup_key") or "").strip()
        if key:
            merged[key] = _normalize_setup_row(row)
    return list(merged.values())


def _aggregate_group(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    normalized = [_normalize_setup_row(row) for row in rows]
    hits = [row for row in normalized if row.get("outcome") == "target_hit"]
    hit_after_invalidation = [
        row for row in normalized if row.get("outcome") == "target_hit_after_invalidation"
    ]
    invalidated = [row for row in normalized if row.get("outcome") == "invalidated"]
    expired = [row for row in normalized if row.get("outcome") == "expired"]
    resolved = [
        row
        for row in normalized
        if row.get("outcome")
        in {"target_hit", "target_hit_after_invalidation", "invalidated", "expired"}
    ]
    eventual_hits = len(hits) + len(hit_after_invalidation)
    return {
        "setups": len(normalized),
        "resolved": len(resolved),
        "target_hits": len(hits),
        "target_hits_after_invalidation": len(hit_after_invalidation),
        "eventual_target_hits": eventual_hits,
        "invalidated": len(invalidated),
        "expired": len(expired),
        "hit_rate_pct": round(len(hits) / len(resolved) * 100.0, 2) if resolved else None,
        "eventual_target_rate_pct": round(eventual_hits / len(resolved) * 100.0, 2) if resolved else None,
        "median_pullback_before_target_pct": _median(_safe_float(row.get("pullback_before_target_pct")) for row in hits),
        "median_minutes_to_target": _median(_safe_float(row.get("minutes_to_target")) for row in hits if _safe_float(row.get("minutes_to_target")) > 0),
    }


def _pullback_tests(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for threshold in (0, 2, 3, 5, 7, 10):
        offered = 0
        wins = 0
        for row in rows:
            freeze = _safe_float(row.get("freeze_price"))
            if freeze <= 0:
                continue
            touched_low = _safe_float(row.get("min_low_before_target") or row.get("min_low_after_freeze"))
            if threshold == 0:
                was_offered = True
            else:
                level = freeze * (1.0 - threshold / 100.0)
                was_offered = touched_low > 0 and touched_low <= level
            if not was_offered:
                continue
            offered += 1
            if _effective_outcome(row) == "target_hit":
                wins += 1
        results.append(
            {
                "pullback_pct": threshold,
                "opportunities": offered,
                "target_hits": wins,
                "hit_rate_pct": round(wins / offered * 100.0, 2) if offered else None,
            }
        )
    return results


@router.get("/study")
async def vwap3_study(days: int = Query(30, ge=1, le=365)):
    rows = _study_rows(days)
    by_grade: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_grade[str(row.get("grade") or "UNKNOWN")].append(row)

    pullbacks = _pullback_tests(rows)
    candidates = [item for item in pullbacks if item["opportunities"] >= 5 and item["hit_rate_pct"] is not None]
    best = max(candidates, key=lambda item: (item["hit_rate_pct"], item["opportunities"])) if candidates else None

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "days": days,
        "overall": _aggregate_group(rows),
        "by_grade": {grade: _aggregate_group(group) for grade, group in sorted(by_grade.items())},
        "pullback_entry_tests": pullbacks,
        "best_observed_pullback": best,
        "notes": [
            "Statistics include all permanently archived qualified setups, not only target hits.",
            "TARGET HIT requires the frozen target to be reached before invalidation. TARGET HIT AFTER INVALIDATION is tracked separately and is not counted as a valid setup win.",
            "Eventual target rate includes both valid target hits and target hits after invalidation for research context.",
            "Pullback tests measure whether the entry level was offered and whether a still-valid setup later reached its frozen target; they are descriptive, not guarantees.",
        ],
    }


@router.get("/setups")
async def vwap3_setups(trade_date: Optional[str] = Query(None), symbol: Optional[str] = Query(None)):
    selected_date = _normalize_date(trade_date)
    rows = _load_setups_for_date(selected_date)
    if symbol:
        normalized = symbol.upper().strip()
        rows = [row for row in rows if str(row.get("symbol") or "").upper().strip() == normalized]
    rows.sort(key=lambda row: str(row.get("freeze_time") or ""))
    return {
        "trade_date": selected_date,
        "count": len(rows),
        "rows": rows,
    }
