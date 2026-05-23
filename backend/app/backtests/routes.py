from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .market_cache import count_scanner_picks, init_db, save_scanner_picks
from .polygon_history_loader import load_polygon_history
from .sweep_backtest import run_scanner_sweep_backtest, run_sweep_backtest

router = APIRouter(prefix="/backtests", tags=["backtests"])


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


@router.get("/health")
def backtest_health():
    init_db()
    return {
        "ok": True,
        "message": "Backtest system ready",
    }


@router.post("/cache/load")
async def load_cache(req: LoadHistoryRequest):
    init_db()
    return await load_polygon_history(
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
