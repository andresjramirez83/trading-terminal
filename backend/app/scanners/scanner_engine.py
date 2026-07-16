from __future__ import annotations

from collections import OrderedDict
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, TypeVar

from app.scanners.parallel_executor import ParallelScannerExecutor
from app.services.market_data_provider import MarketDataProvider
from app.services.scanner_universe_service import get_scanner_universe

T = TypeVar("T")
R = TypeVar("R")


class ScannerEngine:
    """Shared execution helper for scanner modules.

    The engine is provider-independent. Scanner implementations may use Alpaca,
    Polygon during rollback, or a future replay provider as long as the object
    satisfies the MarketDataProvider protocol.

    During migration, ``polygon=`` remains accepted as a backward-compatible
    keyword so existing scanners can be converted one file at a time.
    """

    def __init__(self, *, concurrency: int = 20) -> None:
        self.concurrency = max(1, int(concurrency or 20))
        self.executor = ParallelScannerExecutor(concurrency=self.concurrency)

    async def get_universe(
    *,
    market: MarketDataProvider,
        limit: int = 1000,
        min_limit: Optional[int] = None,
    ) -> "OrderedDict[str, Dict[str, Any]]":
        provider = market

        if provider is None:
            raise RuntimeError(
                "ScannerEngine.get_universe requires a market-data provider"
            )

        return await get_scanner_universe(
            market=provider,
            limit=max(1, int(limit or 1000)),
            min_limit=min_limit,
        )

    async def scan(
        self,
        *,
        items: Iterable[T],
        worker: Callable[[T], Awaitable[Optional[R]]],
    ) -> tuple[List[R], float]:
        return await self.executor.execute(
            items=items,
            worker=worker,
        )


__all__ = ["ScannerEngine"]
