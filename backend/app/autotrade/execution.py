from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4
from typing import Any, Dict

from app.autotrade.models import AutoTradeConfig, TradeSignal
from app.services.alpaca_service import AlpacaService


def normalize_alpaca_price(price: float) -> float:
    value = float(price)
    if value >= 1.0:
        return round(value, 2)
    return round(value, 4)


class ExecutionEngine:
    def __init__(self, config: AutoTradeConfig) -> None:
        self.config = config
        self.alpaca = AlpacaService(mode=config.mode)

    def submit_entry(self, signal: TradeSignal, qty: int) -> Dict[str, Any]:
        """Submit entry only.

        No native Alpaca bracket orders are used here because Alpaca rejects
        bracket orders in extended hours. The dedicated backend worker owns
        synthetic stop/target lifecycle management.
        """
        # Alpaca caps client_order_id at 48 characters.  The full strategy
        # name "overnight_protected_order" made the old ID too long for
        # normal ticker symbols, so use a compact strategy tag.
        strategy_id = str(signal.strategy_id or "").strip()
        is_protected_overnight = strategy_id in {
            "overnight_protected_order",
            "overnite_hail_mary",  # Legacy compatibility alias.
        }
        strategy_tag = "opo" if is_protected_overnight else strategy_id.replace("_", "-")[:12]
        symbol_tag = str(signal.symbol or "").upper().replace(".", "-")[:8]
        ts = int(datetime.now(timezone.utc).timestamp())
        client_order_id = f"autotrade_{strategy_tag}_{symbol_tag}_{ts}_{uuid4().hex[:6]}"[:48]
        entry_price = normalize_alpaca_price(float(signal.entry_price))

        # Protected overnight entries must survive session boundaries.
        time_in_force = "gtc" if is_protected_overnight else "day"
        extended_hours = True if is_protected_overnight else bool(self.config.extended_hours)

        return self.alpaca.place_order(
            symbol=signal.symbol,
            side="buy",
            order_type="limit",
            time_in_force=time_in_force,
            qty=qty,
            limit_price=entry_price,
            extended_hours=extended_hours,
            client_order_id=client_order_id,
        )
