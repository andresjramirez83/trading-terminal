from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


@runtime_checkable
class MarketDataProvider(Protocol):
    """Common market-data contract used by charts, scanners, alerts, and replay.

    Implementations must return bars in the application's normalized dual shape:

        {
            "time": 1710000000000,
            "open": 100.0,
            "high": 101.0,
            "low": 99.5,
            "close": 100.5,
            "volume": 12345.0,
            "t": 1710000000000,
            "o": 100.0,
            "h": 101.0,
            "l": 99.5,
            "c": 100.5,
            "v": 12345.0,
        }

    Timestamps are Unix milliseconds. The long field names are used by chart code;
    the short aliases keep existing scanner code compatible during migration.
    """

    async def get_bars(
        self,
        symbol: str,
        timeframe: str = "1m",
        session: str = "regular",
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

    async def get_snapshot_gainers(self, limit: int = 50) -> List[Dict[str, Any]]:
        ...

    async def get_snapshot_losers(self, limit: int = 50) -> List[Dict[str, Any]]:
        ...

    async def get_snapshot_actives(self, limit: int = 50) -> List[Dict[str, Any]]:
        ...

    async def get_ticker_details(self, symbol: str) -> Dict[str, Any]:
        ...


def normalize_market_data_provider(value: Optional[str]) -> str:
    """Normalize the configured provider name.

    Alpaca is the production default. Polygon remains available only as a
    temporary rollback option while the migration is being verified.
    """
    provider = str(value or "alpaca").strip().lower()

    aliases = {
        "apca": "alpaca",
        "alpaca-sip": "alpaca",
        "alpaca_sip": "alpaca",
        "poly": "polygon",
    }
    provider = aliases.get(provider, provider)

    if provider not in {"alpaca", "polygon"}:
        raise RuntimeError(
            f"Unsupported MARKET_DATA_PROVIDER={provider!r}. "
            "Use 'alpaca' or the temporary rollback value 'polygon'."
        )

    return provider


def get_market_data_provider(
    provider_name: Optional[str] = None,
) -> MarketDataProvider:
    """Create the configured market-data provider.

    The import is intentionally lazy so the trading API can start even while a
    market-data provider is unavailable or being migrated.

    Environment:
        MARKET_DATA_PROVIDER=alpaca
    """
    provider = normalize_market_data_provider(
        provider_name or os.getenv("MARKET_DATA_PROVIDER", "alpaca")
    )

    if provider == "alpaca":
        from app.services.alpaca_market_service import AlpacaMarketService

        instance: MarketDataProvider = AlpacaMarketService()
        return instance

    # Temporary rollback path. Remove this branch after Alpaca chart, scanner,
    # alert, replay, and websocket verification is complete.
    from app.services.polygon_service import PolygonService

    instance = PolygonService()
    return instance


__all__ = [
    "MarketDataProvider",
    "get_market_data_provider",
    "normalize_market_data_provider",
]