from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class LiveBar:
    symbol: str
    timeframe: str

    start_time: int
    end_time: int

    open: float
    high: float
    low: float
    close: float

    volume: float = 0.0

    # Trade-time bounds keep OHLC deterministic when SIP messages arrive a
    # little out of order. These are internal aggregation fields and are not
    # exposed in the chart payload.
    first_price_timestamp: int = 0
    last_price_timestamp: int = 0

    complete: bool = False

    def update(
        self,
        *,
        price: float,
        volume: float,
    ) -> None:
        self.high = max(self.high, price)
        self.low = min(self.low, price)
        self.close = price
        self.volume += volume

    def to_chart(self) -> dict:
        return {
            "time": self.start_time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "complete": self.complete,
        }