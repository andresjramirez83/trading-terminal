from __future__ import annotations

from typing import List

from app.history.history_types import HistoryBar
from app.services.polygon_service import PolygonService


class PolygonHistoryProvider:
    """
    Polygon implementation of the HistoryProvider interface.

    This class is intentionally small.

    Responsibilities:

        • Request raw Polygon history
        • Convert Polygon bars to HistoryBar
        • Nothing else

    NO:

        • caching
        • aggregation
        • lookback policy
        • websocket logic
        • timeframe decisions
    """

    def __init__(self) -> None:
        self._polygon = PolygonService()

    async def fetch_history(
        self,
        symbol: str,
        timeframe: str,
        start_ms: int,
        end_ms: int,
        session: str,
    ) -> List[HistoryBar]:

        multiplier, timespan = self._resolve_polygon_timeframe(timeframe)

        raw = await self._polygon.get_aggs(
            symbol=symbol,
            multiplier=multiplier,
            timespan=timespan,
            start_ms=start_ms,
            end_ms=end_ms,
            adjusted="true",
            sort="asc",
            limit=50000,
        )

        bars: List[HistoryBar] = []

        for row in raw:
            try:
                bars.append(HistoryBar.from_polygon(row))
            except Exception:
                continue

        return bars

    @staticmethod
    def _resolve_polygon_timeframe(
        timeframe: str,
    ) -> tuple[int, str]:

        tf = timeframe.lower().strip()

        mapping = {
            "1m": (1, "minute"),
            "2m": (2, "minute"),
            "3m": (3, "minute"),
            "5m": (5, "minute"),
            "10m": (10, "minute"),
            "15m": (15, "minute"),
            "30m": (30, "minute"),
            "45m": (45, "minute"),

            "1h": (1, "hour"),
            "2h": (2, "hour"),
            "4h": (4, "hour"),

            "1d": (1, "day"),

            "1w": (1, "week"),

            "1mo": (1, "month"),
        }

        if tf not in mapping:
            raise ValueError(f"Unsupported timeframe {timeframe}")

        return mapping[tf]