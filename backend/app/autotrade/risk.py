from __future__ import annotations

from typing import Any, Dict, List, Tuple

from app.autotrade.models import AutoTradeConfig, TradeSignal


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        out = float(value)
        return out if out >= 0 else default
    except Exception:
        return default


class RiskManager:
    def __init__(self, config: AutoTradeConfig) -> None:
        self.config = config

    def active_count(self, positions: List[Dict[str, Any]], orders: List[Dict[str, Any]]) -> int:
        open_orders = [o for o in orders or [] if str(o.get("status") or "").lower() not in {"filled", "canceled", "expired", "rejected"}]
        open_positions = []
        for p in positions or []:
            if abs(safe_float(p.get("qty"))) > 0:
                open_positions.append(p)
        if self.config.require_flat_account:
            return len(open_orders) + len(open_positions)
        auto_orders = [o for o in open_orders if str(o.get("client_order_id") or "").startswith("autotrade_")]
        return len(auto_orders)

    def quantity_for(self, signal: TradeSignal, buying_power: float) -> int:
        entry = float(signal.entry_price)
        if entry <= 0:
            return 0
        if self.config.sizing_mode == "shares":
            qty = max(1, int(self.config.fixed_shares))
            return qty if qty * entry <= buying_power else 0
        dollars = min(float(self.config.trade_amount), buying_power)
        return max(0, int(dollars // entry))

    def approve(self, signal: TradeSignal, *, account: Dict[str, Any], positions: List[Dict[str, Any]], orders: List[Dict[str, Any]]) -> Tuple[bool, str, int]:
        if self.config.mode == "live" and not self.config.allow_live:
            return False, "live mode locked", 0
        if signal.profit_range < float(self.config.min_profit_range):
            return False, f"range too small: ${signal.profit_range:.2f} < ${self.config.min_profit_range:.2f}", 0
        active = self.active_count(positions, orders)
        if active >= int(self.config.max_active_trades):
            return False, "active trade/order lockout", 0
        buying_power = safe_float(account.get("buying_power"), safe_float(account.get("cash")))
        qty = self.quantity_for(signal, buying_power)
        if qty <= 0:
            return False, "insufficient buying power", 0
        return True, "approved", qty
