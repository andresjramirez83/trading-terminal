from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv


# backend/app/services/alpaca_market_service.py -> backend/.env
ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=True)

ET = ZoneInfo("America/New_York")

logger = logging.getLogger(__name__)

DEBUG_ALPACA_MARKET = os.getenv(
    "DEBUG_ALPACA_MARKET",
    "false",
).strip().lower() in {"1", "true", "yes", "on"}


def _debug(message: str) -> None:
    if DEBUG_ALPACA_MARKET:
        logger.info(message)


def _clone_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [dict(row) for row in rows]


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _timestamp_ms(value: Any) -> int:
    """Convert Alpaca RFC-3339 timestamps or epoch values to Unix milliseconds."""
    if value is None:
        return 0

    if isinstance(value, (int, float)):
        number = int(float(value))
        return number if number >= 10_000_000_000 else number * 1000

    raw = str(value).strip()
    if not raw:
        return 0

    try:
        number = int(float(raw))
        return number if number >= 10_000_000_000 else number * 1000
    except Exception:
        pass

    try:
        # Python supports microseconds, while Alpaca may send nanoseconds.
        # Truncate the fractional component to six digits before parsing.
        normalized = raw.replace("Z", "+00:00")
        if "." in normalized:
            head, tail = normalized.split(".", 1)
            timezone_marker = ""
            fraction = tail

            plus_index = fraction.find("+")
            minus_index = fraction.find("-")
            indexes = [index for index in (plus_index, minus_index) if index >= 0]

            if indexes:
                split_index = min(indexes)
                timezone_marker = fraction[split_index:]
                fraction = fraction[:split_index]

            normalized = f"{head}.{fraction[:6]}{timezone_marker}"

        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except Exception:
        return 0


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        if number != number:
            return default
        return number
    except Exception:
        return default


