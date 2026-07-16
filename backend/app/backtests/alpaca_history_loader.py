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