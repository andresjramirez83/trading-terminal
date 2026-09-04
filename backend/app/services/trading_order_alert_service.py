from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests

from app.autotrade.state import AutoTradeStore
from app.services.alpaca_service import AlpacaService


TERMINAL_STATUSES = {
    "filled",
    "canceled",
    "cancelled",
    "expired",
    "rejected",
    "done_for_day",
    "replaced",
}


class TradingOrderAlertService:
    """Broker-backed fill/close Pushover notifications.

    The service intentionally baselines the broker snapshot on first run so a
    worker restart never replays old fill notifications. After that, it tracks
    cumulative filled quantity by Alpaca order id and reconstructs each symbol's
    open trade so the final close alert uses actual exit fills and realized P/L.
    """

    STATE_KEY = "trading_order_alerts_v1"

    def __init__(self, store: AutoTradeStore) -> None:
        self.store = store
        self.poll_seconds = max(
            3.0,
            float(os.getenv("TRADING_ORDER_ALERT_POLL_SECONDS", "5") or 5),
        )
        self._next_poll_at = 0.0

    async def poll_if_due(self) -> None:
        now = time.monotonic()
        if now < self._next_poll_at:
            return
        self._next_poll_at = now + self.poll_seconds

        if not self._configured():
            return

        modes = self._configured_modes()
        for mode in modes:
            try:
                await self._poll_mode(mode)
            except Exception as exc:
                self.store.log_event(
                    "trading_push_poll_error",
                    {"mode": mode, "error": str(exc)},
                )
                print(f"[trading-push] poll failed mode={mode} error={exc}", flush=True)

    def _configured(self) -> bool:
        enabled = str(os.getenv("TRADING_ORDER_PUSH_ENABLED", "true")).strip().lower()
        if enabled in {"0", "false", "no", "off"}:
            return False
        return bool(
            os.getenv("PUSHOVER_USER_KEY", "").strip()
            and os.getenv("PUSHOVER_APP_TOKEN", "").strip()
        )

    @staticmethod
    def _configured_modes() -> List[str]:
        raw = os.getenv("TRADING_ORDER_PUSH_MODES", "live,paper")
        out: List[str] = []
        for item in str(raw).split(","):
            mode = item.strip().lower()
            if mode in {"live", "paper"} and mode not in out:
                out.append(mode)
        return out or ["live"]

    async def _poll_mode(self, mode: str) -> None:
        alpaca = AlpacaService(mode=mode)
        orders, positions = await asyncio.gather(
            asyncio.to_thread(alpaca.get_orders, status="all", limit=500, nested=True),
            asyncio.to_thread(alpaca.get_positions),
        )

        state = self.store.get_raw(self.STATE_KEY) or {}
        modes_state = state.setdefault("modes", {})
        mode_state = modes_state.setdefault(mode, {})

        fills = self._filled_orders(self._flatten_orders(orders))
        current_positions = self._position_map(positions)

        if not bool(mode_state.get("initialized")):
            mode_state.update(
                {
                    "initialized": True,
                    "initialized_at": datetime.now(timezone.utc).isoformat(),
                    "seen_fill_qty": {
                        self._order_id(order): self._filled_qty(order)
                        for order in fills
                        if self._order_id(order)
                    },
                    "seen_fill_notional": {
                        self._order_id(order): self._filled_qty(order) * self._filled_price(order)
                        for order in fills
                        if self._order_id(order)
                    },
                    "notified_entry_orders": [],
                    "entry_fill_orders": [],
                    "positions": current_positions,
                    "trades": self._baseline_trade_trackers(current_positions),
                }
            )
            self.store.set_raw(self.STATE_KEY, state)
            print(
                f"[trading-push] baseline mode={mode} fills={len(fills)} positions={len(current_positions)}",
                flush=True,
            )
            return

        seen_fill_qty = {
            str(key): self._number(value)
            for key, value in dict(mode_state.get("seen_fill_qty") or {}).items()
        }
        seen_fill_notional = {
            str(key): self._number(value)
            for key, value in dict(mode_state.get("seen_fill_notional") or {}).items()
        }
        notified_entry_orders = set(mode_state.get("notified_entry_orders") or [])
        entry_fill_orders = set(mode_state.get("entry_fill_orders") or [])
        prior_positions = dict(mode_state.get("positions") or {})
        trades = dict(mode_state.get("trades") or {})
        runner_states = self.store.get_runner_states()
        recent_events = self.store.recent_events(100)

        synthetic_qty: Dict[str, float] = {
            symbol: self._signed_position_qty(payload)
            for symbol, payload in prior_positions.items()
        }

        new_fill_events: List[Tuple[Dict[str, Any], float, float]] = []
        for order in fills:
            order_id = self._order_id(order)
            if not order_id:
                continue
            cumulative = self._filled_qty(order)
            cumulative_notional = cumulative * self._filled_price(order)
            previous = seen_fill_qty.get(order_id, 0.0)
            previous_notional = seen_fill_notional.get(order_id, 0.0)
            if cumulative > previous + 1e-9:
                delta_qty = cumulative - previous
                delta_notional = max(0.0, cumulative_notional - previous_notional)
                delta_price = (
                    delta_notional / delta_qty
                    if delta_qty > 0 and delta_notional > 0
                    else self._filled_price(order)
                )
                new_fill_events.append((order, delta_qty, delta_price))
            seen_fill_qty[order_id] = max(previous, cumulative)
            seen_fill_notional[order_id] = max(previous_notional, cumulative_notional)

        new_fill_events.sort(key=lambda item: self._timestamp(item[0]))

        close_notifications: List[Dict[str, Any]] = []

        for order, delta_qty, delta_price in new_fill_events:
            symbol = str(order.get("symbol") or "").strip().upper()
            side = str(order.get("side") or "").strip().lower()
            price = delta_price
            order_id = self._order_id(order)
            if not symbol or side not in {"buy", "sell"} or delta_qty <= 0 or price <= 0:
                continue

            before = synthetic_qty.get(symbol, 0.0)
            signed_delta = delta_qty if side == "buy" else -delta_qty
            after = before + signed_delta

            same_direction = (
                abs(before) < 1e-9
                or (before > 0 and signed_delta > 0)
                or (before < 0 and signed_delta < 0)
            )

            if same_direction:
                self._apply_entry_fill(
                    trades,
                    symbol,
                    direction="long" if signed_delta > 0 else "short",
                    qty=delta_qty,
                    price=price,
                    filled_at=self._filled_at(order),
                )
                entry_fill_orders.add(order_id)
            else:
                matched_qty = min(abs(before), delta_qty)
                if matched_qty > 0:
                    closed = self._apply_exit_fill(
                        trades,
                        symbol,
                        qty=matched_qty,
                        price=price,
                        filled_at=self._filled_at(order),
                    )
                    if closed:
                        closed["reason"] = self._close_reason(
                            runner_states.get(symbol),
                            recent_events,
                            symbol,
                            closed.get("closed_at"),
                        )
                        closed["mode"] = mode
                        close_notifications.append(closed)

                crossing_qty = max(0.0, delta_qty - matched_qty)
                if crossing_qty > 1e-9:
                    self._apply_entry_fill(
                        trades,
                        symbol,
                        direction="long" if signed_delta > 0 else "short",
                        qty=crossing_qty,
                        price=price,
                        filled_at=self._filled_at(order),
                    )
                    entry_fill_orders.add(order_id)

            synthetic_qty[symbol] = after

        # Entry alert is intentionally sent once when an entry order reaches a
        # complete broker fill. Partial fills are tracked without push spam.
        for order in fills:
            order_id = self._order_id(order)
            if (
                order_id
                and order_id in entry_fill_orders
                and order_id not in notified_entry_orders
                and str(order.get("status") or "").strip().lower() == "filled"
            ):
                symbol = str(order.get("symbol") or "").strip().upper()
                runner = runner_states.get(symbol) or {}
                await asyncio.to_thread(
                    self._send_entry_alert,
                    mode,
                    order,
                    runner,
                )
                notified_entry_orders.add(order_id)

        for closed in close_notifications:
            await asyncio.to_thread(self._send_close_alert, closed)

        # Trust the broker position snapshot for the next cycle. If a fill and
        # position update arrive a few seconds apart this automatically repairs
        # the synthetic quantity on the following poll.
        mode_state["seen_fill_qty"] = dict(list(seen_fill_qty.items())[-750:])
        mode_state["seen_fill_notional"] = dict(list(seen_fill_notional.items())[-750:])
        mode_state["notified_entry_orders"] = list(notified_entry_orders)[-750:]
        mode_state["entry_fill_orders"] = list(entry_fill_orders)[-750:]
        mode_state["positions"] = current_positions
        mode_state["trades"] = trades
        mode_state["last_poll_at"] = datetime.now(timezone.utc).isoformat()
        self.store.set_raw(self.STATE_KEY, state)


    async def notify_protected_entry_invalidation(
        self,
        *,
        symbol: str,
        reason: str,
        entry: float,
        stop: float,
        target: float,
        mode: str,
    ) -> None:
        if not self._configured():
            return
        reason_label = (
            "Target reached before fill"
            if reason == "target_reached_before_entry_fill"
            else "Stop reached before fill"
        )
        try:
            await asyncio.to_thread(
                self._send_pushover,
                f"PROTECTED ENTRY CANCELED · {symbol}",
                "\n".join(
                    [
                        reason_label,
                        f"Entry {self._price_text(entry)} | Target {self._price_text(target)} | Stop {self._price_text(stop)}",
                        f"Mode: {mode.upper()}",
                    ]
                ),
                1,
            )
            self.store.log_event(
                "trading_push_entry_invalidated",
                {"symbol": symbol, "reason": reason, "mode": mode},
                symbol,
            )
        except Exception as exc:
            self.store.log_event(
                "trading_push_send_error",
                {"symbol": symbol, "event": "entry_invalidated", "error": str(exc)},
                symbol,
            )

    async def notify_protected_exit_trigger(
        self,
        *,
        symbol: str,
        reason: str,
        trigger_price: float,
        entry: float,
        stop: float,
        target: float,
        qty: float,
        mode: str,
    ) -> None:
        if not self._configured():
            return
        reason_label = "TARGET HIT" if reason == "target_hit" else "STOP HIT"
        try:
            await asyncio.to_thread(
                self._send_pushover,
                f"{reason_label} · {symbol} · FLATTENING",
                "\n".join(
                    [
                        f"{self._qty_text(qty)} shares are being flattened.",
                        f"Trigger {self._price_text(trigger_price)} | Entry {self._price_text(entry)}",
                        f"Target {self._price_text(target)} | Stop {self._price_text(stop)} | Mode: {mode.upper()}",
                    ]
                ),
                1,
            )
            self.store.log_event(
                "trading_push_exit_trigger",
                {"symbol": symbol, "reason": reason, "trigger_price": trigger_price, "mode": mode},
                symbol,
            )
        except Exception as exc:
            self.store.log_event(
                "trading_push_send_error",
                {"symbol": symbol, "event": "exit_trigger", "error": str(exc)},
                symbol,
            )

    def _send_entry_alert(
        self,
        mode: str,
        order: Dict[str, Any],
        runner: Dict[str, Any],
    ) -> None:
        symbol = str(order.get("symbol") or "").strip().upper()
        qty = self._filled_qty(order)
        fill = self._filled_price(order)
        target = self._number(runner.get("target_price"))
        stop = self._number(runner.get("stop_price"))

        lines = [
            f"{self._qty_text(qty)} shares @ {self._price_text(fill)}",
            f"Mode: {mode.upper()}",
        ]
        if target > 0 or stop > 0:
            levels: List[str] = []
            if target > 0:
                levels.append(f"Target {self._price_text(target)}")
            if stop > 0:
                levels.append(f"Stop {self._price_text(stop)}")
            lines.append(" | ".join(levels))

        self._send_pushover(
            f"ORDER FILLED · {symbol}",
            "\n".join(lines),
            priority=1,
        )
        self.store.log_event(
            "trading_push_entry_filled",
            {"mode": mode, "symbol": symbol, "qty": qty, "fill_price": fill},
            symbol,
        )

    def _send_close_alert(self, closed: Dict[str, Any]) -> None:
        symbol = str(closed.get("symbol") or "").upper()
        pnl = self._number_signed(closed.get("realized_pnl"))
        pnl_pct = self._number_signed(closed.get("pnl_pct"))
        entry = self._number(closed.get("entry_avg"))
        exit_price = self._number(closed.get("exit_avg"))
        qty = self._number(closed.get("closed_qty"))
        reason = str(closed.get("reason") or "Broker Exit")
        mode = str(closed.get("mode") or "").upper()

        sign = "+" if pnl > 0 else ""
        pct_sign = "+" if pnl_pct > 0 else ""
        result_word = "WIN" if pnl > 0 else "LOSS" if pnl < 0 else "FLAT"

        self._send_pushover(
            f"TRADE CLOSED · {symbol} · {result_word}",
            "\n".join(
                [
                    f"P/L: {sign}${pnl:.2f} ({pct_sign}{pnl_pct:.2f}%)",
                    f"{self._qty_text(qty)} shares | Entry {self._price_text(entry)} | Exit {self._price_text(exit_price)}",
                    f"Reason: {reason} | Mode: {mode}",
                ]
            ),
            priority=1,
        )
        self.store.log_event(
            "trading_push_trade_closed",
            closed,
            symbol,
        )

    @staticmethod
    def _close_reason(
        runner: Any,
        recent_events: Iterable[Dict[str, Any]],
        symbol: str,
        closed_at: Any = None,
    ) -> str:
        state = runner if isinstance(runner, dict) else {}
        raw = str(
            state.get("exit_reason")
            or state.get("force_exit_reason")
            or ""
        ).strip().lower()

        # The protection loop can confirm the position flat and clear the
        # runner state before the slower notification poll runs. Recover the
        # most recent exit reason from the durable AutoTrade event history.
        if not raw:
            close_ts = 0.0
            try:
                close_text = str(closed_at or "").strip()
                parsed_close = datetime.fromisoformat(close_text.replace("Z", "+00:00"))
                if parsed_close.tzinfo is None:
                    parsed_close = parsed_close.replace(tzinfo=timezone.utc)
                close_ts = parsed_close.timestamp()
            except Exception:
                close_ts = 0.0

            for event in recent_events:
                if str(event.get("symbol") or "").strip().upper() != symbol:
                    continue
                event_ts = TradingOrderAlertService._number_signed(event.get("ts"))
                if close_ts > 0 and event_ts > 0 and abs(close_ts - event_ts) > 15 * 60:
                    continue
                if str(event.get("event") or "") not in {
                    "synthetic_exit_filled",
                    "synthetic_exit_submitted",
                    "synthetic_exit_trigger_latched",
                }:
                    continue
                payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
                event_state = payload.get("state") if isinstance(payload.get("state"), dict) else {}
                raw = str(
                    payload.get("reason")
                    or event_state.get("exit_reason")
                    or event_state.get("force_exit_reason")
                    or ""
                ).strip().lower()
                if raw:
                    break

        if raw in {"target_hit", "target", "target_reached_before_entry_fill"}:
            return "Target Hit"
        if raw in {"stop_loss", "stop", "stop_reached_before_entry_fill"}:
            return "Stop Hit"
        if raw in {"manual_close", "manual_flatten", "close_all"}:
            return "Manual Flatten"
        if raw == "manual_scale_out":
            return "Scale Out / Final Exit"
        return "Broker Exit"

    @staticmethod
    def _baseline_trade_trackers(positions: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for symbol, position in positions.items():
            signed_qty = TradingOrderAlertService._signed_position_qty(position)
            qty = abs(signed_qty)
            entry = TradingOrderAlertService._number(position.get("avg_entry_price"))
            if qty <= 0 or entry <= 0:
                continue
            out[symbol] = {
                "direction": "long" if signed_qty > 0 else "short",
                "entry_avg": entry,
                "entry_notional": entry * qty,
                "total_entry_qty": qty,
                "open_qty": qty,
                "exit_qty": 0.0,
                "exit_notional": 0.0,
                "realized_pnl": 0.0,
                "started_at": datetime.now(timezone.utc).isoformat(),
            }
        return out

    @staticmethod
    def _apply_entry_fill(
        trades: Dict[str, Dict[str, Any]],
        symbol: str,
        *,
        direction: str,
        qty: float,
        price: float,
        filled_at: str,
    ) -> None:
        tracker = trades.get(symbol)
        if not isinstance(tracker, dict) or tracker.get("direction") != direction or TradingOrderAlertService._number(tracker.get("open_qty")) <= 0:
            tracker = {
                "direction": direction,
                "entry_avg": price,
                "entry_notional": 0.0,
                "total_entry_qty": 0.0,
                "open_qty": 0.0,
                "exit_qty": 0.0,
                "exit_notional": 0.0,
                "realized_pnl": 0.0,
                "started_at": filled_at,
            }

        entry_notional = TradingOrderAlertService._number(tracker.get("entry_notional")) + price * qty
        total_entry_qty = TradingOrderAlertService._number(tracker.get("total_entry_qty")) + qty
        tracker.update(
            {
                "entry_notional": entry_notional,
                "total_entry_qty": total_entry_qty,
                "entry_avg": entry_notional / total_entry_qty if total_entry_qty > 0 else price,
                "open_qty": TradingOrderAlertService._number(tracker.get("open_qty")) + qty,
            }
        )
        trades[symbol] = tracker

    @staticmethod
    def _apply_exit_fill(
        trades: Dict[str, Dict[str, Any]],
        symbol: str,
        *,
        qty: float,
        price: float,
        filled_at: str,
    ) -> Optional[Dict[str, Any]]:
        tracker = trades.get(symbol)
        if not isinstance(tracker, dict):
            return None

        open_qty = TradingOrderAlertService._number(tracker.get("open_qty"))
        matched = min(open_qty, qty)
        if matched <= 0:
            return None

        direction = str(tracker.get("direction") or "long")
        entry_avg = TradingOrderAlertService._number(tracker.get("entry_avg"))
        per_share = price - entry_avg if direction == "long" else entry_avg - price
        realized = TradingOrderAlertService._number_signed(tracker.get("realized_pnl")) + per_share * matched
        exit_qty = TradingOrderAlertService._number(tracker.get("exit_qty")) + matched
        exit_notional = TradingOrderAlertService._number(tracker.get("exit_notional")) + price * matched
        next_open = max(0.0, open_qty - matched)

        tracker.update(
            {
                "open_qty": next_open,
                "exit_qty": exit_qty,
                "exit_notional": exit_notional,
                "realized_pnl": realized,
                "last_exit_at": filled_at,
            }
        )
        trades[symbol] = tracker

        if next_open > 1e-9:
            return None

        entry_notional = TradingOrderAlertService._number(tracker.get("entry_notional"))
        pnl_pct = (realized / entry_notional) * 100.0 if entry_notional > 0 else 0.0
        closed = {
            "symbol": symbol,
            "direction": direction,
            "closed_qty": exit_qty,
            "entry_avg": entry_avg,
            "exit_avg": exit_notional / exit_qty if exit_qty > 0 else price,
            "realized_pnl": realized,
            "pnl_pct": pnl_pct,
            "started_at": tracker.get("started_at"),
            "closed_at": filled_at,
        }
        trades.pop(symbol, None)
        return closed

    @staticmethod
    def _flatten_orders(orders: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        seen: set[str] = set()

        def visit(order: Any) -> None:
            if not isinstance(order, dict):
                return
            order_id = TradingOrderAlertService._order_id(order)
            if not order_id or order_id not in seen:
                if order_id:
                    seen.add(order_id)
                out.append(order)
            for leg in order.get("legs") or []:
                visit(leg)

        for order in orders or []:
            visit(order)
        return out

    @staticmethod
    def _filled_orders(orders: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            order
            for order in orders
            if TradingOrderAlertService._filled_qty(order) > 0
            and TradingOrderAlertService._filled_price(order) > 0
        ]

    @staticmethod
    def _position_map(positions: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for position in positions or []:
            symbol = str(position.get("symbol") or "").strip().upper()
            if not symbol:
                continue
            out[symbol] = {
                "qty": TradingOrderAlertService._number_signed(position.get("qty")),
                "side": str(position.get("side") or ""),
                "avg_entry_price": TradingOrderAlertService._number(position.get("avg_entry_price")),
            }
        return out

    @staticmethod
    def _signed_position_qty(position: Any) -> float:
        payload = position if isinstance(position, dict) else {}
        qty = TradingOrderAlertService._number_signed(payload.get("qty"))
        side = str(payload.get("side") or "").strip().lower()
        if side == "short" and qty > 0:
            return -qty
        return qty

    @staticmethod
    def _order_id(order: Dict[str, Any]) -> str:
        return str(order.get("id") or order.get("order_id") or "").strip()

    @staticmethod
    def _filled_qty(order: Dict[str, Any]) -> float:
        return TradingOrderAlertService._number(order.get("filled_qty"))

    @staticmethod
    def _filled_price(order: Dict[str, Any]) -> float:
        return TradingOrderAlertService._number(
            order.get("filled_avg_price")
            or order.get("average_fill_price")
            or order.get("limit_price")
        )

    @staticmethod
    def _filled_at(order: Dict[str, Any]) -> str:
        return str(
            order.get("filled_at")
            or order.get("updated_at")
            or order.get("submitted_at")
            or datetime.now(timezone.utc).isoformat()
        )

    @staticmethod
    def _timestamp(order: Dict[str, Any]) -> float:
        raw = TradingOrderAlertService._filled_at(order)
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except Exception:
            return 0.0

    @staticmethod
    def _number(value: Any) -> float:
        try:
            number = float(value)
            return number if number > 0 else 0.0
        except Exception:
            return 0.0

    @staticmethod
    def _number_signed(value: Any) -> float:
        try:
            number = float(value)
            return number if number == number else 0.0
        except Exception:
            return 0.0

    @staticmethod
    def _qty_text(value: float) -> str:
        rounded = round(value)
        return str(int(rounded)) if abs(value - rounded) < 1e-9 else f"{value:.4f}".rstrip("0").rstrip(".")

    @staticmethod
    def _price_text(value: float) -> str:
        return f"${value:.4f}" if 0 < value < 1 else f"${value:.2f}"

    @staticmethod
    def _send_pushover(title: str, message: str, priority: int = 1) -> None:
        response = requests.post(
            "https://api.pushover.net/1/messages.json",
            data={
                "token": os.getenv("PUSHOVER_APP_TOKEN", "").strip(),
                "user": os.getenv("PUSHOVER_USER_KEY", "").strip(),
                "title": title,
                "message": message,
                "priority": priority,
            },
            timeout=10,
        )
        response.raise_for_status()
