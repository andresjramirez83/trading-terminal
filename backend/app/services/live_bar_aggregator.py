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

        # Some SIP trades legitimately update volume without being allowed to
        # update minute-bar OHLC. Keep that volume until the first OHLC-eligible
        # trade creates the bucket.
        self._pending_volume: dict[str, dict[str, tuple[int, float]]] = defaultdict(dict)

    def update_trade(
        self,
        *,
        symbol: str,
        price: float,
        volume: float,
        timestamp: int,
        update_price: bool = True,
        update_volume: bool = True,
    ) -> list[LiveBar]:

        symbol = symbol.upper()

        updated: list[LiveBar] = []

        with self._lock:

            for timeframe in TIMEFRAME_SECONDS:

                start, end = align_timestamp(timestamp, timeframe)

                current = self._current[symbol].get(timeframe)
                pending = self._pending_volume[symbol].get(timeframe)

                # Drop pending volume from an older empty bucket. Alpaca does
                # not emit a bar if no trade in the interval can establish OHLC.
                if pending is not None and pending[0] != start:
                    self._pending_volume[symbol].pop(timeframe, None)
                    pending = None

                # Ignore late/out-of-order trades for an already newer live
                # candle. Historical/updated bars remain the authority for
                # corrections to completed intervals.
                if current is not None and start < current.start_time:
                    continue

                # first candle for this symbol/timeframe
                if current is None:
                    if not update_price:
                        if update_volume:
                            previous = pending[1] if pending and pending[0] == start else 0.0
                            self._pending_volume[symbol][timeframe] = (
                                start,
                                previous + volume,
                            )
                        continue

                    carried_volume = pending[1] if pending and pending[0] == start else 0.0
                    self._pending_volume[symbol].pop(timeframe, None)
                    current = LiveBar(
                        symbol=symbol,
                        timeframe=timeframe,
                        start_time=start,
                        end_time=end,
                        open=price,
                        high=price,
                        low=price,
                        close=price,
                        volume=carried_volume + (volume if update_volume else 0.0),
                        first_price_timestamp=timestamp,
                        last_price_timestamp=timestamp,
                    )

                    self._current[symbol][timeframe] = current
                    updated.append(current)
                    continue

                # new candle. IMPORTANT: a new bar opens at the first eligible
                # trade in the new interval, not at the previous bar's close.
                # Carrying the previous close across a gap creates artificial
                # giant red/green candle bodies on thinly traded stocks.
                if current.start_time < start:
                    current.complete = True
                    self._history[symbol][timeframe].append(current)

                    if not update_price:
                        if update_volume:
                            self._pending_volume[symbol][timeframe] = (start, volume)
                        self._current[symbol].pop(timeframe, None)
                        continue

                    carried_volume = pending[1] if pending and pending[0] == start else 0.0
                    self._pending_volume[symbol].pop(timeframe, None)
                    current = LiveBar(
                        symbol=symbol,
                        timeframe=timeframe,
                        start_time=start,
                        end_time=end,
                        open=price,
                        high=price,
                        low=price,
                        close=price,
                        volume=carried_volume + (volume if update_volume else 0.0),
                        first_price_timestamp=timestamp,
                        last_price_timestamp=timestamp,
                    )

                    self._current[symbol][timeframe] = current
                    updated.append(current)
                    continue

                # update current candle. Price-ineligible SIP conditions can
                # still contribute volume without distorting OHLC.
                if update_price:
                    current.high = max(current.high, price)
                    current.low = min(current.low, price)

                    if (
                        current.first_price_timestamp <= 0
                        or timestamp < current.first_price_timestamp
                    ):
                        current.open = price
                        current.first_price_timestamp = timestamp

                    if (
                        current.last_price_timestamp <= 0
                        or timestamp >= current.last_price_timestamp
                    ):
                        current.close = price
                        current.last_price_timestamp = timestamp

                if update_volume:
                    current.volume += volume

                if update_price or update_volume:
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
            self._pending_volume.pop(symbol, None)

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