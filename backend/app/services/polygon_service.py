from __future__ import annotations

import asyncio
import os
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, List, Optional, Tuple

import httpx

ET = ZoneInfo("America/New_York")


class PolygonService:
    _shared_client: Optional[httpx.AsyncClient] = None

    @classmethod
    def _client(cls, timeout: httpx.Timeout) -> httpx.AsyncClient:
        if cls._shared_client is None or cls._shared_client.is_closed:
            cls._shared_client = httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=True,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "trading-terminal-sprint1/1.0",
                },
                http2=False,
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=30.0),
            )
        return cls._shared_client

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = (api_key or os.getenv("POLYGON_API_KEY", "")).strip()
        if not self.api_key:
            raise RuntimeError("POLYGON_API_KEY is missing")

        self.base_url = "https://api.polygon.io"
        self.timeout = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=30.0)
        self.max_retries = 3

    async def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        merged = dict(params or {})
        merged["apiKey"] = self.api_key

        last_error = ""

        for attempt in range(1, self.max_retries + 1):
            try:
                client = self._client(self.timeout)
                response = await client.get(f"{self.base_url}{path}", params=merged)

                body_preview = response.text[:500]

                if response.status_code == 200:
                    return response.json()

                last_error = f"Polygon HTTP {response.status_code} for {path}: {body_preview}"

                if response.status_code in {408, 409, 425, 429, 500, 502, 503, 504} and attempt < self.max_retries:
                    await asyncio.sleep(0.8 * attempt)
                    continue

                raise RuntimeError(last_error)

            except (httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.ConnectError, httpx.TimeoutException) as exc:
                last_error = f"Polygon network error for {path}: {type(exc).__name__}: {exc}"
                if attempt < self.max_retries:
                    await asyncio.sleep(0.8 * attempt)
                    continue
                raise RuntimeError(last_error) from exc

            except ValueError as exc:
                last_error = f"Polygon JSON parse error for {path}: {exc}"
                if attempt < self.max_retries:
                    await asyncio.sleep(0.8 * attempt)
                    continue
                raise RuntimeError(last_error) from exc

        raise RuntimeError(last_error or f"Polygon request failed for {path}")

    async def get_snapshot_gainers(self, limit: int = 50) -> List[Dict[str, Any]]:
        data = await self._get("/v2/snapshot/locale/us/markets/stocks/gainers")
        return (data.get("tickers") or [])[:limit]

    async def get_snapshot_actives(self, limit: int = 50) -> List[Dict[str, Any]]:
        paths = [
            "/v2/snapshot/locale/us/markets/stocks/most-active",
            "/v2/snapshot/locale/us/markets/stocks/mostActive",
        ]

        for path in paths:
            try:
                data = await self._get(path)
                tickers = data.get("tickers") or []
                if tickers:
                    return tickers[:limit]
            except Exception as exc:
                # Some Polygon plans do not support the active endpoint. A 404 here
                # is expected and should not spam logs every scanner cycle.
                if "HTTP 404" not in str(exc):
                    print(f"POLYGON ACTIVE SNAPSHOT FAILED {path}: {exc}", flush=True)
                continue

        return []

    async def get_snapshot_losers(self, limit: int = 50) -> List[Dict[str, Any]]:
        try:
            data = await self._get("/v2/snapshot/locale/us/markets/stocks/losers")
            return (data.get("tickers") or [])[:limit]
        except Exception as exc:
            print(f"POLYGON LOSERS SNAPSHOT FAILED: {exc}", flush=True)
            return []

    async def get_ticker_snapshot(self, symbol: str) -> Dict[str, Any]:
        data = await self._get(f"/v2/snapshot/locale/us/markets/stocks/tickers/{symbol.upper()}")
        return data.get("ticker") or {}

    async def get_last_trade(self, symbol: str) -> Optional[float]:
        try:
            data = await self._get(f"/v2/last/trade/{symbol.upper()}")
            results = data.get("results") or {}
            price = results.get("p")
            return float(price) if price is not None else None
        except Exception as exc:
            print(f"POLYGON LAST TRADE FAILED {symbol}: {exc}", flush=True)
            return None

    async def get_ticker_details(self, symbol: str) -> Dict[str, Any]:
        try:
            data = await self._get(f"/v3/reference/tickers/{symbol.upper()}")
            return data.get("results") or {}
        except Exception as exc:
            # Scanner candidates can include tickers that no longer have details.
            # Treat Polygon 404s as normal misses instead of noisy errors.
            if "HTTP 404" not in str(exc):
                print(f"POLYGON TICKER DETAILS FAILED {symbol}: {exc}", flush=True)
            return {}

    def _ms_to_dates(self, start_ms: int, end_ms: int) -> Tuple[str, str]:
        start_dt = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
        end_dt = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)
        return start_dt.strftime("%Y-%m-%d"), end_dt.strftime("%Y-%m-%d")

    async def get_aggs(
        self,
        symbol: str,
        multiplier: int,
        timespan: str,
        start_ms: int,
        end_ms: int,
        adjusted: str = "true",
        sort: str = "asc",
        limit: int = 50000,
    ) -> List[Dict[str, Any]]:
        symbol = symbol.upper().strip()

        params = {
            "adjusted": adjusted,
            "sort": sort,
            "limit": limit,
        }

        ms_path = f"/v2/aggs/ticker/{symbol}/range/{multiplier}/{timespan}/{start_ms}/{end_ms}"

        try:
            data = await self._get(ms_path, params=params)
            return data.get("results") or []
        except Exception as ms_exc:
            print(f"POLYGON AGGS MS FAILED {symbol} {multiplier}{timespan}: {ms_exc}", flush=True)

            from_date, to_date = self._ms_to_dates(start_ms, end_ms)
            date_path = f"/v2/aggs/ticker/{symbol}/range/{multiplier}/{timespan}/{from_date}/{to_date}"

            try:
                data = await self._get(date_path, params=params)
                results = data.get("results") or []
                return [bar for bar in results if start_ms <= int(bar.get("t", 0)) <= end_ms]
            except Exception as date_exc:
                print(f"POLYGON AGGS DATE FALLBACK FAILED {symbol} {multiplier}{timespan}: {date_exc}", flush=True)
                raise RuntimeError(
                    f"Polygon aggs failed for {symbol} {multiplier}{timespan}. "
                    f"MS error: {ms_exc}. Date fallback error: {date_exc}"
                ) from date_exc

    def _normalize_aggs(self, raw_bars: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Convert Polygon aggregate bars into the exact Candle shape your ChartPanel uses:
        time/open/high/low/close/volume. IMPORTANT: ChartPanel expects time in milliseconds
        and then divides it by 1000 for Lightweight Charts.
        """
        out: List[Dict[str, Any]] = []
        for bar in raw_bars:
            try:
                t = int(bar.get("t"))
                o = float(bar.get("o"))
                h = float(bar.get("h"))
                l = float(bar.get("l"))
                c = float(bar.get("c"))
                v = float(bar.get("v", 0) or 0)
            except Exception:
                continue

            if t <= 0 or h <= 0 or l <= 0 or c <= 0:
                continue

            # Keep BOTH shapes so scanner code and chart code can read the same bars.
            # ChartPanel uses time/open/high/low/close/volume.
            # Older scanner/session code uses Polygon-style t/o/h/l/c/v.
            out.append(
                {
                    "time": t,
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": v,
                    "t": t,
                    "o": o,
                    "h": h,
                    "l": l,
                    "c": c,
                    "v": v,
                }
            )

        return out

    def _timeframe_config(self, timeframe: str) -> Tuple[int, str, timedelta, str]:
        tf = (timeframe or "1m").lower().strip()

        # Wider windows fix midnight/weekend/holiday blanks. A 24-hour 1m window can be
        # empty on Sunday or after midnight when the last regular session is outside that window.
        if tf in {"1m", "1min", "1", "minute"}:
            return 1, "minute", timedelta(days=3), "1m"
        if tf in {"5m", "5min", "5"}:
            return 5, "minute", timedelta(days=7), "5m"
        if tf in {"15m", "15min", "15"}:
            return 15, "minute", timedelta(days=14), "15m"
        if tf in {"30m", "30min", "30"}:
            return 30, "minute", timedelta(days=21), "30m"
        if tf in {"1h", "60m", "60min", "hour"}:
            return 1, "hour", timedelta(days=60), "1h"
        if tf in {"1d", "day", "daily", "d"}:
            return 1, "day", timedelta(days=365), "1d"

        print(f"POLYGON GET_BARS UNKNOWN TIMEFRAME {timeframe!r}; defaulting to 1m", flush=True)
        return 1, "minute", timedelta(days=3), "1m"

    def _normalize_daily_session(self, session: Optional[str]) -> str:
        value = str(session or "regular").lower().strip()
        if value in {"regular", "rth", "market", "reg", "normal"}:
            return "regular"
        if value in {"extended", "ext", "full", "full_session", "all", "ah", "afterhours", "premarket"}:
            return "extended"
        return "regular"

    def _bar_in_daily_session(self, ms: int, session: str) -> bool:
        dt = datetime.fromtimestamp(ms / 1000, ET)
        hhmm = dt.hour * 100 + dt.minute
        if session == "extended":
            return 400 <= hhmm < 2000
        return 930 <= hhmm < 1600

    def _aggregate_to_daily(self, bars: List[Dict[str, Any]], session: str) -> List[Dict[str, Any]]:
        grouped: Dict[date, Dict[str, Any]] = {}
        for bar in sorted(bars, key=lambda item: int(item.get("time", item.get("t", 0)) or 0)):
            t = int(bar.get("time", bar.get("t", 0)) or 0)
            if t <= 0 or not self._bar_in_daily_session(t, session):
                continue

            dt = datetime.fromtimestamp(t / 1000, ET)
            day = dt.date()
            open_dt = datetime(day.year, day.month, day.day, 9, 30, tzinfo=ET)
            if session == "extended":
                open_dt = datetime(day.year, day.month, day.day, 4, 0, tzinfo=ET)

            o = float(bar.get("open", bar.get("o", 0)) or 0)
            h = float(bar.get("high", bar.get("h", 0)) or 0)
            l = float(bar.get("low", bar.get("l", 0)) or 0)
            c = float(bar.get("close", bar.get("c", 0)) or 0)
            v = float(bar.get("volume", bar.get("v", 0)) or 0)
            if h <= 0 or l <= 0 or c <= 0:
                continue

            row = grouped.get(day)
            if row is None:
                row = {
                    "time": int(open_dt.timestamp() * 1000),
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": v,
                }
                grouped[day] = row
                continue

            row["high"] = max(float(row["high"]), h)
            row["low"] = min(float(row["low"]), l)
            row["close"] = c
            row["volume"] = float(row["volume"]) + v

        out: List[Dict[str, Any]] = []
        for _, row in sorted(grouped.items(), key=lambda item: item[0]):
            row.update({
                "t": row["time"],
                "o": row["open"],
                "h": row["high"],
                "l": row["low"],
                "c": row["close"],
                "v": row["volume"],
            })
            out.append(row)
        return out


    async def get_bars(self, symbol: str, timeframe: str = "1m", session: str = "regular") -> List[Dict[str, Any]]:
        symbol = symbol.upper().strip()
        multiplier, timespan, lookback, normalized_tf = self._timeframe_config(timeframe)

        now = datetime.now(timezone.utc)
        start = now - lookback

        # Daily charts are built from 1m bars so today's candle forms live.
        if normalized_tf == "1d":
            normalized_session = self._normalize_daily_session(session)
            raw = await self.get_aggs(
                symbol=symbol,
                multiplier=1,
                timespan="minute",
                start_ms=int(start.timestamp() * 1000),
                end_ms=int(now.timestamp() * 1000),
                adjusted="true",
                sort="asc",
                limit=50000,
            )
            intraday = self._normalize_aggs(raw)
            bars = self._aggregate_to_daily(intraday, normalized_session)
            print(
                f"POLYGON GET_BARS RESULT {symbol} 1d session={normalized_session}: "
                f"raw_1m={len(raw)} daily={len(bars)}",
                flush=True,
            )
            return bars

        print(
            f"POLYGON GET_BARS {symbol} tf={timeframe} normalized={normalized_tf} "
            f"range={start.isoformat()} -> {now.isoformat()}",
            flush=True,
        )

        raw = await self.get_aggs(
            symbol=symbol,
            multiplier=multiplier,
            timespan=timespan,
            start_ms=int(start.timestamp() * 1000),
            end_ms=int(now.timestamp() * 1000),
            adjusted="true",
            sort="asc",
            limit=50000,
        )

        bars = self._normalize_aggs(raw)
        print(f"POLYGON GET_BARS RESULT {symbol} {normalized_tf}: raw={len(raw)} normalized={len(bars)}", flush=True)
        return bars

    async def get_recent_1m_bars(self, symbol: str, hours_back: int = 48) -> List[Dict[str, Any]]:
        now = datetime.now(timezone.utc)
        start = now - timedelta(hours=hours_back)
        raw = await self.get_aggs(
            symbol=symbol,
            multiplier=1,
            timespan="minute",
            start_ms=int(start.timestamp() * 1000),
            end_ms=int(now.timestamp() * 1000),
            adjusted="true",
            sort="asc",
            limit=50000,
        )
        return self._normalize_aggs(raw)


# Backwards-compatible function wrappers for older routes/scanner code that still imports
# get_polygon_bars/get_last_trade directly from app.services.polygon_service.
def get_polygon_bars(symbol: str, timeframe: str = "1m", session: str = "regular") -> List[Dict[str, Any]]:
    return asyncio.run(PolygonService().get_bars(symbol, timeframe, session=session))


def get_last_trade(symbol: str) -> Optional[float]:
    return asyncio.run(PolygonService().get_last_trade(symbol))
