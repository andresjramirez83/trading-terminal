from __future__ import annotations

from datetime import datetime, timezone
from typing import List

from app.history.history_types import HistoryBar
from app.services.alpaca_market_service import AlpacaMarketService


class AlpacaHistoryProvider:
    """Alpaca implementation of the HistoryProvider interface.

    Responsibilities:
      • request raw Alpaca history
      • merge SIP and BOATS data when extended hours are enabled
      • filter the requested session
      • convert normalized bars into HistoryBar
    """

    def __init__(self) -> None:
        self._alpaca = AlpacaMarketService()

    async def fetch_history(
        self,
        symbol: str,
        timeframe: str,
        start_ms: int,
        end_ms: int,
        session: str,
    ) -> List[HistoryBar]:
        symbol = symbol.upper().strip()
        if not symbol:
            return []

        alpaca_timeframe = self._resolve_alpaca_timeframe(timeframe)
        normalized_session = self._alpaca._session_name(session)

        start = datetime.fromtimestamp(start_ms / 1000, timezone.utc)
        end = datetime.fromtimestamp(end_ms / 1000, timezone.utc)

        sip_rows = await self._alpaca._historical_bars(
            symbol=symbol,
            timeframe=alpaca_timeframe,
            start=start,
            end=end,
            feed=self._alpaca.feed,
        )

        overnight_rows = []
        should_fetch_overnight = (
            self._alpaca.include_overnight
            and normalized_session in {"extended", "overnight"}
            and self._alpaca.overnight_feed
            and self._alpaca.overnight_feed != self._alpaca.feed
        )

        if should_fetch_overnight:
            try:
                overnight_rows = await self._alpaca._historical_bars(
                    symbol=symbol,
                    timeframe=alpaca_timeframe,
                    start=start,
                    end=end,
                    feed=self._alpaca.overnight_feed,
                )
            except Exception:
                # SIP data should still load even when BOATS is unavailable for
                # the account, symbol, or requested date range.
                overnight_rows = []

        rows = self._alpaca._merge_rows(overnight_rows, sip_rows)
        rows = self._alpaca._filter_session(rows, normalized_session)

        bars: List[HistoryBar] = []

        for row in rows:
            try:
                bars.append(HistoryBar.from_chart(row))
            except Exception:
                continue

        return bars

    @staticmethod
    def _resolve_alpaca_timeframe(timeframe: str) -> str:
        tf = str(timeframe or "1m").lower().strip()

        mapping = {
            "1m": "1Min",
            "1h": "1Hour",
            "1d": "1Day",
        }

        if tf not in mapping:
            raise ValueError(
                f"Unsupported Alpaca source timeframe: {timeframe}. "
                "Higher timeframes should be aggregated by HistoryEngine."
            )

        return mapping[tf]


__all__ = ["AlpacaHistoryProvider"]
