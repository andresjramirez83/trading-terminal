from __future__ import annotations

import asyncio
import traceback
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
