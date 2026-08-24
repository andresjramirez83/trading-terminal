from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


def _env_bool(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        return default


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_symbol(symbol: str) -> Tuple[str, str]:
    clean = str(symbol or "").strip().upper()
    if clean.startswith("US."):
        clean = clean[3:]
    clean = "".join(ch for ch in clean if ch.isalnum() or ch in {".", "-"})
    if not clean:
        raise ValueError("Symbol is required.")
    return clean, f"US.{clean}"


@dataclass
class _Subscription:
    refs: int = 0
    subscribed: bool = False


class MoomooLevel2Service:
    """Shared, low-overhead Moomoo OpenD market-depth bridge.

    The Moomoo SDK and OpenD connection are loaded lazily so the trading backend
    still starts normally when Level 2 is disabled or OpenD is unavailable.
    Only active Level 2 consumers use an ORDER_BOOK subscription.
    """

    def __init__(self) -> None:
        self.enabled = _env_bool("MOOMOO_LEVEL2_ENABLED", True)
        self.host = os.getenv("MOOMOO_OPEND_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.port = _safe_int(os.getenv("MOOMOO_OPEND_PORT", "11111"), 11111)
        self.depth = max(1, min(60, _safe_int(os.getenv("MOOMOO_LEVEL2_DEPTH", "60"), 60)))
        self.max_symbols = max(1, min(100, _safe_int(os.getenv("MOOMOO_LEVEL2_MAX_SYMBOLS", "20"), 20)))

        self._lock = threading.RLock()
        self._ctx: Any = None
        self._sdk: Dict[str, Any] = {}
        self._handler: Any = None
        self._books: Dict[str, Dict[str, Any]] = {}
        self._versions: Dict[str, int] = {}
        self._subscriptions: Dict[str, _Subscription] = {}
        self._last_error: Optional[str] = None
        self._connected_at: Optional[float] = None

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "enabled": self.enabled,
                "connected": self._ctx is not None,
                "host": self.host,
                "port": self.port,
                "depth": self.depth,
                "max_symbols": self.max_symbols,
                "active_symbols": sorted(
                    symbol
                    for symbol, sub in self._subscriptions.items()
                    if sub.subscribed
                ),
                "active_count": sum(1 for sub in self._subscriptions.values() if sub.subscribed),
                "connected_at": self._connected_at,
                "last_error": self._last_error,
            }

    def _load_sdk(self) -> None:
        if self._sdk:
            return
        try:
            from moomoo import (  # type: ignore
                OpenQuoteContext,
                OrderBookHandlerBase,
                RET_OK,
                SubType,
            )
        except Exception as exc:  # pragma: no cover - depends on deployed environment
            raise RuntimeError(
                "Moomoo Python SDK is not installed. Run: venv/bin/python -m pip install moomoo-api"
            ) from exc

        self._sdk = {
            "OpenQuoteContext": OpenQuoteContext,
            "OrderBookHandlerBase": OrderBookHandlerBase,
            "RET_OK": RET_OK,
            "SubType": SubType,
        }

    def _ensure_context(self) -> None:
        if not self.enabled:
            raise RuntimeError("Moomoo Level 2 is disabled (MOOMOO_LEVEL2_ENABLED=false).")

        with self._lock:
            if self._ctx is not None:
                return

            self._load_sdk()
            service = self
            OrderBookHandlerBase = self._sdk["OrderBookHandlerBase"]
            RET_OK = self._sdk["RET_OK"]

            class _BookHandler(OrderBookHandlerBase):
                def on_recv_rsp(self, rsp_pb):  # type: ignore[no-untyped-def]
                    ret, data = super().on_recv_rsp(rsp_pb)
                    if ret != RET_OK:
                        service._set_error(str(data))
                        return ret, data
                    service._ingest_book(data)
                    return ret, data

            try:
                ctx = self._sdk["OpenQuoteContext"](host=self.host, port=self.port)
                handler = _BookHandler()
                ctx.set_handler(handler)
            except Exception as exc:
                self._last_error = f"Unable to connect to Moomoo OpenD at {self.host}:{self.port}: {exc}"
                raise RuntimeError(self._last_error) from exc

            self._ctx = ctx
            self._handler = handler
            self._connected_at = time.time()
            self._last_error = None

    def _set_error(self, message: str) -> None:
        with self._lock:
            self._last_error = str(message or "Unknown Moomoo Level 2 error")

    @staticmethod
    def _parse_level(row: Any) -> Dict[str, Any]:
        if isinstance(row, dict):
            price = _safe_float(row.get("price", row.get("Price")))
            size = _safe_float(
                row.get("volume", row.get("Volume", row.get("size", row.get("qty"))))
            )
            orders = _safe_int(row.get("order_num", row.get("order_count", row.get("orders", 0))))
        elif isinstance(row, (tuple, list)):
            price = _safe_float(row[0] if len(row) > 0 else 0)
            size = _safe_float(row[1] if len(row) > 1 else 0)
            orders = _safe_int(row[2] if len(row) > 2 else 0)
        else:
            price = 0.0
            size = 0.0
            orders = 0

        return {
            "price": price,
            "size": size,
            "orders": orders,
        }

    def _ingest_book(self, data: Any) -> None:
        if not isinstance(data, dict):
            return

        raw_code = str(data.get("code") or "").strip().upper()
        if not raw_code:
            return
        symbol = raw_code[3:] if raw_code.startswith("US.") else raw_code

        bids = [self._parse_level(row) for row in list(data.get("Bid") or [])[: self.depth]]
        asks = [self._parse_level(row) for row in list(data.get("Ask") or [])[: self.depth]]
        bids = [level for level in bids if level["price"] > 0]
        asks = [level for level in asks if level["price"] > 0]

        snapshot = self._build_snapshot(
            symbol=symbol,
            name=str(data.get("name") or ""),
            bids=bids,
            asks=asks,
            order_book_type=str(data.get("order_book_type") or ""),
            server_bid_time=str(data.get("svr_recv_time_bid") or ""),
            server_ask_time=str(data.get("svr_recv_time_ask") or ""),
        )

        with self._lock:
            self._books[symbol] = snapshot
            self._versions[symbol] = self._versions.get(symbol, 0) + 1
            self._last_error = None

    @staticmethod
    def _sum(levels: List[Dict[str, Any]], count: int) -> float:
        return float(sum(_safe_float(level.get("size")) for level in levels[:count]))

    @staticmethod
    def _ratio(bid_size: float, ask_size: float) -> Optional[float]:
        if ask_size <= 0:
            return None if bid_size <= 0 else 999.0
        return round(bid_size / ask_size, 3)

    @staticmethod
    def _weighted_pressure(bids: List[Dict[str, Any]], asks: List[Dict[str, Any]], count: int = 20) -> float:
        bid_weighted = 0.0
        ask_weighted = 0.0
        for index, level in enumerate(bids[:count]):
            weight = 1.0 / (1.0 + index * 0.35)
            bid_weighted += _safe_float(level.get("size")) * weight
        for index, level in enumerate(asks[:count]):
            weight = 1.0 / (1.0 + index * 0.35)
            ask_weighted += _safe_float(level.get("size")) * weight
        total = bid_weighted + ask_weighted
        if total <= 0:
            return 0.0
        return round(((bid_weighted - ask_weighted) / total) * 100.0, 1)

    @staticmethod
    def _largest_wall(levels: List[Dict[str, Any]], count: int = 30) -> Optional[Dict[str, Any]]:
        candidates = levels[:count]
        if not candidates:
            return None
        level = max(candidates, key=lambda item: _safe_float(item.get("size")))
        return {
            "price": _safe_float(level.get("price")),
            "size": _safe_float(level.get("size")),
            "orders": _safe_int(level.get("orders")),
            "level": candidates.index(level) + 1,
        }

    def _build_snapshot(
        self,
        *,
        symbol: str,
        name: str,
        bids: List[Dict[str, Any]],
        asks: List[Dict[str, Any]],
        order_book_type: str,
        server_bid_time: str,
        server_ask_time: str,
    ) -> Dict[str, Any]:
        best_bid = _safe_float(bids[0]["price"]) if bids else None
        best_ask = _safe_float(asks[0]["price"]) if asks else None
        spread = None
        mid = None
        if best_bid is not None and best_ask is not None and best_bid > 0 and best_ask > 0:
            spread = round(max(0.0, best_ask - best_bid), 6)
            mid = round((best_bid + best_ask) / 2.0, 6)

        top5_bid = self._sum(bids, 5)
        top5_ask = self._sum(asks, 5)
        top10_bid = self._sum(bids, 10)
        top10_ask = self._sum(asks, 10)
        top20_bid = self._sum(bids, 20)
        top20_ask = self._sum(asks, 20)

        return {
            "type": "level2",
            "provider": "moomoo",
            "symbol": symbol,
            "name": name,
            "order_book_type": order_book_type,
            "received_at": time.time(),
            "server_bid_time": server_bid_time,
            "server_ask_time": server_ask_time,
            "depth": {
                "bid_levels": len(bids),
                "ask_levels": len(asks),
            },
            "best_bid": best_bid,
            "best_ask": best_ask,
            "spread": spread,
            "mid": mid,
            "bids": bids,
            "asks": asks,
            "analytics": {
                "top5_bid_size": top5_bid,
                "top5_ask_size": top5_ask,
                "top5_imbalance": self._ratio(top5_bid, top5_ask),
                "top10_bid_size": top10_bid,
                "top10_ask_size": top10_ask,
                "top10_imbalance": self._ratio(top10_bid, top10_ask),
                "top20_bid_size": top20_bid,
                "top20_ask_size": top20_ask,
                "top20_imbalance": self._ratio(top20_bid, top20_ask),
                "book_pressure": self._weighted_pressure(bids, asks, 20),
                "bid_wall": self._largest_wall(bids, 30),
                "ask_wall": self._largest_wall(asks, 30),
            },
        }

    def add_consumer(self, symbol: str) -> str:
        normalized, moomoo_symbol = _normalize_symbol(symbol)
        self._ensure_context()

        with self._lock:
            sub = self._subscriptions.setdefault(normalized, _Subscription())
            sub.refs += 1
            if sub.subscribed:
                return normalized

            active = sum(1 for item in self._subscriptions.values() if item.subscribed)
            if active >= self.max_symbols:
                sub.refs = max(0, sub.refs - 1)
                raise RuntimeError(
                    f"Moomoo Level 2 symbol limit reached ({self.max_symbols})."
                )

        SubType = self._sdk["SubType"]
        RET_OK = self._sdk["RET_OK"]
        try:
            ret, data = self._ctx.subscribe(
                [moomoo_symbol],
                [SubType.ORDER_BOOK],
                subscribe_push=True,
            )
            if ret != RET_OK:
                raise RuntimeError(str(data))

            # Seed immediately with the current snapshot. Live changes then arrive
            # through the callback handler without polling the Moomoo servers.
            ret, book = self._ctx.get_order_book(moomoo_symbol, num=self.depth)
            if ret == RET_OK:
                self._ingest_book(book)
            else:
                self._set_error(str(book))
        except Exception as exc:
            with self._lock:
                sub = self._subscriptions.setdefault(normalized, _Subscription())
                sub.refs = max(0, sub.refs - 1)
                sub.subscribed = False
                self._last_error = f"Unable to subscribe {normalized}: {exc}"
            raise RuntimeError(self._last_error) from exc

        with self._lock:
            self._subscriptions[normalized].subscribed = True
            self._last_error = None
        return normalized

    def remove_consumer(self, symbol: str) -> None:
        try:
            normalized, moomoo_symbol = _normalize_symbol(symbol)
        except ValueError:
            return

        should_unsubscribe = False
        with self._lock:
            sub = self._subscriptions.get(normalized)
            if sub is None:
                return
            sub.refs = max(0, sub.refs - 1)
            should_unsubscribe = sub.refs == 0 and sub.subscribed
            if should_unsubscribe:
                sub.subscribed = False

        if should_unsubscribe and self._ctx is not None and self._sdk:
            try:
                self._ctx.unsubscribe(
                    [moomoo_symbol],
                    [self._sdk["SubType"].ORDER_BOOK],
                )
            except Exception as exc:
                self._set_error(f"Unable to unsubscribe {normalized}: {exc}")

        with self._lock:
            sub = self._subscriptions.get(normalized)
            if sub and sub.refs == 0:
                self._subscriptions.pop(normalized, None)
                # Keep no stale books once the user leaves a symbol. This keeps
                # memory bounded and makes reconnect state unambiguous.
                self._books.pop(normalized, None)
                self._versions.pop(normalized, None)

    def get_snapshot(self, symbol: str) -> Optional[Dict[str, Any]]:
        normalized, _ = _normalize_symbol(symbol)
        with self._lock:
            book = self._books.get(normalized)
            return dict(book) if book is not None else None

    def get_version(self, symbol: str) -> int:
        normalized, _ = _normalize_symbol(symbol)
        with self._lock:
            return self._versions.get(normalized, 0)

    def close(self) -> None:
        with self._lock:
            ctx = self._ctx
            self._ctx = None
            self._handler = None
            self._books.clear()
            self._versions.clear()
            self._subscriptions.clear()
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass


moomoo_level2_service = MoomooLevel2Service()
