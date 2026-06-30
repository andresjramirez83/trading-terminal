from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Iterable, List, Optional, TypeVar

T = TypeVar("T")
R = TypeVar("R")


class ParallelScannerExecutor:
    def __init__(self, concurrency: int = 20):
        self._concurrency = max(1, concurrency)
        self._semaphore = asyncio.Semaphore(self._concurrency)

    async def execute(
        self,
        items: Iterable[T],
        worker: Callable[[T], Awaitable[Optional[R]]],
    ) -> tuple[List[R], float]:

        start = time.perf_counter()

        async def run(item: T) -> Optional[R]:
            async with self._semaphore:
                try:
                    return await worker(item)
                except Exception as exc:
                    print(f"[parallel-scanner] worker failed: {exc}", flush=True)
                    return None

        tasks = [asyncio.create_task(run(item)) for item in items]

        results = await asyncio.gather(*tasks)

        elapsed_ms = (time.perf_counter() - start) * 1000.0

        return [r for r in results if r is not None], elapsed_ms