class AlpacaMarketService:
    """Alpaca stock market-data provider for charts, scanners, alerts, and replay.

    Market data comes from https://data.alpaca.markets. The default stock feed
    is SIP. When enabled, BOATS bars are merged with SIP bars so the chart can
    cover the 8:00 PM-4:00 AM ET overnight session in addition to premarket,
    regular trading, and after-hours.

    All returned bars preserve both application shapes:
      - time/open/high/low/close/volume
      - t/o/h/l/c/v

    Timestamps are always Unix milliseconds.
    """

    _shared_client: Optional[httpx.AsyncClient] = None
    _bars_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
    _cache_max_items = 384

    def __init__(self) -> None:
        self.base_url = os.getenv(
            "ALPACA_DATA_BASE_URL",
            "https://data.alpaca.markets",
        ).rstrip("/")

        self.feed = os.getenv("ALPACA_STOCK_FEED", "sip").strip().lower() or "sip"
        self.overnight_feed = os.getenv(
            "ALPACA_OVERNIGHT_FEED",
            "boats",
        ).strip().lower() or "boats"

        self.include_overnight = os.getenv(
            "ALPACA_EXTENDED_INCLUDE_OVERNIGHT",
            "true",
        ).strip().lower() in {"1", "true", "yes", "on"}

        self.key_id, self.secret_key = self._resolve_credentials()

        if not self.key_id or not self.secret_key:
            raise RuntimeError(
                "Missing Alpaca market-data credentials. Set "
                "APCA_API_KEY_ID_LIVE / APCA_API_SECRET_KEY_LIVE. "
                "The service can temporarily fall back to the PAPER credentials "
                "when the live variables are not present."
            )

        self.timeout = httpx.Timeout(
            connect=10.0,
            read=35.0,
            write=20.0,
            pool=35.0,
        )
        self.max_retries = max(
            1,
            int(os.getenv("ALPACA_MARKET_MAX_RETRIES", "3") or "3"),
        )

        _debug(
            "AlpacaMarketService initialized "
            f"feed={self.feed} overnight={self.overnight_feed} "
            f"include_overnight={self.include_overnight}"
        )

    def _resolve_credentials(self) -> Tuple[str, str]:
        live_key = os.getenv("APCA_API_KEY_ID_LIVE", "").strip()
        live_secret = os.getenv("APCA_API_SECRET_KEY_LIVE", "").strip()

        if live_key and live_secret:
            return live_key, live_secret

        # Alpaca market-data authorization may also work with paper-account keys.
        # This fallback keeps local development working while the live keys are
        # being added to the server environment.
        return (
            os.getenv("APCA_API_KEY_ID_PAPER", "").strip(),
            os.getenv("APCA_API_SECRET_KEY_PAPER", "").strip(),
        )

    def _latest_stock_feed(self) -> str:
        """Use the overnight market-data feed during the BOATS session.

        SIP does not represent the 8:00 PM-4:00 AM ET overnight market. Using
        a frozen SIP quote there can falsely trigger synthetic stop/target or
        pre-entry invalidation logic.
        """
        now_et = datetime.now(ET)
        hour = now_et.hour
        if self.include_overnight and (hour >= 20 or hour < 4):
            return self.overnight_feed
        return self.feed

    @property
    def headers(self) -> Dict[str, str]:
        return {
            "APCA-API-KEY-ID": self.key_id,
            "APCA-API-SECRET-KEY": self.secret_key,
            "Accept": "application/json",
            "User-Agent": "trading-terminal-alpaca-market/1.0",
        }

    @classmethod
    def _client(cls, timeout: httpx.Timeout) -> httpx.AsyncClient:
        if cls._shared_client is None or cls._shared_client.is_closed:
            cls._shared_client = httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=True,
                http2=False,
                limits=httpx.Limits(
                    max_keepalive_connections=30,
                    max_connections=75,
                    keepalive_expiry=45.0,
                ),
            )
        return cls._shared_client

    @classmethod
    async def close_shared_client(cls) -> None:
        client = cls._shared_client
        cls._shared_client = None
        if client is not None and not client.is_closed:
            await client.aclose()

    async def _get(
        self,
        path: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        last_error: Optional[Exception] = None

        for attempt in range(1, self.max_retries + 1):
            try:
                response = await self._client(self.timeout).get(
                    f"{self.base_url}{path}",
                    params=params,
                    headers=self.headers,
                )

                if response.status_code < 400:
                    data = response.json()
                    return data if isinstance(data, dict) else {}

                preview = response.text[:800]
                error = RuntimeError(
                    f"Alpaca Market Data HTTP {response.status_code} "
                    f"for {path}: {preview}"
                )
                last_error = error

                retryable = response.status_code in {
                    408,
                    409,
                    425,
                    429,
                    500,
                    502,
                    503,
                    504,
                }
                if retryable and attempt < self.max_retries:
                    retry_after = response.headers.get("Retry-After")
                    try:
                        delay = max(float(retry_after or 0), 0.6 * attempt)
                    except Exception:
                        delay = 0.6 * attempt
                    await asyncio.sleep(delay)
                    continue

                raise error

            except (
                httpx.ConnectError,
                httpx.ReadTimeout,
                httpx.WriteTimeout,
                httpx.PoolTimeout,
                httpx.RemoteProtocolError,
            ) as exc:
                last_error = exc
                if attempt < self.max_retries:
                    await asyncio.sleep(0.6 * attempt)
                    continue
                raise RuntimeError(
                    f"Alpaca Market Data request failed for {path}: {exc}"
                ) from exc
            except ValueError as exc:
                raise RuntimeError(
                    f"Alpaca Market Data returned invalid JSON for {path}: {exc}"
                ) from exc

        raise RuntimeError(
            f"Alpaca Market Data request failed for {path}: {last_error}"
        )

    def _timeframe_config(
        self,
        timeframe: str,
    ) -> Tuple[str, timedelta, str, Optional[int]]:
        tf = str(timeframe or "1m").lower().strip()

        aliases = {
            "1": "1m",
            "1min": "1m",
            "minute": "1m",
            "5": "5m",
            "5min": "5m",
            "15": "15m",
            "15min": "15m",
            "30": "30m",
            "30min": "30m",
            "60m": "1h",
            "60min": "1h",
            "hour": "1h",
            "240m": "4h",
            "day": "1d",
            "daily": "1d",
            "d": "1d",
        }
        tf = aliases.get(tf, tf)

        # Higher intraday bars are intentionally built from 1-minute data. This
        # preserves the current still-forming candle instead of waiting for a
        # completed native aggregate from the historical endpoint.
        configs: Dict[str, Tuple[str, timedelta, str, Optional[int]]] = {
            "1m": ("1Min", timedelta(days=5), "1m", None),
            "2m": ("1Min", timedelta(days=5), "2m", 2),
            "3m": ("1Min", timedelta(days=5), "3m", 3),
            "5m": ("1Min", timedelta(days=10), "5m", 5),
            "10m": ("1Min", timedelta(days=14), "10m", 10),
            "15m": ("1Min", timedelta(days=21), "15m", 15),
            "30m": ("1Min", timedelta(days=35), "30m", 30),
            "45m": ("1Min", timedelta(days=45), "45m", 45),
            "1h": ("1Min", timedelta(days=75), "1h", 60),
            "2h": ("1Min", timedelta(days=120), "2h", 120),
            "4h": ("1Min", timedelta(days=180), "4h", 240),
            "1d": ("1Min", timedelta(days=400), "1d", -1),
        }

        if tf not in configs:
            raise RuntimeError(f"Unsupported timeframe: {timeframe}")

        return configs[tf]

    @staticmethod
    def _parse_lookback(value: Optional[str], fallback: timedelta) -> timedelta:
        raw = str(value or "").strip().lower()
        if not raw:
            return fallback

        units = {
            "m": "minutes",
            "min": "minutes",
            "mins": "minutes",
            "minute": "minutes",
            "minutes": "minutes",
            "h": "hours",
            "hr": "hours",
            "hrs": "hours",
            "hour": "hours",
            "hours": "hours",
            "d": "days",
            "day": "days",
            "days": "days",
            "w": "weeks",
            "wk": "weeks",
            "wks": "weeks",
            "week": "weeks",
            "weeks": "weeks",
            "mo": "days",
            "mon": "days",
            "month": "days",
            "months": "days",
            "y": "days",
            "yr": "days",
            "year": "days",
            "years": "days",
        }

        number_text = ""
        unit_text = ""
        for char in raw:
            if char.isdigit() or (char == "." and "." not in number_text):
                number_text += char
            elif not char.isspace():
                unit_text += char

        try:
            amount = float(number_text)
        except Exception:
            return fallback

        if amount <= 0:
            return fallback

        unit = units.get(unit_text)
        if unit is None:
            return fallback

        if unit == "days" and unit_text in {"mo", "mon", "month", "months"}:
            amount *= 30
        elif unit == "days" and unit_text in {"y", "yr", "year", "years"}:
            amount *= 365

        return timedelta(**{unit: amount})

    def _resolve_history_window(
        self,
        *,
        requested_date: Optional[str],
        requested_lookback: Optional[str],
        default_lookback: timedelta,
        session: str,
    ) -> Tuple[datetime, datetime, Optional[str]]:
        clean_date = str(requested_date or "").strip()
        if clean_date:
            try:
                trading_day = date.fromisoformat(clean_date)
            except ValueError as exc:
                raise RuntimeError(
                    "date must use YYYY-MM-DD format"
                ) from exc

            if session == "regular":
                start_et = datetime(
                    trading_day.year, trading_day.month, trading_day.day,
                    9, 30, tzinfo=ET,
                )
                end_et = datetime(
                    trading_day.year, trading_day.month, trading_day.day,
                    16, 0, tzinfo=ET,
                )
            elif self.include_overnight:
                previous_day = trading_day - timedelta(days=1)
                start_et = datetime(
                    previous_day.year, previous_day.month, previous_day.day,
                    20, 0, tzinfo=ET,
                )
                end_et = datetime(
                    trading_day.year, trading_day.month, trading_day.day,
                    20, 0, tzinfo=ET,
                )
            else:
                start_et = datetime(
                    trading_day.year, trading_day.month, trading_day.day,
                    4, 0, tzinfo=ET,
                )
                end_et = datetime(
                    trading_day.year, trading_day.month, trading_day.day,
                    20, 0, tzinfo=ET,
                )

            return (
                start_et.astimezone(timezone.utc),
                end_et.astimezone(timezone.utc),
                clean_date,
            )

        end = datetime.now(timezone.utc)
        lookback = self._parse_lookback(
            requested_lookback,
            default_lookback,
        )
        return end - lookback, end, None

    def _cache_ttl(self, normalized_tf: str) -> float:
        return {
            "1m": 6.0,
            "2m": 8.0,
            "3m": 10.0,
            "5m": 12.0,
            "10m": 18.0,
            "15m": 20.0,
            "30m": 30.0,
            "45m": 40.0,
            "1h": 45.0,
            "2h": 60.0,
            "4h": 75.0,
            "1d": 90.0,
        }.get(normalized_tf, 15.0)

    def _get_cached(self, key: str) -> Optional[List[Dict[str, Any]]]:
        cached = self._bars_cache.get(key)
        if cached is None:
            return None

        expires_at, rows = cached
        if expires_at <= time.time():
            self._bars_cache.pop(key, None)
            return None

        return _clone_rows(rows)

    def _set_cached(
        self,
        key: str,
        ttl_seconds: float,
        rows: List[Dict[str, Any]],
    ) -> None:
        if len(self._bars_cache) >= self._cache_max_items:
            now = time.time()
            expired = [
                cache_key
                for cache_key, (expires_at, _) in self._bars_cache.items()
                if expires_at <= now
            ]
            for cache_key in expired:
                self._bars_cache.pop(cache_key, None)

            if len(self._bars_cache) >= self._cache_max_items:
                oldest_key = min(
                    self._bars_cache,
                    key=lambda item: self._bars_cache[item][0],
                )
                self._bars_cache.pop(oldest_key, None)

        self._bars_cache[key] = (
            time.time() + max(1.0, ttl_seconds),
            _clone_rows(rows),
        )

    def _normalize_bar(
        self,
        raw: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        timestamp = _timestamp_ms(raw.get("t") or raw.get("time"))
        open_price = _safe_float(raw.get("o", raw.get("open")))
        high = _safe_float(raw.get("h", raw.get("high")))
        low = _safe_float(raw.get("l", raw.get("low")))
        close = _safe_float(raw.get("c", raw.get("close")))
        volume = _safe_float(raw.get("v", raw.get("volume")))

        if timestamp <= 0 or high <= 0 or low <= 0 or close <= 0:
            return None

        return {
            "time": timestamp,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
            "t": timestamp,
            "o": open_price,
            "h": high,
            "l": low,
            "c": close,
            "v": volume,
        }

    async def _historical_bars(
        self,
        *,
        symbol: str,
        timeframe: str,
        start: datetime,
        end: datetime,
        feed: str,
        adjustment: str = "all",
    ) -> List[Dict[str, Any]]:
        symbol = symbol.upper().strip()
        page_token: Optional[str] = None
        normalized: List[Dict[str, Any]] = []
        page_count = 0

        while True:
            params: Dict[str, Any] = {
                "timeframe": timeframe,
                "start": _iso_utc(start),
                "end": _iso_utc(end),
                "limit": 10000,
                "adjustment": adjustment,
                "feed": feed,
                "sort": "asc",
            }
            if page_token:
                params["page_token"] = page_token

            data = await self._get(
                f"/v2/stocks/{symbol}/bars",
                params=params,
            )
            page_count += 1

            for raw in data.get("bars") or []:
                if not isinstance(raw, dict):
                    continue
                row = self._normalize_bar(raw)
                if row is not None:
                    normalized.append(row)

            next_token = data.get("next_page_token")
            if not next_token:
                break

            page_token = str(next_token)
            if page_count >= 250:
                raise RuntimeError(
                    f"Alpaca bars pagination safety limit reached for {symbol}"
                )

        return normalized

    def _session_name(self, session: Optional[str]) -> str:
        value = str(session or "extended").lower().strip()

        if value in {"regular", "rth", "market", "reg", "normal"}:
            return "regular"
        if value in {
            "extended",
            "ext",
            "all",
            "full",
            "full_session",
            "ah",
            "afterhours",
            "premarket",
        }:
            return "extended"
        if value in {
            "24h",
            "24x5",
            "overnight",
            "boats",
            "continuous",
        }:
            return "overnight"

        raise RuntimeError(
            "session must be regular, extended, or overnight/24h"
        )

    def _bar_in_session(
        self,
        timestamp_ms: int,
        session: str,
    ) -> bool:
        dt = datetime.fromtimestamp(timestamp_ms / 1000, ET)
        hhmm = dt.hour * 100 + dt.minute

        if session == "regular":
            return 930 <= hhmm < 1600

        if session == "extended":
            if self.include_overnight:
                return True
            return 400 <= hhmm < 2000

        return True

    def _filter_session(
        self,
        rows: List[Dict[str, Any]],
        session: str,
    ) -> List[Dict[str, Any]]:
        return [
            row
            for row in rows
            if self._bar_in_session(int(row["time"]), session)
        ]

    def _merge_rows(
        self,
        *groups: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        by_timestamp: Dict[int, Dict[str, Any]] = {}

        # Later groups overwrite earlier groups at the same timestamp. SIP is
        # passed last where overlap is possible because it is the consolidated
        # all-exchange feed for the normal US sessions.
        for group in groups:
            for row in group:
                timestamp = int(row.get("time", row.get("t", 0)) or 0)
                if timestamp > 0:
                    by_timestamp[timestamp] = dict(row)

        return [
            row
            for _, row in sorted(by_timestamp.items(), key=lambda item: item[0])
        ]

    def _aggregate_minutes(
        self,
        rows: List[Dict[str, Any]],
        bucket_minutes: int,
    ) -> List[Dict[str, Any]]:
        if bucket_minutes <= 1:
            return _clone_rows(rows)

        buckets: Dict[int, Dict[str, Any]] = {}
        bucket_ms = bucket_minutes * 60_000

        for row in sorted(rows, key=lambda item: int(item["time"])):
            timestamp = int(row["time"])
            bucket_timestamp = (timestamp // bucket_ms) * bucket_ms

            open_price = _safe_float(row["open"])
            high = _safe_float(row["high"])
            low = _safe_float(row["low"])
            close = _safe_float(row["close"])
            volume = _safe_float(row["volume"])

            current = buckets.get(bucket_timestamp)
            if current is None:
                buckets[bucket_timestamp] = {
                    "time": bucket_timestamp,
                    "open": open_price,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": volume,
                    "t": bucket_timestamp,
                    "o": open_price,
                    "h": high,
                    "l": low,
                    "c": close,
                    "v": volume,
                }
                continue

            current["high"] = max(_safe_float(current["high"]), high)
            current["low"] = min(_safe_float(current["low"]), low)
            current["close"] = close
            current["volume"] = _safe_float(current["volume"]) + volume
            current["h"] = current["high"]
            current["l"] = current["low"]
            current["c"] = current["close"]
            current["v"] = current["volume"]

        return [
            row
            for _, row in sorted(buckets.items(), key=lambda item: item[0])
        ]

    def _aggregate_daily(
        self,
        rows: List[Dict[str, Any]],
        session: str,
    ) -> List[Dict[str, Any]]:
        grouped: Dict[date, Dict[str, Any]] = {}

        for row in sorted(rows, key=lambda item: int(item["time"])):
            timestamp = int(row["time"])
            dt = datetime.fromtimestamp(timestamp / 1000, ET)
            hhmm = dt.hour * 100 + dt.minute

            if session == "regular" and not (930 <= hhmm < 1600):
                continue
            if (
                session == "extended"
                and not self.include_overnight
                and not (400 <= hhmm < 2000)
            ):
                continue

            # BOATS timestamps between 20:00 and midnight belong to the next
            # trading session. Assign them to the following calendar date so a
            # full overnight + premarket + RTH + AH candle remains together.
            trading_day = dt.date()
            if hhmm >= 2000 and session in {"extended", "overnight"}:
                trading_day = trading_day + timedelta(days=1)

            start_hour = 9
            start_minute = 30
            if session in {"extended", "overnight"}:
                start_hour = 20 if self.include_overnight else 4
                start_minute = 0
                open_date = (
                    trading_day - timedelta(days=1)
                    if self.include_overnight
                    else trading_day
                )
            else:
                open_date = trading_day

            open_dt = datetime(
                open_date.year,
                open_date.month,
                open_date.day,
                start_hour,
                start_minute,
                tzinfo=ET,
            )
            open_timestamp = int(open_dt.timestamp() * 1000)

            current = grouped.get(trading_day)
            if current is None:
                grouped[trading_day] = {
                    "time": open_timestamp,
                    "open": _safe_float(row["open"]),
                    "high": _safe_float(row["high"]),
                    "low": _safe_float(row["low"]),
                    "close": _safe_float(row["close"]),
                    "volume": _safe_float(row["volume"]),
                    "t": open_timestamp,
                    "o": _safe_float(row["open"]),
                    "h": _safe_float(row["high"]),
                    "l": _safe_float(row["low"]),
                    "c": _safe_float(row["close"]),
                    "v": _safe_float(row["volume"]),
                }
                continue

            current["high"] = max(
                _safe_float(current["high"]),
                _safe_float(row["high"]),
            )
            current["low"] = min(
                _safe_float(current["low"]),
                _safe_float(row["low"]),
            )
            current["close"] = _safe_float(row["close"])
            current["volume"] = (
                _safe_float(current["volume"])
                + _safe_float(row["volume"])
            )
            current["h"] = current["high"]
            current["l"] = current["low"]
            current["c"] = current["close"]
            current["v"] = current["volume"]

        return [
            row
            for _, row in sorted(grouped.items(), key=lambda item: item[0])
        ]

    async def get_bars(
        self,
        symbol: str,
        timeframe: str = "1m",
        session: str = "extended",
        date: Optional[str] = None,
        lookback: Optional[str] = None,
        limit: int = 1000,
    ) -> List[Dict[str, Any]]:
        symbol = symbol.upper().strip()
        if not symbol:
            raise RuntimeError("symbol is required")

        alpaca_timeframe, default_lookback, normalized_tf, aggregate_minutes = (
            self._timeframe_config(timeframe)
        )
        normalized_session = self._session_name(session)
        normalized_limit = max(1, min(int(limit or 1000), 5000))

        start, end, selected_date = self._resolve_history_window(
            requested_date=date,
            requested_lookback=lookback,
            default_lookback=default_lookback,
            session=normalized_session,
        )

        live_request = selected_date is None
        ttl = self._cache_ttl(normalized_tf) if live_request else 3600.0
        range_key = (
            f"date={selected_date}"
            if selected_date
            else f"start={int(start.timestamp())}|end={int(end.timestamp())}"
        )
        cache_bucket = int(time.time() // ttl) if live_request else 0
        cache_key = (
            f"{symbol}|{normalized_tf}|{normalized_session}|"
            f"{self.feed}|{self.overnight_feed}|"
            f"{int(self.include_overnight)}|{range_key}|"
            f"limit={normalized_limit}|bucket={cache_bucket}"
        )

        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        sip_rows = await self._historical_bars(
            symbol=symbol,
            timeframe=alpaca_timeframe,
            start=start,
            end=end,
            feed=self.feed,
        )

        should_fetch_overnight = (
            self.include_overnight
            and normalized_session in {"extended", "overnight"}
            and self.overnight_feed
            and self.overnight_feed != self.feed
        )

        overnight_rows: List[Dict[str, Any]] = []
        if should_fetch_overnight:
            try:
                overnight_rows = await self._historical_bars(
                    symbol=symbol,
                    timeframe=alpaca_timeframe,
                    start=start,
                    end=end,
                    feed=self.overnight_feed,
                )
            except Exception as exc:
                _debug(f"BOATS history unavailable for {symbol}: {exc}")

        rows = self._merge_rows(overnight_rows, sip_rows)
        rows = self._filter_session(rows, normalized_session)

        if aggregate_minutes == -1:
            rows = self._aggregate_daily(rows, normalized_session)
        elif aggregate_minutes and aggregate_minutes > 1:
            rows = self._aggregate_minutes(rows, aggregate_minutes)

        if len(rows) > normalized_limit:
            rows = rows[-normalized_limit:]

        _debug(
            f"get_bars {symbol} {normalized_tf} {normalized_session} "
            f"date={selected_date or '-'} "
            f"start={_iso_utc(start)} end={_iso_utc(end)} "
            f"sip={len(sip_rows)} overnight={len(overnight_rows)} "
            f"result={len(rows)} limit={normalized_limit}"
        )

        self._set_cached(cache_key, ttl, rows)
        return _clone_rows(rows)

    async def get_recent_1m_bars(
        self,
        symbol: str,
        hours_back: int = 48,
    ) -> List[Dict[str, Any]]:
        symbol = symbol.upper().strip()
        if not symbol:
            raise RuntimeError("symbol is required")

        now = datetime.now(timezone.utc)
        start = now - timedelta(hours=max(1, int(hours_back)))

        sip_rows = await self._historical_bars(
            symbol=symbol,
            timeframe="1Min",
            start=start,
            end=now,
            feed=self.feed,
        )

        overnight_rows: List[Dict[str, Any]] = []
        if self.include_overnight and self.overnight_feed != self.feed:
            try:
                overnight_rows = await self._historical_bars(
                    symbol=symbol,
                    timeframe="1Min",
                    start=start,
                    end=now,
                    feed=self.overnight_feed,
                )
            except Exception as exc:
                _debug(
                    f"BOATS recent bars unavailable for {symbol}: {exc}"
                )

        return self._merge_rows(overnight_rows, sip_rows)

    async def get_last_trade(self, symbol: str) -> Optional[float]:
        symbol = symbol.upper().strip()
        if not symbol:
            return None

        latest_feed = self._latest_stock_feed()
        data = await self._get(
            "/v2/stocks/trades/latest",
            params={
                "symbols": symbol,
                "feed": latest_feed,
            },
        )
        trade = (data.get("trades") or {}).get(symbol) or {}
        price = trade.get("p")
        return _safe_float(price) if price is not None else None

    async def get_latest_quote(self, symbol: str) -> Dict[str, Any]:
        symbol = symbol.upper().strip()
        if not symbol:
            return {}

        latest_feed = self._latest_stock_feed()
        data = await self._get(
            "/v2/stocks/quotes/latest",
            params={
                "symbols": symbol,
                "feed": latest_feed,
            },
        )
        quote = (data.get("quotes") or {}).get(symbol) or {}
        if not isinstance(quote, dict):
            return {}

        return {
            **quote,
            "symbol": symbol,
            "bid_price": _safe_float(quote.get("bp")),
            "ask_price": _safe_float(quote.get("ap")),
            "bid_size": _safe_float(quote.get("bs")),
            "ask_size": _safe_float(quote.get("as")),
            "time": _timestamp_ms(quote.get("t")),
            "feed": latest_feed,
        }

    async def get_ticker_snapshot(self, symbol: str) -> Dict[str, Any]:
        symbol = symbol.upper().strip()
        if not symbol:
            return {}

        data = await self._get(
            f"/v2/stocks/{symbol}/snapshot",
            params={"feed": self.feed},
        )

        latest_trade = data.get("latestTrade") or {}
        latest_quote = data.get("latestQuote") or {}
        minute_bar = data.get("minuteBar") or {}
        daily_bar = data.get("dailyBar") or {}
        previous_daily_bar = data.get("prevDailyBar") or {}

        current_price = _safe_float(
            latest_trade.get("p"),
            _safe_float(daily_bar.get("c")),
        )
        previous_close = _safe_float(previous_daily_bar.get("c"))
        change = current_price - previous_close if previous_close > 0 else 0.0
        change_pct = (
            (change / previous_close) * 100.0
            if previous_close > 0
            else 0.0
        )

        # Preserve Polygon-style aliases while exposing the full Alpaca
        # snapshot. This prevents existing scanner runners from breaking during
        # the provider migration.
        return {
            "ticker": symbol,
            "symbol": symbol,
            "todaysChange": change,
            "todaysChangePerc": change_pct,
            "lastTrade": {
                **latest_trade,
                "p": current_price,
                "t": _timestamp_ms(latest_trade.get("t")),
            },
            "lastQuote": {
                **latest_quote,
                "t": _timestamp_ms(latest_quote.get("t")),
            },
            "min": {
                "o": _safe_float(minute_bar.get("o")),
                "h": _safe_float(minute_bar.get("h")),
                "l": _safe_float(minute_bar.get("l")),
                "c": _safe_float(minute_bar.get("c")),
                "v": _safe_float(minute_bar.get("v")),
                "t": _timestamp_ms(minute_bar.get("t")),
            },
            "day": {
                "o": _safe_float(daily_bar.get("o")),
                "h": _safe_float(daily_bar.get("h")),
                "l": _safe_float(daily_bar.get("l")),
                "c": _safe_float(daily_bar.get("c")),
                "v": _safe_float(daily_bar.get("v")),
                "t": _timestamp_ms(daily_bar.get("t")),
            },
            "prevDay": {
                "o": _safe_float(previous_daily_bar.get("o")),
                "h": _safe_float(previous_daily_bar.get("h")),
                "l": _safe_float(previous_daily_bar.get("l")),
                "c": previous_close,
                "v": _safe_float(previous_daily_bar.get("v")),
                "t": _timestamp_ms(previous_daily_bar.get("t")),
            },
            "latestTrade": latest_trade,
            "latestQuote": latest_quote,
            "minuteBar": minute_bar,
            "dailyBar": daily_bar,
            "prevDailyBar": previous_daily_bar,
        }

    async def _movers(self, limit: int) -> Dict[str, Any]:
        return await self._get(
            "/v1beta1/screener/stocks/movers",
            params={"top": max(1, min(int(limit), 50))},
        )

    def _normalize_mover(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        symbol = str(raw.get("symbol") or "").upper().strip()
        price = _safe_float(
            raw.get("price"),
            _safe_float(raw.get("latest_price")),
        )
        change = _safe_float(raw.get("change"))
        change_pct = _safe_float(
            raw.get("percent_change"),
            _safe_float(raw.get("change_pct")),
        )

        return {
            **raw,
            "ticker": symbol,
            "symbol": symbol,
            "todaysChange": change,
            "todaysChangePerc": change_pct,
            "lastTrade": {"p": price},
            "day": {"c": price},
        }

    async def get_snapshot_gainers(
        self,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        data = await self._movers(limit)
        return [
            self._normalize_mover(row)
            for row in (data.get("gainers") or [])[:limit]
            if isinstance(row, dict)
        ]

    async def get_snapshot_losers(
        self,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        data = await self._movers(limit)
        return [
            self._normalize_mover(row)
            for row in (data.get("losers") or [])[:limit]
            if isinstance(row, dict)
        ]

    async def get_snapshot_actives(
        self,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        data = await self._get(
            "/v1beta1/screener/stocks/most-actives",
            params={
                "by": "volume",
                "top": max(1, min(int(limit), 100)),
            },
        )

        rows = data.get("most_actives") or data.get("mostActives") or []
        out: List[Dict[str, Any]] = []

        for raw in rows[:limit]:
            if not isinstance(raw, dict):
                continue
            symbol = str(raw.get("symbol") or "").upper().strip()
            volume = _safe_float(raw.get("volume"))
            trade_count = _safe_float(
                raw.get("trade_count"),
                _safe_float(raw.get("trades")),
            )
            out.append(
                {
                    **raw,
                    "ticker": symbol,
                    "symbol": symbol,
                    "day": {"v": volume},
                    "volume": volume,
                    "trade_count": trade_count,
                }
            )

        return out

    async def get_ticker_details(self, symbol: str) -> Dict[str, Any]:
        """Return tradable asset metadata using Alpaca's Trading API asset route.

        Existing scanners use this for fields such as name, exchange, tradable,
        marginability, and shortability. Market-data credentials are reused.
        """
        symbol = symbol.upper().strip()
        if not symbol:
            return {}

        trading_base_url = os.getenv(
            "ALPACA_LIVE_BASE_URL",
            "https://api.alpaca.markets",
        ).rstrip("/")

        last_error: Optional[Exception] = None
        for attempt in range(1, self.max_retries + 1):
            try:
                response = await self._client(self.timeout).get(
                    f"{trading_base_url}/v2/assets/{symbol}",
                    headers=self.headers,
                )

                if response.status_code == 404:
                    return {}
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Alpaca asset HTTP {response.status_code}: "
                        f"{response.text[:500]}"
                    )

                data = response.json()
                return data if isinstance(data, dict) else {}
            except Exception as exc:
                last_error = exc
                if attempt < self.max_retries:
                    await asyncio.sleep(0.5 * attempt)
                    continue

        _debug(f"asset lookup failed for {symbol}: {last_error}")
        return {}


__all__ = ["AlpacaMarketService"]