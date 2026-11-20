from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from zoneinfo import ZoneInfo

from app.services.alpaca_market_service import AlpacaMarketService
from .market_cache import upsert_candles

ET = ZoneInfo("America/New_York")

ALPACA_TIMEFRAME_MAP: Dict[str, str] = {
    "1m": "1Min",
    "5m": "5Min",
    "15m": "15Min",
    "30m": "30Min",
    "1h": "1Hour",
    # 4h bars are built from native 1-hour bars below so their ET bucket
    # alignment matches the chart more closely than a provider-specific 4Hour bar.
    "4h": "1Hour",
    "1d": "1Day",
    "day": "1Day",
}


def _date_range_months(months: int) -> tuple[datetime, datetime]:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=max(1, int(months)) * 31)
    return start, end


def _normalize_alpaca_bar(bar: Dict[str, Any]) -> Dict[str, Any]:
    ts = int(bar.get("time", bar.get("t", 0)) or 0)
    if ts < 10_000_000_000:
        ts *= 1000

    dt_utc = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    dt_et = dt_utc.astimezone(ET)

    return {
        "ts": ts,
        "dt_utc": dt_utc.isoformat(),
        "dt_et": dt_et.isoformat(),
        "trade_date": dt_et.date().isoformat(),
        "open": float(bar.get("open", bar.get("o", 0)) or 0),
        "high": float(bar.get("high", bar.get("h", 0)) or 0),
        "low": float(bar.get("low", bar.get("l", 0)) or 0),
        "close": float(bar.get("close", bar.get("c", 0)) or 0),
        "volume": float(bar.get("volume", bar.get("v", 0)) or 0),
    }


