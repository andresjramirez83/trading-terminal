from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict


@dataclass(slots=True)
class HistoryBar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    @classmethod
    def from_polygon(cls, bar: Dict[str, Any]) -> "HistoryBar":
        return cls(
            time=int(bar["t"]),
            open=float(bar["o"]),
            high=float(bar["h"]),
            low=float(bar["l"]),
            close=float(bar["c"]),
            volume=float(bar.get("v", 0) or 0),
        )

    @classmethod
    def from_chart(cls, bar: Dict[str, Any]) -> "HistoryBar":
        return cls(
            time=int(bar["time"]),
            open=float(bar["open"]),
            high=float(bar["high"]),
            low=float(bar["low"]),
            close=float(bar["close"]),
            volume=float(bar.get("volume", 0) or 0),
        )

    def to_chart(self) -> Dict[str, Any]:
        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "t": self.time,
            "o": self.open,
            "h": self.high,
            "l": self.low,
            "c": self.close,
            "v": self.volume,
        }