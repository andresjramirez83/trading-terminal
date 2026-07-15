from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import defaultdict
from contextlib import suppress
from pathlib import Path
from typing import Any, DefaultDict, Dict, Optional, Set

import websockets
from dotenv import load_dotenv
from fastapi import WebSocket, WebSocketDisconnect

from app.services.live_bar_aggregator import live_bar_aggregator


# backend/app/services/alpaca_ws.py -> backend/.env
ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=True)

logger = logging.getLogger(__name__)

DEBUG_ALPACA_WS = os.getenv(
    "DEBUG_ALPACA_WS",
    "false",
).strip().lower() in {"1", "true", "yes", "on"}


def _debug(message: str) -> None:
    if DEBUG_ALPACA_WS:
        logger.info(message)


def _normalize_timeframe(value: str | None) -> str:
    tf = str(value or "1m").lower().strip()

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

    allowed = {
        "1m",
        "2m",
        "3m",
        "5m",
        "10m",
        "15m",
        "30m",
        "45m",
        "1h",
        "2h",
        "4h",
        "1d",
    }

    return tf if tf in allowed else "1m"


def _normalize_symbol(value: str | None) -> str:
    return "".join(
        character
        for character in str(value or "").upper().strip()
        if character.isalnum() or character in {".", "-"}
    )


def _client_key(symbol: str, timeframe: str) -> str:
    return f"{_normalize_symbol(symbol)}::{_normalize_timeframe(timeframe)}"


def _timestamp_ms(value: Any) -> int:
    """Convert Alpaca RFC-3339 or epoch timestamps to Unix milliseconds."""
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
        from datetime import datetime, timezone

        normalized = raw.replace("Z", "+00:00")

        # Alpaca timestamps may include nanoseconds. Python datetime supports
        # microseconds, so trim the fractional portion to six digits.
        if "." in normalized:
            head, tail = normalized.split(".", 1)
            timezone_suffix = ""
            fraction = tail

            indexes = [
                index
                for index in (fraction.find("+"), fraction.find("-"))
                if index >= 0
            ]
            if indexes:
                split_index = min(indexes)
                timezone_suffix = fraction[split_index:]
                fraction = fraction[:split_index]

            normalized = f"{head}.{fraction[:6]}{timezone_suffix}"

        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except Exception:
        return 0


