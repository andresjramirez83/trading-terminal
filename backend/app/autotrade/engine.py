from __future__ import annotations

import asyncio
import traceback
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.autotrade.execution import ExecutionEngine
from app.autotrade.models import AutoTradeConfig, TradeSignal
from app.autotrade.risk import RiskManager
from app.autotrade.state import AutoTradeStore
from app.autotrade.symbols import resolve_symbols
from app.services.alpaca_service import AlpacaService
from app.services.market_data_provider import MarketDataProvider, get_market_data_provider
from app.strategies.registry import StrategyRegistry


class AutoTradeEngine:
    """Dedicated single-owner trading engine.

    FastAPI only queues plans/config. This worker submits entries and manages
    synthetic stop/target exits.
    """

    def __init__(self, store: Optional[AutoTradeStore] = None) -> None:
        self.store = store or AutoTradeStore()
        self.strategy_registry = StrategyRegistry()
        self.stop_requested = False

    @staticmethod
    def _alpaca_price(price: Any) -> float:
        try:
            value = float(price)
        except Exception:
            return 0.0
        if value <= 0:
            return 0.0
        return round(value, 2) if value >= 1 else round(value, 4)

    async def run_forever(self) -> None:
        self.store.set_worker_status({"running": True, "status": "started", "last_error": None})
        print("[auto-trade-worker] started", flush=True)
        try:
            while not self.stop_requested:
                cfg = self.store.get_config()
                try:
                    await self.manage_active_synthetic_trades(cfg)
                    if not cfg.enabled:
                        self.store.set_worker_status({"running": True, "status": "disabled", "last_error": None})
                        await asyncio.sleep(1)
                        continue
                    await self.run_cycle(cfg)
                except Exception as exc:
                    self.store.set_worker_status({"running": True, "status": "error", "last_error": str(exc)})
                    self.store.log_event("engine_error", {"error": str(exc), "traceback": traceback.format_exc()})
                    print(f"[auto-trade-worker] error: {exc}", flush=True)
                    traceback.print_exc()
                await asyncio.sleep(max(3, int(cfg.poll_seconds)))
        finally:
            self.store.set_worker_status({"running": False, "status": "stopped"})
            print("[auto-trade-worker] stopped", flush=True)

    async def run_cycle(self, cfg: AutoTradeConfig) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.store.prune_old_fired_signals()
        await self.cleanup_orphaned_exit_orders(cfg)
        await self.manage_pending_entries(cfg)

        manual_done = await self.process_manual_trade_plans(cfg)
        if manual_done:
            return

        symbols = resolve_symbols(cfg)
        if not symbols:
            self.store.set_worker_status({
                "running": True,
                "status": "idle",
                "last_check": now,
                "last_skip": {"reason": "no symbols selected", "source": cfg.source},
                "last_error": None,
            })
            return

        signals = await self.collect_signals(cfg, symbols)
        if not signals:
            self.store.set_worker_status({
                "running": True,
                "status": "watching",
                "last_check": now,
                "last_skip": {"reason": "no fresh tradable signals", "symbols": symbols},
                "last_error": None,
            })
            return

        best = self.rank_signals(signals)[0]
        await self.submit_signal(cfg, best, now)

    async def process_manual_trade_plans(self, cfg: AutoTradeConfig) -> bool:
        plans = self.store.list_manual_trade_plans()
        if not plans:
            return False

        now = datetime.now(timezone.utc).isoformat()
        item = plans[0]
        payload = dict(item.get("payload") or {})
        plan_id = str(item.get("plan_id") or payload.get("signal_id") or "")

        requested_qty = int(payload.get("qty") or payload.get("fixed_shares") or 0)
        requested_dollars = float(payload.get("trade_amount") or 0)
        sizing_mode = "shares" if requested_qty > 0 else str(payload.get("sizing_mode") or cfg.sizing_mode)

        manual_cfg = cfg.copy(update={
            "mode": payload.get("mode", cfg.mode),
            "sizing_mode": sizing_mode,
            "trade_amount": requested_dollars if requested_dollars > 0 else float(cfg.trade_amount),
            "fixed_shares": requested_qty if requested_qty > 0 else int(payload.get("fixed_shares") or cfg.fixed_shares),
            "extended_hours": True,
            "runner_mode": "off",
            "min_profit_range": 0.0,
        })

        signal = TradeSignal(
            strategy_id=str(payload.get("strategy_id") or "overnight_protected_order"),
            symbol=str(payload.get("symbol") or "").upper(),
            side="buy",
            setup=str(payload.get("setup") or "overnight_protected_limit_entry_stop_target"),
            signal_id=plan_id,
            timeframe=str(payload.get("timeframe") or "manual"),
            signal_time=str(payload.get("signal_time") or now),
            entry_price=float(payload.get("entry_price")),
            target_price=float(payload.get("target_price")),
            stop_price=float(payload.get("stop_price")),
            score=float(payload.get("score") or 100.0),
            profit_range=max(0.0, float(payload.get("target_price")) - float(payload.get("entry_price"))),
            metadata={"manual_plan": payload},
        )

        try:
            await self.submit_signal(manual_cfg, signal, now)
            self.store.delete_manual_trade_plan(plan_id)
            return True
        except Exception as exc:
            self.store.set_worker_status({
                "running": True,
                "status": "manual_plan_error",
                "last_check": now,
                "last_error": str(exc),
                "last_skip": {"reason": "manual plan failed", "plan": payload},
            })
            self.store.log_event("manual_plan_error", {"error": str(exc), "traceback": traceback.format_exc(), "plan": payload}, signal.symbol, signal.strategy_id)
            raise

    async def submit_signal(self, cfg: AutoTradeConfig, signal: TradeSignal, now: str) -> None:
        if self.store.signal_was_fired(signal.signal_id):
            self.store.set_worker_status({
                "running": True,
                "status": "watching",
                "last_check": now,
                "last_skip": {"reason": "signal already handled", "signal": signal.dict()},
                "last_signal": signal.dict(),
                "last_error": None,
            })
            return

        approved, reason, qty = await asyncio.to_thread(self.risk_check, cfg, signal)
        if not approved:
            self.store.set_worker_status({
                "running": True,
                "status": "blocked",
                "last_check": now,
                "last_skip": {"reason": reason, "signal": signal.dict()},
                "last_signal": signal.dict(),
                "last_error": None,
            })
            self.store.log_event("skip", {"reason": reason, "signal": signal.dict()}, signal.symbol, signal.strategy_id)
            return

        order = await asyncio.to_thread(self.execute, cfg, signal, qty)
        order_id = str((order or {}).get("id") or "")
        if order_id:
            pending_payload = {
                "order_id": order_id,
                "symbol": signal.symbol,
                "strategy_id": signal.strategy_id,
                "signal_id": signal.signal_id,
                "entry_price": self._alpaca_price(signal.entry_price),
                "target_price": self._alpaca_price(signal.target_price),
                "stop_price": self._alpaca_price(signal.stop_price),
                "qty": qty,
                "submitted_at": datetime.now(timezone.utc).isoformat(),
                "extended_hours": bool(cfg.extended_hours),
                "mode": cfg.mode,
                "reason": "synthetic_entry_waiting_for_fill",
            }
            self.store.upsert_pending_entry(order_id, pending_payload)
            self.store.upsert_runner_state(signal.symbol, {
                "phase": "entry_submitted",
                **pending_payload,
            })
        self.store.mark_signal_fired(signal.signal_id, signal.symbol, signal.strategy_id)
        self.store.set_worker_status({
            "running": True,
            "status": "ordered",
            "last_check": now,
            "last_signal": signal.dict(),
            "last_order": order,
            "last_skip": None,
            "last_error": None,
        })
        self.store.log_event("ordered", {"qty": qty, "order": order, "signal": signal.dict()}, signal.symbol, signal.strategy_id)

    async def manage_active_synthetic_trades(self, cfg: AutoTradeConfig) -> None:
        states = self.store.get_runner_states()
        if not states:
            return

        market = get_market_data_provider()
        account_cache: Dict[str, Dict[str, Any]] = {}

        def account_snapshot(mode: str) -> Dict[str, Any]:
            normalized_mode = "live" if str(mode).lower() == "live" else "paper"
            cached = account_cache.get(normalized_mode)
            if cached is not None:
                return cached

            alpaca = AlpacaService(mode=normalized_mode)
            positions_ok = True
            try:
                positions = alpaca.get_positions()
            except Exception as exc:
                positions_ok = False
                self.store.log_event(
                    "synthetic_position_check_error",
                    {"error": str(exc), "mode": normalized_mode},
                )
                positions = []

            open_orders_ok = True
            try:
                open_orders = alpaca.get_orders(status="open", limit=500, nested=True)
            except Exception as exc:
                open_orders_ok = False
                self.store.log_event(
                    "synthetic_open_order_check_error",
                    {"error": str(exc), "mode": normalized_mode},
                )
                open_orders = []

            cached = {
                "mode": normalized_mode,
                "alpaca": alpaca,
                "positions": positions,
                "positions_ok": positions_ok,
                "open_orders": open_orders,
                "open_orders_ok": open_orders_ok,
            }
            account_cache[normalized_mode] = cached
            return cached

        for symbol, state in list(states.items()):
            phase = str(state.get("phase") or "")
            strategy_id = str(state.get("strategy_id") or "")
            if strategy_id not in {
                "overnight_protected_order",
                "overnite_hail_mary",
                "six_seven_sweep",
                "five_am_sweep",
            }:
                continue

            trade_mode = str(state.get("mode") or cfg.mode)
            snapshot = account_snapshot(trade_mode)
            alpaca: AlpacaService = snapshot["alpaca"]
            positions: List[Dict[str, Any]] = snapshot["positions"]
            positions_ok = bool(snapshot.get("positions_ok"))
            open_orders: List[Dict[str, Any]] = snapshot["open_orders"]
            open_orders_ok = bool(snapshot.get("open_orders_ok"))

            if phase == "entry_submitted":
                await self._promote_filled_entry_to_active(alpaca, symbol, state)
                continue

            if phase == "exit_submitted":
                if not positions_ok:
                    continue
                await self._reconcile_submitted_exit(
                    alpaca=alpaca,
                    symbol=symbol,
                    state=state,
                    positions=positions,
                )
                continue

            if phase != "active_synthetic":
                continue
            if not positions_ok or not open_orders_ok:
                # Never clear protection or submit a duplicate exit when account
                # reconciliation is unavailable.
                continue

            qty = int(float(state.get("filled_qty") or state.get("qty") or 0))
            stop = self._alpaca_price(state.get("stop_price"))
            target = self._alpaca_price(state.get("target_price"))
            if qty <= 0 or stop <= 0 or target <= 0:
                continue

            live_qty = int(self._position_qty_for(positions, symbol))
            if live_qty <= 0:
                self.store.delete_runner_state(symbol)
                self.store.log_event(
                    "synthetic_state_cleared_no_position",
                    {"reason": "no live position to exit", "state": state, "mode": trade_mode},
                    symbol,
                    strategy_id,
                )
                continue

            existing_exit = self._find_open_closing_order(open_orders, symbol)
            if existing_exit is not None:
                repaired_state = dict(state)
                repaired_state.update({
                    "phase": "exit_submitted",
                    "exit_order_id": str(existing_exit.get("id") or ""),
                    "exit_reason": str(state.get("exit_reason") or "existing_closing_order"),
                    "exit_qty": int(max(0, self._safe_float(existing_exit.get("qty")))),
                    "exit_submitted_at": str(existing_exit.get("submitted_at") or datetime.now(timezone.utc).isoformat()),
                    "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
                })
                self.store.upsert_runner_state(symbol, repaired_state)
                continue

            reserved_exit_qty = int(self._open_closing_qty_for(open_orders, symbol))
            if reserved_exit_qty > 0:
                self.store.log_event(
                    "synthetic_exit_waiting_existing_order",
                    {"reserved_exit_qty": reserved_exit_qty, "state": state},
                    symbol,
                    strategy_id,
                )
                continue

            market_snapshot = await self._synthetic_market_snapshot(symbol, market)
            trigger_price = self._safe_float(market_snapshot.get("trigger_price"))
            if trigger_price <= 0:
                continue

            forced_reason = str(state.get("force_exit_reason") or "")
            reason = forced_reason if forced_reason in {"stop_loss", "target_hit"} else None
            if reason is None:
                if trigger_price <= stop:
                    reason = "stop_loss"
                elif trigger_price >= target:
                    reason = "target_hit"
            if reason is None:
                continue

            exit_qty = min(qty, live_qty)
            if exit_qty <= 0:
                continue

            use_extended = bool(state.get("extended_hours", True))
            is_protected_overnight = strategy_id in {"overnight_protected_order", "overnite_hail_mary"}
            order_type = "limit" if use_extended else "market"
            limit_price = None
            if order_type == "limit":
                bid_price = self._safe_float(market_snapshot.get("bid_price"))
                if reason == "target_hit" and not forced_reason:
                    limit_price = target
                else:
                    # A retry is already committed to exiting. Reprice from the
                    # executable bid so a stale target/stop limit cannot remain
                    # stranded after the market moves away.
                    reference_price = bid_price or trigger_price
                    limit_price = self._alpaca_price(max(0.0001, reference_price * 0.995))

            try:
                order = alpaca.place_order(
                    symbol=symbol,
                    side="sell",
                    order_type=order_type,
                    time_in_force="gtc" if is_protected_overnight else "day",
                    qty=exit_qty,
                    limit_price=limit_price,
                    extended_hours=use_extended,
                    position_intent="sell_to_close",
                    client_order_id=f"autotrade_exit_{reason}_{symbol}_{int(time.time())}",
                )
                exit_order_id = str((order or {}).get("id") or "")
                next_state = dict(state)
                next_state.update({
                    "phase": "exit_submitted",
                    "exit_order_id": exit_order_id,
                    "exit_reason": reason,
                    "exit_qty": exit_qty,
                    "exit_limit_price": limit_price,
                    "exit_submitted_at": datetime.now(timezone.utc).isoformat(),
                    "last_market_snapshot": market_snapshot,
                    "last_exit_error": None,
                    "force_exit_reason": reason,
                    "exit_attempt_count": int(state.get("exit_attempt_count") or 0) + 1,
                })
                self.store.upsert_runner_state(symbol, next_state)
                self.store.log_event(
                    "synthetic_exit_submitted",
                    {
                        "reason": reason,
                        "trigger_price": trigger_price,
                        "live_qty": live_qty,
                        "exit_qty": exit_qty,
                        "state": next_state,
                        "order": order,
                        "market": market_snapshot,
                    },
                    symbol,
                    strategy_id,
                )
            except Exception as exc:
                error_text = str(exc)
                if "not allowed to short" in error_text.lower():
                    try:
                        refreshed_positions = alpaca.get_positions()
                    except Exception:
                        refreshed_positions = positions
                    refreshed_qty = int(self._position_qty_for(refreshed_positions, symbol))
                    if refreshed_qty <= 0:
                        self.store.delete_runner_state(symbol)
                        self.store.log_event(
                            "synthetic_state_cleared_after_short_reject",
                            {"state": state, "error": error_text, "mode": trade_mode},
                            symbol,
                            strategy_id,
                        )
                        continue
                    repaired_state = dict(state)
                    repaired_state.update({
                        "qty": refreshed_qty,
                        "filled_qty": refreshed_qty,
                        "last_exit_error": error_text,
                        "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
                    })
                    self.store.upsert_runner_state(symbol, repaired_state)
                    continue

                failed_state = dict(state)
                failed_state.update({
                    "last_exit_error": error_text,
                    "last_exit_attempt_at": datetime.now(timezone.utc).isoformat(),
                    "last_market_snapshot": market_snapshot,
                })
                self.store.upsert_runner_state(symbol, failed_state)
                self.store.log_event(
                    "synthetic_exit_error",
                    {"reason": reason, "state": failed_state, "error": error_text},
                    symbol,
                    strategy_id,
                )

    async def _synthetic_market_snapshot(
        self,
        symbol: str,
        market: MarketDataProvider,
    ) -> Dict[str, Any]:
        quote: Dict[str, Any] = {}
        bid_price = 0.0
        ask_price = 0.0
        last_price = 0.0

        try:
            quote = await market.get_latest_quote(symbol) or {}
            bid_price = self._safe_float(quote.get("bid_price", quote.get("bp")))
            ask_price = self._safe_float(quote.get("ask_price", quote.get("ap")))
        except Exception:
            quote = {}

        try:
            last_price = self._safe_float(await market.get_last_trade(symbol))
        except Exception:
            last_price = 0.0

        # For a long position, the bid is the executable side of the market.
        trigger_price = bid_price or last_price
        return {
            "symbol": symbol,
            "bid_price": bid_price,
            "ask_price": ask_price,
            "last_price": last_price,
            "trigger_price": trigger_price,
            "quote_time": quote.get("time", quote.get("t")),
        }

    async def _reconcile_submitted_exit(
        self,
        *,
        alpaca: AlpacaService,
        symbol: str,
        state: Dict[str, Any],
        positions: List[Dict[str, Any]],
    ) -> None:
        strategy_id = str(state.get("strategy_id") or "")
        order_id = str(state.get("exit_order_id") or "")
        live_qty = int(self._position_qty_for(positions, symbol))

        if live_qty <= 0:
            self.store.delete_runner_state(symbol)
            self.store.log_event(
                "synthetic_exit_filled",
                {"reason": state.get("exit_reason"), "state": state, "position_qty": 0},
                symbol,
                strategy_id,
            )
            return

        if not order_id:
            retry_state = dict(state)
            retry_state.update({
                "phase": "active_synthetic",
                "force_exit_reason": str(state.get("exit_reason") or state.get("force_exit_reason") or ""),
                "last_exit_error": "exit order id missing; protection re-armed",
                "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
            })
            self.store.upsert_runner_state(symbol, retry_state)
            return

        try:
            order = alpaca.get_order(order_id, nested=True)
        except RuntimeError as exc:
            message = str(exc).lower()
            if "order not found" not in message and "40410000" not in message:
                raise
            retry_state = dict(state)
            retry_state.update({
                "phase": "active_synthetic",
                "filled_qty": live_qty,
                "qty": live_qty,
                "force_exit_reason": str(state.get("exit_reason") or state.get("force_exit_reason") or ""),
                "last_exit_error": str(exc),
                "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
            })
            retry_state.pop("exit_order_id", None)
            self.store.upsert_runner_state(symbol, retry_state)
            self.store.log_event(
                "synthetic_exit_missing_rearmed",
                {"state": retry_state, "error": str(exc)},
                symbol,
                strategy_id,
            )
            return

        status = str(order.get("status") or "").lower()
        if status == "filled":
            self.store.delete_runner_state(symbol)
            self.store.log_event(
                "synthetic_exit_filled",
                {"reason": state.get("exit_reason"), "state": state, "order": order},
                symbol,
                strategy_id,
            )
            return

        if status in {"canceled", "cancelled", "expired", "rejected"}:
            retry_state = dict(state)
            retry_state.update({
                "phase": "active_synthetic",
                "filled_qty": live_qty,
                "qty": live_qty,
                "force_exit_reason": str(state.get("exit_reason") or state.get("force_exit_reason") or ""),
                "last_exit_error": f"exit order {status}; protection re-armed",
                "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
            })
            retry_state.pop("exit_order_id", None)
            self.store.upsert_runner_state(symbol, retry_state)
            self.store.log_event(
                "synthetic_exit_rearmed",
                {"order_status": status, "state": retry_state, "order": order},
                symbol,
                strategy_id,
            )
            return

        exit_age_seconds = self._seconds_since_iso(state.get("exit_submitted_at"))
        if exit_age_seconds >= 15 and status in {
            "new",
            "accepted",
            "pending_new",
            "partially_filled",
            "held",
        }:
            try:
                alpaca.cancel_order(order_id)
                retry_state = dict(state)
                retry_state.update({
                    "phase": "active_synthetic",
                    "filled_qty": live_qty,
                    "qty": live_qty,
                    "force_exit_reason": str(state.get("exit_reason") or state.get("force_exit_reason") or ""),
                    "last_exit_error": "unfilled exit canceled for a more marketable retry",
                    "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
                })
                retry_state.pop("exit_order_id", None)
                self.store.upsert_runner_state(symbol, retry_state)
                self.store.log_event(
                    "synthetic_exit_retry_requested",
                    {"order": order, "state": retry_state, "exit_age_seconds": exit_age_seconds},
                    symbol,
                    strategy_id,
                )
                return
            except Exception as exc:
                waiting_state = dict(state)
                waiting_state.update({
                    "last_exit_error": f"exit retry cancel failed: {exc}",
                    "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
                })
                self.store.upsert_runner_state(symbol, waiting_state)
                return

        waiting_state = dict(state)
        waiting_state.update({
            "phase": "exit_submitted",
            "remaining_qty": live_qty,
            "exit_order_status": status,
            "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
        })
        self.store.upsert_runner_state(symbol, waiting_state)

    @staticmethod
    def _seconds_since_iso(value: Any) -> float:
        text = str(value or "").strip()
        if not text:
            return 0.0
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return max(0.0, (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds())
        except Exception:
            return 0.0

    def _find_open_closing_order(
        self,
        orders: List[Dict[str, Any]],
        symbol: str,
    ) -> Optional[Dict[str, Any]]:
        symbol_u = str(symbol or "").upper()
        terminal = {"filled", "canceled", "cancelled", "expired", "rejected"}
        for order in orders or []:
            if str(order.get("symbol") or "").upper() != symbol_u:
                continue
            if str(order.get("status") or "").lower() in terminal:
                continue
            if str(order.get("side") or "").lower() != "sell":
                continue
            client_order_id = str(order.get("client_order_id") or "")
            if not client_order_id.startswith("autotrade_exit_"):
                continue
            return order
        return None

    def _position_qty_for(self, positions: List[Dict[str, Any]], symbol: str) -> float:
        symbol_u = str(symbol or "").upper()
        for pos in positions or []:
            if str(pos.get("symbol") or "").upper() != symbol_u:
                continue
            return abs(self._safe_float(pos.get("qty")))
        return 0.0

    def _open_closing_qty_for(self, orders: List[Dict[str, Any]], symbol: str) -> float:
        symbol_u = str(symbol or "").upper()
        total = 0.0
        terminal = {"filled", "canceled", "cancelled", "expired", "rejected"}
        for order in orders or []:
            if str(order.get("symbol") or "").upper() != symbol_u:
                continue
            if str(order.get("status") or "").lower() in terminal:
                continue
            side = str(order.get("side") or "").lower()
            intent = str(order.get("position_intent") or order.get("positionIntent") or "").lower()
            order_class = str(order.get("order_class") or order.get("orderClass") or "").lower()
            if side != "sell":
                continue
            if "close" not in intent and order_class not in {"bracket", "oco", "oto"}:
                # Plain sell orders still reserve long shares at Alpaca. Count them to avoid overselling.
                pass
            qty = self._safe_float(order.get("qty"))
            filled = self._safe_float(order.get("filled_qty"))
            total += max(0.0, qty - filled)
        return total

    async def _promote_filled_entry_to_active(self, alpaca: AlpacaService, symbol: str, state: Dict[str, Any]) -> None:
        order_id = str(state.get("order_id") or state.get("entry_order_id") or "")
        if not order_id:
            self.store.delete_runner_state(symbol)
            return

        try:
            order = alpaca.get_order(order_id, nested=True)
        except RuntimeError as exc:
            msg = str(exc).lower()
            if "order not found" in msg or "40410000" in msg:
                strategy_id = str(state.get("strategy_id") or "")
                self.store.delete_pending_entry(order_id)
                self.store.delete_runner_state(symbol)
                self.store.log_event(
                    "stale_entry_order_cleared",
                    {
                        "order_id": order_id,
                        "reason": "alpaca_order_not_found",
                        "error": str(exc),
                        "state": state,
                    },
                    symbol,
                    strategy_id,
                )
                return
            raise
        status = str(order.get("status") or "").lower()
        filled_qty = self._safe_float(order.get("filled_qty"))
        if status in {"canceled", "cancelled", "expired", "rejected"}:
            self.store.delete_runner_state(symbol)
            self.store.delete_pending_entry(order_id)
            self.store.log_event("synthetic_entry_closed", {"order_status": status, "state": state}, symbol, str(state.get("strategy_id") or ""))
            return
        if status != "filled" and filled_qty <= 0:
            return

        if status != "filled" and filled_qty > 0:
            try:
                alpaca.cancel_order(order_id)
            except Exception as exc:
                self.store.log_event(
                    "partial_entry_cancel_error",
                    {"order_id": order_id, "state": state, "error": str(exc)},
                    symbol,
                    str(state.get("strategy_id") or ""),
                )

        qty = int(filled_qty or self._safe_float(state.get("qty")))
        if qty <= 0:
            return

        next_state = dict(state)
        next_state.update({
            "phase": "active_synthetic",
            "filled_qty": qty,
            "filled_at": datetime.now(timezone.utc).isoformat(),
        })
        self.store.delete_pending_entry(order_id)
        self.store.upsert_runner_state(symbol, next_state)
        self.store.log_event("synthetic_entry_active", {"order": order, "state": next_state}, symbol, str(state.get("strategy_id") or ""))

    async def cleanup_orphaned_exit_orders(self, cfg: AutoTradeConfig) -> None:
        try:
            alpaca = AlpacaService(mode=cfg.mode)
            positions = alpaca.get_positions()
            open_orders = alpaca.get_orders(status="open", limit=500, nested=True)
        except Exception as exc:
            self.store.log_event("orphan_cleanup_error", {"error": str(exc)})
            return

        positioned_symbols = set()
        for pos in positions or []:
            symbol = str(pos.get("symbol") or "").upper()
            qty = self._safe_float(pos.get("qty"))
            if symbol and abs(qty) > 0:
                positioned_symbols.add(symbol)

        for order in open_orders or []:
            try:
                order_id = str(order.get("id") or "")
                symbol = str(order.get("symbol") or "").upper()
                side = str(order.get("side") or "").lower()
                order_class = str(order.get("order_class") or order.get("orderClass") or "").lower()
                position_intent = str(order.get("position_intent") or order.get("positionIntent") or "").lower()
                legs = order.get("legs")
                status = str(order.get("status") or "").lower()

                if not order_id or not symbol:
                    continue
                if status in {"filled", "canceled", "cancelled", "expired", "rejected"}:
                    continue
                if symbol in positioned_symbols:
                    continue
                if side != "sell":
                    continue
                if not ("close" in position_intent or order_class in {"bracket", "oco", "oto"}):
                    continue
                if isinstance(legs, list) and len(legs) > 0:
                    continue

                alpaca.cancel_order(order_id)
                self.store.delete_pending_entry(order_id)
                self.store.log_event(
                    "orphan_exit_order_cancelled",
                    {"order_id": order_id, "symbol": symbol, "order": order},
                    symbol,
                    str(order.get("client_order_id") or order_class or ""),
                )
            except Exception as exc:
                self.store.log_event(
                    "orphan_exit_cancel_error",
                    {"order": order, "error": str(exc)},
                    str((order or {}).get("symbol") or "").upper(),
                    str((order or {}).get("client_order_id") or ""),
                )

    async def manage_pending_entries(self, cfg: AutoTradeConfig) -> None:
        pending = self.store.list_pending_entries()
        if not pending:
            return

        market = get_market_data_provider()
        alpaca_by_mode: Dict[str, AlpacaService] = {}

        for item in pending:
            order_id = str(item.get("order_id") or "")
            symbol = str(item.get("symbol") or "").upper()
            payload = item.get("payload") or {}
            entry_mode = "live" if str(payload.get("mode") or cfg.mode).lower() == "live" else "paper"
            alpaca = alpaca_by_mode.get(entry_mode)
            if alpaca is None:
                alpaca = AlpacaService(mode=entry_mode)
                alpaca_by_mode[entry_mode] = alpaca
            target = self._alpaca_price(payload.get("target_price"))
            if not order_id or not symbol or target <= 0:
                if order_id:
                    self.store.delete_pending_entry(order_id)
                continue

            try:
                try:
                    order = alpaca.get_order(order_id, nested=True)
                except RuntimeError as exc:
                    msg = str(exc).lower()
                    if "order not found" in msg or "40410000" in msg:
                        self.store.delete_pending_entry(order_id)
                        self.store.delete_runner_state(symbol)
                        self.store.log_event(
                            "stale_pending_entry_cleared",
                            {
                                "order_id": order_id,
                                "symbol": symbol,
                                "reason": "alpaca_order_not_found",
                                "error": str(exc),
                                "pending": payload,
                            },
                            symbol,
                            str(payload.get("strategy_id") or ""),
                        )
                        continue
                    raise
                status = str(order.get("status") or "").lower()
                filled_qty = self._safe_float(order.get("filled_qty"))

                if status in {"filled"} or filled_qty > 0:
                    await self._promote_filled_entry_to_active(alpaca, symbol, payload)
                    continue

                if status in {"canceled", "expired", "rejected"}:
                    self.store.delete_pending_entry(order_id)
                    self.store.delete_runner_state(symbol)
                    self.store.log_event("pending_entry_closed", {"order_status": status, "pending": payload}, symbol, str(payload.get("strategy_id") or ""))
                    continue

                if status not in {"new", "accepted", "pending_new", "partially_filled"}:
                    continue

                target_reached, market_snapshot = await self._target_reached(symbol, target, market)
                if not target_reached:
                    continue

                alpaca.cancel_order(order_id)
                self.store.delete_pending_entry(order_id)
                self.store.delete_runner_state(symbol)
                self.store.log_event(
                    "pending_entry_cancelled_target_reached",
                    {
                        "reason": "target reached before entry fill",
                        "order_id": order_id,
                        "order_status": status,
                        "target_price": target,
                        "market": market_snapshot,
                        "pending": payload,
                    },
                    symbol,
                    str(payload.get("strategy_id") or ""),
                )
            except Exception as exc:
                self.store.log_event(
                    "pending_entry_manage_error",
                    {"order_id": order_id, "symbol": symbol, "error": str(exc), "pending": payload},
                    symbol,
                    str(payload.get("strategy_id") or ""),
                )

    async def _target_reached(self, symbol: str, target: float, market: MarketDataProvider) -> tuple[bool, Dict[str, Any]]:
        target = self._alpaca_price(target)
        last_price = 0.0
        recent_high = 0.0
        try:
            last = await market.get_last_trade(symbol)
            last_price = self._safe_float(last)
        except Exception:
            last_price = 0.0

        try:
            bars = await market.get_bars(symbol, "1m", session="extended")
            recent = (bars or [])[-3:]
            highs = [self._safe_float(b.get("high", b.get("h"))) for b in recent]
            recent_high = max([h for h in highs if h > 0], default=0.0)
        except Exception:
            recent_high = 0.0

        reached = (self._alpaca_price(last_price) >= target) or (self._alpaca_price(recent_high) >= target)
        return reached, {"last_price": last_price, "recent_1m_high": recent_high, "target_price": target}

    @staticmethod
    def _safe_float(value: Any, default: float = 0.0) -> float:
        try:
            if value is None:
                return default
            out = float(value)
            return out if out > 0 else default
        except Exception:
            return default

    async def collect_signals(self, cfg: AutoTradeConfig, symbols: List[str]) -> List[TradeSignal]:
        market = get_market_data_provider()
        enabled_strategies = [s for s in cfg.strategies if s.enabled]
        out: List[TradeSignal] = []

        for symbol in symbols:
            for item in enabled_strategies:
                strategy = self.strategy_registry.get(item.strategy_id)
                if strategy is None:
                    continue
                try:
                    found = await strategy.scan(symbol=symbol, market=market, config=cfg)
                    for signal in found:
                        if signal.score >= item.min_score and signal.profit_range >= cfg.min_profit_range:
                            out.append(signal)
                except Exception as exc:
                    self.store.log_event("strategy_error", {"symbol": symbol, "strategy_id": item.strategy_id, "error": str(exc)}, symbol, item.strategy_id)
        return out

    def rank_signals(self, signals: List[TradeSignal]) -> List[TradeSignal]:
        return sorted(signals, key=lambda s: (float(s.score), float(s.profit_range)), reverse=True)

    def risk_check(self, cfg: AutoTradeConfig, signal: TradeSignal) -> tuple[bool, str, int]:
        alpaca = AlpacaService(mode=cfg.mode)
        account = alpaca.get_account()
        positions = alpaca.get_positions()
        orders = alpaca.get_orders(status="open", limit=100, nested=True)
        return RiskManager(cfg).approve(signal, account=account, positions=positions, orders=orders)

    def execute(self, cfg: AutoTradeConfig, signal: TradeSignal, qty: int) -> Dict[str, Any]:
        return ExecutionEngine(cfg).submit_entry(signal, qty)


__all__ = ["AutoTradeEngine"]
