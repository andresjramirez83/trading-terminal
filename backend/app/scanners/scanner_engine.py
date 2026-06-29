from __future__ import annotations

from collections import OrderedDict
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, TypeVar

from app.scanners.parallel_executor import ParallelScannerExecutor
from app.services.polygon_service import PolygonService
from app.services.scanner_universe_service import get_scanner_universe

T = TypeVar("T")
R = TypeVar("R")


class ScannerEngine:
    """Shared execution helper for scanner modules.

    This keeps scanner files focused on setup logic while this engine owns the
    common mechanics: shared universe loading, bounded parallel execution,
    elapsed timing, and isolated worker failures through ParallelScannerExecutor.
    """

    def __init__(self, *, concurrency: int = 20) -> None:
        self.concurrency = max(1, int(concurrency or 20))
        self.executor = ParallelScannerExecutor(concurrency=self.concurrency)

    async def get_universe(
        self,
        *,
        polygon: PolygonService,
        limit: int = 1000,
        min_limit: Optional[int] = None,
    ) -> "OrderedDict[str, Dict[str, Any]]":
        return await get_scanner_universe(
            polygon,
            limit=max(1, int(limit or 1000)),
            min_limit=min_limit,
        )

    async def scan(
        self,
        *,
        items: Iterable[T],
        worker: Callable[[T], Awaitable[Optional[R]]],
    ) -> tuple[List[R], float]:
        return await self.executor.execute(items=items, worker=worker)
