"""Regression: a market-data HTTP client must not cross asyncio event loops."""
import asyncio
import unittest
from unittest.mock import patch

from app.services.alpaca_market_service import AlpacaMarketService


class AlpacaHTTPClientLoopIsolationTests(unittest.TestCase):
    def test_client_isolated_between_event_loops(self):
        async def acquire():
            service = AlpacaMarketService()
            first_lookup = service._client(service.timeout)
            second_lookup = service._client(service.timeout)
            self.assertIs(first_lookup, second_lookup)
            return first_lookup

        # No real credentials or network operations are required.
        with patch.object(AlpacaMarketService, "_resolve_credentials", return_value=("test", "test")):
            # Deliberately let the first loop close while holding the client.
            # Old code incorrectly returned this SAME client to the second loop.
            first = asyncio.run(acquire())
            second = asyncio.run(acquire())
        try:
            self.assertIsNot(first, second)
        finally:
            # No network requests were made, so closing these unused clients
            # is harmless; close each once to avoid ResourceWarnings.
            async def close_clients():
                await first.aclose()
                await second.aclose()
            asyncio.run(close_clients())
