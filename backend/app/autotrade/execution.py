from __future__ import annotations

from datetime import datetime, timezone
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
        client_order_id = f"autotrade_{signal.strategy_id}_{signal.symbol}_{int(datetime.now(timezone.utc).timestamp())}"
        entry_price = normalize_alpaca_price(float(signal.entry_price))

        # Hail Mary orders need to survive overnight / session boundaries.
        # Alpaca DAY + extended_hours orders can be canceled at session boundaries,
        # so use GTC + extended_hours only for the manual Hail Mary strategy.
        is_hail_mary = str(signal.strategy_id or "").strip() == "overnite_hail_mary"
        time_in_force = "gtc" if is_hail_mary else "day"
        extended_hours = True if is_hail_mary else bool(self.config.extended_hours)

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
