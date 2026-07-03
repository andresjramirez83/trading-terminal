from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import defaultdict
from contextlib import suppress
from typing import DefaultDict, Optional, Set

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from app.services.live_bar_aggregator import live_bar_aggregator

POLYGON_WS_URL = "wss://socket.polygon.io/stocks"

logger = logging.getLogger(__name__)

DEBUG_POLYGON_WS = os.getenv("DEBUG_POLYGON_WS", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _debug(message: str) -> None:
    if DEBUG_POLYGON_WS:
        logger.info(message)


def _normalize_timeframe(value: str | None) -> str:
    tf = str(value or "1m").lower().strip()

    aliases = {
        "1": "1m",
        "1min": "1m",
        "5min": "5m",
        "15min": "15m",
        "30min": "30m",
        "60m": "1h",
        "hour": "1h",
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


def _client_key(symbol: str, timeframe: str) -> str:
    return f"{symbol.upper().strip()}::{_normalize_timeframe(timeframe)}"


class PolygonWSManager:
    def __init__(self) -> None:
        self.api_key = os.getenv("POLYGON_API_KEY", "").strip()
        if not self.api_key:
            raise RuntimeError("Missing POLYGON_API_KEY in backend environment")

        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._listen_task: Optional[asyncio.Task] = None

        self._lock = asyncio.Lock()
        self._connected = False
        self._connecting = False

        self._subscriptions: Set[str] = set()

        self._clients_by_key: DefaultDict[str, Set[WebSocket]] = defaultdict(set)
        self._keys_by_client: DefaultDict[WebSocket, Set[str]] = defaultdict(set)

    async def ensure_connected(self) -> None:
        async with self._lock:
            if self._connected and self._ws is not None:
                return

            if self._connecting:
                return

            self._connecting = True

            try:
                _debug("[polygon_ws] opening shared Polygon connection")

                self._ws = await websockets.connect(
                    POLYGON_WS_URL,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                    max_size=2_000_000,
                )

                await self._ws.send(
                    json.dumps(
                        {
                            "action": "auth",
                            "params": self.api_key,
                        }
                    )
                )

                auth_ok = False
                saw_error = None

                for _ in range(10):
                    auth_raw = await asyncio.wait_for(
                        self._ws.recv(),
                        timeout=10.0,
                    )

                    _debug(f"[polygon_ws] auth raw: {auth_raw}")

                    auth_msgs = json.loads(auth_raw)

                    if not isinstance(auth_msgs, list):
                        auth_msgs = [auth_msgs]

                    for msg in auth_msgs:
                        if msg.get("ev") != "status":
                            continue

                        status = msg.get("status")

                        if status == "auth_success":
                            auth_ok = True
                            break

                        if status in {"auth_failed", "error"}:
                            saw_error = msg

                    if auth_ok:
                        break

                if not auth_ok:
                    raise RuntimeError(
                        f"Polygon auth failed: {saw_error or 'No auth_success received'}"
                    )

                self._connected = True
                self._listen_task = asyncio.create_task(self._listen_loop())

            finally:
                self._connecting = False

    async def subscribe_client(
        self,
        frontend_ws: WebSocket,
        symbol: str,
        timeframe: str = "1m",
    ) -> None:
        normalized_symbol = symbol.upper().strip()
        normalized_timeframe = _normalize_timeframe(timeframe)

        if not normalized_symbol:
            raise RuntimeError("Missing symbol for Polygon WebSocket subscription")

        await self.ensure_connected()

        key = _client_key(normalized_symbol, normalized_timeframe)

        async with self._lock:
            self._clients_by_key[key].add(frontend_ws)
            self._keys_by_client[frontend_ws].add(key)

            if normalized_symbol not in self._subscriptions and self._ws is not None:
                subscribe_params = f"T.{normalized_symbol}"

                await self._ws.send(
                    json.dumps(
                        {
                            "action": "subscribe",
                            "params": subscribe_params,
                        }
                    )
                )

                self._subscriptions.add(normalized_symbol)

                _debug(f"[polygon_ws] subscribed shared: {subscribe_params}")

        current = live_bar_aggregator.current_bar(
            normalized_symbol,
            normalized_timeframe,
        )

        if current is not None:
            with suppress(Exception):
                await frontend_ws.send_text(json.dumps([current.to_chart()]))

    async def unsubscribe_client(self, frontend_ws: WebSocket) -> None:
        async with self._lock:
            keys = list(self._keys_by_client.pop(frontend_ws, set()))

            if not keys:
                return

            symbols_to_check: set[str] = set()

            for key in keys:
                clients = self._clients_by_key.get(key)

                if clients is None:
                    continue

                clients.discard(frontend_ws)

                symbol = key.split("::", 1)[0]
                symbols_to_check.add(symbol)

                if not clients:
                    self._clients_by_key.pop(key, None)

            for symbol in symbols_to_check:
                still_needed = any(
                    existing_key.startswith(f"{symbol}::")
                    for existing_key in self._clients_by_key.keys()
                )

                if still_needed:
                    continue

                if symbol in self._subscriptions and self._ws is not None:
                    unsubscribe_params = f"T.{symbol}"

                    await self._ws.send(
                        json.dumps(
                            {
                                "action": "unsubscribe",
                                "params": unsubscribe_params,
                            }
                        )
                    )

                    self._subscriptions.discard(symbol)

                    _debug(f"[polygon_ws] unsubscribed shared: {unsubscribe_params}")

    async def _listen_loop(self) -> None:
        try:
            while self._ws is not None:
                raw = await self._ws.recv()

                msgs = json.loads(raw)

                if not isinstance(msgs, list):
                    msgs = [msgs]

                updated_by_key: DefaultDict[str, list] = defaultdict(list)

                for msg in msgs:
                    if msg.get("ev") == "status":
                        _debug(f"[polygon_ws] status: {msg}")
                        continue

                    if msg.get("ev") != "T":
                        continue

                    symbol = str(msg.get("sym", "")).upper().strip()
                    price = float(msg.get("p") or 0)
                    volume = float(msg.get("s") or 0)
                    timestamp = int(float(msg.get("t") or 0))

                    if not symbol or price <= 0 or timestamp <= 0:
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

        except Exception as exc:
            logger.warning("[polygon_ws] shared listen failed: %s", exc)

        finally:
            await self._reset_connection_state()

    async def _broadcast(
        self,
        updated_by_key: DefaultDict[str, list],
    ) -> None:
        stale_clients: list[WebSocket] = []

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

            latest_bar = bars[-1]
            encoded = json.dumps([latest_bar.to_chart()])

            for client in clients:
                try:
                    await client.send_text(encoded)
                except WebSocketDisconnect:
                    stale_clients.append(client)
                except Exception as exc:
                    _debug(f"[polygon_ws] send_text failed for {key}: {exc}")
                    stale_clients.append(client)

        for client in stale_clients:
            with suppress(Exception):
                await self.unsubscribe_client(client)

    async def _reset_connection_state(self) -> None:
        async with self._lock:
            self._connected = False
            self._connecting = False
            self._subscriptions.clear()

            ws = self._ws

            self._ws = None
            self._listen_task = None

        if ws is not None:
            with suppress(Exception):
                await ws.close()


polygon_ws_manager = PolygonWSManager()


async def forward_polygon_minute_aggregates(
    frontend_ws: WebSocket,
    symbol: str,
    timeframe: str = "1m",
) -> None:
    await polygon_ws_manager.subscribe_client(
        frontend_ws,
        symbol,
        timeframe,
    )

    _debug(
        f"[polygon_ws] frontend attached to shared stream "
        f"symbol={symbol.upper().strip()} timeframe={timeframe}"
    )

    try:
        while True:
            await frontend_ws.receive_text()

    except WebSocketDisconnect:
        _debug(
            f"[polygon_ws] frontend disconnected "
            f"symbol={symbol.upper().strip()} timeframe={timeframe}"
        )
        raise

    finally:
        await polygon_ws_manager.unsubscribe_client(frontend_ws)