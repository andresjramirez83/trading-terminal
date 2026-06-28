from __future__ import annotations

import math
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.scanners.base import ScannerBase
from app.services.polygon_service import PolygonService
from app.services.scanner_snapshot_store import ScannerSnapshotStore

ET = ZoneInfo("America/New_York")
PT = ZoneInfo("America/Los_Angeles")


class OvernightRunnerScanner(ScannerBase):
    id = "overnight_runner"
    name = "Overnight Compression Runner"
    description = (
        "Uses saved previous-day afterhours plus current premarket to rank overnight and momentum runner setups."
    )

    async def save_afterhours_snapshot(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = int(kwargs.get("max_symbols", 80))
        min_price = float(kwargs.get("min_price", 0.5))
        max_price = float(kwargs.get("max_price", 20.0))
        min_volume = int(kwargs.get("min_volume", 250_000))
        min_gap_pct = float(kwargs.get("min_gap_pct", 0.0))
        min_dollar_volume = float(kwargs.get("min_dollar_volume", 100_000.0))
        hours_back = int(kwargs.get("hours_back", 96))

        universe_map = await build_snapshot_universe(polygon, limit=max_symbols * 4)
        rows: List[Dict[str, Any]] = []
        session_date_used: Optional[str] = None
        debug_counts: Dict[str, int] = {
            "checked": 0,
            "no_afterhours_bars": 0,
            "price": 0,
            "ah_volume": 0,
            "ah_gap_pct": 0,
            "ah_dollar_volume": 0,
            "passed": 0,
        }
        debug_examples: List[Dict[str, Any]] = []

        for symbol, snapshot in list(universe_map.items())[: max_symbols * 5]:
            debug_counts["checked"] += 1
            row = await self._build_afterhours_row(symbol, snapshot, polygon, hours_back=hours_back)
            if row is None:
                debug_counts["no_afterhours_bars"] += 1
                continue

            last_price = safe_float(row.get("last_price"))
            ah_volume = int(safe_float(row.get("ah_volume")))
            ah_gap_pct = safe_float(row.get("ah_gap_pct"))
            ah_dollar_volume = safe_float(row.get("ah_dollar_volume"))

            reject_reason: Optional[str] = None
            if last_price < min_price or last_price > max_price:
                reject_reason = "price"
            elif ah_volume < min_volume:
                reject_reason = "ah_volume"
            elif ah_gap_pct < min_gap_pct:
                reject_reason = "ah_gap_pct"
            elif ah_dollar_volume < min_dollar_volume:
                reject_reason = "ah_dollar_volume"

            if reject_reason:
                debug_counts[reject_reason] += 1
                if len(debug_examples) < 12:
                    debug_examples.append({
                        "symbol": symbol,
                        "reason": reject_reason,
                        "last_price": round(last_price, 4),
                        "ah_volume": ah_volume,
                        "ah_gap_pct": round(ah_gap_pct, 2),
                        "ah_dollar_volume": round(ah_dollar_volume, 2),
                    })
                continue

            debug_counts["passed"] += 1
            session_date_used = session_date_used or row.get("session_date")
            rows.append(row)

        rows.sort(
            key=lambda item: (
                safe_float(item.get("ah_score")),
                safe_float(item.get("ah_dollar_volume")),
                safe_float(item.get("ah_volume")),
            ),
            reverse=True,
        )
        rows = rows[:max_symbols]

        if not rows:
            return {
                "scanner_id": self.id,
                "scanner_name": self.name,
                "saved": False,
                "message": "No afterhours rows met the filters to save.",
                "count": 0,
                "snapshot_dates": snapshot_store.list_snapshot_dates(self.id, "ah"),
                "debug": {
                    "reject_counts": debug_counts,
                    "reject_examples": debug_examples,
                    "filters": {
                        "max_symbols": max_symbols,
                        "min_price": min_price,
                        "max_price": max_price,
                        "min_volume": min_volume,
                        "min_gap_pct": min_gap_pct,
                        "min_dollar_volume": min_dollar_volume,
                        "hours_back": hours_back,
                    },
                },
            }

        trade_date = session_date_used or datetime.now(ET).strftime("%Y-%m-%d")
        payload = {
            "scanner_id": self.id,
            "session": "afterhours",
            "trade_date": trade_date,
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "filters": {
                    "max_symbols": max_symbols,
                    "min_price": min_price,
                    "max_price": max_price,
                    "min_volume": min_volume,
                    "min_gap_pct": min_gap_pct,
                    "min_dollar_volume": min_dollar_volume,
                    "hours_back": hours_back,
                },
                "reject_counts": debug_counts
            },
        }
        path = snapshot_store.save_snapshot(self.id, "ah", trade_date, payload)

        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "saved": True,
            "trade_date": trade_date,
            "count": len(rows),
            "path": path,
            "snapshot_dates": snapshot_store.list_snapshot_dates(self.id, "ah"),
            "top_rows": rows[:10],
        }

    async def run(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        requested_workflow = str(kwargs.get("workflow", "auto")).lower().strip()
        workflow = requested_workflow if requested_workflow != "auto" else choose_workflow()

        if workflow == "live":
            result = await self._run_live_only(polygon, snapshot_store, **kwargs)
        else:
            result = await self._run_combined(polygon, snapshot_store, **kwargs)

        result.setdefault("meta", {})
        result["meta"]["workflow_requested"] = requested_workflow
        result["meta"]["workflow_resolved"] = workflow
        result["meta"]["workflow_auto_rule"] = "combined before 07:30 America/Los_Angeles, live at or after 07:30"
        return result

    async def _run_live_only(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = int(kwargs.get("max_symbols", 30))
        min_price = float(kwargs.get("min_price", 0.5))
        max_price = float(kwargs.get("max_price", 20.0))
        min_volume = int(kwargs.get("min_volume", 500_000))
        min_gap_pct = float(kwargs.get("min_gap_pct", 3.0))
        min_pm_range_pct = float(kwargs.get("min_pm_range_pct", 4.5))
        min_pm_dollar_volume = float(kwargs.get("min_pm_dollar_volume", 500_000.0))
        min_compression_score = float(kwargs.get("min_compression_score", 0.0))
        min_breakout_score = float(kwargs.get("min_breakout_score", 0.0))
        min_short_interest_pct = float(kwargs.get("min_short_interest_pct", 0.0))
        min_turnover_pct = float(kwargs.get("min_turnover_pct", 0.0))
        max_float_shares_raw = kwargs.get("max_float_shares")
        max_float_shares = float(max_float_shares_raw) if max_float_shares_raw not in (None, "", 0, "0") else None
        low_float_only = str(kwargs.get("low_float_only", "false")).lower() in ("1", "true", "yes", "on")
        hours_back = int(kwargs.get("hours_back", 96))

        universe_map = await build_snapshot_universe(polygon, limit=max_symbols * 4)
        rows: List[Dict[str, Any]] = []
        debug_counts = make_filter_debug_counts()
        debug_counts["universe_count"] = len(universe_map)
        debug_examples: List[Dict[str, Any]] = []

        scan_items = list(universe_map.items())[: max_symbols * 6]
        debug_counts["scanned"] = len(scan_items)

        for symbol, snapshot in scan_items:
            row = await self._build_premarket_row(symbol, snapshot, polygon, hours_back=hours_back)
            if row is None:
                debug_counts["row_none"] += 1
                if len(debug_examples) < 15:
                    debug_examples.append({"symbol": symbol, "reason": "row_none_no_bars_or_session"})
                continue

            debug_counts["rows_built"] += 1
            reject_reason = filter_reject_reason(
                row,
                min_price,
                max_price,
                min_volume,
                min_gap_pct,
                min_pm_range_pct,
                min_pm_dollar_volume,
                min_compression_score,
                min_breakout_score,
                max_float_shares,
                low_float_only,
                min_short_interest_pct,
                min_turnover_pct,
            )
            if reject_reason is not None:
                debug_counts[reject_reason] = debug_counts.get(reject_reason, 0) + 1
                if len(debug_examples) < 15:
                    debug_examples.append(build_reject_example(symbol, reject_reason, row))
                continue

            debug_counts["passed"] += 1
            rows.append(row)

        print(
            "[overnight-runner/live] "
            f"universe={debug_counts['universe_count']} "
            f"scanned={debug_counts['scanned']} "
            f"built={debug_counts['rows_built']} "
            f"passed={debug_counts['passed']} "
            f"row_none={debug_counts['row_none']}",
            flush=True,
        )

        rows.sort(
            key=lambda item: (
                safe_float(item.get("runner_score")),
                safe_float(item.get("squeeze_rank")),
                safe_float(item.get("pm_dollar_volume")),
                safe_float(item.get("pm_volume")),
            ),
            reverse=True,
        )
        rows = rows[:max_symbols]

        latest_saved = snapshot_store.list_snapshot_dates(self.id, "ah")
        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "live",
            "trade_day": datetime.now(ET).strftime("%Y-%m-%d"),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "latest_saved_ah_date": latest_saved[0] if latest_saved else None,
                "snapshot_dates": latest_saved,
                "runner_type_counts": summarize_runner_types(rows),
                "debug": {
                    "counts": debug_counts,
                    "reject_examples": debug_examples,
                },
                "active_filters": build_active_filters(
                    min_price=min_price,
                    max_price=max_price,
                    min_volume=min_volume,
                    min_gap_pct=min_gap_pct,
                    min_pm_range_pct=min_pm_range_pct,
                    min_pm_dollar_volume=min_pm_dollar_volume,
                    min_compression_score=min_compression_score,
                    min_breakout_score=min_breakout_score,
                    max_float_shares=max_float_shares,
                    low_float_only=low_float_only,
                    min_short_interest_pct=min_short_interest_pct,
                    min_turnover_pct=min_turnover_pct,
                    hours_back=hours_back,
                ),
            },
        }

    async def _run_combined(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        max_symbols = int(kwargs.get("max_symbols", 30))
        min_price = float(kwargs.get("min_price", 0.5))
        max_price = float(kwargs.get("max_price", 20.0))
        min_volume = int(kwargs.get("min_volume", 500_000))
        min_gap_pct = float(kwargs.get("min_gap_pct", 3.0))
        min_pm_range_pct = float(kwargs.get("min_pm_range_pct", 4.5))
        min_pm_dollar_volume = float(kwargs.get("min_pm_dollar_volume", 500_000.0))
        min_compression_score = float(kwargs.get("min_compression_score", 0.0))
        min_breakout_score = float(kwargs.get("min_breakout_score", 0.0))
        min_short_interest_pct = float(kwargs.get("min_short_interest_pct", 0.0))
        min_turnover_pct = float(kwargs.get("min_turnover_pct", 0.0))
        max_float_shares_raw = kwargs.get("max_float_shares")
        max_float_shares = float(max_float_shares_raw) if max_float_shares_raw not in (None, "", 0, "0") else None
        low_float_only = str(kwargs.get("low_float_only", "false")).lower() in ("1", "true", "yes", "on")
        ah_date = str(kwargs.get("ah_date", "")).strip() or None
        hours_back = int(kwargs.get("hours_back", 96))

        ah_snapshot = (
            snapshot_store.load_snapshot(self.id, "ah", ah_date)
            if ah_date
            else snapshot_store.load_latest_snapshot(self.id, "ah")
        )
        if ah_snapshot is None:
            live_result = await self._run_live_only(polygon, snapshot_store, **kwargs)
            live_result.setdefault("meta", {})
            live_result["meta"]["combined_fallback"] = True
            live_result["meta"]["combined_fallback_reason"] = "No saved afterhours snapshot found"
            live_result["workflow"] = "live"
            return live_result

        saved_rows = ah_snapshot.get("rows") or []
        saved_map = {
            str(item.get("symbol", "")).upper(): item
            for item in saved_rows
            if item.get("symbol")
        }

        live_universe = await build_snapshot_universe(polygon, limit=max_symbols * 4)
        candidate_symbols = list(
            OrderedDict((symbol, None) for symbol in list(saved_map.keys()) + list(live_universe.keys())).keys()
        )

        rows: List[Dict[str, Any]] = []
        debug_counts = make_filter_debug_counts()
        debug_counts["saved_ah_count"] = len(saved_map)
        debug_counts["live_universe_count"] = len(live_universe)
        debug_counts["candidate_count"] = len(candidate_symbols)
        debug_examples: List[Dict[str, Any]] = []

        scan_symbols = candidate_symbols[: max_symbols * 8]
        debug_counts["scanned"] = len(scan_symbols)

        for symbol in scan_symbols:
            snapshot = live_universe.get(symbol, {})
            row = await self._build_combined_row(symbol, snapshot, polygon, saved_map.get(symbol), hours_back=hours_back)
            if row is None:
                debug_counts["row_none"] += 1
                if len(debug_examples) < 15:
                    debug_examples.append({"symbol": symbol, "reason": "row_none_no_bars_or_session"})
                continue

            debug_counts["rows_built"] += 1
            reject_reason = filter_reject_reason(
                row,
                min_price,
                max_price,
                min_volume,
                min_gap_pct,
                min_pm_range_pct,
                min_pm_dollar_volume,
                min_compression_score,
                min_breakout_score,
                max_float_shares,
                low_float_only,
                min_short_interest_pct,
                min_turnover_pct,
            )
            if reject_reason is not None:
                debug_counts[reject_reason] = debug_counts.get(reject_reason, 0) + 1
                if len(debug_examples) < 15:
                    debug_examples.append(build_reject_example(symbol, reject_reason, row))
                continue

            debug_counts["passed"] += 1
            rows.append(row)

        print(
            "[overnight-runner/combined] "
            f"saved_ah={debug_counts['saved_ah_count']} "
            f"live_universe={debug_counts['live_universe_count']} "
            f"candidates={debug_counts['candidate_count']} "
            f"scanned={debug_counts['scanned']} "
            f"built={debug_counts['rows_built']} "
            f"passed={debug_counts['passed']} "
            f"row_none={debug_counts['row_none']}",
            flush=True,
        )

        rows.sort(
            key=lambda item: (
                safe_float(item.get("runner_score")),
                safe_float(item.get("squeeze_rank")),
                safe_float(item.get("pm_dollar_volume")),
                safe_float(item.get("pm_volume")),
                safe_float(item.get("ah_score")),
            ),
            reverse=True,
        )
        rows = rows[:max_symbols]

        snapshot_dates = snapshot_store.list_snapshot_dates(self.id, "ah")
        return {
            "scanner_id": self.id,
            "scanner_name": self.name,
            "description": self.description,
            "workflow": "combined",
            "trade_day": datetime.now(ET).strftime("%Y-%m-%d"),
            "count": len(rows),
            "rows": rows,
            "meta": {
                "ah_trade_date": ah_snapshot.get("trade_date"),
                "snapshot_dates": snapshot_dates,
                "candidate_count": len(candidate_symbols),
                "runner_type_counts": summarize_runner_types(rows),
                "debug": {
                    "counts": debug_counts,
                    "reject_examples": debug_examples,
                },
                "active_filters": build_active_filters(
                    min_price=min_price,
                    max_price=max_price,
                    min_volume=min_volume,
                    min_gap_pct=min_gap_pct,
                    min_pm_range_pct=min_pm_range_pct,
                    min_pm_dollar_volume=min_pm_dollar_volume,
                    min_compression_score=min_compression_score,
                    min_breakout_score=min_breakout_score,
                    max_float_shares=max_float_shares,
                    low_float_only=low_float_only,
                    min_short_interest_pct=min_short_interest_pct,
                    min_turnover_pct=min_turnover_pct,
                    hours_back=hours_back,
                ),
            },
        }

    async def _build_afterhours_row(
        self,
        symbol: str,
        snapshot: Dict[str, Any],
        polygon: PolygonService,
        *,
        hours_back: int,
    ) -> Optional[Dict[str, Any]]:
        prev_close = safe_float((snapshot.get("prevDay") or {}).get("c"))
        day = snapshot.get("day") or {}
        last_trade = snapshot.get("lastTrade") or {}
        min_bar = snapshot.get("min") or {}

        fallback_last = safe_float(last_trade.get("p")) or safe_float(day.get("c")) or safe_float(min_bar.get("c"))
        last_price = fallback_last or await polygon.get_last_trade(symbol) or 0.0
        if last_price <= 0:
            return None

        bars = await polygon.get_recent_1m_bars(symbol, hours_back=hours_back)
        if not bars:
            return None

        session = parse_latest_afterhours_session(bars)
        if session is None:
            return None

        ah_gap_pct = pct_change(session["ah_last_close"], prev_close) if prev_close > 0 else 0.0
        ah_range_pct = pct_change(session["ah_high"], session["ah_low"]) if session["ah_low"] > 0 else 0.0
        ah_dollar_volume = calc_dollar_volume(session["ah_vwap_price"], session["ah_volume"])
        ah_compression_score = calc_compression_score(
            session["ah_high"],
            session["recent_closes"],
            session["recent_ranges"],
        )
        ah_score = calc_afterhours_score(
            ah_gap_pct,
            ah_range_pct,
            session["ah_volume"],
            ah_compression_score,
            ah_dollar_volume,
        )

        notes: List[str] = []
        if ah_gap_pct >= 8:
            notes.append("AH strong")
        if ah_range_pct >= 6:
            notes.append("AH range")
        if ah_compression_score >= 70:
            notes.append("AH compression")
        if ah_dollar_volume >= 1_000_000:
            notes.append("AH liquidity")

        return {
            "symbol": symbol,
            "session_date": session["session_date"],
            "last_price": round(last_price, 4),
            "prev_close": round(prev_close, 4),
            "ah_gap_pct": round(ah_gap_pct, 2),
            "ah_range_pct": round(ah_range_pct, 2),
            "ah_volume": int(session["ah_volume"]),
            "ah_dollar_volume": round(ah_dollar_volume, 2),
            "ah_score": round(ah_score, 2),
            "compression_score": round(ah_compression_score, 2),
            "notes": notes,
            "runner_type": "overnight",
            "extra": {
                "ah_high": round(session["ah_high"], 4),
                "ah_low": round(session["ah_low"], 4),
                "ah_last_close": round(session["ah_last_close"], 4),
            },
        }

    async def _build_premarket_row(
        self,
        symbol: str,
        snapshot: Dict[str, Any],
        polygon: PolygonService,
        *,
        hours_back: int,
    ) -> Optional[Dict[str, Any]]:
        prev_close = safe_float((snapshot.get("prevDay") or {}).get("c"))
        day = snapshot.get("day") or {}
        last_trade = snapshot.get("lastTrade") or {}
        min_bar = snapshot.get("min") or {}

        fallback_last = safe_float(last_trade.get("p")) or safe_float(day.get("c")) or safe_float(min_bar.get("c"))
        last_price = fallback_last or await polygon.get_last_trade(symbol) or 0.0
        if last_price <= 0:
            return None

        bars = await polygon.get_recent_1m_bars(symbol, hours_back=hours_back)
        if not bars:
            return None

        pm_session = parse_latest_premarket_session(bars)
        session_source = "premarket"
        if pm_session is None:
            # No AH/PM dependency: during regular hours, rank from today's live session.
            pm_session = parse_latest_regular_session(bars)
            session_source = "regular"
        if pm_session is None:
            # Final fallback so the scanner does not go empty just because a session window is missing.
            pm_session = parse_latest_any_session(bars)
            session_source = "recent"
        if pm_session is None:
            return None

        details = await polygon.get_ticker_details(symbol)
        share_stats = extract_share_stats(details)
        float_shares = share_stats.get("float_shares")
        shares_outstanding = share_stats.get("shares_outstanding")
        short_interest_pct = share_stats.get("short_interest_pct")

        pm_gap_pct = pct_change(pm_session["pm_last_close"], prev_close) if prev_close > 0 else pct_change(last_price, prev_close)
        pm_range_pct = pct_change(pm_session["pm_high"], pm_session["pm_low"]) if pm_session["pm_low"] > 0 else 0.0
        pm_dollar_volume = calc_dollar_volume(pm_session["pm_vwap_price"], pm_session["pm_volume"])
        compression_score = calc_compression_score(
            pm_session["pm_high"],
            pm_session["recent_closes"],
            pm_session["recent_ranges"],
        )
        breakout_score = calc_breakout_score(
            pm_session["pm_high"],
            pm_session["pm_last_close"],
            safe_float(day.get("o")),
        )
        volume_accel_pct = calc_volume_accel_pct(pm_session["recent_volumes"])
        turnover_pct = calc_turnover_pct(pm_session["pm_volume"], float_shares)
        short_rank = calc_short_interest_rank(short_interest_pct)
        turnover_rank = calc_turnover_rank(turnover_pct)
        squeeze_rank = calc_squeeze_rank(short_rank, turnover_rank, breakout_score, volume_accel_pct, compression_score)

        pm_runner_score = calc_runner_score(
            gap_pct=pm_gap_pct,
            pm_range_pct=pm_range_pct,
            pm_volume=pm_session["pm_volume"],
            compression_score=compression_score,
            breakout_score=breakout_score,
            float_shares=float_shares,
            pm_dollar_volume=pm_dollar_volume,
            volume_accel_pct=volume_accel_pct,
            short_interest_pct=short_interest_pct,
            turnover_pct=turnover_pct,
            squeeze_rank=squeeze_rank,
        )

        runner_type = classify_runner_type(
            ah_score=0.0,
            pm_volume=pm_session["pm_volume"],
            pm_dollar_volume=pm_dollar_volume,
            pm_range_pct=pm_range_pct,
            compression_score=compression_score,
            breakout_score=breakout_score,
            volume_accel_pct=volume_accel_pct,
            has_saved_ah=False,
            short_interest_pct=short_interest_pct,
            turnover_pct=turnover_pct,
        )
        runner_score = calc_final_runner_score(
            runner_type=runner_type,
            ah_score=0.0,
            pm_runner_score=pm_runner_score,
            breakout_score=breakout_score,
            compression_score=compression_score,
            pm_range_pct=pm_range_pct,
            volume_accel_pct=volume_accel_pct,
            pm_dollar_volume=pm_dollar_volume,
            has_saved_ah=False,
            squeeze_rank=squeeze_rank,
        )

        notes: List[str] = []
        if pm_gap_pct >= 10:
            notes.append("Strong gap")
        if pm_range_pct >= 8:
            notes.append("Wide PM range")
        if compression_score >= 70:
            notes.append("Compression near highs")
        if breakout_score >= 70:
            notes.append("Near PMH")
        if volume_accel_pct >= 75:
            notes.append("Volume accel")
        if pm_dollar_volume >= 2_000_000:
            notes.append("High liquidity")
        if float_shares and float_shares <= 50_000_000:
            notes.append("Lower float")
        if short_interest_pct is not None and short_interest_pct >= 15:
            notes.append("Short interest")
        if turnover_pct >= 25:
            notes.append("Turnover")

        return {
            "symbol": symbol,
            "last_price": round(last_price, 4),
            "prev_close": round(prev_close, 4),
            "pm_gap_pct": round(pm_gap_pct, 2),
            "gap_pct": round(pm_gap_pct, 2),
            "pm_volume": int(pm_session["pm_volume"]),
            "pm_dollar_volume": round(pm_dollar_volume, 2),
            "pm_range_pct": round(pm_range_pct, 2),
            "compression_score": round(compression_score, 2),
            "breakout_score": round(breakout_score, 2),
            "volume_accel_pct": round(volume_accel_pct, 2),
            "runner_type": runner_type,
            "runner_score": round(runner_score, 2),
            "pm_runner_score": round(pm_runner_score, 2),
            "float_shares": int(float_shares) if float_shares else None,
            "shares_outstanding": int(shares_outstanding) if shares_outstanding else None,
            "short_interest_pct": round(short_interest_pct, 2) if short_interest_pct is not None else None,
            "short_interest_rank": round(short_rank, 2),
            "turnover_pct": round(turnover_pct, 2),
            "turnover_rank": round(turnover_rank, 2),
            "squeeze_rank": round(squeeze_rank, 2),
            "has_saved_ah": False,
            "notes": notes,
            "source": f"overnight_runner_live_{session_source}",
            "extra": {
                "session_source": session_source,
                "pm_high": round(pm_session["pm_high"], 4),
                "pm_low": round(pm_session["pm_low"], 4),
                "pm_last_close": round(pm_session["pm_last_close"], 4),
                "pm_session_date": pm_session["session_date"],
            },
        }

    async def _build_combined_row(
        self,
        symbol: str,
        snapshot: Dict[str, Any],
        polygon: PolygonService,
        saved_ah_row: Optional[Dict[str, Any]],
        *,
        hours_back: int,
    ) -> Optional[Dict[str, Any]]:
        bars = await polygon.get_recent_1m_bars(symbol, hours_back=hours_back)
        if not bars:
            return None

        pm_session = parse_latest_premarket_session(bars)
        session_source = "premarket"
        if pm_session is None:
            # No AH/PM dependency: combined mode falls back to today's live session.
            pm_session = parse_latest_regular_session(bars)
            session_source = "regular"
        if pm_session is None:
            pm_session = parse_latest_any_session(bars)
            session_source = "recent"
        if pm_session is None:
            return None

        snapshot_prev_close = safe_float((snapshot.get("prevDay") or {}).get("c"))
        prev_close = snapshot_prev_close or safe_float((saved_ah_row or {}).get("prev_close"))

        day = snapshot.get("day") or {}
        last_trade = snapshot.get("lastTrade") or {}
        min_bar = snapshot.get("min") or {}
        fallback_last = safe_float(last_trade.get("p")) or safe_float(day.get("c")) or safe_float(min_bar.get("c"))
        last_price = fallback_last or safe_float(pm_session["pm_last_close"]) or await polygon.get_last_trade(symbol) or 0.0
        if last_price <= 0:
            return None

        details = await polygon.get_ticker_details(symbol)
        share_stats = extract_share_stats(details)
        float_shares = share_stats.get("float_shares")
        shares_outstanding = share_stats.get("shares_outstanding")
        short_interest_pct = share_stats.get("short_interest_pct")

        pm_gap_pct = pct_change(pm_session["pm_last_close"], prev_close) if prev_close > 0 else 0.0
        pm_range_pct = pct_change(pm_session["pm_high"], pm_session["pm_low"]) if pm_session["pm_low"] > 0 else 0.0
        pm_dollar_volume = calc_dollar_volume(pm_session["pm_vwap_price"], pm_session["pm_volume"])
        compression_score = calc_compression_score(
            pm_session["pm_high"],
            pm_session["recent_closes"],
            pm_session["recent_ranges"],
        )
        breakout_score = calc_breakout_score(
            pm_session["pm_high"],
            pm_session["pm_last_close"],
            safe_float(day.get("o")),
        )
        volume_accel_pct = calc_volume_accel_pct(pm_session["recent_volumes"])
        turnover_pct = calc_turnover_pct(pm_session["pm_volume"], float_shares)
        short_rank = calc_short_interest_rank(short_interest_pct)
        turnover_rank = calc_turnover_rank(turnover_pct)
        squeeze_rank = calc_squeeze_rank(short_rank, turnover_rank, breakout_score, volume_accel_pct, compression_score)

        pm_runner_score = calc_runner_score(
            gap_pct=pm_gap_pct,
            pm_range_pct=pm_range_pct,
            pm_volume=pm_session["pm_volume"],
            compression_score=compression_score,
            breakout_score=breakout_score,
            float_shares=float_shares,
            pm_dollar_volume=pm_dollar_volume,
            volume_accel_pct=volume_accel_pct,
            short_interest_pct=short_interest_pct,
            turnover_pct=turnover_pct,
            squeeze_rank=squeeze_rank,
        )

        ah_gap_pct = safe_float((saved_ah_row or {}).get("ah_gap_pct"))
        ah_range_pct = safe_float((saved_ah_row or {}).get("ah_range_pct"))
        ah_volume = int(safe_float((saved_ah_row or {}).get("ah_volume")))
        ah_dollar_volume = safe_float((saved_ah_row or {}).get("ah_dollar_volume"))
        ah_score = safe_float((saved_ah_row or {}).get("ah_score"))
        has_saved_ah = saved_ah_row is not None

        runner_type = classify_runner_type(
            ah_score=ah_score,
            pm_volume=pm_session["pm_volume"],
            pm_dollar_volume=pm_dollar_volume,
            pm_range_pct=pm_range_pct,
            compression_score=compression_score,
            breakout_score=breakout_score,
            volume_accel_pct=volume_accel_pct,
            has_saved_ah=has_saved_ah,
            short_interest_pct=short_interest_pct,
            turnover_pct=turnover_pct,
        )
        runner_score = calc_final_runner_score(
            runner_type=runner_type,
            ah_score=ah_score,
            pm_runner_score=pm_runner_score,
            breakout_score=breakout_score,
            compression_score=compression_score,
            pm_range_pct=pm_range_pct,
            volume_accel_pct=volume_accel_pct,
            pm_dollar_volume=pm_dollar_volume,
            has_saved_ah=has_saved_ah,
            squeeze_rank=squeeze_rank,
        )

        notes: List[str] = []
        if has_saved_ah:
            notes.append("Saved AH")
        if ah_gap_pct >= 8:
            notes.append("AH strong")
        if pm_gap_pct >= 8:
            notes.append("PM strong")
        if compression_score >= 70:
            notes.append("Compression")
        if breakout_score >= 70:
            notes.append("Near PMH")
        if volume_accel_pct >= 75:
            notes.append("Volume accel")
        if pm_dollar_volume >= 2_000_000:
            notes.append("High liquidity")
        if float_shares and float_shares <= 50_000_000:
            notes.append("Lower float")
        if short_interest_pct is not None and short_interest_pct >= 15:
            notes.append("Short interest")
        if turnover_pct >= 25:
            notes.append("Turnover")
        if runner_type == "momentum" and not has_saved_ah:
            notes.append("PM-only runner")

        return {
            "symbol": symbol,
            "last_price": round(last_price, 4),
            "prev_close": round(prev_close, 4),
            "ah_gap_pct": round(ah_gap_pct, 2),
            "ah_range_pct": round(ah_range_pct, 2),
            "ah_volume": ah_volume,
            "ah_dollar_volume": round(ah_dollar_volume, 2),
            "ah_score": round(ah_score, 2),
            "pm_gap_pct": round(pm_gap_pct, 2),
            "gap_pct": round(pm_gap_pct, 2),
            "pm_volume": int(pm_session["pm_volume"]),
            "pm_dollar_volume": round(pm_dollar_volume, 2),
            "pm_range_pct": round(pm_range_pct, 2),
            "compression_score": round(compression_score, 2),
            "breakout_score": round(breakout_score, 2),
            "volume_accel_pct": round(volume_accel_pct, 2),
            "runner_type": runner_type,
            "runner_score": round(runner_score, 2),
            "pm_runner_score": round(pm_runner_score, 2),
            "float_shares": int(float_shares) if float_shares else None,
            "shares_outstanding": int(shares_outstanding) if shares_outstanding else None,
            "short_interest_pct": round(short_interest_pct, 2) if short_interest_pct is not None else None,
            "short_interest_rank": round(short_rank, 2),
            "turnover_pct": round(turnover_pct, 2),
            "turnover_rank": round(turnover_rank, 2),
            "squeeze_rank": round(squeeze_rank, 2),
            "has_saved_ah": has_saved_ah,
            "notes": notes,
            "source": f"overnight_runner_combined_{session_source}",
            "extra": {
                "session_source": session_source,
                "pm_high": round(pm_session["pm_high"], 4),
                "pm_low": round(pm_session["pm_low"], 4),
                "pm_last_close": round(pm_session["pm_last_close"], 4),
                "pm_session_date": pm_session["session_date"],
                "ah_session_date": (saved_ah_row or {}).get("session_date"),
            },
        }


async def build_snapshot_universe(polygon: PolygonService, limit: int = 160) -> "OrderedDict[str, Dict[str, Any]]":
    gainers = await polygon.get_snapshot_gainers(limit=limit)
    actives = await polygon.get_snapshot_actives(limit=limit)

    losers: List[Dict[str, Any]] = []
    get_losers = getattr(polygon, "get_snapshot_losers", None)
    if callable(get_losers):
        try:
            losers = await get_losers(limit=limit)
        except Exception:
            losers = []

    universe_map: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
    for item in gainers + actives + losers:
        symbol = str(item.get("ticker", "")).upper().strip()
        if symbol and symbol not in universe_map:
            universe_map[symbol] = item
    return universe_map



def bar_time_ms(bar: Dict[str, Any]) -> Optional[int]:
    raw = bar.get("t", bar.get("time"))
    try:
        return int(raw) if raw is not None else None
    except Exception:
        return None


def bar_open(bar: Dict[str, Any]) -> float:
    return safe_float(bar.get("o", bar.get("open")))


def bar_high(bar: Dict[str, Any]) -> float:
    return safe_float(bar.get("h", bar.get("high")))


def bar_low(bar: Dict[str, Any]) -> float:
    return safe_float(bar.get("l", bar.get("low")))


def bar_close(bar: Dict[str, Any]) -> float:
    return safe_float(bar.get("c", bar.get("close")))


def bar_volume(bar: Dict[str, Any]) -> float:
    return safe_float(bar.get("v", bar.get("volume")))


def normalize_scanner_bars(bars: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Accepts either Polygon raw bars (t/o/h/l/c/v) or your app-normalized bars
    (time/open/high/low/close/volume). Returns one consistent t/o/h/l/c/v shape.
    This is the key scanner fix: PolygonService.get_recent_1m_bars returns the
    app-normalized shape, while the scanner session parser was reading only t/o/h/l/c/v.
    """
    out: List[Dict[str, Any]] = []
    for bar in bars or []:
        ts = bar_time_ms(bar)
        o = bar_open(bar)
        h = bar_high(bar)
        l = bar_low(bar)
        c = bar_close(bar)
        v = bar_volume(bar)
        if ts is None or h <= 0 or l <= 0 or c <= 0:
            continue
        out.append({"t": ts, "o": o, "h": h, "l": l, "c": c, "v": v})
    out.sort(key=lambda item: item["t"])
    return out


def parse_latest_afterhours_session(bars: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    bars = normalize_scanner_bars(bars)
    sessions: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()

    for bar in bars:
        ts = bar["t"]
        dt_et = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).astimezone(ET)
        hhmm = dt_et.hour * 100 + dt_et.minute
        if 1600 <= hhmm <= 2359:
            key = dt_et.strftime("%Y-%m-%d")
            sessions.setdefault(key, []).append(bar)

    if not sessions:
        return None

    session_date = next(reversed(sessions.keys()))
    ah_bars = sessions[session_date]
    if not ah_bars:
        return None

    recent = ah_bars[-8:] if len(ah_bars) >= 8 else ah_bars
    return {
        "session_date": session_date,
        "ah_high": max(bar_high(item) for item in ah_bars),
        "ah_low": min(bar_low(item) for item in ah_bars),
        "ah_volume": sum(bar_volume(item) for item in ah_bars),
        "ah_last_close": bar_close(ah_bars[-1]),
        "ah_vwap_price": calc_weighted_avg_price(ah_bars),
        "recent_closes": [bar_close(item) for item in recent],
        "recent_ranges": [max(bar_high(item) - bar_low(item), 0.0) for item in recent],
    }


def parse_latest_premarket_session(bars: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    bars = normalize_scanner_bars(bars)
    sessions: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()

    for bar in bars:
        ts = bar["t"]
        dt_et = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).astimezone(ET)
        hhmm = dt_et.hour * 100 + dt_et.minute
        if 400 <= hhmm <= 929:
            key = dt_et.strftime("%Y-%m-%d")
            sessions.setdefault(key, []).append(bar)

    if not sessions:
        return None

    session_date = next(reversed(sessions.keys()))
    pm_bars = sessions[session_date]
    if not pm_bars:
        return None

    recent = pm_bars[-10:] if len(pm_bars) >= 10 else pm_bars
    recent_volumes = [bar_volume(item) for item in recent]
    return {
        "session_date": session_date,
        "pm_high": max(bar_high(item) for item in pm_bars),
        "pm_low": min(bar_low(item) for item in pm_bars),
        "pm_volume": sum(bar_volume(item) for item in pm_bars),
        "pm_last_close": bar_close(pm_bars[-1]),
        "pm_vwap_price": calc_weighted_avg_price(pm_bars),
        "recent_closes": [bar_close(item) for item in recent],
        "recent_ranges": [max(bar_high(item) - bar_low(item), 0.0) for item in recent],
        "recent_volumes": recent_volumes,
    }


def build_pm_like_session_from_bars(bars: List[Dict[str, Any]], session_date: str) -> Optional[Dict[str, Any]]:
    bars = normalize_scanner_bars(bars)
    if not bars:
        return None

    recent = bars[-10:] if len(bars) >= 10 else bars
    recent_volumes = [bar_volume(item) for item in recent]
    return {
        "session_date": session_date,
        "pm_high": max(bar_high(item) for item in bars),
        "pm_low": min(bar_low(item) for item in bars),
        "pm_volume": sum(bar_volume(item) for item in bars),
        "pm_last_close": bar_close(bars[-1]),
        "pm_vwap_price": calc_weighted_avg_price(bars),
        "recent_closes": [bar_close(item) for item in recent],
        "recent_ranges": [max(bar_high(item) - bar_low(item), 0.0) for item in recent],
        "recent_volumes": recent_volumes,
    }


def parse_latest_regular_session(bars: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    bars = normalize_scanner_bars(bars)
    sessions: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()

    for bar in bars:
        ts = bar["t"]
        dt_et = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).astimezone(ET)
        hhmm = dt_et.hour * 100 + dt_et.minute
        if 930 <= hhmm <= 1600:
            key = dt_et.strftime("%Y-%m-%d")
            sessions.setdefault(key, []).append(bar)

    if not sessions:
        return None

    session_date = next(reversed(sessions.keys()))
    return build_pm_like_session_from_bars(sessions[session_date], session_date)


def parse_latest_any_session(bars: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    valid_bars = normalize_scanner_bars(bars)
    if not valid_bars:
        return None

    latest = valid_bars[-120:] if len(valid_bars) > 120 else valid_bars
    last_dt_et = datetime.fromtimestamp(latest[-1]["t"] / 1000, tz=timezone.utc).astimezone(ET)
    return build_pm_like_session_from_bars(latest, last_dt_et.strftime("%Y-%m-%d"))


def calc_weighted_avg_price(bars: List[Dict[str, Any]]) -> float:
    total_pv = 0.0
    total_v = 0.0
    fallback_closes: List[float] = []

    for item in bars:
        close_price = bar_close(item)
        volume = bar_volume(item)
        if close_price > 0:
            fallback_closes.append(close_price)
        if close_price > 0 and volume > 0:
            total_pv += close_price * volume
            total_v += volume

    if total_v > 0:
        return total_pv / total_v
    if fallback_closes:
        return sum(fallback_closes) / len(fallback_closes)
    return 0.0


def extract_share_stats(details: Dict[str, Any]) -> Dict[str, Optional[float]]:
    details = details or {}
    market_cap = first_number(
        details.get("market_cap"),
        nested_get(details, "branding", "market_cap"),
        nested_get(details, "results", "market_cap"),
    )

    raw_float = first_number(
        details.get("float_shares"),
        details.get("public_float"),
        details.get("float"),
        nested_get(details, "share_class_shares_outstanding"),
        nested_get(details, "weighted_shares_outstanding"),
        nested_get(details, "results", "float_shares"),
        nested_get(details, "results", "public_float"),
        nested_get(details, "results", "share_class_shares_outstanding"),
        nested_get(details, "results", "weighted_shares_outstanding"),
    )

    shares_outstanding = first_number(
        details.get("share_class_shares_outstanding"),
        details.get("weighted_shares_outstanding"),
        nested_get(details, "results", "share_class_shares_outstanding"),
        nested_get(details, "results", "weighted_shares_outstanding"),
    )

    short_interest_pct = first_number(
        details.get("short_interest_pct"),
        details.get("short_percent_of_float"),
        details.get("percent_of_float_short"),
        details.get("short_float_percent"),
        nested_get(details, "results", "short_interest_pct"),
        nested_get(details, "results", "short_percent_of_float"),
        nested_get(details, "results", "percent_of_float_short"),
    )

    float_shares = raw_float
    if float_shares is None and market_cap and shares_outstanding:
        float_shares = shares_outstanding

    return {
        "float_shares": float_shares,
        "shares_outstanding": shares_outstanding,
        "short_interest_pct": short_interest_pct,
    }


def calc_compression_score(session_high: float, recent_closes: List[float], recent_ranges: List[float]) -> float:
    if session_high <= 0 or not recent_closes or not recent_ranges:
        return 0.0

    avg_close = sum(recent_closes) / len(recent_closes)
    avg_range = sum(recent_ranges) / len(recent_ranges)
    distance_from_high_pct = abs((session_high - avg_close) / session_high) * 100.0
    average_range_pct = (avg_range / session_high) * 100.0

    close_to_high_score = max(0.0, 100.0 - distance_from_high_pct * 10.0)
    tight_range_score = max(0.0, 100.0 - average_range_pct * 40.0)
    return close_to_high_score * 0.65 + tight_range_score * 0.35


def calc_breakout_score(pm_high: float, pm_last_close: float, regular_open: float) -> float:
    if pm_high <= 0 or pm_last_close <= 0:
        return 0.0

    if pm_last_close >= pm_high:
        near_pmh_score = 100.0
    else:
        pmh_distance_pct = abs((pm_high - pm_last_close) / pm_high) * 100.0
        near_pmh_score = max(0.0, 100.0 - pmh_distance_pct * 12.0)

    if regular_open > 0:
        open_distance_pct = abs((pm_last_close - regular_open) / pm_last_close) * 100.0
        open_strength_score = max(0.0, 100.0 - open_distance_pct * 10.0)
    else:
        open_strength_score = 0.0

    return near_pmh_score * 0.7 + open_strength_score * 0.3


def calc_afterhours_score(
    ah_gap_pct: float,
    ah_range_pct: float,
    ah_volume: float,
    compression_score: float,
    ah_dollar_volume: float,
) -> float:
    gap_score = min(max(ah_gap_pct * 4.5, 0.0), 100.0)
    range_score = min(max(ah_range_pct * 8.0, 0.0), 100.0)
    volume_score = min(100.0, math.log10(max(ah_volume, 1.0)) * 20.0)
    dollar_volume_score = min(100.0, math.log10(max(ah_dollar_volume, 1.0)) * 16.0)
    return (
        gap_score * 0.30
        + range_score * 0.18
        + volume_score * 0.16
        + dollar_volume_score * 0.12
        + compression_score * 0.24
    )


def calc_runner_score(
    gap_pct: float,
    pm_range_pct: float,
    pm_volume: float,
    compression_score: float,
    breakout_score: float,
    float_shares: Optional[float],
    pm_dollar_volume: float,
    volume_accel_pct: float,
    short_interest_pct: Optional[float],
    turnover_pct: float,
    squeeze_rank: float,
) -> float:
    gap_score = min(max(gap_pct * 4.5, 0.0), 100.0)
    range_score = min(max(pm_range_pct * 7.0, 0.0), 100.0)
    volume_score = min(100.0, math.log10(max(pm_volume, 1.0)) * 20.0)
    dollar_volume_score = min(100.0, math.log10(max(pm_dollar_volume, 1.0)) * 16.0)
    accel_score = min(100.0, max(volume_accel_pct, 0.0) * 0.6)
    short_score = calc_short_interest_rank(short_interest_pct)
    turnover_score = calc_turnover_rank(turnover_pct)

    float_score = 50.0
    if float_shares and float_shares > 0:
        if float_shares <= 10_000_000:
            float_score = 100.0
        elif float_shares <= 25_000_000:
            float_score = 85.0
        elif float_shares <= 50_000_000:
            float_score = 70.0
        elif float_shares <= 100_000_000:
            float_score = 55.0
        else:
            float_score = 35.0

    return (
        gap_score * 0.16
        + range_score * 0.14
        + volume_score * 0.12
        + dollar_volume_score * 0.12
        + compression_score * 0.12
        + breakout_score * 0.14
        + accel_score * 0.05
        + float_score * 0.05
        + short_score * 0.04
        + turnover_score * 0.03
        + squeeze_rank * 0.03
    )


def calc_short_interest_rank(short_interest_pct: Optional[float]) -> float:
    if short_interest_pct is None or short_interest_pct <= 0:
        return 0.0
    if short_interest_pct >= 40:
        return 100.0
    if short_interest_pct >= 30:
        return 88.0 + (short_interest_pct - 30.0) * 1.2
    if short_interest_pct >= 20:
        return 70.0 + (short_interest_pct - 20.0) * 1.8
    if short_interest_pct >= 10:
        return 45.0 + (short_interest_pct - 10.0) * 2.5
    return min(40.0, short_interest_pct * 4.0)


def calc_turnover_pct(volume: float, float_shares: Optional[float]) -> float:
    if volume <= 0 or float_shares is None or float_shares <= 0:
        return 0.0
    return (volume / float_shares) * 100.0


def calc_turnover_rank(turnover_pct: float) -> float:
    if turnover_pct <= 0:
        return 0.0
    if turnover_pct >= 100:
        return 100.0
    if turnover_pct >= 50:
        return 85.0 + ((turnover_pct - 50.0) / 50.0) * 15.0
    if turnover_pct >= 20:
        return 60.0 + ((turnover_pct - 20.0) / 30.0) * 25.0
    if turnover_pct >= 10:
        return 35.0 + ((turnover_pct - 10.0) / 10.0) * 25.0
    return min(30.0, turnover_pct * 3.0)


def calc_squeeze_rank(
    short_rank: float,
    turnover_rank: float,
    breakout_score: float,
    volume_accel_pct: float,
    compression_score: float,
) -> float:
    accel_score = min(100.0, max(volume_accel_pct, 0.0) * 0.6)
    return min(
        100.0,
        short_rank * 0.38
        + turnover_rank * 0.30
        + breakout_score * 0.17
        + accel_score * 0.10
        + compression_score * 0.05,
    )


def classify_runner_type(
    ah_score: float,
    pm_volume: float,
    pm_dollar_volume: float,
    pm_range_pct: float,
    compression_score: float,
    breakout_score: float,
    volume_accel_pct: float,
    has_saved_ah: bool,
    short_interest_pct: Optional[float],
    turnover_pct: float,
) -> str:
    momentum_signals = 0
    overnight_signals = 0

    if pm_volume >= 1_000_000:
        momentum_signals += 1
    if pm_dollar_volume >= 2_000_000:
        momentum_signals += 1
    if pm_range_pct >= 10:
        momentum_signals += 1
    if volume_accel_pct >= 75:
        momentum_signals += 1
    if breakout_score >= 75:
        momentum_signals += 1
    if turnover_pct >= 20:
        momentum_signals += 1
    if short_interest_pct is not None and short_interest_pct >= 20:
        momentum_signals += 1

    if has_saved_ah:
        overnight_signals += 1
    if ah_score >= 55:
        overnight_signals += 1
    if compression_score >= 65:
        overnight_signals += 1
    if breakout_score >= 60:
        overnight_signals += 1
    if pm_range_pct < 12:
        overnight_signals += 1

    if momentum_signals > overnight_signals:
        return "momentum"
    return "overnight"


def calc_final_runner_score(
    runner_type: str,
    ah_score: float,
    pm_runner_score: float,
    breakout_score: float,
    compression_score: float,
    pm_range_pct: float,
    volume_accel_pct: float,
    pm_dollar_volume: float,
    has_saved_ah: bool,
    squeeze_rank: float,
) -> float:
    dollar_vol_score = min(100.0, math.log10(max(pm_dollar_volume, 1.0)) * 18.0)
    accel_score = min(100.0, max(volume_accel_pct, 0.0) * 0.6)
    range_score = min(100.0, max(pm_range_pct, 0.0) * 7.0)
    ah_bonus = 8.0 if has_saved_ah else 0.0

    if runner_type == "momentum":
        score = (
            pm_runner_score * 0.40
            + breakout_score * 0.18
            + range_score * 0.10
            + accel_score * 0.12
            + dollar_vol_score * 0.08
            + squeeze_rank * 0.12
        )
    else:
        score = (
            ah_score * 0.24
            + pm_runner_score * 0.28
            + compression_score * 0.18
            + breakout_score * 0.13
            + dollar_vol_score * 0.05
            + squeeze_rank * 0.04
            + ah_bonus
        )

    return min(100.0, score)


def make_filter_debug_counts() -> Dict[str, int]:
    return {
        "universe_count": 0,
        "saved_ah_count": 0,
        "live_universe_count": 0,
        "candidate_count": 0,
        "scanned": 0,
        "row_none": 0,
        "rows_built": 0,
        "price": 0,
        "volume": 0,
        "gap": 0,
        "range": 0,
        "dollar_volume": 0,
        "compression": 0,
        "breakout": 0,
        "low_float": 0,
        "max_float": 0,
        "short_interest": 0,
        "turnover": 0,
        "passed": 0,
    }


def filter_reject_reason(
    row: Dict[str, Any],
    min_price: float,
    max_price: float,
    min_volume: int,
    min_gap_pct: float,
    min_pm_range_pct: float,
    min_pm_dollar_volume: float,
    min_compression_score: float = 0.0,
    min_breakout_score: float = 0.0,
    max_float_shares: Optional[float] = None,
    low_float_only: bool = False,
    min_short_interest_pct: float = 0.0,
    min_turnover_pct: float = 0.0,
) -> Optional[str]:
    last_price = safe_float(row.get("last_price"))
    pm_volume = int(safe_float(row.get("pm_volume")))
    gap_pct = safe_float(row.get("pm_gap_pct") if row.get("pm_gap_pct") is not None else row.get("gap_pct"))
    pm_range_pct = safe_float(row.get("pm_range_pct"))
    pm_dollar_volume = safe_float(row.get("pm_dollar_volume"))
    compression_score = safe_float(row.get("compression_score"))
    breakout_score = safe_float(row.get("breakout_score"))
    float_shares_raw = row.get("float_shares")
    float_shares = safe_float(float_shares_raw) if float_shares_raw is not None else None
    short_interest_pct = row.get("short_interest_pct")
    short_interest_pct = safe_float(short_interest_pct) if short_interest_pct is not None else None
    turnover_pct = safe_float(row.get("turnover_pct"))
    ah_score = safe_float(row.get("ah_score"))
    has_saved_ah = bool(row.get("has_saved_ah"))

    if last_price < min_price or last_price > max_price:
        return "price"
    if pm_volume < min_volume:
        return "volume"

    gap_ok = gap_pct >= min_gap_pct
    combined_ah_override = has_saved_ah and ah_score >= max(50.0, min_breakout_score)
    if not gap_ok and not combined_ah_override:
        return "gap"

    if pm_range_pct < min_pm_range_pct and not combined_ah_override:
        return "range"
    if pm_dollar_volume < min_pm_dollar_volume and not combined_ah_override:
        return "dollar_volume"
    if compression_score < min_compression_score:
        return "compression"
    if breakout_score < min_breakout_score and not combined_ah_override:
        return "breakout"
    if low_float_only and (float_shares is None or float_shares > 50_000_000):
        return "low_float"
    if max_float_shares is not None and (float_shares is None or float_shares > max_float_shares):
        return "max_float"
    if min_short_interest_pct > 0 and (short_interest_pct is None or short_interest_pct < min_short_interest_pct):
        return "short_interest"
    if min_turnover_pct > 0 and turnover_pct < min_turnover_pct:
        return "turnover"
    return None


def build_reject_example(symbol: str, reason: str, row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "symbol": symbol,
        "reason": reason,
        "last_price": round(safe_float(row.get("last_price")), 4),
        "pm_volume": int(safe_float(row.get("pm_volume"))),
        "gap_pct": round(safe_float(row.get("pm_gap_pct") if row.get("pm_gap_pct") is not None else row.get("gap_pct")), 2),
        "pm_range_pct": round(safe_float(row.get("pm_range_pct")), 2),
        "pm_dollar_volume": round(safe_float(row.get("pm_dollar_volume")), 2),
        "compression_score": round(safe_float(row.get("compression_score")), 2),
        "breakout_score": round(safe_float(row.get("breakout_score")), 2),
        "runner_score": round(safe_float(row.get("runner_score")), 2),
        "source": row.get("source"),
    }


def row_passes_filters(
    row: Dict[str, Any],
    min_price: float,
    max_price: float,
    min_volume: int,
    min_gap_pct: float,
    min_pm_range_pct: float,
    min_pm_dollar_volume: float,
    min_compression_score: float = 0.0,
    min_breakout_score: float = 0.0,
    max_float_shares: Optional[float] = None,
    low_float_only: bool = False,
    min_short_interest_pct: float = 0.0,
    min_turnover_pct: float = 0.0,
) -> bool:
    last_price = safe_float(row.get("last_price"))
    pm_volume = int(safe_float(row.get("pm_volume")))
    gap_pct = safe_float(row.get("pm_gap_pct") if row.get("pm_gap_pct") is not None else row.get("gap_pct"))
    pm_range_pct = safe_float(row.get("pm_range_pct"))
    pm_dollar_volume = safe_float(row.get("pm_dollar_volume"))
    compression_score = safe_float(row.get("compression_score"))
    breakout_score = safe_float(row.get("breakout_score"))
    float_shares_raw = row.get("float_shares")
    float_shares = safe_float(float_shares_raw) if float_shares_raw is not None else None
    short_interest_pct = row.get("short_interest_pct")
    short_interest_pct = safe_float(short_interest_pct) if short_interest_pct is not None else None
    turnover_pct = safe_float(row.get("turnover_pct"))
    ah_score = safe_float(row.get("ah_score"))
    has_saved_ah = bool(row.get("has_saved_ah"))

    if last_price < min_price or last_price > max_price:
        return False
    if pm_volume < min_volume:
        return False

    gap_ok = gap_pct >= min_gap_pct
    combined_ah_override = has_saved_ah and ah_score >= max(50.0, min_breakout_score)
    if not gap_ok and not combined_ah_override:
        return False

    if pm_range_pct < min_pm_range_pct and not combined_ah_override:
        return False
    if pm_dollar_volume < min_pm_dollar_volume and not combined_ah_override:
        return False
    if compression_score < min_compression_score:
        return False
    if breakout_score < min_breakout_score and not combined_ah_override:
        return False
    if low_float_only and (float_shares is None or float_shares > 50_000_000):
        return False
    if max_float_shares is not None and (float_shares is None or float_shares > max_float_shares):
        return False
    if min_short_interest_pct > 0 and (short_interest_pct is None or short_interest_pct < min_short_interest_pct):
        return False
    if min_turnover_pct > 0 and turnover_pct < min_turnover_pct:
        return False
    return True


def calc_volume_accel_pct(recent_volumes: List[float]) -> float:
    vols = [v for v in recent_volumes if v >= 0]
    if len(vols) < 6:
        return 0.0

    half = len(vols) // 2
    older = vols[:half]
    newer = vols[half:]
    if not older or not newer:
        return 0.0

    avg_old = sum(older) / len(older)
    avg_new = sum(newer) / len(newer)
    if avg_old <= 0:
        return 0.0
    return ((avg_new - avg_old) / avg_old) * 100.0


def calc_dollar_volume(avg_price: float, volume: float) -> float:
    if avg_price <= 0 or volume <= 0:
        return 0.0
    return avg_price * volume


def summarize_runner_types(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {"momentum": 0, "overnight": 0}
    for row in rows:
        runner_type = str(row.get("runner_type", "")).strip().lower()
        if runner_type in counts:
            counts[runner_type] += 1
    return counts


def build_active_filters(
    *,
    min_price: float,
    max_price: float,
    min_volume: int,
    min_gap_pct: float,
    min_pm_range_pct: float,
    min_pm_dollar_volume: float,
    min_compression_score: float = 0.0,
    min_breakout_score: float = 0.0,
    max_float_shares: Optional[float] = None,
    low_float_only: bool = False,
    min_short_interest_pct: float = 0.0,
    min_turnover_pct: float = 0.0,
    hours_back: int = 96,
) -> Dict[str, Any]:
    return {
        "min_price": min_price,
        "max_price": max_price,
        "min_volume": min_volume,
        "min_gap_pct": min_gap_pct,
        "min_pm_range_pct": min_pm_range_pct,
        "min_pm_dollar_volume": min_pm_dollar_volume,
        "min_compression_score": min_compression_score,
        "min_breakout_score": min_breakout_score,
        "max_float_shares": max_float_shares,
        "low_float_only": low_float_only,
        "min_short_interest_pct": min_short_interest_pct,
        "min_turnover_pct": min_turnover_pct,
        "hours_back": hours_back,
    }


def choose_workflow(now_utc: Optional[datetime] = None) -> str:
    current = now_utc or datetime.now(timezone.utc)
    pacific = current.astimezone(PT)
    total_minutes = pacific.hour * 60 + pacific.minute
    return "combined" if total_minutes < 450 else "live"


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def pct_change(current: float, prev: float) -> float:
    if prev <= 0:
        return 0.0
    return ((current - prev) / prev) * 100.0


def nested_get(data: Dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def first_number(*values: Any) -> Optional[float]:
    for value in values:
        try:
            if value is None:
                continue
            number = float(value)
            if math.isfinite(number):
                return number
        except Exception:
            continue
    return None