class AlpacaWSManager:
    """Shared Alpaca SIP trade stream for all frontend chart clients.

    One backend WebSocket connection subscribes to every symbol currently needed
    by the browser clients. Each incoming trade is sent through the existing
    LiveBarAggregator, which builds the application's 1m and higher-timeframe
    chart candles.

    Frontend payload compatibility is intentionally unchanged: each update is a
    JSON array containing one normalized chart bar.
    """

    def __init__(self) -> None:
        self.feed = os.getenv("ALPACA_STOCK_FEED", "sip").strip().lower() or "sip"
        self.ws_url = os.getenv(
            "ALPACA_STOCK_WS_URL",
            f"wss://stream.data.alpaca.markets/v2/{self.feed}",
        ).strip()

        self.key_id, self.secret_key = self._resolve_credentials()
        if not self.key_id or not self.secret_key:
            raise RuntimeError(
                "Missing Alpaca market-data credentials. Set "
                "APCA_API_KEY_ID_LIVE and APCA_API_SECRET_KEY_LIVE."
            )

        self._ws: Optional[Any] = None
        self._listen_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None

        self._lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        self._connected = False
        self._authenticated = False
        self._closing = False

        self._subscriptions: Set[str] = set()
        self._desired_symbols: Set[str] = set()

        self._clients_by_key: DefaultDict[str, Set[WebSocket]] = defaultdict(set)
        self._keys_by_client: DefaultDict[WebSocket, Set[str]] = defaultdict(set)

        self._reconnect_delay_seconds = 1.0
        self._max_reconnect_delay_seconds = 30.0

    def _resolve_credentials(self) -> tuple[str, str]:
        live_key = os.getenv("APCA_API_KEY_ID_LIVE", "").strip()
        live_secret = os.getenv("APCA_API_SECRET_KEY_LIVE", "").strip()

        if live_key and live_secret:
            return live_key, live_secret

        return (
            os.getenv("APCA_API_KEY_ID_PAPER", "").strip(),
            os.getenv("APCA_API_SECRET_KEY_PAPER", "").strip(),
        )

    async def ensure_connected(self) -> None:
        if self._closing:
            raise RuntimeError("Alpaca WebSocket manager is closing")

        if self._connected and self._authenticated and self._ws is not None:
            return

        async with self._connect_lock:
            if self._connected and self._authenticated and self._ws is not None:
                return

            await self._connect()

    async def _connect(self) -> None:
        await self._close_socket_only()

        _debug(f"[alpaca_ws] connecting to {self.ws_url}")

        try:
            ws = await websockets.connect(
                self.ws_url,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=5,
                max_size=4_000_000,
                open_timeout=15,
            )
        except Exception as exc:
            raise RuntimeError(f"Unable to connect to Alpaca stream: {exc}") from exc

        self._ws = ws
        self._connected = True
        self._authenticated = False

        try:
            await ws.send(
                json.dumps(
                    {
                        "action": "auth",
                        "key": self.key_id,
                        "secret": self.secret_key,
                    }
                )
            )
            await self._wait_for_authentication(ws)
        except Exception:
            await self._close_socket_only()
            raise

        self._authenticated = True
        self._reconnect_delay_seconds = 1.0

        desired = sorted(self._desired_symbols)
        if desired:
            await self._send_subscribe(desired)

        self._listen_task = asyncio.create_task(
            self._listen_loop(ws),
            name="alpaca-market-data-listener",
        )

        _debug(
            f"[alpaca_ws] authenticated feed={self.feed} "
            f"symbols={len(desired)}"
        )

    async def _wait_for_authentication(self, ws: Any) -> None:
        saw_connected = False
        last_message: Any = None

        for _ in range(20):
            raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
            messages = json.loads(raw)
            if not isinstance(messages, list):
                messages = [messages]

            for message in messages:
                if not isinstance(message, dict):
                    continue

                last_message = message
                message_type = str(message.get("T") or "").lower()
                msg = str(message.get("msg") or "").lower()
                code = int(message.get("code") or 0)

                if message_type == "success" and msg == "connected":
                    saw_connected = True
                    continue

                if message_type == "success" and msg == "authenticated":
                    return

                if message_type == "error":
                    raise RuntimeError(
                        f"Alpaca WebSocket authentication error "
                        f"code={code}: {message.get('msg')}"
                    )

        raise RuntimeError(
            "Alpaca WebSocket authentication timed out. "
            f"connected={saw_connected}, last_message={last_message}"
        )

    async def subscribe_client(
        self,
        frontend_ws: WebSocket,
        symbol: str,
        timeframe: str = "1m",
    ) -> None:
        normalized_symbol = _normalize_symbol(symbol)
        normalized_timeframe = _normalize_timeframe(timeframe)

        if not normalized_symbol:
            raise RuntimeError("Missing symbol for Alpaca WebSocket subscription")

        key = _client_key(normalized_symbol, normalized_timeframe)

        async with self._lock:
            self._clients_by_key[key].add(frontend_ws)
            self._keys_by_client[frontend_ws].add(key)
            symbol_was_needed = normalized_symbol in self._desired_symbols
            self._desired_symbols.add(normalized_symbol)

        try:
            await self.ensure_connected()
        except Exception:
            async with self._lock:
                self._clients_by_key[key].discard(frontend_ws)
                self._keys_by_client[frontend_ws].discard(key)
                if not self._clients_by_key[key]:
                    self._clients_by_key.pop(key, None)
                if not self._keys_by_client[frontend_ws]:
                    self._keys_by_client.pop(frontend_ws, None)

                still_needed = any(
                    existing_key.startswith(f"{normalized_symbol}::")
                    for existing_key in self._clients_by_key
                )
                if not still_needed:
                    self._desired_symbols.discard(normalized_symbol)
            raise

        if not symbol_was_needed:
            await self._subscribe_symbols({normalized_symbol})

        current = live_bar_aggregator.current_bar(
            normalized_symbol,
            normalized_timeframe,
        )
        if current is not None:
            with suppress(Exception):
                await frontend_ws.send_text(
                    json.dumps([current.to_chart()])
                )

    async def unsubscribe_client(self, frontend_ws: WebSocket) -> None:
        symbols_to_check: Set[str] = set()

        async with self._lock:
            keys = list(self._keys_by_client.pop(frontend_ws, set()))

            for key in keys:
                clients = self._clients_by_key.get(key)
                if clients is None:
                    continue

                clients.discard(frontend_ws)
                symbol = key.split("::", 1)[0]
                symbols_to_check.add(symbol)

                if not clients:
                    self._clients_by_key.pop(key, None)

            no_clients_left = not self._clients_by_key

            no_longer_needed: Set[str] = set()
            for symbol in symbols_to_check:
                still_needed = any(
                    existing_key.startswith(f"{symbol}::")
                    for existing_key in self._clients_by_key
                )
                if not still_needed:
                    self._desired_symbols.discard(symbol)
                    no_longer_needed.add(symbol)

        if no_longer_needed:
            await self._unsubscribe_symbols(no_longer_needed)

        if no_clients_left:
            _debug("[alpaca_ws] no frontend clients remain")

    async def _subscribe_symbols(self, symbols: Set[str]) -> None:
        clean = sorted(
            symbol
            for symbol in {_normalize_symbol(item) for item in symbols}
            if symbol
        )
        if not clean:
            return

        await self.ensure_connected()

        pending = [
            symbol
            for symbol in clean
            if symbol not in self._subscriptions
        ]
        if not pending:
            return

        await self._send_subscribe(pending)

    async def _send_subscribe(self, symbols: list[str]) -> None:
        ws = self._ws
        if ws is None or not self._connected or not self._authenticated:
            raise RuntimeError("Alpaca WebSocket is not authenticated")

        await ws.send(
            json.dumps(
                {
                    "action": "subscribe",
                    "trades": symbols,
                }
            )
        )
        self._subscriptions.update(symbols)

        _debug(f"[alpaca_ws] subscribed trades={symbols}")

    async def _unsubscribe_symbols(self, symbols: Set[str]) -> None:
        clean = sorted(
            symbol
            for symbol in {_normalize_symbol(item) for item in symbols}
            if symbol and symbol in self._subscriptions
        )
        if not clean:
            return

        ws = self._ws
        if ws is not None and self._connected and self._authenticated:
            try:
                await ws.send(
                    json.dumps(
                        {
                            "action": "unsubscribe",
                            "trades": clean,
                        }
                    )
                )
            except Exception as exc:
                _debug(f"[alpaca_ws] unsubscribe send failed: {exc}")

        self._subscriptions.difference_update(clean)
        _debug(f"[alpaca_ws] unsubscribed trades={clean}")

    async def _listen_loop(self, ws: Any) -> None:
        failure: Optional[Exception] = None

        try:
            async for raw in ws:
                messages = json.loads(raw)
                if not isinstance(messages, list):
                    messages = [messages]

                updated_by_key: DefaultDict[str, list] = defaultdict(list)

                for message in messages:
                    if not isinstance(message, dict):
                        continue

                    message_type = str(message.get("T") or "")

                    if message_type == "subscription":
                        _debug(f"[alpaca_ws] subscription state: {message}")
                        continue

                    if message_type == "success":
                        _debug(f"[alpaca_ws] success: {message}")
                        continue

                    if message_type == "error":
                        logger.warning(
                            "[alpaca_ws] stream error code=%s message=%s",
                            message.get("code"),
                            message.get("msg"),
                        )
                        continue

                    if message_type != "t":
                        continue

                    symbol = _normalize_symbol(message.get("S"))
                    price = float(message.get("p") or 0)
                    volume = float(message.get("s") or 0)
                    timestamp = _timestamp_ms(message.get("t"))

                    if (
                        not symbol
                        or price <= 0
                        or volume < 0
                        or timestamp <= 0
                    ):
                        continue

                    updated_bars = live_bar_aggregator.update_trade(
                        symbol=symbol,
                        price=price,
                        volume=volume,
                        timestamp=timestamp,
                    )

                    for bar in updated_bars:
                        key = _client_key(bar.symbol, bar.timeframe)
                        updated_by_key[key].append(bar)

                if updated_by_key:
                    await self._broadcast(updated_by_key)

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failure = exc
            logger.warning("[alpaca_ws] shared listen failed: %s", exc)
        finally:
            await self._handle_disconnect(ws, failure)

    async def _broadcast(
        self,
        updated_by_key: DefaultDict[str, list],
    ) -> None:
        stale_clients: Set[WebSocket] = set()

        async with self._lock:
            items = [
                (
                    key,
                    list(self._clients_by_key.get(key, set())),
                    bars,
                )
                for key, bars in updated_by_key.items()
            ]

        for key, clients, bars in items:
            if not clients or not bars:
                continue

            encoded = json.dumps([bars[-1].to_chart()])

            for client in clients:
                try:
                    await client.send_text(encoded)
                except WebSocketDisconnect:
                    stale_clients.add(client)
                except Exception as exc:
                    _debug(f"[alpaca_ws] send failed for {key}: {exc}")
                    stale_clients.add(client)

        for client in stale_clients:
            with suppress(Exception):
                await self.unsubscribe_client(client)

    async def _handle_disconnect(
        self,
        ws: Any,
        failure: Optional[Exception],
    ) -> None:
        async with self._lock:
            if ws is not self._ws:
                return

            self._connected = False
            self._authenticated = False
            self._subscriptions.clear()
            self._ws = None
            self._listen_task = None
            should_reconnect = bool(self._desired_symbols) and not self._closing

        with suppress(Exception):
            await ws.close()

        if should_reconnect:
            if failure is not None:
                _debug(
                    f"[alpaca_ws] scheduling reconnect after error: {failure}"
                )
            self._schedule_reconnect()

    def _schedule_reconnect(self) -> None:
        if self._closing:
            return

        if self._reconnect_task and not self._reconnect_task.done():
            return

        self._reconnect_task = asyncio.create_task(
            self._reconnect_loop(),
            name="alpaca-market-data-reconnect",
        )

    async def _reconnect_loop(self) -> None:
        try:
            while self._desired_symbols and not self._closing:
                delay = self._reconnect_delay_seconds
                await asyncio.sleep(delay)

                try:
                    await self.ensure_connected()
                    _debug("[alpaca_ws] reconnect successful")
                    return
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(
                        "[alpaca_ws] reconnect failed after %.1fs: %s",
                        delay,
                        exc,
                    )
                    self._reconnect_delay_seconds = min(
                        self._max_reconnect_delay_seconds,
                        max(1.0, delay * 2.0),
                    )
        finally:
            self._reconnect_task = None

    async def _close_socket_only(self) -> None:
        ws = self._ws
        self._ws = None
        self._connected = False
        self._authenticated = False
        self._subscriptions.clear()

        if ws is not None:
            with suppress(Exception):
                await ws.close()

    async def close(self) -> None:
        self._closing = True

        reconnect_task = self._reconnect_task
        self._reconnect_task = None
        if reconnect_task and not reconnect_task.done():
            reconnect_task.cancel()
            with suppress(asyncio.CancelledError):
                await reconnect_task

        listen_task = self._listen_task
        self._listen_task = None
        if listen_task and not listen_task.done():
            listen_task.cancel()
            with suppress(asyncio.CancelledError):
                await listen_task

        await self._close_socket_only()

        async with self._lock:
            self._clients_by_key.clear()
            self._keys_by_client.clear()
            self._desired_symbols.clear()

        _debug("[alpaca_ws] manager closed")


alpaca_ws_manager = AlpacaWSManager()


async def forward_alpaca_trades(
    frontend_ws: WebSocket,
    symbol: str,
    timeframe: str = "1m",
) -> None:
    """Backward-compatible frontend forwarding helper."""
    await alpaca_ws_manager.subscribe_client(
        frontend_ws,
        symbol,
        timeframe,
    )

    _debug(
        "[alpaca_ws] frontend attached "
        f"symbol={_normalize_symbol(symbol)} "
        f"timeframe={_normalize_timeframe(timeframe)}"
    )

    try:
        while True:
            await frontend_ws.receive_text()
    except WebSocketDisconnect:
        raise
    finally:
        await alpaca_ws_manager.unsubscribe_client(frontend_ws)


__all__ = [
    "AlpacaWSManager",
    "alpaca_ws_manager",
    "forward_alpaca_trades",
]