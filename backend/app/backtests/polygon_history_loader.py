import os
import httpx
from datetime import datetime, timedelta, timezone
from typing import Dict, List
from zoneinfo import ZoneInfo

from .market_cache import upsert_candles

POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "").strip() or os.getenv("POLYGON_KEY", "").strip()
ET = ZoneInfo("America/New_York")

TIMEFRAME_MAP = {
    "1m": (1, "minute"),
    "5m": (5, "minute"),
    "15m": (15, "minute"),
    "30m": (30, "minute"),
    "1h": (1, "hour"),
    "1d": (1, "day"),
    "day": (1, "day"),
}


def _date_range_months(months: int) -> tuple[str, str]:
    end = datetime.now(ET).date()
    start = end - timedelta(days=max(1, months) * 31)
    return start.isoformat(), end.isoformat()


def _normalize_polygon_bar(bar: Dict) -> Dict:
    ts = int(bar["t"])
    dt_utc = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    dt_et = dt_utc.astimezone(ET)

    return {
        "ts": ts,
        "dt_utc": dt_utc.isoformat(),
        "dt_et": dt_et.isoformat(),
        "trade_date": dt_et.date().isoformat(),
        "open": float(bar["o"]),
        "high": float(bar["h"]),
        "low": float(bar["l"]),
        "close": float(bar["c"]),
        "volume": float(bar.get("v", 0)),
    }


async def load_polygon_history_for_symbol(symbol: str, timeframe: str, months: int = 12) -> Dict:
    if not POLYGON_API_KEY:
        raise RuntimeError("Missing POLYGON_API_KEY or POLYGON_KEY environment variable")

    tf = timeframe.lower().strip()
    if tf not in TIMEFRAME_MAP:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    multiplier, span = TIMEFRAME_MAP[tf]
    start_date, end_date = _date_range_months(months)

    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{symbol.upper()}/range/"
        f"{multiplier}/{span}/{start_date}/{end_date}"
    )

    params = {
        "adjusted": "true",
        "sort": "asc",
        "limit": 50000,
        "apiKey": POLYGON_API_KEY,
    }

    all_bars: List[Dict] = []

    async with httpx.AsyncClient(timeout=60) as client:
        while True:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

            for row in data.get("results", []) or []:
                all_bars.append(_normalize_polygon_bar(row))

            next_url = data.get("next_url")
            if not next_url:
                break

            url = next_url
            params = {"apiKey": POLYGON_API_KEY}

    saved = upsert_candles(symbol, tf, all_bars)

    return {
        "symbol": symbol.upper(),
        "timeframe": tf,
        "months": months,
        "bars_saved": saved,
        "start_date": start_date,
        "end_date": end_date,
    }


async def load_polygon_history(symbols: List[str], timeframes: List[str], months: int = 12) -> Dict:
    results = []
    errors = []

    clean_symbols = []
    for raw in symbols:
        sym = "".join(ch for ch in str(raw).upper().strip() if ch.isalpha() or ch == ".")
        if sym and sym not in clean_symbols:
            clean_symbols.append(sym)

    for symbol in clean_symbols:
        for timeframe in timeframes:
            try:
                results.append(await load_polygon_history_for_symbol(symbol, timeframe, months))
            except Exception as exc:
                errors.append({"symbol": symbol, "timeframe": timeframe, "error": str(exc)})

    return {
        "ok": len(errors) == 0,
        "results": results,
        "errors": errors,
    }
