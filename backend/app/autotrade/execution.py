from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from app.autotrade.models import AutoTradeConfig, TradeSignal
from app.services.alpaca_service import AlpacaService


def normalize_alpaca_price(price: float) -> float:
    """Normalize prices to Alpaca tick-size rules.

    Alpaca rejects sub-penny prices for stocks >= $1.00.
    - >= $1.00: max 2 decimals
    - <  $1.00: max 4 decimals
    """
    value = float(price)
    if value >= 1.0:
        return round(value, 2)
    return round(value, 4)


class ExecutionEngine:
    def __init__(self, config: AutoTradeConfig) -> None:
        self.config = config
        self.alpaca = AlpacaService(mode=config.mode)

    def submit_entry(self, signal: TradeSignal, qty: int) -> Dict[str, Any]:
        client_order_id = f"autotrade_{signal.strategy_id}_{signal.symbol}_{int(datetime.now(timezone.utc).timestamp())}"

        entry_price = normalize_alpaca_price(float(signal.entry_price))
        target_price = normalize_alpaca_price(float(signal.target_price))
        stop_price = normalize_alpaca_price(float(signal.stop_price))

        if self.config.runner_mode == "scale_trail" and qty >= 2:
            return self.alpaca.place_order(
                symbol=signal.symbol,
                side="buy",
                order_type="limit",
                time_in_force="day",
                qty=qty,
                limit_price=entry_price,
                extended_hours=bool(self.config.extended_hours),
                client_order_id=client_order_id,
            )

        return self.alpaca.place_order(
            symbol=signal.symbol,
            side="buy",
            order_type="limit",
            time_in_force="day",
            qty=qty,
            limit_price=entry_price,
            extended_hours=bool(self.config.extended_hours),
            client_order_id=client_order_id,
            order_class="bracket",
            take_profit={"limit_price": target_price},
            stop_loss={"stop_price": stop_price},
        )
