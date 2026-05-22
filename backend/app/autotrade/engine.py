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
from app.services.polygon_service import PolygonService
from app.strategies.registry import StrategyRegistry


class AutoTradeEngine:
    """Dedicated single-owner trading engine.

    Run this from app.workers.auto_trade_worker, not inside Gunicorn workers.
    FastAPI can have multiple workers because shared state lives in SQLite and
    only this process submits orders.
    """

    def __init__(self, store: Optional[AutoTradeStore] = None) -> None:
        self.store = store or AutoTradeStore()
        self.strategy_registry = StrategyRegistry()
        self.stop_requested = False

    async def run_forever(self) -> None:
        self.store.set_worker_status({"running": True, "status": "started", "last_error": None})
        print("[auto-trade-worker] started", flush=True)
        try:
            while not self.stop_requested:
                cfg = self.store.get_config()
                try:
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
        symbols = resolve_symbols(cfg)
        self.store.prune_old_fired_signals()
        await self.manage_pending_entries(cfg)
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
        if self.store.signal_was_fired(best.signal_id):
            self.store.set_worker_status({
                "running": True,
                "status": "watching",
                "last_check": now,
                "last_skip": {"reason": "best signal already handled", "signal": best.dict()},
                "last_signal": best.dict(),
                "last_error": None,
            })
            return

        approved, reason, qty = await asyncio.to_thread(self.risk_check, cfg, best)
        if not approved:
            self.store.set_worker_status({
                "running": True,
                "status": "blocked",
                "last_check": now,
                "last_skip": {"reason": reason, "signal": best.dict()},
                "last_signal": best.dict(),
                "last_error": None,
            })
            self.store.log_event("skip", {"reason": reason, "signal": best.dict()}, best.symbol, best.strategy_id)
            return

        order = await asyncio.to_thread(self.execute, cfg, best, qty)
        order_id = str((order or {}).get("id") or "")
        if order_id:
            self.store.upsert_pending_entry(order_id, {
                "order_id": order_id,
                "symbol": best.symbol,
                "strategy_id": best.strategy_id,
                "signal_id": best.signal_id,
                "entry_price": best.entry_price,
                "target_price": best.target_price,
                "stop_price": best.stop_price,
                "qty": qty,
                "submitted_at": datetime.now(timezone.utc).isoformat(),
                "reason": "cancel_if_target_reached_before_entry_fill",
            })
        self.store.mark_signal_fired(best.signal_id, best.symbol, best.strategy_id)
        self.store.set_worker_status({
            "running": True,
            "status": "ordered",
            "last_check": now,
            "last_signal": best.dict(),
            "last_order": order,
            "last_skip": None,
            "last_error": None,
        })
        self.store.log_event("ordered", {"qty": qty, "order": order, "signal": best.dict()}, best.symbol, best.strategy_id)

    async def manage_pending_entries(self, cfg: AutoTradeConfig) -> None:
        """Cancel stale unfilled entries when the target has already been reached.

        This prevents a late fill after price already hit the planned target. Example:
        entry limit is sitting at the blue line, price rips straight to target, and the
        order never filled. The worker cancels that pending entry instead of leaving a
        bad chase/reversal fill waiting on the book.
        """
        pending = self.store.list_pending_entries()
        if not pending:
            return

        alpaca = AlpacaService(mode=cfg.mode)
        polygon = PolygonService()

        for item in pending:
            order_id = str(item.get("order_id") or "")
            symbol = str(item.get("symbol") or "").upper()
            payload = item.get("payload") or {}
            target = self._safe_float(payload.get("target_price"))
            if not order_id or not symbol or target <= 0:
                if order_id:
                    self.store.delete_pending_entry(order_id)
                continue

            try:
                order = alpaca.get_order(order_id, nested=True)
                status = str(order.get("status") or "").lower()
                filled_qty = self._safe_float(order.get("filled_qty"))

                if status in {"filled"} or filled_qty > 0:
                    self.store.delete_pending_entry(order_id)
                    self.store.log_event("pending_entry_filled", {"order": order, "pending": payload}, symbol, str(payload.get("strategy_id") or ""))
                    continue

                if status in {"canceled", "expired", "rejected"}:
                    self.store.delete_pending_entry(order_id)
                    self.store.log_event("pending_entry_closed", {"order_status": status, "pending": payload}, symbol, str(payload.get("strategy_id") or ""))
                    continue

                if status not in {"new", "accepted", "pending_new", "partially_filled"}:
                    continue

                target_reached, market_snapshot = await self._target_reached(symbol, target, polygon)
                if not target_reached:
                    continue

                alpaca.cancel_order(order_id)
                self.store.delete_pending_entry(order_id)
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

    async def _target_reached(self, symbol: str, target: float, polygon: PolygonService) -> tuple[bool, Dict[str, Any]]:
        last_price = 0.0
        recent_high = 0.0
        try:
            last = await polygon.get_last_trade(symbol)
            last_price = self._safe_float(last)
        except Exception:
            last_price = 0.0

        try:
            bars = await polygon.get_bars(symbol, "1m", session="extended")
            recent = (bars or [])[-3:]
            highs = [self._safe_float(b.get("high", b.get("h"))) for b in recent]
            recent_high = max([h for h in highs if h > 0], default=0.0)
        except Exception:
            recent_high = 0.0

        reached = (last_price >= target) or (recent_high >= target)
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
        polygon = PolygonService()
        enabled_strategies = [s for s in cfg.strategies if s.enabled]
        out: List[TradeSignal] = []

        for symbol in symbols:
            for item in enabled_strategies:
                strategy = self.strategy_registry.get(item.strategy_id)
                if strategy is None:
                    continue
                try:
                    found = await strategy.scan(symbol=symbol, polygon=polygon, config=cfg)
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
