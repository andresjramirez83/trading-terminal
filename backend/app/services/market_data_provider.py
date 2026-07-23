from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


@runtime_checkable
class MarketDataProvider(Protocol):
    """Common market-data contract used by charts, scanners, alerts, and replay."""

    async def get_bars(
        self,
        symbol: str,
        timeframe: str = "1m",
        session: str = "regular",
        date: Optional[str] = None,
        lookback: Optional[str] = None,
        limit: int = 1000,
    ) -> List[Dict[str, Any]]:
        ...

    async def get_recent_1m_bars(
        self,
        symbol: str,
        hours_back: int = 48,
    ) -> List[Dict[str, Any]]:
        ...

    async def get_last_trade(self, symbol: str) -> Optional[float]:
        ...

    async def get_latest_quote(self, symbol: str) -> Dict[str, Any]:
        ...

    async def get_ticker_snapshot(self, symbol: str) -> Dict[str, Any]:
        ...

    async def get_snapshot_gainers(
        self,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        ...

    async def get_snapshot_losers(
        self,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        ...

    async def get_snapshot_actives(
        self,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        ...

    async def get_ticker_details(self, symbol: str) -> Dict[str, Any]:
        ...


def normalize_market_data_provider(value: Optional[str]) -> str:
    provider = str(value or "alpaca").strip().lower()

    aliases = {
        "apca": "alpaca",
        "alpaca-sip": "alpaca",
        "alpaca_sip": "alpaca",
    }
    provider = aliases.get(provider, provider)

    if provider != "alpaca":
        raise RuntimeError(
            f"Unsupported MARKET_DATA_PROVIDER={provider!r}. "
            "Only 'alpaca' is supported."
        )

    return provider


def get_market_data_provider(
    provider_name: Optional[str] = None,
) -> MarketDataProvider:
    """Create the Alpaca market-data provider."""

    normalize_market_data_provider(
        provider_name or os.getenv("MARKET_DATA_PROVIDER", "alpaca")
    )

    from app.services.alpaca_market_service import AlpacaMarketService

    instance: MarketDataProvider = AlpacaMarketService()
    return instance


__all__ = [
    "MarketDataProvider",
    "get_market_data_provider",
    "normalize_market_data_provider",
]