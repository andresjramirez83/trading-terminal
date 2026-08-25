from __future__ import annotations

import json
import math
import os
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
PT = ZoneInfo("America/Los_Angeles")


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


def _pct_delta(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0
    return ((current - previous) / previous) * 100.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


@dataclass
class _Subscription:
    refs: int = 0
    subscribed: bool = False
    ticker_subscribed: bool = False


class MoomooLevel2Service:
    """Shared Moomoo OpenD depth bridge plus research-only breakout intelligence.

    Raw 60x60 books stay on the backend. The browser receives at most 5 updates
    per second from the WebSocket route. A short rolling history is kept in
    memory so the service can measure *changes* in liquidity instead of treating
    one static wall as predictive. Compact research samples can also be written
    to disk for the post-trade AI Coach.

    Breakout analytics are intentionally research/confirmation signals. They do
    not submit orders and are not wired into AutoTrade scoring.
    """

    def __init__(self) -> None:
        self.enabled = _env_bool("MOOMOO_LEVEL2_ENABLED", True)
        self.host = os.getenv("MOOMOO_OPEND_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.port = _safe_int(os.getenv("MOOMOO_OPEND_PORT", "11111"), 11111)
        self.depth = max(1, min(60, _safe_int(os.getenv("MOOMOO_LEVEL2_DEPTH", "60"), 60)))
        self.max_symbols = max(1, min(100, _safe_int(os.getenv("MOOMOO_LEVEL2_MAX_SYMBOLS", "20"), 20)))

        self.history_seconds = max(10.0, min(120.0, _safe_float(os.getenv("MOOMOO_LEVEL2_HISTORY_SECONDS", "30"), 30.0)))
        self.analysis_lookback_seconds = max(2.0, min(20.0, _safe_float(os.getenv("MOOMOO_LEVEL2_BREAKOUT_LOOKBACK_SECONDS", "5"), 5.0)))
        self.ticker_enabled = _env_bool("MOOMOO_LEVEL2_TICKER_ENABLED", True)

        self.research_enabled = _env_bool("MOOMOO_LEVEL2_RESEARCH_ENABLED", True)
        self.research_max_symbols = max(0, min(20, _safe_int(os.getenv("MOOMOO_LEVEL2_RESEARCH_MAX_SYMBOLS", "8"), 8)))
        self.record_interval_seconds = max(0.5, min(10.0, _safe_float(os.getenv("MOOMOO_LEVEL2_RECORD_INTERVAL_SECONDS", "1"), 1.0)))
        self.retention_days = max(1, min(90, _safe_int(os.getenv("MOOMOO_LEVEL2_RETENTION_DAYS", "14"), 14)))
        self.record_dir = self._resolve_record_dir()

        self._lock = threading.RLock()
        self._ctx: Any = None
        self._sdk: Dict[str, Any] = {}
        self._book_handler: Any = None
        self._ticker_handler: Any = None
        self._books: Dict[str, Dict[str, Any]] = {}
        self._versions: Dict[str, int] = {}
        self._subscriptions: Dict[str, _Subscription] = {}
        self._history: Dict[str, Deque[Dict[str, Any]]] = {}
        self._trades: Dict[str, Deque[Dict[str, Any]]] = {}
        self._research_symbols: set[str] = set()
        self._last_persist_at: Dict[str, float] = {}
        self._last_cleanup_day: Optional[str] = None
        self._last_error: Optional[str] = None
        self._ticker_errors: Dict[str, str] = {}
        self._connected_at: Optional[float] = None

    @staticmethod
    def _resolve_record_dir() -> Path:
        raw = os.getenv("MOOMOO_LEVEL2_HISTORY_DIR", "").strip()
        if raw:
            path = Path(raw)
            return path if path.is_absolute() else Path.cwd() / path
        return Path(__file__).resolve().parents[1] / "data" / "level2_history"

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
                "ticker_enabled": self.ticker_enabled,
                "ticker_symbols": sorted(
                    symbol
                    for symbol, sub in self._subscriptions.items()
                    if sub.ticker_subscribed
                ),
                "research_enabled": self.research_enabled,
                "research_symbols": sorted(self._research_symbols),
                "research_max_symbols": self.research_max_symbols,
                "record_interval_seconds": self.record_interval_seconds,
                "record_dir": str(self.record_dir),
                "connected_at": self._connected_at,
                "last_error": self._last_error,
                "ticker_errors": dict(self._ticker_errors),
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
                TickerHandlerBase,
            )
        except Exception as exc:  # pragma: no cover - depends on deployed environment
            raise RuntimeError(
                "Moomoo Python SDK is not installed. Run: venv/bin/python -m pip install moomoo-api"
            ) from exc

        self._sdk = {
            "OpenQuoteContext": OpenQuoteContext,
            "OrderBookHandlerBase": OrderBookHandlerBase,
            "TickerHandlerBase": TickerHandlerBase,
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
            TickerHandlerBase = self._sdk["TickerHandlerBase"]
            RET_OK = self._sdk["RET_OK"]

            class _BookHandler(OrderBookHandlerBase):
                def on_recv_rsp(self, rsp_pb):  # type: ignore[no-untyped-def]
                    ret, data = super().on_recv_rsp(rsp_pb)
                    if ret != RET_OK:
                        service._set_error(str(data))
                        return ret, data
                    service._ingest_book(data)
                    return ret, data

            class _TickerHandler(TickerHandlerBase):
                def on_recv_rsp(self, rsp_pb):  # type: ignore[no-untyped-def]
                    ret, data = super().on_recv_rsp(rsp_pb)
                    if ret != RET_OK:
                        return ret, data
                    service._ingest_tickers(data)
                    return ret, data

            try:
                ctx = self._sdk["OpenQuoteContext"](host=self.host, port=self.port)
                book_handler = _BookHandler()
                ticker_handler = _TickerHandler()
                ctx.set_handler(book_handler)
                if self.ticker_enabled:
                    ctx.set_handler(ticker_handler)
            except Exception as exc:
                self._last_error = f"Unable to connect to Moomoo OpenD at {self.host}:{self.port}: {exc}"
                raise RuntimeError(self._last_error) from exc

            self._ctx = ctx
            self._book_handler = book_handler
            self._ticker_handler = ticker_handler
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

        return {"price": price, "size": size, "orders": orders}

    @staticmethod
    def _rows_from_data(data: Any) -> List[Dict[str, Any]]:
        if data is None:
            return []
        if isinstance(data, dict):
            return [dict(data)]
        try:
            records = data.to_dict("records")
            if isinstance(records, list):
                return [dict(row) for row in records if isinstance(row, dict)]
        except Exception:
            pass
        if isinstance(data, list):
            return [dict(row) for row in data if isinstance(row, dict)]
        return []

    def _ingest_tickers(self, data: Any) -> None:
        now = time.time()
        for row in self._rows_from_data(data):
            raw_code = str(row.get("code") or "").strip().upper()
            if not raw_code:
                continue
            symbol = raw_code[3:] if raw_code.startswith("US.") else raw_code
            price = _safe_float(row.get("price"))
            volume = _safe_float(row.get("volume", row.get("qty")))
            if price <= 0 or volume <= 0:
                continue

            direction = str(
                row.get("ticker_direction")
                or row.get("direction")
                or row.get("type")
                or ""
            ).strip().upper()

            with self._lock:
                book = self._books.get(symbol) or {}
                best_bid = _safe_float(book.get("best_bid"))
                best_ask = _safe_float(book.get("best_ask"))

                side = "neutral"
                if "BUY" in direction or "UP" in direction:
                    side = "buy"
                elif "SELL" in direction or "DOWN" in direction:
                    side = "sell"
                elif best_ask > 0 and price >= best_ask - max(0.000001, best_ask * 0.00001):
                    side = "buy"
                elif best_bid > 0 and price <= best_bid + max(0.000001, best_bid * 0.00001):
                    side = "sell"

                queue = self._trades.setdefault(symbol, deque())
                queue.append({"ts": now, "price": price, "volume": volume, "side": side})
                cutoff = now - self.history_seconds
                while queue and _safe_float(queue[0].get("ts")) < cutoff:
                    queue.popleft()

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

        persist_sample: Optional[Dict[str, Any]] = None
        with self._lock:
            history = self._history.setdefault(symbol, deque())
            trades = list(self._trades.get(symbol) or [])
            breakout = self._breakout_context(snapshot, list(history), trades)
            snapshot["breakout"] = breakout
            snapshot["analytics"].update(breakout.get("metrics") or {})

            self._books[symbol] = snapshot
            self._versions[symbol] = self._versions.get(symbol, 0) + 1
            self._last_error = None

            compact = self._compact_history_sample(snapshot)
            history.append(compact)
            cutoff = _safe_float(snapshot.get("received_at")) - self.history_seconds
            while history and _safe_float(history[0].get("ts")) < cutoff:
                history.popleft()

            sub = self._subscriptions.get(symbol)
            should_record = bool(
                self.research_enabled
                and (symbol in self._research_symbols or (sub is not None and sub.refs > 0))
            )
            if should_record:
                last_persist = self._last_persist_at.get(symbol, 0.0)
                if compact["ts"] - last_persist >= self.record_interval_seconds:
                    self._last_persist_at[symbol] = compact["ts"]
                    persist_sample = self._compact_record_sample(snapshot)

        if persist_sample is not None:
            self._persist_sample(symbol, persist_sample)

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
            "depth": {"bid_levels": len(bids), "ask_levels": len(asks)},
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

    def _reference_sample(self, history: List[Dict[str, Any]], now: float) -> Optional[Dict[str, Any]]:
        if not history:
            return None
        target = now - self.analysis_lookback_seconds
        candidates = [row for row in history if _safe_float(row.get("ts")) <= target]
        if candidates:
            return candidates[-1]
        return history[0]

    @staticmethod
    def _trade_stats(trades: Iterable[Dict[str, Any]], now: float, seconds: float = 5.0) -> Dict[str, float]:
        cutoff = now - seconds
        buy = 0.0
        sell = 0.0
        neutral = 0.0
        prints = 0
        for item in trades:
            if _safe_float(item.get("ts")) < cutoff:
                continue
            volume = _safe_float(item.get("volume"))
            side = str(item.get("side") or "neutral")
            prints += 1
            if side == "buy":
                buy += volume
            elif side == "sell":
                sell += volume
            else:
                neutral += volume
        total_directional = buy + sell
        pressure = ((buy - sell) / total_directional * 100.0) if total_directional > 0 else 0.0
        return {
            "buy": round(buy, 2),
            "sell": round(sell, 2),
            "neutral": round(neutral, 2),
            "prints": float(prints),
            "pressure": round(pressure, 1),
        }

    def _breakout_context(
        self,
        snapshot: Dict[str, Any],
        history: List[Dict[str, Any]],
        trades: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        now = _safe_float(snapshot.get("received_at"), time.time())
        analytics = snapshot.get("analytics") or {}
        reference = self._reference_sample(history, now)

        top5_bid = _safe_float(analytics.get("top5_bid_size"))
        top5_ask = _safe_float(analytics.get("top5_ask_size"))
        top10_bid = _safe_float(analytics.get("top10_bid_size"))
        top10_ask = _safe_float(analytics.get("top10_ask_size"))
        top5_ratio = _safe_float(analytics.get("top5_imbalance"))
        top10_ratio = _safe_float(analytics.get("top10_imbalance"))
        pressure = _safe_float(analytics.get("book_pressure"))

        ref_top5_bid = _safe_float((reference or {}).get("top5_bid"))
        ref_top5_ask = _safe_float((reference or {}).get("top5_ask"))
        ref_top5_ratio = _safe_float((reference or {}).get("top5_ratio"))
        ref_top10_ratio = _safe_float((reference or {}).get("top10_ratio"))
        ref_pressure = _safe_float((reference or {}).get("pressure"))

        bid_delta = _pct_delta(top5_bid, ref_top5_bid) if reference else 0.0
        ask_delta = _pct_delta(top5_ask, ref_top5_ask) if reference else 0.0
        bid_stacking = max(0.0, bid_delta)
        bid_pulling = max(0.0, -bid_delta)
        ask_pulling = max(0.0, -ask_delta)
        ask_stacking = max(0.0, ask_delta)
        top5_momentum = top5_ratio - ref_top5_ratio if reference else 0.0
        top10_momentum = top10_ratio - ref_top10_ratio if reference else 0.0
        pressure_change = pressure - ref_pressure if reference else 0.0

        current_bid_wall = analytics.get("bid_wall") or {}
        current_ask_wall = analytics.get("ask_wall") or {}
        ref_bid_wall_price = _safe_float((reference or {}).get("bid_wall_price"))
        ref_ask_wall_price = _safe_float((reference or {}).get("ask_wall_price"))
        bid_wall_price = _safe_float(current_bid_wall.get("price"))
        ask_wall_price = _safe_float(current_ask_wall.get("price"))
        mid = _safe_float(snapshot.get("mid"))
        epsilon = max(0.000001, mid * 0.00005) if mid > 0 else 0.000001
        bid_wall_moved_up = bool(reference and bid_wall_price > ref_bid_wall_price + epsilon and ref_bid_wall_price > 0)
        ask_wall_moved_down = bool(reference and ask_wall_price + epsilon < ref_ask_wall_price and ask_wall_price > 0)

        trade5 = self._trade_stats(trades, now, 5.0)
        directional_volume = trade5["buy"] + trade5["sell"]
        buy_share = trade5["buy"] / directional_volume if directional_volume > 0 else 0.0
        ask_depletion = min(100.0, ask_pulling)
        absorption_score = 0.0
        if directional_volume > 0:
            absorption_score = _clamp((buy_share * 65.0) + (ask_depletion * 0.35), 0.0, 100.0)

        upside_liquidity_ratio = (top10_ask / top10_bid) if top10_bid > 0 else 999.0
        upside_path_thin = bool(top10_bid > 0 and top10_ask > 0 and upside_liquidity_ratio <= 0.70 and top5_ratio >= 1.25)

        spread = _safe_float(snapshot.get("spread"))
        spread_pct = (spread / mid * 100.0) if spread > 0 and mid > 0 else 0.0

        history_span = 0.0
        if history:
            history_span = max(0.0, now - _safe_float(history[0].get("ts")))
        ready = history_span >= min(4.0, self.analysis_lookback_seconds * 0.8)

        score = 0.0
        positive_signals: List[str] = []
        cautions: List[str] = []

        if bid_stacking >= 8:
            points = min(15.0, 4.0 + bid_stacking * 0.35)
            score += points
            positive_signals.append(f"Bid liquidity stacking +{bid_stacking:.0f}% over ~{self.analysis_lookback_seconds:.0f}s")
        if bid_wall_moved_up:
            score += 10
            positive_signals.append("Largest bid wall moved higher with price")
        if ask_pulling >= 8:
            points = min(15.0, 4.0 + ask_pulling * 0.35)
            score += points
            positive_signals.append(f"Near ask liquidity pulled/depleted {ask_pulling:.0f}%")
        if absorption_score >= 45:
            score += min(15.0, 5.0 + (absorption_score - 45.0) * 0.18)
            positive_signals.append(f"Ask absorption/aggressive buying score {absorption_score:.0f}/100")
        if top5_ratio >= 1.5 and top5_momentum >= 0.20:
            score += 10
            positive_signals.append(f"Top-5 imbalance accelerating to {top5_ratio:.2f}x")
        elif top5_ratio >= 2.5:
            score += 5
            positive_signals.append(f"Top-5 book is bid-heavy at {top5_ratio:.2f}x")
        if top10_ratio >= 1.3 and top10_momentum >= 0.15:
            score += 10
            positive_signals.append(f"Top-10 imbalance strengthening to {top10_ratio:.2f}x")
        if pressure >= 10 and pressure_change >= 10:
            score += 10
            positive_signals.append(f"Book pressure accelerated {ref_pressure:+.0f} → {pressure:+.0f}")
        if directional_volume > 0 and trade5["pressure"] >= 25:
            score += 10
            positive_signals.append(f"Aggressive prints favor buyers ({buy_share * 100:.0f}% buy-side volume)")
        if upside_path_thin:
            score += 10
            positive_signals.append("Upside path is thin versus nearby bid liquidity")

        if bid_pulling >= 15:
            score -= min(20.0, 6.0 + bid_pulling * 0.35)
            cautions.append(f"Bid liquidity pulling {bid_pulling:.0f}%")
        if ask_stacking >= 15:
            score -= min(15.0, 5.0 + ask_stacking * 0.30)
            cautions.append(f"Ask liquidity stacking +{ask_stacking:.0f}%")
        if ask_wall_moved_down:
            score -= 8
            cautions.append("Largest ask wall moved closer/down toward price")
        if pressure <= -25 and pressure_change <= 0:
            score -= 10
            cautions.append(f"Book pressure remains bearish at {pressure:+.0f}")
        if trade5["pressure"] <= -30 and directional_volume > 0:
            score -= 10
            cautions.append("Aggressive prints favor sellers")
        if spread_pct >= 1.5:
            score -= 12
            cautions.append(f"Spread is wide at {spread_pct:.2f}% of mid")
        elif spread_pct >= 0.75:
            score -= 6
            cautions.append(f"Spread is elevated at {spread_pct:.2f}% of mid")

        score = round(_clamp(score, 0.0, 100.0), 1)
        if not ready:
            label = "WARMING UP"
        elif score >= 85:
            label = "BREAKOUT PRESSURE"
        elif score >= 70:
            label = "STRONG"
        elif score >= 50:
            label = "BUILDING"
        elif score >= 30:
            label = "NEUTRAL"
        else:
            label = "WEAK"

        history_confidence = _clamp(history_span / max(self.analysis_lookback_seconds, 1.0), 0.0, 1.0)
        tape_confidence = 1.0 if directional_volume > 0 else 0.0
        confidence = round((history_confidence * 0.75) + (tape_confidence * 0.25), 2)

        if not ready:
            coach_summary = "Collecting several seconds of Level 2 history before judging breakout pressure."
        elif score >= 85:
            coach_summary = "Multiple order-flow signals are aligning for a potential upside break: demand is strengthening while nearby supply is thinning. Watch price structure for the actual trigger."
        elif score >= 70:
            coach_summary = "Level 2 is showing strong bullish breakout behavior, but price still needs to confirm through the nearby structure/resistance level."
        elif score >= 50:
            coach_summary = "Bullish pressure is building, but the book is not yet one-sided enough to treat it as a high-confidence breakout condition."
        elif score >= 30:
            coach_summary = "The order book is mixed. Wait for clearer bid stacking, ask depletion, and pressure acceleration before using Level 2 as confirmation."
        else:
            coach_summary = "Level 2 is not showing convincing upside breakout pressure right now. Avoid treating a static bid wall by itself as a breakout signal."

        metrics = {
            "bid_stacking_pct": round(bid_stacking, 1),
            "bid_pulling_pct": round(bid_pulling, 1),
            "ask_pulling_pct": round(ask_pulling, 1),
            "ask_stacking_pct": round(ask_stacking, 1),
            "top5_imbalance_momentum": round(top5_momentum, 3),
            "top10_imbalance_momentum": round(top10_momentum, 3),
            "book_pressure_change": round(pressure_change, 1),
            "aggressive_buy_volume_5s": trade5["buy"],
            "aggressive_sell_volume_5s": trade5["sell"],
            "trade_pressure_5s": trade5["pressure"],
            "ticker_prints_5s": int(trade5["prints"]),
            "ask_absorption_score": round(absorption_score, 1),
            "upside_liquidity_ratio": round(upside_liquidity_ratio, 3) if upside_liquidity_ratio < 999 else None,
            "upside_path_thin": upside_path_thin,
            "bid_wall_moved_up": bid_wall_moved_up,
            "ask_wall_moved_down": ask_wall_moved_down,
            "spread_pct": round(spread_pct, 3),
        }

        return {
            "score": score,
            "label": label,
            "ready": ready,
            "confidence": confidence,
            "lookback_seconds": self.analysis_lookback_seconds,
            "history_span_seconds": round(history_span, 1),
            "signals": positive_signals[:6],
            "cautions": cautions[:5],
            "metrics": metrics,
            "coach": {
                "headline": f"L2 Breakout · {label}",
                "summary": coach_summary,
                "research_only": True,
            },
        }

    @staticmethod
    def _compact_history_sample(snapshot: Dict[str, Any]) -> Dict[str, Any]:
        analytics = snapshot.get("analytics") or {}
        breakout = snapshot.get("breakout") or {}
        bid_wall = analytics.get("bid_wall") or {}
        ask_wall = analytics.get("ask_wall") or {}
        return {
            "ts": _safe_float(snapshot.get("received_at")),
            "best_bid": _safe_float(snapshot.get("best_bid")),
            "best_ask": _safe_float(snapshot.get("best_ask")),
            "top5_bid": _safe_float(analytics.get("top5_bid_size")),
            "top5_ask": _safe_float(analytics.get("top5_ask_size")),
            "top10_bid": _safe_float(analytics.get("top10_bid_size")),
            "top10_ask": _safe_float(analytics.get("top10_ask_size")),
            "top5_ratio": _safe_float(analytics.get("top5_imbalance")),
            "top10_ratio": _safe_float(analytics.get("top10_imbalance")),
            "pressure": _safe_float(analytics.get("book_pressure")),
            "bid_wall_price": _safe_float(bid_wall.get("price")),
            "bid_wall_size": _safe_float(bid_wall.get("size")),
            "ask_wall_price": _safe_float(ask_wall.get("price")),
            "ask_wall_size": _safe_float(ask_wall.get("size")),
            "score": _safe_float(breakout.get("score")),
        }

    @staticmethod
    def _compact_record_sample(snapshot: Dict[str, Any]) -> Dict[str, Any]:
        analytics = snapshot.get("analytics") or {}
        breakout = snapshot.get("breakout") or {}
        metrics = breakout.get("metrics") or {}
        bid_wall = analytics.get("bid_wall") or {}
        ask_wall = analytics.get("ask_wall") or {}
        return {
            "ts": round(_safe_float(snapshot.get("received_at")), 3),
            "bid": _safe_float(snapshot.get("best_bid")),
            "ask": _safe_float(snapshot.get("best_ask")),
            "spr": _safe_float(snapshot.get("spread")),
            "i5": _safe_float(analytics.get("top5_imbalance")),
            "i10": _safe_float(analytics.get("top10_imbalance")),
            "i20": _safe_float(analytics.get("top20_imbalance")),
            "p": _safe_float(analytics.get("book_pressure")),
            "b5": _safe_float(analytics.get("top5_bid_size")),
            "a5": _safe_float(analytics.get("top5_ask_size")),
            "b10": _safe_float(analytics.get("top10_bid_size")),
            "a10": _safe_float(analytics.get("top10_ask_size")),
            "bw": _safe_float(bid_wall.get("price")),
            "bws": _safe_float(bid_wall.get("size")),
            "aw": _safe_float(ask_wall.get("price")),
            "aws": _safe_float(ask_wall.get("size")),
            "score": _safe_float(breakout.get("score")),
            "label": str(breakout.get("label") or ""),
            "bst": _safe_float(metrics.get("bid_stacking_pct")),
            "bpl": _safe_float(metrics.get("bid_pulling_pct")),
            "apl": _safe_float(metrics.get("ask_pulling_pct")),
            "ast": _safe_float(metrics.get("ask_stacking_pct")),
            "pm": _safe_float(metrics.get("book_pressure_change")),
            "im": _safe_float(metrics.get("top5_imbalance_momentum")),
            "tb": _safe_float(metrics.get("aggressive_buy_volume_5s")),
            "tsl": _safe_float(metrics.get("aggressive_sell_volume_5s")),
            "tp": _safe_float(metrics.get("trade_pressure_5s")),
            "abs": _safe_float(metrics.get("ask_absorption_score")),
            "thin": bool(metrics.get("upside_path_thin")),
            "signals": list(breakout.get("signals") or [])[:4],
            "cautions": list(breakout.get("cautions") or [])[:3],
        }

    def _persist_sample(self, symbol: str, sample: Dict[str, Any]) -> None:
        try:
            ts = _safe_float(sample.get("ts"), time.time())
            trade_date = datetime.fromtimestamp(ts, timezone.utc).astimezone(ET).date().isoformat()
            directory = self.record_dir / trade_date
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{symbol}.jsonl"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(sample, separators=(",", ":"), ensure_ascii=True) + "\n")
            self._cleanup_old_records(trade_date)
        except Exception as exc:
            self._set_error(f"Level 2 research record write failed for {symbol}: {exc}")

    def _cleanup_old_records(self, current_trade_date: str) -> None:
        if self._last_cleanup_day == current_trade_date:
            return
        self._last_cleanup_day = current_trade_date
        try:
            cutoff = datetime.now(ET).date() - timedelta(days=self.retention_days)
            if not self.record_dir.exists():
                return
            for child in self.record_dir.iterdir():
                if not child.is_dir():
                    continue
                try:
                    child_date = datetime.strptime(child.name, "%Y-%m-%d").date()
                except Exception:
                    continue
                if child_date >= cutoff:
                    continue
                for file_path in child.glob("*"):
                    try:
                        file_path.unlink()
                    except Exception:
                        pass
                try:
                    child.rmdir()
                except Exception:
                    pass
        except Exception:
            pass

    def _load_recorded_samples(self, symbol: str, start_ts: float, end_ts: float) -> List[Dict[str, Any]]:
        normalized, _ = _normalize_symbol(symbol)
        if end_ts < start_ts:
            start_ts, end_ts = end_ts, start_ts
        start_date = datetime.fromtimestamp(start_ts, timezone.utc).astimezone(ET).date()
        end_date = datetime.fromtimestamp(end_ts, timezone.utc).astimezone(ET).date()
        rows: List[Dict[str, Any]] = []
        cursor = start_date
        while cursor <= end_date:
            path = self.record_dir / cursor.isoformat() / f"{normalized}.jsonl"
            if path.exists():
                try:
                    with path.open("r", encoding="utf-8") as handle:
                        for line in handle:
                            try:
                                row = json.loads(line)
                            except Exception:
                                continue
                            ts = _safe_float(row.get("ts"))
                            if start_ts <= ts <= end_ts:
                                rows.append(row)
                except Exception:
                    pass
            cursor += timedelta(days=1)
        rows.sort(key=lambda row: _safe_float(row.get("ts")))
        return rows

    @staticmethod
    def _record_state_label(score: Optional[float]) -> str:
        if score is None:
            return "NO DATA"
        if score >= 85:
            return "BREAKOUT PRESSURE"
        if score >= 70:
            return "STRONG"
        if score >= 50:
            return "BUILDING"
        if score >= 30:
            return "NEUTRAL"
        return "WEAK"

    def summarize_recorded_breakout(
        self,
        symbol: str,
        entry_ts: float,
        before_seconds: float = 30.0,
        after_seconds: float = 60.0,
    ) -> Dict[str, Any]:
        """Summarize persisted L2 behavior around a trade entry for the AI Coach."""
        start_ts = entry_ts - max(5.0, before_seconds)
        end_ts = entry_ts + max(5.0, after_seconds)
        rows = self._load_recorded_samples(symbol, start_ts, end_ts)
        if not rows:
            return {
                "available": False,
                "research_only": True,
                "sample_count": 0,
                "summary": "No recorded Level 2 research samples were available around this entry.",
            }

        pre = [row for row in rows if _safe_float(row.get("ts")) <= entry_ts]
        post = [row for row in rows if _safe_float(row.get("ts")) > entry_ts]
        nearest = min(rows, key=lambda row: abs(_safe_float(row.get("ts")) - entry_ts))
        nearest_delta = abs(_safe_float(nearest.get("ts")) - entry_ts)
        entry_row = nearest if nearest_delta <= max(5.0, self.record_interval_seconds * 2.5) else None

        def max_score(items: List[Dict[str, Any]]) -> Optional[float]:
            values = [_safe_float(row.get("score"), -1.0) for row in items]
            values = [value for value in values if value >= 0]
            return max(values) if values else None

        pre_max = max_score(pre)
        post_max = max_score(post)
        entry_score = _safe_float(entry_row.get("score")) if entry_row else None
        first_strong = next((row for row in rows if _safe_float(row.get("score")) >= 70.0), None)
        first_breakout = next((row for row in rows if _safe_float(row.get("score")) >= 85.0), None)

        first_strong_seconds = (
            round(_safe_float(first_strong.get("ts")) - entry_ts, 1)
            if first_strong
            else None
        )
        first_breakout_seconds = (
            round(_safe_float(first_breakout.get("ts")) - entry_ts, 1)
            if first_breakout
            else None
        )

        peak = max(rows, key=lambda row: _safe_float(row.get("score")))
        peak_score = _safe_float(peak.get("score"))
        peak_seconds = round(_safe_float(peak.get("ts")) - entry_ts, 1)

        if entry_score is not None and entry_score >= 70 and (pre_max or 0) >= 70:
            summary = "Level 2 breakout pressure was already strong before the entry and remained strong at the entry."
        elif entry_score is not None and entry_score < 50 and (post_max or 0) >= 70:
            delay = first_strong_seconds if first_strong_seconds is not None and first_strong_seconds > 0 else None
            summary = (
                f"The entry came before strong Level 2 confirmation; breakout pressure strengthened after entry{f' about {delay:.0f}s later' if delay is not None else ''}."
            )
        elif (pre_max or 0) >= 70 and (entry_score or 0) < 50:
            summary = "Strong Level 2 pressure appeared before the entry but had faded by the time the trade was entered."
        elif (post_max or 0) >= 85:
            summary = "The recorded Level 2 book developed breakout-pressure behavior shortly after entry."
        elif peak_score >= 50:
            summary = "Level 2 showed some bullish pressure around entry, but the recorded book never reached a strong breakout threshold."
        else:
            summary = "The recorded Level 2 book did not show convincing bullish breakout behavior around entry."

        entry_signals = list((entry_row or peak).get("signals") or [])[:5]
        entry_cautions = list((entry_row or peak).get("cautions") or [])[:4]

        return {
            "available": True,
            "research_only": True,
            "sample_count": len(rows),
            "window_before_seconds": before_seconds,
            "window_after_seconds": after_seconds,
            "score_at_entry": round(entry_score, 1) if entry_score is not None else None,
            "state_at_entry": self._record_state_label(entry_score),
            "pre_entry_max_score": round(pre_max, 1) if pre_max is not None else None,
            "post_entry_max_score": round(post_max, 1) if post_max is not None else None,
            "peak_score": round(peak_score, 1),
            "peak_seconds_from_entry": peak_seconds,
            "first_strong_seconds_from_entry": first_strong_seconds,
            "first_breakout_seconds_from_entry": first_breakout_seconds,
            "book_pressure_at_entry": _safe_float((entry_row or {}).get("p")) if entry_row else None,
            "top5_imbalance_at_entry": _safe_float((entry_row or {}).get("i5")) if entry_row else None,
            "bid_stacking_pct_at_entry": _safe_float((entry_row or {}).get("bst")) if entry_row else None,
            "ask_pulling_pct_at_entry": _safe_float((entry_row or {}).get("apl")) if entry_row else None,
            "ask_absorption_score_at_entry": _safe_float((entry_row or {}).get("abs")) if entry_row else None,
            "trade_pressure_5s_at_entry": _safe_float((entry_row or {}).get("tp")) if entry_row else None,
            "upside_path_thin_at_entry": bool((entry_row or {}).get("thin")) if entry_row else None,
            "signals": entry_signals,
            "cautions": entry_cautions,
            "summary": summary,
        }

    def sync_research_symbols(self, symbols: Iterable[str]) -> Dict[str, Any]:
        """Keep L2 research subscriptions on top live strategy candidates.

        The scanner calls this with a small ranked set. Reference counting means
        the same symbol can simultaneously be open in the browser without being
        unsubscribed when either consumer goes away.
        """
        if not self.research_enabled or self.research_max_symbols <= 0:
            desired: List[str] = []
        else:
            desired = []
            for raw in symbols:
                try:
                    normalized, _ = _normalize_symbol(raw)
                except ValueError:
                    continue
                if normalized not in desired:
                    desired.append(normalized)
                if len(desired) >= self.research_max_symbols:
                    break

        with self._lock:
            current = set(self._research_symbols)
        desired_set = set(desired)

        removed: List[str] = []
        for symbol in sorted(current - desired_set):
            self.remove_consumer(symbol)
            with self._lock:
                self._research_symbols.discard(symbol)
            removed.append(symbol)

        added: List[str] = []
        errors: Dict[str, str] = {}
        for symbol in desired:
            with self._lock:
                already = symbol in self._research_symbols
            if already:
                continue
            try:
                self.add_consumer(symbol)
                with self._lock:
                    self._research_symbols.add(symbol)
                added.append(symbol)
            except Exception as exc:
                errors[symbol] = str(exc)

        with self._lock:
            active = sorted(self._research_symbols)
        return {"active": active, "added": added, "removed": removed, "errors": errors}

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
                raise RuntimeError(f"Moomoo Level 2 symbol limit reached ({self.max_symbols}).")

        SubType = self._sdk["SubType"]
        RET_OK = self._sdk["RET_OK"]
        ticker_subscribed = False
        try:
            ret, data = self._ctx.subscribe(
                [moomoo_symbol],
                [SubType.ORDER_BOOK],
                subscribe_push=True,
            )
            if ret != RET_OK:
                raise RuntimeError(str(data))

            if self.ticker_enabled:
                try:
                    ret_ticker, ticker_data = self._ctx.subscribe(
                        [moomoo_symbol],
                        [SubType.TICKER],
                        subscribe_push=True,
                    )
                    ticker_subscribed = ret_ticker == RET_OK
                    with self._lock:
                        if ticker_subscribed:
                            self._ticker_errors.pop(normalized, None)
                        else:
                            self._ticker_errors[normalized] = str(ticker_data)
                except Exception as ticker_exc:
                    with self._lock:
                        self._ticker_errors[normalized] = str(ticker_exc)

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
                sub.ticker_subscribed = False
                self._last_error = f"Unable to subscribe {normalized}: {exc}"
            raise RuntimeError(self._last_error) from exc

        with self._lock:
            sub = self._subscriptions[normalized]
            sub.subscribed = True
            sub.ticker_subscribed = ticker_subscribed
            self._last_error = None
        return normalized

    def remove_consumer(self, symbol: str) -> None:
        try:
            normalized, moomoo_symbol = _normalize_symbol(symbol)
        except ValueError:
            return

        should_unsubscribe = False
        ticker_subscribed = False
        with self._lock:
            sub = self._subscriptions.get(normalized)
            if sub is None:
                return
            sub.refs = max(0, sub.refs - 1)
            should_unsubscribe = sub.refs == 0 and sub.subscribed
            ticker_subscribed = sub.ticker_subscribed
            if should_unsubscribe:
                sub.subscribed = False
                sub.ticker_subscribed = False

        if should_unsubscribe and self._ctx is not None and self._sdk:
            try:
                self._ctx.unsubscribe([moomoo_symbol], [self._sdk["SubType"].ORDER_BOOK])
            except Exception as exc:
                self._set_error(f"Unable to unsubscribe {normalized} order book: {exc}")
            if ticker_subscribed:
                try:
                    self._ctx.unsubscribe([moomoo_symbol], [self._sdk["SubType"].TICKER])
                except Exception:
                    pass

        with self._lock:
            sub = self._subscriptions.get(normalized)
            if sub and sub.refs == 0:
                self._subscriptions.pop(normalized, None)
                # Keep persisted research on disk, but free hot in-memory state.
                self._books.pop(normalized, None)
                self._versions.pop(normalized, None)
                self._history.pop(normalized, None)
                self._trades.pop(normalized, None)
                self._ticker_errors.pop(normalized, None)

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
            self._book_handler = None
            self._ticker_handler = None
            self._books.clear()
            self._versions.clear()
            self._subscriptions.clear()
            self._history.clear()
            self._trades.clear()
            self._research_symbols.clear()
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass


moomoo_level2_service = MoomooLevel2Service()
