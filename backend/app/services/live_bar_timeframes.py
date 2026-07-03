from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


TIMEFRAME_SECONDS = {
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


def align_timestamp(
    timestamp_ms: int,
    timeframe: str,
) -> tuple[int, int]:
    """
    Returns

        start_ms,
        end_ms

    aligned exactly to the timeframe.
    """

    dt = datetime.fromtimestamp(timestamp_ms / 1000, ET)

    if timeframe.endswith("m"):

        mins = int(timeframe[:-1])

        aligned = dt.replace(
            minute=(dt.minute // mins) * mins,
            second=0,
            microsecond=0,
        )

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