def _aggregate_four_hour_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not rows:
        return []

    buckets: Dict[int, Dict[str, Any]] = {}
    for row in sorted(rows, key=lambda item: int(item.get("ts") or 0)):
        ts = int(row.get("ts") or 0)
        if ts <= 0:
            continue
        dt_et = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).astimezone(ET)
        bucket_hour = (dt_et.hour // 4) * 4
        bucket_et = dt_et.replace(hour=bucket_hour, minute=0, second=0, microsecond=0)
        bucket_ts = int(bucket_et.astimezone(timezone.utc).timestamp() * 1000)

        open_price = float(row.get("open") or 0)
        high = float(row.get("high") or 0)
        low = float(row.get("low") or 0)
        close = float(row.get("close") or 0)
        volume = float(row.get("volume") or 0)

        current = buckets.get(bucket_ts)
        if current is None:
            bucket_utc = datetime.fromtimestamp(bucket_ts / 1000, tz=timezone.utc)
            buckets[bucket_ts] = {
                "ts": bucket_ts,
                "dt_utc": bucket_utc.isoformat(),
                "dt_et": bucket_et.isoformat(),
                "trade_date": bucket_et.date().isoformat(),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
            continue

        current["high"] = max(float(current["high"]), high)
        current["low"] = min(float(current["low"]), low)
        current["close"] = close
        current["volume"] = float(current["volume"]) + volume

    return [buckets[key] for key in sorted(buckets)]


def _postprocess_timeframe_rows(
    rows: List[Dict[str, Any]],
    timeframe: str,
) -> List[Dict[str, Any]]:
    tf = str(timeframe or "").lower().strip()
    if tf == "4h":
        return _aggregate_four_hour_rows(rows)
    return rows




async def load_alpaca_history_for_symbol(
    symbol: str,
    timeframe: str,
    months: int = 12,
) -> Dict[str, Any]:
    tf = str(timeframe or "").lower().strip()
    if tf not in ALPACA_TIMEFRAME_MAP:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    service = AlpacaMarketService()
    start, end = _date_range_months(months)

    raw_bars = await service._historical_bars(
        symbol=symbol.upper().strip(),
        timeframe=ALPACA_TIMEFRAME_MAP[tf],
        start=start,
        end=end,
        feed=service.feed,
        adjustment="all",
    )

    normalized: List[Dict[str, Any]] = []
    for row in raw_bars:
        try:
            bar = _normalize_alpaca_bar(row)
        except (TypeError, ValueError):
            continue
        if bar["ts"] > 0 and bar["high"] > 0 and bar["low"] > 0 and bar["close"] > 0:
            normalized.append(bar)

    normalized = _postprocess_timeframe_rows(normalized, tf)
    saved = upsert_candles(symbol, tf, normalized)

    return {
        "symbol": symbol.upper(),
        "timeframe": tf,
        "months": months,
        "bars_saved": saved,
        "start_date": start.date().isoformat(),
        "end_date": end.date().isoformat(),
        "provider": "alpaca",
        "feed": service.feed,
    }


async def load_alpaca_history(
    symbols: List[str],
    timeframes: List[str],
    months: int = 12,
) -> Dict[str, Any]:
    results: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    clean_symbols: List[str] = []
    for raw in symbols:
        symbol = "".join(ch for ch in str(raw).upper().strip() if ch.isalpha() or ch == ".")
        if symbol and symbol not in clean_symbols:
            clean_symbols.append(symbol)

    clean_timeframes: List[str] = []
    for raw in timeframes:
        timeframe = str(raw or "").lower().strip()
        if timeframe and timeframe not in clean_timeframes:
            clean_timeframes.append(timeframe)

    for symbol in clean_symbols:
        for timeframe in clean_timeframes:
            try:
                results.append(
                    await load_alpaca_history_for_symbol(symbol, timeframe, months)
                )
            except Exception as exc:
                errors.append({
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "error": str(exc),
                })

    return {
        "ok": len(errors) == 0,
        "provider": "alpaca",
        "results": results,
        "errors": errors,
    }


__all__ = ["load_alpaca_history", "load_alpaca_history_for_symbol"]

def _date_range_explicit(
    start_date: str,
    end_date: str,
    *,
    warmup_calendar_days: int = 7,
    future_calendar_days: int = 10,
) -> tuple[datetime, datetime]:
    start_local = datetime.fromisoformat(str(start_date)[:10]).replace(tzinfo=ET)
    end_local = datetime.fromisoformat(str(end_date)[:10]).replace(tzinfo=ET)
    start_local = start_local - timedelta(days=max(0, int(warmup_calendar_days)))
    end_local = end_local + timedelta(days=max(0, int(future_calendar_days)) + 1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


async def load_alpaca_history_for_symbol_range(
    symbol: str,
    timeframe: str,
    start_date: str,
    end_date: str,
    *,
    warmup_calendar_days: int = 7,
    future_calendar_days: int = 10,
) -> Dict[str, Any]:
    tf = str(timeframe or "").lower().strip()
    if tf not in ALPACA_TIMEFRAME_MAP:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    service = AlpacaMarketService()
    start, end = _date_range_explicit(
        start_date,
        end_date,
        warmup_calendar_days=warmup_calendar_days,
        future_calendar_days=future_calendar_days,
    )

    raw_bars = await service._historical_bars(
        symbol=symbol.upper().strip(),
        timeframe=ALPACA_TIMEFRAME_MAP[tf],
        start=start,
        end=end,
        feed=service.feed,
        adjustment="all",
    )

    normalized: List[Dict[str, Any]] = []
    for row in raw_bars:
        try:
            bar = _normalize_alpaca_bar(row)
        except (TypeError, ValueError):
            continue
        if bar["ts"] > 0 and bar["high"] > 0 and bar["low"] > 0 and bar["close"] > 0:
            normalized.append(bar)

    saved = upsert_candles(symbol, tf, normalized)
    return {
        "symbol": symbol.upper(),
        "timeframe": tf,
        "bars_saved": saved,
        "requested_start_date": str(start_date)[:10],
        "requested_end_date": str(end_date)[:10],
        "loaded_start_date": start.date().isoformat(),
        "loaded_end_date": end.date().isoformat(),
        "provider": "alpaca",
        "feed": service.feed,
    }


async def load_alpaca_history_for_ranges(
    symbol_ranges: Dict[str, Dict[str, str]],
    *,
    timeframe: str = "5m",
    warmup_calendar_days: int = 7,
    future_calendar_days: int = 10,
) -> Dict[str, Any]:
    results: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    for raw_symbol, date_range in (symbol_ranges or {}).items():
        symbol = "".join(ch for ch in str(raw_symbol).upper().strip() if ch.isalpha() or ch == ".")
        if not symbol or not isinstance(date_range, dict):
            continue
        start_date = str(date_range.get("start_date") or "")[:10]
        end_date = str(date_range.get("end_date") or start_date)[:10]
        if not start_date or not end_date:
            continue
        try:
            results.append(
                await load_alpaca_history_for_symbol_range(
                    symbol=symbol,
                    timeframe=timeframe,
                    start_date=start_date,
                    end_date=end_date,
                    warmup_calendar_days=warmup_calendar_days,
                    future_calendar_days=future_calendar_days,
                )
            )
        except Exception as exc:
            errors.append({
                "symbol": symbol,
                "timeframe": timeframe,
                "start_date": start_date,
                "end_date": end_date,
                "error": str(exc),
            })

    return {
        "ok": len(errors) == 0,
        "provider": "alpaca",
        "timeframe": timeframe,
        "results": results,
        "errors": errors,
    }




async def load_alpaca_history_bulk(
    symbols: List[str],
    timeframe: str,
    *,
    months: int = 12,
    start_date: str | None = None,
    end_date: str | None = None,
    warmup_calendar_days: int = 30,
    future_calendar_days: int = 120,
) -> Dict[str, Any]:
    """Bulk-load bars into the backtest SQLite cache.

    This is intended for research runs across many symbols. For 4h, native 1h
    bars are downloaded and aggregated into ET-aligned four-hour buckets.
    """
    tf = str(timeframe or "").lower().strip()
    if tf not in ALPACA_TIMEFRAME_MAP:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    clean_symbols: List[str] = []
    for raw in symbols or []:
        symbol = "".join(ch for ch in str(raw).upper().strip() if ch.isalpha() or ch == ".")
        if symbol and symbol not in clean_symbols:
            clean_symbols.append(symbol)

    if not clean_symbols:
        return {
            "ok": False,
            "timeframe": tf,
            "symbols_requested": 0,
            "bars_saved": 0,
            "results": [],
            "error": "No symbols supplied",
        }

    if bool(start_date) != bool(end_date):
        raise ValueError("Provide both start_date and end_date or neither")

    if start_date and end_date:
        start, end = _date_range_explicit(
            start_date,
            end_date,
            warmup_calendar_days=warmup_calendar_days,
            future_calendar_days=future_calendar_days,
        )
    else:
        start, end = _date_range_months(months)

    service = AlpacaMarketService()
    source_timeframe = ALPACA_TIMEFRAME_MAP[tf]

    # Keep each Alpaca multi-symbol response comfortably below the pagination
    # safety cap. Shorter timeframes generate many more rows per symbol.
    chunk_size = {
        "15m": 8,
        "30m": 12,
        "1h": 20,
        "4h": 20,
        "1d": 100,
        "day": 100,
    }.get(tf, 10)

    raw_by_symbol = await service.get_bulk_bars(
        clean_symbols,
        timeframe=source_timeframe,
        start=start,
        end=end,
        feed=service.feed,
        adjustment="all",
        chunk_size=chunk_size,
        concurrency=4,
    )

    results: List[Dict[str, Any]] = []
    total_saved = 0

    for symbol in clean_symbols:
        raw_bars = raw_by_symbol.get(symbol, [])
        normalized: List[Dict[str, Any]] = []
        for row in raw_bars:
            try:
                bar = _normalize_alpaca_bar(row)
            except (TypeError, ValueError):
                continue
            if bar["ts"] > 0 and bar["high"] > 0 and bar["low"] > 0 and bar["close"] > 0:
                normalized.append(bar)

        normalized = _postprocess_timeframe_rows(normalized, tf)
        saved = upsert_candles(symbol, tf, normalized)
        total_saved += saved
        results.append({
            "symbol": symbol,
            "timeframe": tf,
            "source_timeframe": source_timeframe,
            "bars_saved": saved,
        })

    return {
        "ok": True,
        "provider": "alpaca",
        "feed": service.feed,
        "timeframe": tf,
        "source_timeframe": source_timeframe,
        "symbols_requested": len(clean_symbols),
        "symbols_with_bars": sum(1 for row in results if int(row["bars_saved"]) > 0),
        "bars_saved": total_saved,
        "loaded_start_date": start.date().isoformat(),
        "loaded_end_date": end.date().isoformat(),
        "results": results,
    }


__all__ = [
    "load_alpaca_history",
    "load_alpaca_history_for_symbol",
    "load_alpaca_history_for_symbol_range",
    "load_alpaca_history_for_ranges",
    "load_alpaca_history_bulk",
]
