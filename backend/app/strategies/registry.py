from __future__ import annotations

from typing import Dict, List

from app.strategies.base import StrategyBase
from app.strategies.six_seven_sweep import SixSevenSweepStrategy


class StrategyRegistry:
    def __init__(self) -> None:
        strategies: List[StrategyBase] = [SixSevenSweepStrategy()]
        self._items: Dict[str, StrategyBase] = {s.id: s for s in strategies}

    def get(self, strategy_id: str) -> StrategyBase | None:
        return self._items.get(strategy_id)

    def list(self) -> list[dict]:
        return [{"id": s.id, "name": s.name} for s in self._items.values()]
