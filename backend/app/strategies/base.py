from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

from app.autotrade.models import AutoTradeConfig, TradeSignal
from app.services.market_data_provider import MarketDataProvider


class StrategyBase(ABC):
    id: str
    name: str

    @abstractmethod
    async def scan(self, *, symbol: str, market: MarketDataProvider, config: AutoTradeConfig) -> List[TradeSignal]:
        raise NotImplementedError


__all__ = ["StrategyBase"]
