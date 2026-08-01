from fastapi import APIRouter, HTTPException, Query

from app.models.market import BarsResponse, LastTradeResponse
from app.services.market_data_provider import get_market_data_provider

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/bars", response_model=BarsResponse)
async def bars(
    symbol: str = Query(..., min_length=1, max_length=10),
    timeframe: str = Query("1m"),
    session: str = Query("extended"),
    date: str | None = Query(default=None),
    lookback: str | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=5000),
):
    """
    Historical chart and replay bars.

    Replay requests supply an exact trading date. Live chart requests
    generally supply a rolling lookback window.
    """
    try:
        provider = get_market_data_provider()

        data = await provider.get_bars(
            symbol=symbol,
            timeframe=timeframe,
            session=session,
            date=date,
            lookback=lookback,
            limit=limit,
        )

        return BarsResponse(
            symbol=symbol.upper(),
            timeframe=timeframe,
            bars=data,
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Bars error: {exc}",
        )


@router.get("/last-trade", response_model=LastTradeResponse)
async def last_trade(
    symbol: str = Query(..., min_length=1, max_length=10),
):
    try:
        provider = get_market_data_provider()

        price = await provider.get_last_trade(symbol)

        return LastTradeResponse(
            symbol=symbol.upper(),
            price=price,
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Last trade error: {exc}",
        )
