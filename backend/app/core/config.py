import os
from dotenv import load_dotenv

load_dotenv()

DEFAULT_SYMBOL = os.getenv("DEFAULT_SYMBOL", "AAPL")

MARKET_DATA_PROVIDER = os.getenv(
    "MARKET_DATA_PROVIDER",
    "alpaca",
).strip().lower()

if MARKET_DATA_PROVIDER != "alpaca":
    raise RuntimeError(
        f"Unsupported MARKET_DATA_PROVIDER={MARKET_DATA_PROVIDER!r}. "
        "Only 'alpaca' is supported."
    )

APCA_API_KEY_ID_LIVE = os.getenv("APCA_API_KEY_ID_LIVE", "").strip()
APCA_API_SECRET_KEY_LIVE = os.getenv("APCA_API_SECRET_KEY_LIVE", "").strip().getenv("ALPACA_SECRET_KEY", "")