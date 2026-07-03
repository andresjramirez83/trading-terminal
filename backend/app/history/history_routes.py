from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.history.history_engine import HistoryEngine
from app.history.providers.polygon_provider import PolygonHistoryProvider

router = APIRouter(prefix="/history", tags=["history"])

history_engine = HistoryEngine(
    provider=PolygonHistoryProvider(),
)


@router.get("/bars")
async def history_bars(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query("1m"),
    session: str = Query("extended"),
):
    try:
        bars = await history_engine.get_history(
            symbol=symbol,
            timeframe=timeframe,
            session=session,
        )

        return {
            "symbol": symbol.upper().strip(),
            "timeframe": timeframe,
            "session": session,
            "count": len(bars),
            "bars": [bar.to_chart() for bar in bars],
        }

    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/cache")
async def history_cache():
    return history_engine.cache_stats()


@router.post("/cache/clear")
async def clear_history_cache():
    history_engine.clear_cache()
    return {
        "ok": True,
        "cache": history_engine.cache_stats(),
    }