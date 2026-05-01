import os
from dotenv import load_dotenv

load_dotenv()

POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "")
DEFAULT_SYMBOL = os.getenv("DEFAULT_SYMBOL", "AAPL")

if not POLYGON_API_KEY:
    raise RuntimeError("Missing POLYGON_API_KEY in environment.")
