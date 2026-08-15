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
        next_strategy_cycle_at = 0.0
        protection_poll_seconds = 2.0
        try:
            while not self.stop_requested:
                cfg = self.store.get_config()
                try:
                    # Protection is intentionally checked more frequently than
                    # scanner strategies. This reduces the time an overnight
                    # entry or open position can remain exposed during a fast move.
                    await self.manage_active_synthetic_trades(cfg)
                    await self.manage_pending_entries(cfg)

                    now_monotonic = time.monotonic()
                    if not cfg.enabled:
                        self.store.set_worker_status({
                            "running": True,
                            "status": "disabled",
                            "last_error": None,
                            "protection_poll_seconds": protection_poll_seconds,
                        })
                    elif now_monotonic >= next_strategy_cycle_at:
                        await self.run_cycle(cfg)
                        next_strategy_cycle_at = now_monotonic + max(3, int(cfg.poll_seconds))
                    else:
                        worker = self.store.get_worker_status()
                        worker.update({
                            "running": True,
                            "heartbeat": time.time(),
                            "protection_poll_seconds": protection_poll_seconds,
                        })
                        self.store.set_worker_status(worker)
                except Exception as exc:
                    self.store.set_worker_status({"running": True, "status": "error", "last_error": str(exc)})
                    self.store.log_event("engine_error", {"error": str(exc), "traceback": traceback.format_exc()})
                    print(f"[auto-trade-worker] error: {exc}", flush=True)
                    traceback.print_exc()
                await asyncio.sleep(protection_poll_seconds)
        finally:
            self.store.set_worker_status({"running": False, "status": "stopped"})
            print("[auto-trade-worker] stopped", flush=True)

    async def run_cycle(self, cfg: AutoTradeConfig) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.store.prune_old_fired_signals()
        await self.cleanup_orphaned_exit_orders(cfg)

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

        manual_strategy_id = str(
            payload.get("strategy_id") or "overnight_protected_order"
        )

        is_protected_manual_order = manual_strategy_id in {
            "overnight_protected_order",
            "overnite_hail_mary",
        }

        manual_cfg = cfg.copy(update={
            "mode": payload.get("mode", cfg.mode),
            "sizing_mode": sizing_mode,
            "trade_amount": requested_dollars if requested_dollars > 0 else float(cfg.trade_amount),
            "fixed_shares": requested_qty if requested_qty > 0 else int(payload.get("fixed_shares") or cfg.fixed_shares),
            "extended_hours": True,
            "runner_mode": "off",
            "min_profit_range": 0.0,

            # Manual Overnight Protected Orders may coexist with unrelated
            # Alpaca positions/orders. Other AutoTrade strategies retain the
            # global flat-account protection.
            "require_flat_account": (
                False
                if is_protected_manual_order
                else cfg.require_flat_account
            ),
        })

        signal = TradeSignal(
            strategy_id=manual_strategy_id,
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
            handled = await self.submit_signal(manual_cfg, signal, now)
            # Do not throw away a manual protected order just because the
            # risk gate is temporarily blocking it. Keep it queued so the
            # worker can retry after the blocking condition clears.
            if handled:
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

    async def submit_signal(self, cfg: AutoTradeConfig, signal: TradeSignal, now: str) -> bool:
        if self.store.signal_was_fired(signal.signal_id):
            self.store.set_worker_status({
                "running": True,
                "status": "watching",
                "last_check": now,
                "last_skip": {"reason": "signal already handled", "signal": signal.dict()},
                "last_signal": signal.dict(),
                "last_error": None,
            })
            return True

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
            return False

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
        return True

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

            # Server-side trailing for Overnight Protected Orders. The trail
            # never lowers the existing stop. On first enable, preserve the
            # current stop-to-market distance; after that, raise the synthetic
            # stop only when a new executable bid high-water mark is made.
            if bool(state.get("trail_enabled")):
                entry_price = self._alpaca_price(state.get("entry_price"))
                tick = 0.0001 if trigger_price < 1.0 else 0.01
                trail_initialized = bool(state.get("trail_initialized"))
                trail_distance = self._safe_float(state.get("trail_distance"))
                trail_high_water = self._safe_float(state.get("trail_high_water"))

                if not trail_initialized or trail_distance <= 0:
                    reference_distance = max(
                        trigger_price - stop,
                        entry_price - stop if entry_price > stop else 0.0,
                        tick,
                    )
                    trail_distance = self._alpaca_price(reference_distance)
                    trail_high_water = trigger_price
                    trail_initialized = True
                else:
                    trail_high_water = max(trail_high_water, trigger_price)

                trailed_stop = self._alpaca_price(
                    max(stop, trail_high_water - trail_distance)
                )
                trail_state = dict(state)
                trail_state.update({
                    "trail_initialized": trail_initialized,
                    "trail_distance": trail_distance,
                    "trail_high_water": self._alpaca_price(trail_high_water),
                    "trail_last_quote": trigger_price,
                    "trail_updated_at": datetime.now(timezone.utc).isoformat(),
                    "stop_price": trailed_stop,
                })
                if trailed_stop > stop:
                    self.store.log_event(
                        "protected_trailing_stop_raised",
                        {
                            "old_stop": stop,
                            "new_stop": trailed_stop,
                            "high_water": trail_high_water,
                            "trail_distance": trail_distance,
                        },
                        symbol,
                        strategy_id,
                    )
                state = trail_state
                stop = trailed_stop
                self.store.upsert_runner_state(symbol, trail_state)

            manual_action = str(state.get("manual_exit_action") or "")
            manual_exit_qty = int(self._safe_float(state.get("manual_exit_qty")))
            forced_reason = str(state.get("force_exit_reason") or "")
            valid_forced_reasons = {
                "stop_loss",
                "target_hit",
                "manual_scale_out",
                "manual_close",
            }
            reason = forced_reason if forced_reason in valid_forced_reasons else None

            if reason is None and manual_action == "scale_out" and manual_exit_qty > 0:
                reason = "manual_scale_out"
            elif reason is None and manual_action == "close_all":
                reason = "manual_close"

            if reason is None:
                if trigger_price <= stop:
                    reason = "stop_loss"
                elif trigger_price >= target:
                    reason = "target_hit"
            if reason is None:
                continue

            if reason == "manual_scale_out":
                exit_qty = min(manual_exit_qty, max(0, live_qty - 1))
            else:
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
                    "exit_start_live_qty": live_qty,
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

        quote_time_raw = quote.get("time", quote.get("t"))
        quote_time_ms = self._epoch_ms(quote_time_raw)
        now_ms = int(time.time() * 1000)
        quote_age_seconds = (now_ms - quote_time_ms) / 1000.0 if quote_time_ms > 0 else None
        quote_is_fresh = (
            quote_time_ms > 0
            and quote_age_seconds is not None
            and quote_age_seconds <= 60.0
            and bid_price > 0
        )

        # For a long position, the bid is the executable side of the market.
        # Never fall back to an untimestamped last trade for synthetic exits;
        # a stale SIP print during BOATS hours can otherwise flatten a valid
        # overnight position immediately after it fills.
        trigger_price = bid_price if quote_is_fresh else 0.0
        return {
            "symbol": symbol,
            "bid_price": bid_price,
            "ask_price": ask_price,
            "last_price": last_price,
            "trigger_price": trigger_price,
            "quote_time": quote_time_raw,
            "quote_time_ms": quote_time_ms,
            "quote_age_seconds": quote_age_seconds,
            "quote_is_fresh": quote_is_fresh,
            "feed": quote.get("feed"),
            "market_data_status": "fresh" if quote_is_fresh else "stale_or_unavailable",
        }

    def _rearmed_exit_state(
        self,
        state: Dict[str, Any],
        *,
        live_qty: int,
        order: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return an active synthetic state after an exit completes or retries.

        Manual scale-outs are quantity-aware: if an order partially filled before
        cancellation, only the unfilled portion of the requested scale-out is
        retried. A completed scale-out clears the manual request while leaving
        stop/target protection armed for the remaining shares.
        """
        next_state = dict(state)
        live_qty = max(0, int(live_qty))
        reason = str(state.get("exit_reason") or state.get("force_exit_reason") or "")

        next_state.update({
            "phase": "active_synthetic",
            "qty": live_qty,
            "filled_qty": live_qty,
            "last_reconciled_at": datetime.now(timezone.utc).isoformat(),
        })
        if error is not None:
            next_state["last_exit_error"] = error

        if reason == "manual_scale_out":
            requested = int(self._safe_float(state.get("exit_qty") or state.get("manual_exit_qty")))
            start_qty = int(self._safe_float(state.get("exit_start_live_qty")))
            order_filled = int(self._safe_float((order or {}).get("filled_qty")))
            observed_filled = max(0, start_qty - live_qty) if start_qty > 0 else 0
            filled_against_request = min(requested, max(order_filled, observed_filled))
            remaining_request = max(0, requested - filled_against_request)

            if remaining_request > 0 and live_qty > 1:
                next_state.update({
                    "manual_exit_action": "scale_out",
                    "manual_exit_qty": min(remaining_request, live_qty - 1),
                    "force_exit_reason": "manual_scale_out",
                })
            else:
                next_state["force_exit_reason"] = ""
                for key in (
                    "manual_exit_action",
                    "manual_exit_qty",
                    "manual_exit_percent",
                    "manual_exit_requested_at",
                    "manual_exit_request_id",
                ):
                    next_state.pop(key, None)
        elif reason == "manual_close":
            if live_qty > 0:
                next_state.update({
                    "manual_exit_action": "close_all",
                    "manual_exit_qty": live_qty,
                    "manual_exit_percent": 100.0,
                    "force_exit_reason": "manual_close",
                })
            else:
                next_state["force_exit_reason"] = ""
        else:
            next_state["force_exit_reason"] = reason

        for key in (
            "exit_order_id",
            "exit_reason",
            "exit_qty",
            "exit_start_live_qty",
            "exit_limit_price",
            "exit_submitted_at",
            "exit_order_status",
            "remaining_qty",
        ):
            next_state.pop(key, None)

        return next_state


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
            retry_state = self._rearmed_exit_state(
                state,
                live_qty=live_qty,
                error="exit order id missing; protection re-armed",
            )
            self.store.upsert_runner_state(symbol, retry_state)
            return

        try:
            order = alpaca.get_order(order_id, nested=True)
        except RuntimeError as exc:
            message = str(exc).lower()
            if "order not found" not in message and "40410000" not in message:
                raise
            retry_state = self._rearmed_exit_state(
                state,
                live_qty=live_qty,
                error=str(exc),
            )
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
            # A scale-out (or any partial exit) must not detach the remaining
            # shares from protection. If Alpaca still reports a live position,
            # re-arm the same synthetic stop/target for exactly that quantity.
            if live_qty > 0:
                rearmed_state = self._rearmed_exit_state(
                    state,
                    live_qty=live_qty,
                    order=order,
                )
                rearmed_state.update({
                    "last_scale_out_at": datetime.now(timezone.utc).isoformat(),
                    "last_scale_out_qty": int(self._safe_float(state.get("exit_qty"))),
                    "last_scale_out_reason": str(state.get("exit_reason") or "partial_exit"),
                })
                self.store.upsert_runner_state(symbol, rearmed_state)
                self.store.log_event(
                    "synthetic_partial_exit_filled_rearmed",
                    {
                        "reason": state.get("exit_reason"),
                        "remaining_qty": live_qty,
                        "state": rearmed_state,
                        "order": order,
                    },
                    symbol,
                    strategy_id,
                )
                return

            self.store.delete_runner_state(symbol)
            self.store.log_event(
                "synthetic_exit_filled",
                {"reason": state.get("exit_reason"), "state": state, "order": order},
                symbol,
                strategy_id,
            )
            return

        if status in {"canceled", "cancelled", "expired", "rejected"}:
            retry_state = self._rearmed_exit_state(
                state,
                live_qty=live_qty,
                order=order,
                error=f"exit order {status}; protection re-armed",
            )
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
                retry_state = self._rearmed_exit_state(
                    state,
                    live_qty=live_qty,
                    order=order,
                    error="unfilled exit canceled for a more marketable retry",
                )
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
        cancel_reason = str(state.get("entry_cancel_reason") or "")
        forced_exit_reason = ""
        if cancel_reason == "stop_reached_before_entry_fill":
            forced_exit_reason = "stop_loss"
        elif cancel_reason == "target_reached_before_entry_fill":
            forced_exit_reason = "target_hit"

        next_state.update({
            "phase": "active_synthetic",
            "filled_qty": qty,
            "filled_at": datetime.now(timezone.utc).isoformat(),
            # If shares filled while the cancel request was racing the market,
            # immediately unwind them instead of treating the setup as valid.
            "force_exit_reason": forced_exit_reason,
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
            payload = dict(item.get("payload") or {})
            entry_mode = "live" if str(payload.get("mode") or cfg.mode).lower() == "live" else "paper"
            alpaca = alpaca_by_mode.get(entry_mode)
            if alpaca is None:
                alpaca = AlpacaService(mode=entry_mode)
                alpaca_by_mode[entry_mode] = alpaca

            stop = self._alpaca_price(payload.get("stop_price"))
            target = self._alpaca_price(payload.get("target_price"))
            strategy_id = str(payload.get("strategy_id") or "")
            protected_manual_entry = strategy_id in {
                "overnight_protected_order",
                "overnite_hail_mary",
            }

            if not order_id or not symbol or target <= 0 or stop <= 0:
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
                            strategy_id,
                        )
                        continue
                    raise

                status = str(order.get("status") or "").lower()
                filled_qty = self._safe_float(order.get("filled_qty"))

                # Alpaca PATCHes are replacement operations. If a working
                # overnight entry was replaced from the chart or Alpaca UI,
                # follow the new id instead of leaving the protection worker
                # attached to the stale parent order.
                if status == "replaced":
                    replacement_id = str(
                        order.get("replaced_by")
                        or order.get("replacedBy")
                        or ""
                    ).strip()

                    replacement = None
                    if replacement_id:
                        try:
                            replacement = alpaca.get_order(replacement_id, nested=True)
                        except Exception:
                            replacement = None

                    if replacement is None:
                        try:
                            open_orders = alpaca.get_orders(
                                status="open",
                                limit=500,
                                nested=True,
                                symbols=[symbol],
                            )
                            replacement = next(
                                (
                                    candidate
                                    for candidate in open_orders
                                    if str(candidate.get("replaces") or "").strip() == order_id
                                ),
                                None,
                            )
                            if replacement:
                                replacement_id = str(replacement.get("id") or "").strip()
                        except Exception:
                            replacement = None

                    if replacement_id and replacement:
                        replacement_entry = self._alpaca_price(
                            replacement.get("limit_price")
                            or payload.get("entry_price")
                        )
                        old_order_id = order_id
                        order_id = replacement_id
                        payload.update({
                            "order_id": replacement_id,
                            "entry_order_id": replacement_id,
                            "entry_price": replacement_entry,
                            "replaced_order_id": old_order_id,
                            "replacement_followed_at": datetime.now(timezone.utc).isoformat(),
                        })
                        self.store.delete_pending_entry(old_order_id)
                        self.store.upsert_pending_entry(replacement_id, payload)
                        self.store.upsert_runner_state(
                            symbol,
                            {"phase": "entry_submitted", **payload},
                        )
                        self.store.log_event(
                            "pending_entry_replacement_followed",
                            {
                                "old_order_id": old_order_id,
                                "new_order_id": replacement_id,
                                "entry_price": replacement_entry,
                                "replacement": replacement,
                            },
                            symbol,
                            strategy_id,
                        )
                        order = replacement
                        status = str(order.get("status") or "").lower()
                        filled_qty = self._safe_float(order.get("filled_qty"))
                    else:
                        self.store.log_event(
                            "pending_entry_replacement_unresolved",
                            {"order_id": order_id, "order": order, "pending": payload},
                            symbol,
                            strategy_id,
                        )
                        continue

                # Filled or partially filled shares always take priority over
                # cancellation. Cancel the remainder and activate protection.
                if status == "filled" or filled_qty > 0:
                    await self._promote_filled_entry_to_active(alpaca, symbol, payload)
                    continue

                if status in {"canceled", "cancelled", "expired", "rejected"}:
                    cancel_reason = str(payload.get("entry_cancel_reason") or "")
                    self.store.delete_pending_entry(order_id)
                    self.store.delete_runner_state(symbol)
                    self.store.log_event(
                        "pending_entry_cancel_confirmed" if cancel_reason else "pending_entry_closed",
                        {
                            "order_status": status,
                            "cancel_reason": cancel_reason or None,
                            "pending": payload,
                            "order": order,
                        },
                        symbol,
                        strategy_id,
                    )
                    continue

                if status not in {"new", "accepted", "pending_new", "partially_filled", "held"}:
                    continue

                # LOCKED OWNERSHIP RULE FOR MANUAL OVERNIGHT ORDERS:
                # Once Alpaca accepts the pending limit entry, the AutoTrade
                # worker is NEVER allowed to cancel that unfilled order.
                #
                # Previous versions stored entry_cancel_reason and retried
                # cancel_order() every few seconds.  That stale flag could keep
                # deleting newly accepted overnight orders even after the market
                # data/freshness logic was corrected.  Clear any legacy cancel
                # state and leave the broker order untouched until it fills, the
                # user cancels it, or Alpaca itself returns a terminal status.
                if protected_manual_entry:
                    had_legacy_cancel = bool(
                        payload.get("entry_cancel_reason")
                        or payload.get("entry_cancel_requested_at")
                        or payload.get("entry_cancel_error")
                    )
                    for key in (
                        "entry_cancel_reason",
                        "entry_cancel_requested_at",
                        "entry_cancel_attempts",
                        "entry_cancel_market_snapshot",
                        "entry_cancel_error",
                    ):
                        payload.pop(key, None)
                    payload["phase"] = "entry_submitted"
                    payload["pending_entry_locked"] = True
                    payload["pending_entry_lock_reason"] = "manual_overnight_order_owned_by_broker_until_fill"
                    payload["last_reconciled_at"] = datetime.now(timezone.utc).isoformat()
                    self.store.upsert_pending_entry(order_id, payload)
                    self.store.upsert_runner_state(symbol, {"phase": "entry_submitted", **payload})
                    if had_legacy_cancel:
                        self.store.log_event(
                            "pending_entry_legacy_cancel_cleared",
                            {
                                "order_id": order_id,
                                "order_status": status,
                                "pending": payload,
                            },
                            symbol,
                            strategy_id,
                        )
                    continue

                # Non-manual strategies may still use their own cancellation
                # lifecycle.  Do not apply that lifecycle to locked manual
                # Overnight Protected Orders.
                cancel_reason = str(payload.get("entry_cancel_reason") or "")
                if cancel_reason:
                    cancel_age = self._seconds_since_iso(payload.get("entry_cancel_requested_at"))
                    if cancel_age >= 3:
                        try:
                            alpaca.cancel_order(order_id)
                            payload["entry_cancel_requested_at"] = datetime.now(timezone.utc).isoformat()
                            payload["entry_cancel_attempts"] = int(payload.get("entry_cancel_attempts") or 1) + 1
                            self.store.upsert_pending_entry(order_id, payload)
                            self.store.upsert_runner_state(symbol, {"phase": "entry_cancel_requested", **payload})
                        except Exception as cancel_exc:
                            payload["entry_cancel_error"] = str(cancel_exc)
                            self.store.upsert_pending_entry(order_id, payload)
                    continue
            except Exception as exc:
                self.store.log_event(
                    "pending_entry_manage_error",
                    {"order_id": order_id, "symbol": symbol, "error": str(exc), "pending": payload},
                    symbol,
                    strategy_id,
                )

    async def _entry_invalidation_reason(
        self,
        *,
        symbol: str,
        stop: float,
        target: float,
        market: MarketDataProvider,
        submitted_at: Any = None,
    ) -> tuple[Optional[str], Dict[str, Any]]:
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

        # Keep last trade for diagnostics only. The existing provider returns
        # a price without its timestamp, so it is unsafe to use as an overnight
        # cancel trigger: during BOATS hours the normal SIP trade can be stale.
        try:
            last_price = self._safe_float(await market.get_last_trade(symbol))
        except Exception:
            last_price = 0.0

        quote_time_raw = quote.get("time", quote.get("t"))
        quote_time_ms = self._epoch_ms(quote_time_raw)
        submitted_ms = self._epoch_ms(submitted_at)
        now_ms = int(time.time() * 1000)
        quote_age_seconds = (now_ms - quote_time_ms) / 1000.0 if quote_time_ms > 0 else None
        entry_age_seconds = self._seconds_since_iso(submitted_at)

        snapshot: Dict[str, Any] = {
            "symbol": symbol,
            "bid_price": bid_price,
            "ask_price": ask_price,
            "last_price": last_price,
            "target_probe": bid_price,
            "stop_probe": ask_price,
            "stop_price": stop,
            "target_price": target,
            "quote_time": quote_time_raw,
            "quote_time_ms": quote_time_ms,
            "submitted_at": submitted_at,
            "submitted_ms": submitted_ms,
            "quote_age_seconds": quote_age_seconds,
            "entry_age_seconds": entry_age_seconds,
        }

        # Do not let the first worker pass instantly cancel a freshly accepted
        # order. More importantly, never use a quote that predates the order or
        # is stale. SIP can freeze during the 8 PM-4 AM ET BOATS session, and
        # that stale snapshot was canceling valid Overnight Protected Orders.
        if entry_age_seconds < 5.0:
            snapshot["invalidation_status"] = "grace_period"
            return None, snapshot

        if quote_time_ms <= 0:
            snapshot["invalidation_status"] = "missing_quote_timestamp"
            return None, snapshot

        if submitted_ms > 0 and quote_time_ms < submitted_ms:
            snapshot["invalidation_status"] = "quote_predates_entry"
            return None, snapshot

        if quote_age_seconds is None or quote_age_seconds > 60.0:
            snapshot["invalidation_status"] = "stale_quote"
            return None, snapshot

        if bid_price <= 0 or ask_price <= 0:
            snapshot["invalidation_status"] = "incomplete_quote"
            return None, snapshot

        # Only a fresh, post-submission executable quote is allowed to cancel
        # an unfilled entry. Never fall back to an untimestamped last trade.
        reason: Optional[str] = None
        if self._alpaca_price(bid_price) >= target:
            reason = "target_reached_before_entry_fill"
        elif self._alpaca_price(ask_price) <= stop:
            reason = "stop_reached_before_entry_fill"

        snapshot["invalidation_status"] = reason or "armed_no_trigger"
        return reason, snapshot

    @staticmethod
    def _epoch_ms(value: Any) -> int:
        if value is None:
            return 0
        if isinstance(value, (int, float)):
            number = int(float(value))
            return number if number >= 10_000_000_000 else number * 1000

        text = str(value).strip()
        if not text:
            return 0

        try:
            number = int(float(text))
            return number if number >= 10_000_000_000 else number * 1000
        except Exception:
            pass

        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.astimezone(timezone.utc).timestamp() * 1000)
        except Exception:
            return 0

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