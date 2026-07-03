from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Protocol

from app.history.history_aggregation import HistoryAggregation
from app.history.history_cache import HistoryCache
from app.history.history_timeframes import get_timeframe
from app.history.history_types import HistoryBar


class HistoryProvider(Protocol):
    async def fetch_history(
        self,
        symbol: str,
        timeframe: str,
        start_ms: int,
        end_ms: int,
        session: str,
    ) -> List[HistoryBar]:
        ...


class HistoryEngine:
    def __init__(
        self,
        provider: HistoryProvider,
        cache: HistoryCache | None = None,
    ) -> None:
        self.provider = provider
        self.cache = cache or HistoryCache()

    async def get_history(
        self,
        symbol: str,
        timeframe: str,
        session: str = "extended",
    ) -> List[HistoryBar]:
        tf = get_timeframe(timeframe)

        now = datetime.now(timezone.utc)
        start = now - tf.lookback

        start_ms = int(start.timestamp() * 1000)
        end_ms = int(now.timestamp() * 1000)

        target_key = self.cache.make_key(
            provider=self.provider.__class__.__name__,
            symbol=symbol,
            timeframe=tf.name,
            session=session,
            lookback_key=str(tf.lookback),
        )

        cached_target = self.cache.get(target_key)
        if cached_target is not None:
            return cached_target

        source_timeframe = tf.aggregate_from or tf.name
        source_tf = get_timeframe(source_timeframe)

        source_key = self.cache.make_key(
            provider=self.provider.__class__.__name__,
            symbol=symbol,
            timeframe=source_tf.name,
            session=session,
            lookback_key=str(tf.lookback),
        )

        source_bars = self.cache.get(source_key)

        if source_bars is None:
            source_bars = await self.provider.fetch_history(
                symbol=symbol,
                timeframe=source_tf.name,
                start_ms=start_ms,
                end_ms=end_ms,
                session=session,
            )

            self.cache.set(
                source_key,
                source_bars,
                source_tf.cache_seconds,
            )

        if tf.aggregate_from is not None:
            bars = HistoryAggregation.aggregate(source_bars, tf.name)
        else:
            bars = source_bars

        self.cache.set(
            target_key,
            bars,
            tf.cache_seconds,
        )

        return bars

    def clear_cache(self) -> None:
        self.cache.clear()

    def cache_stats(self) -> dict:
        return self.cache.stats()