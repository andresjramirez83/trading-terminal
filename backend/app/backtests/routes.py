from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.daily_watchlist_store import DailyWatchlistStore
from .market_cache import count_scanner_picks, init_db, save_scanner_picks
from .alpaca_history_loader import (
    load_alpaca_history,
    load_alpaca_history_for_ranges,
)
from .sweep_backtest import run_scanner_sweep_backtest, run_sweep_backtest
from .vwap_std_backtest import run_vwap3_backtest
from .fib_continuation_backtest import run_fib_continuation_backtest

router = APIRouter(prefix="/backtests", tags=["backtests"])
daily_watchlists = DailyWatchlistStore()


class LoadHistoryRequest(BaseModel):
    symbols: List[str]
    months: int = Field(default=12, ge=1, le=24)
    timeframes: List[str] = Field(default_factory=lambda: ["15m", "1h"])


class SweepBacktestRequest(BaseModel):
    symbols: List[str]
    timeframe: str = "15m"
    target_r: float = Field(default=2.0, gt=0)
    run_name: str = "sweep_backtest"
    clear_existing: bool = True
    setup: Optional[str] = None
    min_day_volume: Optional[float] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None


class SaveScannerPicksRequest(BaseModel):
    scanner: str
    pick_date: str
    rows: List[Dict[str, Any]]
    timeframe: Optional[str] = None


class ScannerSweepBacktestRequest(BaseModel):
    scanner: str
    timeframe: str = "15m"
    target_r: float = Field(default=2.0, gt=0)
    run_name: str = "scanner_sweep_backtest"
    clear_existing: bool = True

    # Set to None to compare all setups. Default focuses on the current best setup.
    setup: Optional[str] = "5am_pacific_hour_sweep"

    start_date: Optional[str] = None
    end_date: Optional[str] = None
    min_score: Optional[float] = None
    limit_per_day: Optional[int] = Field(default=None, ge=1)

    min_day_volume: Optional[float] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None


