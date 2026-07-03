from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from typing import Iterable, List
from zoneinfo import ZoneInfo

from app.history.history_types import HistoryBar

ET = ZoneInfo("America/New_York")


class HistoryAggregation:
    @staticmethod
    def aggregate(
        bars: Iterable[HistoryBar],
        timeframe: str,
    ) -> List[HistoryBar]:
        tf = str(timeframe or "1m").lower().strip()

        if tf == "1m":
            return list(bars)

        if tf.endswith("m") and tf != "1mo":
            return HistoryAggregation.aggregate_minutes(bars, int(tf[:-1]))

        if tf.endswith("h"):
            return HistoryAggregation.aggregate_hours(bars, int(tf[:-1]))

        if tf == "1d":
            return HistoryAggregation.aggregate_daily(bars)

        if tf == "1w":
            return HistoryAggregation.aggregate_weekly(bars)

        if tf == "1mo":
            return HistoryAggregation.aggregate_monthly(bars)

        raise ValueError(f"Unsupported timeframe {timeframe}")

    @staticmethod
    def aggregate_minutes(
        bars: Iterable[HistoryBar],
        minutes: int,
    ) -> List[HistoryBar]:
        buckets = OrderedDict()

        for bar in sorted(bars, key=lambda item: item.time):
            dt = datetime.fromtimestamp(bar.time / 1000, ET)

            bucket = dt.replace(
                minute=(dt.minute // minutes) * minutes,
                second=0,
                microsecond=0,
            )

            ts = int(bucket.timestamp() * 1000)
            HistoryAggregation._merge_bucket(buckets, ts, bar)

        return list(buckets.values())

    @staticmethod
    def aggregate_hours(
        bars: Iterable[HistoryBar],
        hours: int,
    ) -> List[HistoryBar]:
        buckets = OrderedDict()

        for bar in sorted(bars, key=lambda item: item.time):
            dt = datetime.fromtimestamp(bar.time / 1000, ET)

            bucket = dt.replace(
                hour=(dt.hour // hours) * hours,
                minute=0,
                second=0,
                microsecond=0,
            )

            ts = int(bucket.timestamp() * 1000)
            HistoryAggregation._merge_bucket(buckets, ts, bar)

        return list(buckets.values())

    @staticmethod
    def aggregate_daily(
        bars: Iterable[HistoryBar],
    ) -> List[HistoryBar]:
        buckets = OrderedDict()

        for bar in sorted(bars, key=lambda item: item.time):
            dt = datetime.fromtimestamp(bar.time / 1000, ET)

            bucket = datetime(
                dt.year,
                dt.month,
                dt.day,
                tzinfo=ET,
            )

            ts = int(bucket.timestamp() * 1000)
            HistoryAggregation._merge_bucket(buckets, ts, bar)

        return list(buckets.values())

    @staticmethod
    def aggregate_weekly(
        bars: Iterable[HistoryBar],
    ) -> List[HistoryBar]:
        buckets = OrderedDict()

        for bar in sorted(bars, key=lambda item: item.time):
            dt = datetime.fromtimestamp(bar.time / 1000, ET)

            monday = dt.date().toordinal() - dt.weekday()
            bucket = datetime.fromordinal(monday).replace(tzinfo=ET)

            ts = int(bucket.timestamp() * 1000)
            HistoryAggregation._merge_bucket(buckets, ts, bar)

        return list(buckets.values())

    @staticmethod
    def aggregate_monthly(
        bars: Iterable[HistoryBar],
    ) -> List[HistoryBar]:
        buckets = OrderedDict()

        for bar in sorted(bars, key=lambda item: item.time):
            dt = datetime.fromtimestamp(bar.time / 1000, ET)

            bucket = datetime(
                dt.year,
                dt.month,
                1,
                tzinfo=ET,
            )

            ts = int(bucket.timestamp() * 1000)
            HistoryAggregation._merge_bucket(buckets, ts, bar)

        return list(buckets.values())

    @staticmethod
    def _merge_bucket(
        buckets,
        timestamp: int,
        bar: HistoryBar,
    ) -> None:
        existing = buckets.get(timestamp)

        if existing is None:
            buckets[timestamp] = HistoryBar(
                time=timestamp,
                open=bar.open,
                high=bar.high,
                low=bar.low,
                close=bar.close,
                volume=bar.volume,
            )
            return

        existing.high = max(existing.high, bar.high)
        existing.low = min(existing.low, bar.low)
        existing.close = bar.close
        existing.volume += bar.volume