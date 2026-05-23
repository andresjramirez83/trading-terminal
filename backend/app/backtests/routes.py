from typing import List

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .market_cache import init_db
from .polygon_history_loader import load_polygon_history
from .sweep_backtest import run_sweep_backtest

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
    )
