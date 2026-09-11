from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta


@dataclass(frozen=True, slots=True)
class TimeframeConfig:
    name: str
    multiplier: int
    timespan: str
    lookback: timedelta
    cache_seconds: int
    aggregate_from: str | None = None


TIMEFRAMES: dict[str, TimeframeConfig] = {
    "1m": TimeframeConfig("1m", 1, "minute", timedelta(days=5), 5),
    "2m": TimeframeConfig("2m", 2, "minute", timedelta(days=10), 10, "1m"),
    "3m": TimeframeConfig("3m", 3, "minute", timedelta(days=10), 10, "1m"),
    "5m": TimeframeConfig("5m", 5, "minute", timedelta(days=30), 15, "1m"),
    "10m": TimeframeConfig("10m", 10, "minute", timedelta(days=60), 20, "1m"),
    "15m": TimeframeConfig("15m", 15, "minute", timedelta(days=90), 30, "1m"),
    "30m": TimeframeConfig("30m", 30, "minute", timedelta(days=180), 45, "1m"),
    "45m": TimeframeConfig("45m", 45, "minute", timedelta(days=365), 60, "1m"),

    "1h": TimeframeConfig("1h", 1, "hour", timedelta(days=730), 60),
    "2h": TimeframeConfig("2h", 2, "hour", timedelta(days=730), 60, "1h"),
    "4h": TimeframeConfig("4h", 4, "hour", timedelta(days=1460), 60, "1h"),

    "1d": TimeframeConfig("1d", 1, "day", timedelta(days=3650), 300),
    "1w": TimeframeConfig("1w", 1, "week", timedelta(days=7300), 900, "1d"),
    "1mo": TimeframeConfig("1mo", 1, "month", timedelta(days=7300), 1800, "1d"),
}


ALIASES: dict[str, str] = {
    "1": "1m",
    "1min": "1m",
    "minute": "1m",

    "2min": "2m",
    "3min": "3m",
    "5min": "5m",
    "10min": "10m",
    "15min": "15m",
    "30min": "30m",
    "45min": "45m",

    "60m": "1h",
    "hour": "1h",
    "1H": "1h",
    "2H": "2h",
    "4H": "4h",

    "d": "1d",
    "day": "1d",
    "daily": "1d",

    "week": "1w",
    "weekly": "1w",
    "1W": "1w",

    "month": "1mo",
    "monthly": "1mo",
    "1M": "1mo",
    "1mo": "1mo",
}


def normalize_timeframe(value: str) -> str:
    raw = str(value or "1m").strip()
    return ALIASES.get(raw, ALIASES.get(raw.lower(), raw.lower()))


def get_timeframe(value: str) -> TimeframeConfig:
    key = normalize_timeframe(value)
    config = TIMEFRAMES.get(key)
    if config is not None:
        return config

    # Custom intraday intervals: e.g. 7m, 90m, 3h, 6h, 12h.
    # Keep the allowed range bounded so history requests remain responsive.
    if len(key) >= 2 and key[-1] in {"m", "h"}:
        try:
            amount = int(key[:-1])
        except ValueError:
            amount = 0

        if key.endswith("m") and 1 <= amount <= 720:
            if amount <= 5:
                lookback = timedelta(days=10)
                cache_seconds = 10
            elif amount <= 30:
                lookback = timedelta(days=60)
                cache_seconds = 20
            elif amount <= 120:
                lookback = timedelta(days=180)
                cache_seconds = 45
            else:
                lookback = timedelta(days=365)
                cache_seconds = 60

            return TimeframeConfig(
                key,
                amount,
                "minute",
                lookback,
                cache_seconds,
                "1m" if amount > 1 else None,
            )

        if key.endswith("h") and 1 <= amount <= 24:
            return TimeframeConfig(
                key,
                amount,
                "hour",
                timedelta(days=1460 if amount >= 4 else 730),
                60,
                "1h" if amount > 1 else None,
            )

    raise ValueError(f"Unsupported timeframe: {value}")
