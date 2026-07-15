from app.history.history_engine import HistoryEngine
from app.history.providers.alpaca_provider import AlpacaHistoryProvider

history_engine = HistoryEngine(
    provider=AlpacaHistoryProvider(),
)
