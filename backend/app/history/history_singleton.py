from app.history.history_engine import HistoryEngine
from app.history.providers.polygon_provider import PolygonHistoryProvider

history_engine = HistoryEngine(
    provider=PolygonHistoryProvider(),
)
