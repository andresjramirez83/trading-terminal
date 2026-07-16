from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class BarsResponse(BaseModel):
    symbol: str
    timeframe: str
    bars: List[Candle]
    trading_date: Optional[str] = None


class LastTradeResponse(BaseModel):
    symbol: str
    price: Optional[float] = None


__all__ = [
    "Candle",
    "BarsResponse",
    "LastTradeResponse",
]