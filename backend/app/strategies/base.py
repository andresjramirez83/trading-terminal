from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

from app.autotrade.models import AutoTradeConfig, TradeSignal
from app.services.polygon_service import PolygonService


class StrategyBase(ABC):
    id: str
    name: str

    @abstractmethod
    async def scan(self, *, symbol: str, polygon: PolygonService, config: AutoTradeConfig) -> List[TradeSignal]:
        raise NotImplementedError
