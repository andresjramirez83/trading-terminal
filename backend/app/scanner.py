from __future__ import annotations

import asyncio
import os
from datetime import datetime, time, timedelta, timezone
from typing import Any, Dict, List

import httpx

try:
    from zoneinfo import ZoneInfo
    try:
        ET = ZoneInfo("America/New_York")
    except Exception:
        ET = timezone(timedelta(hours=-4))
except Exception:
    ET = timezone(timedelta(hours=-4))


POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "").strip()


_SHARED_POLYGON_CLIENT: httpx.AsyncClient | None = None


def get_shared_polygon_client(timeout: float) -> httpx.AsyncClient:
    global _SHARED_POLYGON_CLIENT
    if _SHARED_POLYGON_CLIENT is None or _SHARED_POLYGON_CLIENT.is_closed:
        _SHARED_POLYGON_CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            follow_redirects=True,
            headers={
                "Accept": "application/json",
                "User-Agent": "trading-terminal-sprint1/1.0",
            },
            http2=False,
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=25, keepalive_expiry=30.0),
        )
    return _SHARED_POLYGON_CLIENT


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def pct_change(current: float, prev: float) -> float:
    if prev <= 0:
        return 0.0
    return ((current - prev) / prev) * 100.0


def get_trade_day_et() -> str:
    now_et = datetime.now(ET)
    return now_et.strftime("%Y-%m-%d")


def get_session_mode_et() -> str:
    now_et = datetime.now(ET).time()

    if time(4, 0) <= now_et < time(9, 30):
        return "premarket"
    if time(9, 30) <= now_et < time(16, 0):
        return "regular"
    if time(16, 0) <= now_et < time(20, 0):
        return "afterhours"
    return "closed"


async def _fetch_polygon_json(
    url: str,
    params: Dict[str, Any],
    *,
    retries: int = 3,
    timeout: float = 20.0,
) -> Dict[str, Any]:
    last_exc: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            client = get_shared_polygon_client(timeout)
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            return resp.json()

        except (
            httpx.ReadError,
            httpx.ReadTimeout,
            httpx.ConnectError,
            httpx.RemoteProtocolError,
            httpx.TimeoutException,
        ) as exc:
            last_exc = exc
            if attempt >= retries:
                break
            await asyncio.sleep(0.6 * attempt)

        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code if exc.response is not None else None

            # Retry only transient server/rate-limit errors.
            if status in {429, 500, 502, 503, 504} and attempt < retries:
                last_exc = exc
                await asyncio.sleep(0.8 * attempt)
                continue

            raise

    if last_exc is not None:
        raise last_exc

    raise RuntimeError(f"Polygon request failed for {url}")


async def fetch_snapshot_gainers(limit: int = 50) -> List[Dict[str, Any]]:
    if not POLYGON_API_KEY:
        raise RuntimeError("POLYGON_API_KEY is missing")

    url = "https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers"
    params = {"apiKey": POLYGON_API_KEY}

    data = await _fetch_polygon_json(url, params=params, retries=3, timeout=20.0)
    return (data.get("tickers") or [])[:limit]


async def fetch_snapshot_actives(limit: int = 50) -> List[Dict[str, Any]]:
    if not POLYGON_API_KEY:
        return []

    paths = [
        "https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/most-active",
        "https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/mostActive",
    ]
    params = {"apiKey": POLYGON_API_KEY}

    for url in paths:
        try:
            data = await _fetch_polygon_json(url, params=params, retries=3, timeout=20.0)
            return (data.get("tickers") or [])[:limit]
        except httpx.HTTPStatusError as exc:
            # Some Polygon plans return 404 or another non-200 here.
            if exc.response is not None and exc.response.status_code in {403, 404}:
                continue
        except Exception:
            continue

    return []


