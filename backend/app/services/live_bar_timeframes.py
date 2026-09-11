from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


TIMEFRAME_SECONDS: dict[str, int] = {
    "1m": 60,
    "2m": 120,
    "3m": 180,
    "5m": 300,
    "10m": 600,
    "15m": 900,
    "30m": 1800,
    "45m": 2700,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "1d": 86400,
}


def normalize_live_timeframe(value: str | None) -> str:
    tf = str(value or "1m").lower().strip().replace(" ", "")

    aliases = {
        "1": "1m",
        "1min": "1m",
        "2min": "2m",
        "3min": "3m",
        "5min": "5m",
        "10min": "10m",
        "15min": "15m",
        "30min": "30m",
        "45min": "45m",
        "60m": "1h",
        "60min": "1h",
        "hour": "1h",
        "120m": "2h",
        "240m": "4h",
        "day": "1d",
        "daily": "1d",
    }
    tf = aliases.get(tf, tf)

    if tf == "1d":
        return tf

    if len(tf) < 2 or tf[-1] not in {"m", "h"}:
        return "1m"

    try:
        amount = int(tf[:-1])
    except ValueError:
        return "1m"

    if tf.endswith("m") and 1 <= amount <= 720:
        return f"{amount}m"

    if tf.endswith("h") and 1 <= amount <= 24:
        return f"{amount}h"

    return "1m"


def register_timeframe(value: str | None) -> str:
    timeframe = normalize_live_timeframe(value)

    if timeframe in TIMEFRAME_SECONDS:
        return timeframe

    amount = int(timeframe[:-1])
    if timeframe.endswith("m"):
        TIMEFRAME_SECONDS[timeframe] = amount * 60
    elif timeframe.endswith("h"):
        TIMEFRAME_SECONDS[timeframe] = amount * 3600

    return timeframe


def align_timestamp(
    timestamp_ms: int,
    timeframe: str,
) -> tuple[int, int]:
    """
    Return (start_ms, end_ms) aligned to the exchange-local interval.

    Intraday custom bars are aligned from midnight ET so historical and live
    aggregation use the same bucket boundaries even across DST changes.
    """

    timeframe = register_timeframe(timeframe)
    dt = datetime.fromtimestamp(timestamp_ms / 1000, ET)

    if timeframe.endswith("m"):
        mins = int(timeframe[:-1])
        total_minutes = dt.hour * 60 + dt.minute
        bucket_minutes = (total_minutes // mins) * mins
        midnight = dt.replace(hour=0, minute=0, second=0, microsecond=0)
        aligned = midnight + timedelta(minutes=bucket_minutes)

    elif timeframe.endswith("h"):
        hrs = int(timeframe[:-1])
        aligned = dt.replace(
            hour=(dt.hour // hrs) * hrs,
            minute=0,
            second=0,
            microsecond=0,
        )

    else:
        aligned = dt.replace(
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )

    start = int(aligned.timestamp() * 1000)
    end = start + (TIMEFRAME_SECONDS[timeframe] * 1000)
    return start, end
