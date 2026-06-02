from fastapi import APIRouter, HTTPException, Query

from app.models.market import BarsResponse, LastTradeResponse
from app.services.polygon_service import PolygonService

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/bars", response_model=BarsResponse)
async def bars(
    symbol: str = Query(..., min_length=1, max_length=10),
    timeframe: str = Query("1m"),
    session: str = Query("extended"),
):
    """
    Chart bars endpoint.

    Uses PolygonService.get_bars() so 1m, 5m, and 15m all get a proper
    lookback window instead of relying on the old function-style fetch.
    """
    try:
        polygon = PolygonService()
        data = await polygon.get_bars(symbol, timeframe, session=session)
        return BarsResponse(symbol=symbol.upper(), timeframe=timeframe, bars=data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Bars error: {e}")


@router.get("/last-trade", response_model=LastTradeResponse)
async def last_trade(symbol: str = Query(..., min_length=1, max_length=10)):
    try:
        polygon = PolygonService()
        price = await polygon.get_last_trade(symbol)
        return LastTradeResponse(symbol=symbol.upper(), price=price)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Last trade error: {e}")