class WatchlistHistoryLoadRequest(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    include_scanner: bool = True
    include_manual: bool = True
    scanner_ids: Optional[List[str]] = None
    timeframe: str = "5m"
    warmup_calendar_days: int = Field(default=7, ge=0, le=30)
    future_calendar_days: int = Field(default=10, ge=0, le=30)


class FibContinuationBacktestRequest(BaseModel):
    symbols: Optional[List[str]] = None
    include_archived_watchlists: bool = True
    include_scanner: bool = True
    include_manual: bool = True
    scanner_ids: Optional[List[str]] = None

    start_date: Optional[str] = None
    end_date: Optional[str] = None
    timeframe: str = "5m"
    months: int = Field(default=12, ge=1, le=24)
    auto_load_alpaca: bool = True
    max_symbols: int = Field(default=200, ge=1, le=1000)

    min_range_pct: float = Field(default=12.0, ge=0)
    min_body_pct: float = Field(default=6.0, ge=0)
    min_close_location: float = Field(default=0.65, ge=0, le=1)
    min_volume: float = Field(default=50_000.0, ge=0)

    retrace_min: float = Field(default=0.50, ge=0, le=1)
    retrace_max: float = Field(default=0.70, ge=0, le=1)
    max_retrace: float = Field(default=0.786, ge=0, le=1)
    min_hold_bars: int = Field(default=12, ge=0, le=1000)
    min_hold_sessions: int = Field(default=1, ge=0, le=20)
    max_setup_sessions: int = Field(default=6, ge=1, le=30)
    target_sessions: int = Field(default=5, ge=1, le=30)
    cooldown_bars: int = Field(default=12, ge=1, le=1000)
    fib_lookback_bars: int = Field(default=6, ge=0, le=100)
    example_limit: int = Field(default=100, ge=1, le=500)


class VwapStdBacktestRequest(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    include_scanner: bool = True
    include_manual: bool = True
    scanner_ids: Optional[List[str]] = None

    # If symbols are supplied, each symbol is tested on every archived date in the
    # requested range. This is useful for ad-hoc research alongside watchlist picks.
    symbols: Optional[List[str]] = None

    timeframe: str = "5m"
    std_length: int = Field(default=20, ge=2, le=200)
    multiplier: float = Field(default=3.0, gt=0, le=10)
    future_trading_days: int = Field(default=5, ge=0, le=10)

    # Search the prior trading day's after-hours session plus the candidate day's
    # premarket session. This captures setups like NAMI where the displacement
    # began after 4 PM and the +3 STD target was reached the next morning.
    include_prior_after_hours: bool = True
    after_hours_start_hhmm: int = Field(default=1600, ge=0, le=2359)
    after_hours_end_hhmm: int = Field(default=2000, ge=0, le=2359)
    include_premarket: bool = True
    premarket_start_hhmm: int = Field(default=400, ge=0, le=2359)
    premarket_end_hhmm: int = Field(default=930, ge=0, le=2359)

    # Initial displacement defaults. These are intentionally configurable so we can
    # test the idea instead of hard-coding a definition of "displacement" forever.
    min_body_pct: float = Field(default=3.0, ge=0)
    min_range_pct: float = Field(default=4.0, ge=0)
    min_volume: float = Field(default=50_000.0, ge=0)
    min_close_location: float = Field(default=0.65, ge=0, le=1)

    # Freeze the highest +STD projection from the initial expansion episode after
    # the band contracts for N consecutive bars.
    projection_contraction_bars: int = Field(default=3, ge=1, le=12)
    projection_max_bars: int = Field(default=36, ge=1, le=120)

    # continuous mirrors the user's thinkScript CompoundValue behavior within the
    # loaded history window. daily resets VWAP each ET date for a reproducible control.
    vwap_mode: str = "continuous"

    auto_load_alpaca: bool = True
    warmup_calendar_days: int = Field(default=7, ge=0, le=30)
    future_calendar_days: int = Field(default=10, ge=0, le=30)


@router.get("/health")
def backtest_health():
    init_db()
    return {
        "ok": True,
        "message": "Backtest system ready",
        "daily_watchlist_dates": len(daily_watchlists.list_dates()),
    }


@router.post("/cache/load")
async def load_cache(req: LoadHistoryRequest):
    init_db()
    return await load_alpaca_history(
        symbols=req.symbols,
        timeframes=req.timeframes,
        months=req.months,
    )


@router.post("/sweeps/run")
def run_sweeps(req: SweepBacktestRequest):
    init_db()
    return run_sweep_backtest(
        symbols=req.symbols,
        timeframe=req.timeframe,
        target_r=req.target_r,
        run_name=req.run_name,
        clear_existing=req.clear_existing,
        setup=req.setup,
        min_day_volume=req.min_day_volume,
        min_price=req.min_price,
        max_price=req.max_price,
    )


@router.post("/scanner-picks/save")
def save_picks(req: SaveScannerPicksRequest):
    init_db()
    return save_scanner_picks(
        scanner=req.scanner,
        pick_date=req.pick_date,
        rows=req.rows,
        timeframe=req.timeframe,
    )


@router.get("/scanner-picks/stats/{scanner}")
def scanner_pick_stats(scanner: str):
    init_db()
    return count_scanner_picks(scanner)


@router.post("/sweeps/run-scanner")
def run_scanner_sweeps(req: ScannerSweepBacktestRequest):
    init_db()
    return run_scanner_sweep_backtest(
        scanner=req.scanner,
        timeframe=req.timeframe,
        target_r=req.target_r,
        run_name=req.run_name,
        clear_existing=req.clear_existing,
        setup=req.setup,
        start_date=req.start_date,
        end_date=req.end_date,
        min_score=req.min_score,
        limit_per_day=req.limit_per_day,
        min_day_volume=req.min_day_volume,
        min_price=req.min_price,
        max_price=req.max_price,
    )


@router.get("/watchlists/dates")
def watchlist_dates():
    dates = daily_watchlists.list_dates()
    return {
        "ok": True,
        "count": len(dates),
        "dates": dates,
    }


@router.get("/watchlists/{trade_date}")
def watchlist_for_date(trade_date: str):
    payload = daily_watchlists.load(str(trade_date)[:10])
    if payload is None:
        raise HTTPException(status_code=404, detail="No archived watchlist for that date")
    return payload


def _candidate_map(
    *,
    start_date: Optional[str],
    end_date: Optional[str],
    include_scanner: bool,
    include_manual: bool,
    scanner_ids: Optional[List[str]],
    symbols: Optional[List[str]] = None,
) -> Dict[str, List[str]]:
    candidate_by_date = daily_watchlists.get_symbols(
        start_date=start_date,
        end_date=end_date,
        include_scanner=include_scanner,
        include_manual=include_manual,
        scanner_ids=scanner_ids,
    )

    extra_symbols = []
    for raw in symbols or []:
        symbol = "".join(ch for ch in str(raw).upper().strip() if ch.isalpha() or ch == ".")
        if symbol and symbol not in extra_symbols:
            extra_symbols.append(symbol)

    if extra_symbols:
        dates = sorted(candidate_by_date.keys())
        for trade_date in dates:
            merged = list(candidate_by_date.get(trade_date) or [])
            for symbol in extra_symbols:
                if symbol not in merged:
                    merged.append(symbol)
            candidate_by_date[trade_date] = merged

    return candidate_by_date


def _symbol_ranges(candidate_by_date: Dict[str, List[str]]) -> Dict[str, Dict[str, str]]:
    dates_by_symbol: Dict[str, List[str]] = defaultdict(list)
    for trade_date, symbols in (candidate_by_date or {}).items():
        for symbol in symbols or []:
            if trade_date not in dates_by_symbol[symbol]:
                dates_by_symbol[symbol].append(trade_date)

    out: Dict[str, Dict[str, str]] = {}
    for symbol, dates in dates_by_symbol.items():
        clean_dates = sorted(dates)
        if clean_dates:
            out[symbol] = {
                "start_date": clean_dates[0],
                "end_date": clean_dates[-1],
            }
    return out


@router.post("/watchlists/load-history")
async def load_watchlist_history(req: WatchlistHistoryLoadRequest):
    init_db()
    candidate_by_date = _candidate_map(
        start_date=req.start_date,
        end_date=req.end_date,
        include_scanner=req.include_scanner,
        include_manual=req.include_manual,
        scanner_ids=req.scanner_ids,
    )
    ranges = _symbol_ranges(candidate_by_date)
    if not ranges:
        return {
            "ok": False,
            "error": "No archived watchlist symbols found for the requested dates",
            "candidate_dates": len(candidate_by_date),
        }

    load_result = await load_alpaca_history_for_ranges(
        ranges,
        timeframe=req.timeframe,
        warmup_calendar_days=req.warmup_calendar_days,
        future_calendar_days=req.future_calendar_days,
    )
    return {
        **load_result,
        "candidate_dates": len(candidate_by_date),
        "symbols_requested": len(ranges),
    }


@router.post("/fib-continuation/run")
async def run_fib_continuation(req: FibContinuationBacktestRequest):
    init_db()

    explicit_symbols: List[str] = []
    for raw in req.symbols or []:
        symbol = "".join(ch for ch in str(raw).upper().strip() if ch.isalpha() or ch == ".")
        if symbol and symbol not in explicit_symbols:
            explicit_symbols.append(symbol)

    candidate_by_date: Dict[str, List[str]] = {}
    archive_counts: Dict[str, int] = defaultdict(int)
    if req.include_archived_watchlists:
        candidate_by_date = _candidate_map(
            start_date=req.start_date,
            end_date=req.end_date,
            include_scanner=req.include_scanner,
            include_manual=req.include_manual,
            scanner_ids=req.scanner_ids,
        )
        for day_symbols in candidate_by_date.values():
            for symbol in day_symbols or []:
                archive_counts[symbol] += 1

    ranked_archive_symbols = [
        symbol
        for symbol, _count in sorted(
            archive_counts.items(),
            key=lambda item: (-item[1], item[0]),
        )
    ]

    symbols: List[str] = list(explicit_symbols)
    for symbol in ranked_archive_symbols:
        if symbol not in symbols:
            symbols.append(symbol)

    available_symbol_count = len(symbols)
    symbols = symbols[: req.max_symbols]
    if not symbols:
        return {
            "ok": False,
            "error": "No symbols supplied and no archived watchlist symbols were found.",
            "hint": "Supply symbols explicitly or archive manual/scanner watchlists first.",
        }

    if (req.start_date and not req.end_date) or (req.end_date and not req.start_date):
        raise HTTPException(
            status_code=400,
            detail="Provide both start_date and end_date or neither.",
        )
    if req.retrace_min > req.retrace_max:
        raise HTTPException(status_code=400, detail="retrace_min must be <= retrace_max")
    if req.retrace_max > req.max_retrace:
        raise HTTPException(status_code=400, detail="retrace_max must be <= max_retrace")

    alpaca_load: Optional[Dict[str, Any]] = None
    if req.auto_load_alpaca:
        if req.start_date and req.end_date:
            ranges = {
                symbol: {
                    "start_date": str(req.start_date)[:10],
                    "end_date": str(req.end_date)[:10],
                }
                for symbol in symbols
            }
            alpaca_load = await load_alpaca_history_for_ranges(
                ranges,
                timeframe=req.timeframe,
                warmup_calendar_days=2,
                future_calendar_days=req.max_setup_sessions + req.target_sessions + 3,
            )
        else:
            alpaca_load = await load_alpaca_history(
                symbols=symbols,
                timeframes=[req.timeframe],
                months=req.months,
            )

    result = run_fib_continuation_backtest(
        symbols,
        timeframe=req.timeframe,
        start_date=req.start_date,
        end_date=req.end_date,
        min_range_pct=req.min_range_pct,
        min_body_pct=req.min_body_pct,
        min_close_location=req.min_close_location,
        min_volume=req.min_volume,
        retrace_min=req.retrace_min,
        retrace_max=req.retrace_max,
        max_retrace=req.max_retrace,
        min_hold_bars=req.min_hold_bars,
        min_hold_sessions=req.min_hold_sessions,
        max_setup_sessions=req.max_setup_sessions,
        target_sessions=req.target_sessions,
        cooldown_bars=req.cooldown_bars,
        fib_lookback_bars=req.fib_lookback_bars,
        example_limit=req.example_limit,
    )
    result["universe"] = {
        "explicit_symbols": explicit_symbols,
        "archived_symbol_count": len(ranked_archive_symbols),
        "available_symbol_count": available_symbol_count,
        "tested_symbol_count": len(symbols),
        "max_symbols": req.max_symbols,
        "truncated": available_symbol_count > len(symbols),
    }
    result["alpaca_load"] = alpaca_load
    return result


@router.post("/vwap-std/run")
async def run_vwap_std(req: VwapStdBacktestRequest):
    init_db()
    candidate_by_date = _candidate_map(
        start_date=req.start_date,
        end_date=req.end_date,
        include_scanner=req.include_scanner,
        include_manual=req.include_manual,
        scanner_ids=req.scanner_ids,
        symbols=req.symbols,
    )

    if not candidate_by_date:
        return {
            "ok": False,
            "error": "No archived daily watchlists found for the requested date range",
            "hint": "Daily scanner/manual archiving starts automatically after this update is deployed.",
        }

    alpaca_load: Optional[Dict[str, Any]] = None
    if req.auto_load_alpaca:
        ranges = _symbol_ranges(candidate_by_date)
        alpaca_load = await load_alpaca_history_for_ranges(
            ranges,
            timeframe=req.timeframe,
            warmup_calendar_days=req.warmup_calendar_days,
            future_calendar_days=req.future_calendar_days,
        )

    result = run_vwap3_backtest(
        candidate_by_date,
        timeframe=req.timeframe,
        std_length=req.std_length,
        multiplier=req.multiplier,
        future_trading_days=req.future_trading_days,
        include_prior_after_hours=req.include_prior_after_hours,
        after_hours_start_hhmm=req.after_hours_start_hhmm,
        after_hours_end_hhmm=req.after_hours_end_hhmm,
        include_premarket=req.include_premarket,
        premarket_start_hhmm=req.premarket_start_hhmm,
        premarket_end_hhmm=req.premarket_end_hhmm,
        min_body_pct=req.min_body_pct,
        min_range_pct=req.min_range_pct,
        min_volume=req.min_volume,
        min_close_location=req.min_close_location,
        projection_contraction_bars=req.projection_contraction_bars,
        projection_max_bars=req.projection_max_bars,
        vwap_mode=req.vwap_mode,
    )
    result["alpaca_load"] = alpaca_load
    return result