def normalize_snapshot_row(raw: Dict[str, Any]) -> Dict[str, Any]:
    day = raw.get("day", {}) or {}
    prev_day = raw.get("prevDay", {}) or {}
    last_quote = raw.get("lastQuote", {}) or {}
    last_trade = raw.get("lastTrade", {}) or {}
    min_data = raw.get("min", {}) or {}

    symbol = str(raw.get("ticker", "")).upper()

    price = (
        safe_float(last_trade.get("p"))
        or safe_float(day.get("c"))
        or safe_float(min_data.get("c"))
    )

    prev_close = safe_float(prev_day.get("c"))
    volume = safe_float(day.get("v"))
    day_open = safe_float(day.get("o"))
    day_high = safe_float(day.get("h"))
    day_low = safe_float(day.get("l"))

    # Polygon sometimes uses lower-case keys, sometimes data may be missing.
    bid = safe_float(last_quote.get("P")) or safe_float(last_quote.get("p"))
    ask = safe_float(last_quote.get("p")) or safe_float(last_quote.get("P"))

    change_pct = pct_change(price, prev_close)
    gap_pct = pct_change(day_open, prev_close) if day_open > 0 and prev_close > 0 else 0.0
    range_pct = ((day_high - day_low) / day_low * 100.0) if day_low > 0 else 0.0

    score = (
        change_pct * 0.45
        + gap_pct * 0.20
        + min(volume / 1_000_000.0, 50.0) * 0.20
        + range_pct * 0.15
    )

    return {
        "symbol": symbol,
        "price": round(price, 4),
        "prev_close": round(prev_close, 4),
        "change_pct": round(change_pct, 2),
        "gap_pct": round(gap_pct, 2),
        "range_pct": round(range_pct, 2),
        "volume": int(volume),
        "day_open": round(day_open, 4),
        "day_high": round(day_high, 4),
        "day_low": round(day_low, 4),
        "bid": round(bid, 4) if bid > 0 else None,
        "ask": round(ask, 4) if ask > 0 else None,
        "score": round(score, 2),
    }


def merge_ranked_lists(
    gainers: List[Dict[str, Any]],
    actives: List[Dict[str, Any]],
    max_symbols: int = 25,
) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}

    for row in gainers:
        item = normalize_snapshot_row(row)
        if not item["symbol"]:
            continue
        item["source"] = "gainers"
        merged[item["symbol"]] = item

    for row in actives:
        item = normalize_snapshot_row(row)
        symbol = item["symbol"]

        if not symbol:
            continue

        if symbol in merged:
            existing = merged[symbol]
            existing["volume"] = max(existing["volume"], item["volume"])
            existing["score"] = round(existing["score"] + 5.0, 2)
            existing["source"] = "gainers+active"
        else:
            item["source"] = "active"
            merged[symbol] = item

    rows = list(merged.values())
    rows.sort(
        key=lambda x: (
            x["score"],
            x["change_pct"],
            x["volume"],
        ),
        reverse=True,
    )

    return rows[:max_symbols]


async def build_scanner(
    max_symbols: int = 25,
    min_price: float = 0.5,
    max_price: float = 20.0,
    min_volume: int = 100_000,
    min_change_pct: float = 3.0,
) -> Dict[str, Any]:
    gainers = await fetch_snapshot_gainers(limit=60)

    try:
        actives = await fetch_snapshot_actives(limit=60)
    except Exception:
        actives = []

    rows = merge_ranked_lists(gainers, actives, max_symbols=max_symbols * 3)

    filtered: List[Dict[str, Any]] = []
    for row in rows:
        if row["price"] < min_price:
            continue
        if row["price"] > max_price:
            continue
        if row["volume"] < min_volume:
            continue
        if row["change_pct"] < min_change_pct:
            continue
        filtered.append(row)

    filtered = filtered[:max_symbols]

    return {
        "trade_day": get_trade_day_et(),
        "session_mode": get_session_mode_et(),
        "count": len(filtered),
        "rows": filtered,
    }
