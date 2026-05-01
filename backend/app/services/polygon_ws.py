from __future__ import annotations

import asyncio
import json
import os
from collections import defaultdict
from contextlib import suppress
from typing import DefaultDict, Optional, Set

import websockets
from fastapi import WebSocket, WebSocketDisconnect

POLYGON_WS_URL = "wss://socket.polygon.io/stocks"


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
        self._clients_by_symbol: DefaultDict[str, Set[WebSocket]] = defaultdict(set)
        self._symbols_by_client: DefaultDict[WebSocket, Set[str]] = defaultdict(set)

    async def ensure_connected(self) -> None:
        async with self._lock:
            if self._connected and self._ws is not None:
                return
            if self._connecting:
                return

            self._connecting = True
            try:
                print("[polygon_ws] opening shared Polygon connection", flush=True)
                self._ws = await websockets.connect(
                    POLYGON_WS_URL,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                    max_size=2_000_000,
                )

                # Authenticate immediately. Do not wait for a pre-auth greeting;
                # Polygon can close or delay before auth, which makes the frontend
                # websocket appear to fail before it is established.
                await self._ws.send(json.dumps({"action": "auth", "params": self.api_key}))

                auth_ok = False
                saw_error = None
                for _ in range(10):
                    auth_raw = await asyncio.wait_for(self._ws.recv(), timeout=10.0)
                    print(f"[polygon_ws] auth raw: {auth_raw}", flush=True)
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
                    raise RuntimeError(f"Polygon auth failed: {saw_error or 'No auth_success received'}")

                self._connected = True
                self._listen_task = asyncio.create_task(self._listen_loop())
            finally:
                self._connecting = False

    async def subscribe_client(self, frontend_ws: WebSocket, symbol: str) -> None:
        normalized_symbol = symbol.upper().strip()
        if not normalized_symbol:
            raise RuntimeError("Missing symbol for Polygon WebSocket subscription")

        await self.ensure_connected()

        async with self._lock:
            self._clients_by_symbol[normalized_symbol].add(frontend_ws)
            self._symbols_by_client[frontend_ws].add(normalized_symbol)

            if normalized_symbol not in self._subscriptions and self._ws is not None:
                subscribe_params = f"T.{normalized_symbol},A.{normalized_symbol},AM.{normalized_symbol}"
                await self._ws.send(json.dumps({"action": "subscribe", "params": subscribe_params}))
                self._subscriptions.add(normalized_symbol)
                print(f"[polygon_ws] subscribed shared: {subscribe_params}", flush=True)

    async def unsubscribe_client(self, frontend_ws: WebSocket) -> None:
        async with self._lock:
            symbols = list(self._symbols_by_client.pop(frontend_ws, set()))
            if not symbols:
                return

            for symbol in symbols:
                clients = self._clients_by_symbol.get(symbol)
                if clients is None:
                    continue

                clients.discard(frontend_ws)
                if clients:
                    continue

                self._clients_by_symbol.pop(symbol, None)
                if symbol in self._subscriptions and self._ws is not None:
                    unsubscribe_params = f"T.{symbol},A.{symbol},AM.{symbol}"
                    await self._ws.send(json.dumps({"action": "unsubscribe", "params": unsubscribe_params}))
                    self._subscriptions.discard(symbol)
                    print(f"[polygon_ws] unsubscribed shared: {unsubscribe_params}", flush=True)

    async def _listen_loop(self) -> None:
        try:
            while self._ws is not None:
                raw = await self._ws.recv()

                msgs = json.loads(raw)
                if not isinstance(msgs, list):
                    msgs = [msgs]

                per_symbol: DefaultDict[str, list] = defaultdict(list)
                for msg in msgs:
                    if msg.get("ev") == "status":
                        print(f"[polygon_ws] status: {msg}", flush=True)
                        continue

                    symbol = str(msg.get("sym", "")).upper()
                    if not symbol:
                        continue
                    per_symbol[symbol].append(msg)

                if not per_symbol:
                    continue

                await self._broadcast(per_symbol)
        except Exception as exc:
            print(f"[polygon_ws] shared listen failed: {exc}", flush=True)
        finally:
            await self._reset_connection_state()

    async def _broadcast(self, per_symbol: DefaultDict[str, list]) -> None:
        stale_clients: list[WebSocket] = []
        async with self._lock:
            items = [(symbol, list(self._clients_by_symbol.get(symbol, set())), payload) for symbol, payload in per_symbol.items()]

        for symbol, clients, payload in items:
            if not clients:
                continue
            # Send only the newest trade/aggregate packet per symbol to avoid flooding React.
            encoded = json.dumps(payload[-1:] if len(payload) > 1 else payload)
            for client in clients:
                try:
                    await client.send_text(encoded)
                except WebSocketDisconnect:
                    stale_clients.append(client)
                except Exception as exc:
                    print(f"[polygon_ws] send_text failed for {symbol}: {exc}", flush=True)
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


async def forward_polygon_minute_aggregates(frontend_ws: WebSocket, symbol: str) -> None:
    await polygon_ws_manager.subscribe_client(frontend_ws, symbol)
    print(f"[polygon_ws] frontend attached to shared stream for {symbol.upper().strip()}", flush=True)

    try:
        while True:
            await frontend_ws.receive_text()
    except WebSocketDisconnect:
        print(f"[polygon_ws] frontend disconnected for {symbol.upper().strip()}", flush=True)
        raise
    finally:
        await polygon_ws_manager.unsubscribe_client(frontend_ws)
