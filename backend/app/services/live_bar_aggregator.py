from __future__ import annotations

from collections import defaultdict, deque
from threading import RLock

from app.services.live_bar_timeframes import (
    TIMEFRAME_SECONDS,
    align_timestamp,
)
from app.services.live_bar_types import LiveBar


MAX_HISTORY = 500


class LiveBarAggregator:
    """
    Maintains the current live candle for every
    symbol/timeframe pair.

    Also keeps a rolling history of recently
    completed candles so reconnecting clients
    immediately receive the newest bars.
    """

    def __init__(self) -> None:

        self._lock = RLock()

        self._current: dict[str, dict[str, LiveBar]] = defaultdict(dict)

        self._history: dict[str, dict[str, deque[LiveBar]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=MAX_HISTORY))
        )

    def update_trade(
        self,
        *,
        symbol: str,
        price: float,
        volume: float,
        timestamp: int,
    ) -> list[LiveBar]:

        symbol = symbol.upper()

        updated: list[LiveBar] = []

        with self._lock:

            for timeframe in TIMEFRAME_SECONDS:

                start, end = align_timestamp(timestamp, timeframe)

                current = self._current[symbol].get(timeframe)

                #
                # first candle
                #

                if current is None:

                    current = LiveBar(
                        symbol=symbol,
                        timeframe=timeframe,
                        start_time=start,
                        end_time=end,
                        open=price,
                        high=price,
                        low=price,
                        close=price,
                        volume=volume,
                    )

                    self._current[symbol][timeframe] = current
                    updated.append(current)
                    continue

                #
                # new candle
                #

                if current.start_time != start:

                    current.complete = True

                    self._history[symbol][timeframe].append(current)

                    current = LiveBar(
                        symbol=symbol,
                        timeframe=timeframe,
                        start_time=start,
                        end_time=end,
                        open=current.close,
                        high=price,
                        low=price,
                        close=price,
                        volume=volume,
                    )

                    self._current[symbol][timeframe] = current

                    updated.append(current)

                    continue

                #
                # update current candle
                #

                current.update(
                    price=price,
                    volume=volume,
                )

                updated.append(current)

        return updated

    def current_bar(
        self,
        symbol: str,
        timeframe: str,
    ) -> LiveBar | None:

        return self._current.get(
            symbol.upper(),
            {},
        ).get(timeframe)

    def history(
        self,
        symbol: str,
        timeframe: str,
    ) -> list[LiveBar]:

        return list(
            self._history.get(
                symbol.upper(),
                {},
            ).get(timeframe, [])
        )

    def reset_symbol(
        self,
        symbol: str,
    ) -> None:

        symbol = symbol.upper()

        with self._lock:

            self._current.pop(symbol, None)

            self._history.pop(symbol, None)

    def stats(self) -> dict:

        with self._lock:

            symbols = len(self._current)

            current = sum(
                len(v)
                for v in self._current.values()
            )

            history = sum(
                len(q)
                for symbol in self._history.values()
                for q in symbol.values()
            )

            return {
                "symbols": symbols,
                "current_bars": current,
                "completed_bars": history,
            }


live_bar_aggregator = LiveBarAggregator()