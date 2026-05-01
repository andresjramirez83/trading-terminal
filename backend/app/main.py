
import asyncio
import json
import os
import traceback
from pathlib import Path
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import requests
import httpx
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

print("RUNNING MAIN FROM:", __file__, flush=True)
load_dotenv(override=True)

try:
    from zoneinfo import ZoneInfo

    try:
        ET = ZoneInfo("America/New_York")
    except Exception:
        ET = timezone(timedelta(hours=-4))
except Exception:
    ET = timezone(timedelta(hours=-4))

from app.scanner import build_scanner
from app.scanners.registry import ScannerRegistry
from app.services.alpaca_service import AlpacaService
from app.services.polygon_service import PolygonService
from app.services.polygon_ws import polygon_ws_manager
from app.services.scanner_snapshot_store import ScannerSnapshotStore
from app.services.signal_engine import (
    SignalEngineConfig,
    evaluate_symbol_signal,
    signal_state_from_dict,
    signal_state_to_dict,
)

POLYGON_API_KEY = os.getenv("POLYGON_API_KEY", "").strip()
registry = ScannerRegistry()
snapshot_store = ScannerSnapshotStore()

# Small in-memory cache so multiple chart panels do not hammer Polygon on every mount.
BARS_CACHE: Dict[str, Dict[str, Any]] = {}
BARS_CACHE_TTL_SECONDS = 60
MAX_BARS_DEFAULT = 700
IN_FLIGHT_BARS_REQUESTS: Dict[str, asyncio.Task] = {}
POLYGON_HTTP_CLIENT: Optional[httpx.AsyncClient] = None

app = FastAPI(title="Trading Terminal Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class BarsResponse(BaseModel):
    symbol: str
    timeframe: str
    bars: List[Candle]
    trading_date: str


class LastTradeResponse(BaseModel):
    symbol: str
    price: Optional[float]


class AlpacaOrderRequest(BaseModel):
    mode: str = "paper"
    symbol: str
    side: str
    qty: Optional[float] = None
    notional: Optional[float] = None
    type: str = "market"
    time_in_force: str = "day"
    limit_price: Optional[float] = None
    extended_hours: bool = False


class AlertPayload(BaseModel):
    message: str
    title: Optional[str] = "Trading Alert"
    priority: int = 1


class SharedAlpacaStatePayload(BaseModel):
    selectedSymbol: Optional[str] = None
    watchlist: List[str] = []
    manualWatchlist: List[str] = []
    updatedAt: Optional[float] = None


APP_STATE_DIR = Path(__file__).resolve().parent / "data" / "app_state"
APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
ALPACA_APP_STATE_FILE = APP_STATE_DIR / "alpaca_state.json"


def _normalize_symbol_list(items: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for item in items or []:
        symbol = "".join(ch for ch in str(item).upper().strip() if ch.isalpha() or ch == ".")
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        out.append(symbol)
    return out


def _clean_alpaca_state(payload: SharedAlpacaStatePayload) -> Dict[str, Any]:
    watchlist = _normalize_symbol_list(payload.watchlist)
    manual = _normalize_symbol_list(payload.manualWatchlist)
    selected = "".join(ch for ch in str(payload.selectedSymbol or "").upper().strip() if ch.isalpha() or ch == ".")
    return {
        "selectedSymbol": selected or None,
        "watchlist": watchlist,
        "manualWatchlist": manual,
        "updatedAt": payload.updatedAt or datetime.now(timezone.utc).timestamp() * 1000,
    }


class BackendAlertLoopConfig(BaseModel):
    enabled: bool = False
    symbols: List[str] = []
    timeframe: str = "1m"
    poll_seconds: int = 20
    cooldown_seconds: int = 300
    lookback_bars: int = 8
    webhook_url: Optional[str] = None
    notify_phone: bool = True
    notify_webhook: bool = False
    alert_on_prealert: bool = False
    min_score_confirmed: float = 72.0
    min_score_prealert: float = 58.0
    min_rvol: float = 1.35
    require_vwap_reclaim: bool = False
    breakout_buffer_pct: float = 0.0005
    structure_window: int = 12


class BackendAlertLoopUpdate(BaseModel):
    enabled: Optional[bool] = None
    symbols: Optional[List[str]] = None
    timeframe: Optional[str] = None
    poll_seconds: Optional[int] = None
    cooldown_seconds: Optional[int] = None
    lookback_bars: Optional[int] = None
    webhook_url: Optional[str] = None
    notify_phone: Optional[bool] = None
    notify_webhook: Optional[bool] = None
    alert_on_prealert: Optional[bool] = None
    min_score_confirmed: Optional[float] = None
    min_score_prealert: Optional[float] = None
    min_rvol: Optional[float] = None
    require_vwap_reclaim: Optional[bool] = None
    breakout_buffer_pct: Optional[float] = None
    structure_window: Optional[int] = None


DEFAULT_ALERT_SYMBOLS = [
    item.strip().upper()
    for item in os.getenv("BACKEND_ALERT_SYMBOLS", "AAPL,NVDA,TSLA,AMD").split(",")
    if item.strip()
]

backend_alert_config = BackendAlertLoopConfig(
    enabled=os.getenv("BACKEND_ALERTS_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"},
    symbols=DEFAULT_ALERT_SYMBOLS,
    timeframe=os.getenv("BACKEND_ALERTS_TIMEFRAME", "1m").strip().lower() or "1m",
    poll_seconds=max(5, int(os.getenv("BACKEND_ALERTS_POLL_SECONDS", "20") or "20")),
    cooldown_seconds=max(30, int(os.getenv("BACKEND_ALERTS_COOLDOWN_SECONDS", "300") or "300")),
    lookback_bars=max(5, int(os.getenv("BACKEND_ALERTS_LOOKBACK_BARS", "8") or "8")),
    webhook_url=os.getenv("BACKEND_ALERTS_WEBHOOK_URL", "").strip() or None,
    notify_phone=os.getenv("BACKEND_ALERTS_NOTIFY_PHONE", "true").strip().lower() in {"1", "true", "yes", "on"},
    notify_webhook=os.getenv("BACKEND_ALERTS_NOTIFY_WEBHOOK", "false").strip().lower() in {"1", "true", "yes", "on"},
    alert_on_prealert=os.getenv("BACKEND_ALERTS_ALERT_ON_PREALERT", "false").strip().lower() in {"1", "true", "yes", "on"},
    min_score_confirmed=float(os.getenv("BACKEND_ALERTS_MIN_SCORE_CONFIRMED", "72") or "72"),
    min_score_prealert=float(os.getenv("BACKEND_ALERTS_MIN_SCORE_PREALERT", "58") or "58"),
    min_rvol=float(os.getenv("BACKEND_ALERTS_MIN_RVOL", "1.35") or "1.35"),
    require_vwap_reclaim=os.getenv("BACKEND_ALERTS_REQUIRE_VWAP_RECLAIM", "false").strip().lower() in {"1", "true", "yes", "on"},
    breakout_buffer_pct=float(os.getenv("BACKEND_ALERTS_BREAKOUT_BUFFER_PCT", "0.0005") or "0.0005"),
    structure_window=max(8, int(os.getenv("BACKEND_ALERTS_STRUCTURE_WINDOW", "12") or "12")),
)

backend_alert_task: Optional[asyncio.Task] = None
backend_alert_last_sent: Dict[str, datetime] = {}
backend_alert_last_check: Optional[datetime] = None
backend_alert_last_error: Optional[str] = None
backend_alert_last_results: List[Dict[str, Any]] = []
backend_alert_signal_state: Dict[str, Dict[str, Any]] = {}
backend_alert_last_alert: Optional[Dict[str, Any]] = None

# === BACKGROUND SCANNER CACHE STATE ===
# Runs scanner in the backend so pages can read cached results without hammering Polygon.
scanner_task: Optional[asyncio.Task] = None
scanner_cache: Optional[Dict[str, Any]] = None
scanner_last_run: Optional[datetime] = None
scanner_last_error: Optional[str] = None
scanner_last_status: str = "stopped"
scanner_run_count: int = 0
scanner_last_auto_ah_save_date: Optional[str] = None

SCANNER_BACKGROUND_ENABLED = os.getenv("SCANNER_BACKGROUND_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
SCANNER_INTERVAL_SECONDS = max(30, int(os.getenv("SCANNER_INTERVAL_SECONDS", "45") or "45"))
SCANNER_MAX_SYMBOLS = max(1, int(os.getenv("SCANNER_MAX_SYMBOLS", "25") or "25"))
SCANNER_MIN_PRICE = float(os.getenv("SCANNER_MIN_PRICE", "0.5") or "0.5")
SCANNER_MAX_PRICE = float(os.getenv("SCANNER_MAX_PRICE", "20.0") or "20.0")
SCANNER_MIN_VOLUME = max(0, int(os.getenv("SCANNER_MIN_VOLUME", "500000") or "500000"))
SCANNER_MIN_CHANGE_PCT = float(os.getenv("SCANNER_MIN_CHANGE_PCT", "3.0") or "3.0")
SCANNER_ID = os.getenv("BACKGROUND_SCANNER_ID", "overnight_runner").strip() or "overnight_runner"
SCANNER_WORKFLOW = os.getenv("BACKGROUND_SCANNER_WORKFLOW", "auto").strip().lower() or "auto"
SCANNER_MIN_PM_RANGE_PCT = float(os.getenv("BACKGROUND_SCANNER_MIN_PM_RANGE_PCT", "4.5") or "4.5")
SCANNER_MIN_PM_DOLLAR_VOLUME = float(os.getenv("BACKGROUND_SCANNER_MIN_PM_DOLLAR_VOLUME", "500000") or "500000")
SCANNER_MIN_COMPRESSION_SCORE = float(os.getenv("BACKGROUND_SCANNER_MIN_COMPRESSION_SCORE", "0") or "0")
SCANNER_MIN_BREAKOUT_SCORE = float(os.getenv("BACKGROUND_SCANNER_MIN_BREAKOUT_SCORE", "0") or "0")
SCANNER_HOURS_BACK = max(24, int(os.getenv("BACKGROUND_SCANNER_HOURS_BACK", "96") or "96"))


def previous_trading_day(ref: Optional[date] = None) -> date:
    d = ref or datetime.now(ET).date()
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def parse_requested_date(date_str: Optional[str]) -> date:
    if not date_str:
        return previous_trading_day()

    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    return previous_trading_day(d)


def polygon_multiplier_and_timespan(timeframe: str) -> tuple[int, str]:
    tf = timeframe.lower().strip()

    mapping = {
        "1m": (1, "minute"),
        "5m": (5, "minute"),
        "15m": (15, "minute"),
        "30m": (30, "minute"),
        "1h": (1, "hour"),
        "day": (1, "day"),
        "1d": (1, "day"),
    }

    if tf not in mapping:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe}")

    return mapping[tf]


def normalize_workflow(workflow: str) -> str:
    value = (workflow or "").strip().lower()

    if value in {"auto", "combined", "combo"}:
        return "combined"
    if value in {"live", "pm", "premarket"}:
        return "live"

    raise HTTPException(
        status_code=400,
        detail=f"Unsupported workflow '{workflow}'. Use 'combined' or 'live'.",
    )


DEFAULT_LOOKBACK_BY_TIMEFRAME = {
    "1m": "1d",
    "5m": "2d",
    "15m": "5d",
    "30m": "10d",
    "1h": "20d",
    "1d": "6m",
    "day": "6m",
}


def resolve_lookback_days(lookback: Optional[str], timeframe: str) -> int:
    value = (lookback or DEFAULT_LOOKBACK_BY_TIMEFRAME.get(timeframe.lower().strip(), "5d")).strip().lower()

    if value.endswith("y"):
        amount = int(value[:-1] or "1")
        return max(1, amount * 365)

    if value.endswith("m"):
        amount = int(value[:-1] or "1")
        return max(1, amount * 30)

    if value.endswith("w"):
        amount = int(value[:-1] or "1")
        return max(1, amount * 7)

    if value.endswith("d"):
        amount = int(value[:-1] or "1")
        return max(1, amount)

    raise HTTPException(
        status_code=400,
        detail="Invalid lookback format. Use values like 2d, 5d, 1m, 3m, or 1y.",
    )


def get_polygon_http_client() -> httpx.AsyncClient:
    global POLYGON_HTTP_CLIENT
    if POLYGON_HTTP_CLIENT is None or POLYGON_HTTP_CLIENT.is_closed:
        POLYGON_HTTP_CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=25.0, write=25.0, pool=25.0),
            follow_redirects=True,
            headers={
                "Accept": "application/json",
                "User-Agent": "trading-terminal-sprint1/1.0",
            },
            http2=False,
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=30.0),
        )
    return POLYGON_HTTP_CLIENT


async def fetch_bars_range_async(
    symbol: str,
    timeframe: str,
    lookback: Optional[str] = None,
    end_day: Optional[date] = None,
    limit_bars: Optional[int] = MAX_BARS_DEFAULT,
) -> tuple[List[Candle], date]:
    if not POLYGON_API_KEY:
        raise HTTPException(status_code=500, detail="Missing POLYGON_API_KEY in backend environment")

    multiplier, timespan = polygon_multiplier_and_timespan(timeframe)

    final_day = previous_trading_day(end_day or datetime.now(ET).date())
    lookback_days = resolve_lookback_days(lookback, timeframe)
    start_day = final_day - timedelta(days=lookback_days)

    start_str = start_day.strftime("%Y-%m-%d")
    end_str = final_day.strftime("%Y-%m-%d")

    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{symbol.upper()}/range/"
        f"{multiplier}/{timespan}/{start_str}/{end_str}"
    )

    params = {
        "adjusted": "true",
        "sort": "asc",
        "limit": 50000,
        "apiKey": POLYGON_API_KEY,
    }

    data: Dict[str, Any] = {}
    last_error: Optional[Exception] = None
    client = get_polygon_http_client()

    for attempt in range(1, 4):
        try:
            r = await client.get(url, params=params)
            if r.status_code >= 400:
                body = r.text[:500]
                raise httpx.HTTPStatusError(
                    f"Polygon HTTP {r.status_code}: {body}",
                    request=r.request,
                    response=r,
                )

            data = r.json()
            break

        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
            print(
                f"[bars] Polygon async request failed attempt {attempt}/3 "
                f"symbol={symbol.upper()} timeframe={timeframe}: {exc}",
                flush=True,
            )

            if attempt < 3:
                await asyncio.sleep(0.6 * attempt)
                continue

            raise HTTPException(status_code=502, detail=f"Polygon request failed after retries: {exc}")

    if not data and last_error is not None:
        raise HTTPException(status_code=502, detail=f"Polygon request failed: {last_error}")

    results = data.get("results", []) or []

    bars: List[Candle] = []
    for row in results:
        try:
            bars.append(
                Candle(
                    time=row["t"],
                    open=row["o"],
                    high=row["h"],
                    low=row["l"],
                    close=row["c"],
                    volume=row["v"],
                )
            )
        except KeyError:
            continue

    if limit_bars is not None and limit_bars > 0 and len(bars) > limit_bars:
        bars = bars[-limit_bars:]

    return bars, final_day


async def fetch_bars_for_day_async(
    symbol: str,
    timeframe: str,
    trading_day: date,
    limit_bars: Optional[int] = MAX_BARS_DEFAULT,
) -> List[Candle]:
    bars, _ = await fetch_bars_range_async(symbol, timeframe, "1d", trading_day, limit_bars=limit_bars)
    if bars:
        return [bar for bar in bars if datetime.fromtimestamp(bar.time / 1000, ET).date() == trading_day]
    return []


def fetch_bars_range(
    symbol: str,
    timeframe: str,
    lookback: Optional[str] = None,
    end_day: Optional[date] = None,
    limit_bars: Optional[int] = MAX_BARS_DEFAULT,
) -> tuple[List[Candle], date]:
    if not POLYGON_API_KEY:
        raise HTTPException(status_code=500, detail="Missing POLYGON_API_KEY in backend environment")

    multiplier, timespan = polygon_multiplier_and_timespan(timeframe)

    final_day = previous_trading_day(end_day or datetime.now(ET).date())
    lookback_days = resolve_lookback_days(lookback, timeframe)
    start_day = final_day - timedelta(days=lookback_days)

    start_str = start_day.strftime("%Y-%m-%d")
    end_str = final_day.strftime("%Y-%m-%d")

    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{symbol.upper()}/range/"
        f"{multiplier}/{timespan}/{start_str}/{end_str}"
    )

    params = {
        "adjusted": "true",
        "sort": "asc",
        "limit": 50000,
        "apiKey": POLYGON_API_KEY,
    }

    data: Dict[str, Any] = {}
    last_error: Optional[Exception] = None

    for attempt in range(1, 4):
        try:
            r = requests.get(
                url,
                params=params,
                timeout=25,
                headers={
                    "Accept": "application/json",
                    "Connection": "close",
                    "User-Agent": "trading-terminal-sprint1/1.0",
                },
            )
            if r.status_code >= 400:
                body = r.text[:500]
                raise requests.HTTPError(
                    f"Polygon HTTP {r.status_code}: {body}",
                    response=r,
                )

            data = r.json()
            break

        except requests.RequestException as exc:
            last_error = exc
            print(
                f"[bars] Polygon request failed attempt {attempt}/3 "
                f"symbol={symbol.upper()} timeframe={timeframe}: {exc}",
                flush=True,
            )

            if attempt < 3:
                import time
                time.sleep(0.6 * attempt)
                continue

            raise HTTPException(status_code=502, detail=f"Polygon request failed after retries: {exc}")

        except ValueError as exc:
            last_error = exc
            raise HTTPException(status_code=502, detail=f"Polygon returned invalid JSON: {exc}")

    if not data and last_error is not None:
        raise HTTPException(status_code=502, detail=f"Polygon request failed: {last_error}")

    results = data.get("results", []) or []

    bars: List[Candle] = []
    for row in results:
        try:
            bars.append(
                Candle(
                    time=row["t"],
                    open=row["o"],
                    high=row["h"],
                    low=row["l"],
                    close=row["c"],
                    volume=row["v"],
                )
            )
        except KeyError:
            continue

    if limit_bars is not None and limit_bars > 0 and len(bars) > limit_bars:
        bars = bars[-limit_bars:]

    return bars, final_day

def fetch_bars_for_day(
    symbol: str,
    timeframe: str,
    trading_day: date,
    limit_bars: Optional[int] = MAX_BARS_DEFAULT,
) -> List[Candle]:
    bars, _ = fetch_bars_range(symbol, timeframe, "1d", trading_day, limit_bars=limit_bars)
    if bars:
        return [bar for bar in bars if datetime.fromtimestamp(bar.time / 1000, ET).date() == trading_day]
    return []


def get_alpaca_service(mode: str) -> AlpacaService:
    normalized = (mode or "paper").strip().lower()
    print("GET ALPACA SERVICE MODE:", normalized, flush=True)

    if normalized not in {"paper", "live"}:
        raise HTTPException(status_code=400, detail="mode must be 'paper' or 'live'")

    try:
        service = AlpacaService(mode=normalized)
        print("GET ALPACA SERVICE CREATED", flush=True)
        return service
    except RuntimeError as exc:
        print("GET ALPACA SERVICE RUNTIME ERROR:", repr(exc), flush=True)
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        print("GET ALPACA SERVICE UNEXPECTED ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))


def send_pushover_alert(title: str, message: str, priority: int = 1) -> dict:
    user_key = os.getenv("PUSHOVER_USER_KEY", "").strip()
    app_token = os.getenv("PUSHOVER_APP_TOKEN", "").strip()

    if not user_key or not app_token:
        raise HTTPException(
            status_code=500,
            detail="Pushover is not configured. Set PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN in backend .env",
        )

    try:
        response = requests.post(
            "https://api.pushover.net/1/messages.json",
            data={
                "token": app_token,
                "user": user_key,
                "title": title,
                "message": message,
                "priority": priority,
            },
            timeout=10,
        )
        response.raise_for_status()
        return response.json()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Pushover request failed: {exc}")


def post_json_webhook(url: str, payload: dict) -> dict:
    try:
        response = requests.post(url, json=payload, timeout=10)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type.lower():
            return response.json()
        return {"status_code": response.status_code, "text": response.text[:500]}
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Webhook request failed: {exc}")


def build_signal_engine_config() -> SignalEngineConfig:
    return SignalEngineConfig(
        lookback_bars=max(5, int(backend_alert_config.lookback_bars)),
        min_score_confirmed=float(backend_alert_config.min_score_confirmed),
        min_score_prealert=float(backend_alert_config.min_score_prealert),
        min_rvol=float(backend_alert_config.min_rvol),
        require_vwap_reclaim=bool(backend_alert_config.require_vwap_reclaim),
        breakout_buffer_pct=float(backend_alert_config.breakout_buffer_pct),
        structure_window=max(8, int(backend_alert_config.structure_window)),
    )


def signal_state_key(symbol: str, timeframe: str) -> str:
    return f"{symbol.upper()}::{timeframe}"


def fetch_signal_bars(symbol: str, timeframe: str) -> List[Dict[str, Any]]:
    bars, _ = fetch_bars_range(symbol, timeframe, lookback="2d")
    return [
        {
            "time": bar.time,
            "open": bar.open,
            "high": bar.high,
            "low": bar.low,
            "close": bar.close,
            "volume": bar.volume,
        }
        for bar in bars
    ]


def evaluate_backend_signal(symbol: str, timeframe: str) -> Dict[str, Any]:
    key = signal_state_key(symbol, timeframe)
    previous_state = signal_state_from_dict(backend_alert_signal_state.get(key))
    signal = evaluate_symbol_signal(
        symbol=symbol,
        timeframe=timeframe,
        raw_bars=fetch_signal_bars(symbol, timeframe),
        previous_state=previous_state,
        config=build_signal_engine_config(),
    )
    state = signal.get("state")
    if state is not None:
        backend_alert_signal_state[key] = signal_state_to_dict(state)
    return signal


def alert_cooldown_key(signal: dict) -> str:
    setup = str(signal.get("setup") or "generic")
    phase = str(signal.get("phase") or "none")
    return f"{signal['symbol']}::{signal['timeframe']}::{setup}::{phase}"


def can_send_backend_alert(signal: dict, cooldown_seconds: int) -> bool:
    key = alert_cooldown_key(signal)
    last_sent = backend_alert_last_sent.get(key)
    if last_sent is None:
        return True
    return (datetime.now(timezone.utc) - last_sent).total_seconds() >= cooldown_seconds


def mark_backend_alert_sent(signal: dict) -> None:
    backend_alert_last_sent[alert_cooldown_key(signal)] = datetime.now(timezone.utc)


async def run_backend_alerts_loop() -> None:
    global backend_alert_last_check, backend_alert_last_error, backend_alert_last_results, backend_alert_last_alert

    print("[backend-alert-loop] started", flush=True)

    while True:
        try:
            if not backend_alert_config.enabled:
                await asyncio.sleep(1)
                continue

            if not backend_alert_config.symbols:
                backend_alert_last_results = []
                backend_alert_last_check = datetime.now(timezone.utc)
                backend_alert_last_error = None
                await asyncio.sleep(max(5, backend_alert_config.poll_seconds))
                continue

            cycle_results: List[Dict[str, Any]] = []

            for raw_symbol in backend_alert_config.symbols:
                symbol = raw_symbol.strip().upper()
                if not symbol:
                    continue

                try:
                    signal = await asyncio.to_thread(
                        evaluate_backend_signal,
                        symbol,
                        backend_alert_config.timeframe,
                    )

                    entry: Dict[str, Any] = {
                        "symbol": symbol,
                        "triggered": bool(signal.get("triggered")),
                        "phase": signal.get("phase"),
                        "setup": signal.get("setup"),
                        "score": signal.get("score"),
                        "message": signal.get("message"),
                        "reason": signal.get("reason"),
                        "became_new": bool(signal.get("became_new")),
                        "features": signal.get("features"),
                    }
                    cycle_results.append(entry)

                    if not signal.get("triggered"):
                        continue

                    phase = str(signal.get("phase") or "none")
                    should_deliver = phase == "confirmed" or (
                        phase == "prealert" and backend_alert_config.alert_on_prealert
                    )
                    if not should_deliver:
                        continue

                    if not can_send_backend_alert(signal, backend_alert_config.cooldown_seconds):
                        continue

                    title = f"{phase.title()} Signal · {signal['symbol']}"

                    if backend_alert_config.notify_phone:
                        await asyncio.to_thread(
                            send_pushover_alert,
                            title,
                            signal["message"],
                            1 if phase == "confirmed" else 0,
                        )

                    if backend_alert_config.notify_webhook and backend_alert_config.webhook_url:
                        await asyncio.to_thread(
                            post_json_webhook,
                            backend_alert_config.webhook_url,
                            {
                                "title": title,
                                "message": signal["message"],
                                "signal": signal,
                            },
                        )

                    mark_backend_alert_sent(signal)
                    backend_alert_last_alert = {
                        "symbol": signal.get("symbol"),
                        "timeframe": signal.get("timeframe"),
                        "setup": signal.get("setup"),
                        "phase": signal.get("phase"),
                        "score": signal.get("score"),
                        "message": signal.get("message"),
                        "sent_at": datetime.now(timezone.utc).isoformat(),
                    }
                except Exception as symbol_exc:
                    cycle_results.append({"symbol": symbol, "triggered": False, "error": str(symbol_exc)})

            backend_alert_last_results = cycle_results[-100:]
            backend_alert_last_check = datetime.now(timezone.utc)
            backend_alert_last_error = None
        except asyncio.CancelledError:
            print("[backend-alert-loop] cancelled", flush=True)
            raise
        except Exception as exc:
            backend_alert_last_error = str(exc)
            print(f"[backend-alert-loop] error: {exc}", flush=True)
            traceback.print_exc()

        await asyncio.sleep(max(5, backend_alert_config.poll_seconds))


def start_backend_alert_task_if_needed() -> None:
    global backend_alert_task

    if backend_alert_task and not backend_alert_task.done():
        return

    backend_alert_task = asyncio.create_task(run_backend_alerts_loop())


async def stop_backend_alert_task() -> None:
    global backend_alert_task

    task = backend_alert_task
    backend_alert_task = None

    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def maybe_auto_save_afterhours_snapshot() -> None:
    global scanner_last_auto_ah_save_date

    now_et = datetime.now(ET)
    hhmm = now_et.hour * 100 + now_et.minute
    trade_date = now_et.strftime("%Y-%m-%d")

    # Save once per ET trade date after the official AH window is complete enough.
    if hhmm < 2000 or scanner_last_auto_ah_save_date == trade_date:
        return

    scanner = registry.get("overnight_runner")
    if scanner is None or not POLYGON_API_KEY:
        return

    try:
        polygon = PolygonService(api_key=POLYGON_API_KEY)
        result = await scanner.save_afterhours_snapshot(
            polygon,
            snapshot_store,
            max_symbols=max(SCANNER_MAX_SYMBOLS, 60),
            min_price=SCANNER_MIN_PRICE,
            max_price=SCANNER_MAX_PRICE,
            min_volume=min(SCANNER_MIN_VOLUME, 100_000),
            min_gap_pct=0.0,
            min_dollar_volume=min(SCANNER_MIN_PM_DOLLAR_VOLUME, 100_000.0),
            hours_back=SCANNER_HOURS_BACK,
        )
        scanner_last_auto_ah_save_date = trade_date
        print(
            f"[scanner-loop] auto AH save saved={result.get('saved')} "
            f"date={result.get('trade_date') or trade_date} count={result.get('count')}",
            flush=True,
        )
    except Exception as exc:
        print(f"[scanner-loop] auto AH save failed: {exc}", flush=True)


async def run_background_scanner_loop() -> None:
    global scanner_cache, scanner_last_run, scanner_last_error, scanner_last_status, scanner_run_count

    print("[scanner-loop] started", flush=True)
    scanner_last_status = "running"

    while True:
        try:
            if not SCANNER_BACKGROUND_ENABLED:
                scanner_last_status = "disabled"
                await asyncio.sleep(1)
                continue

            scanner_last_status = "scanning"
            await maybe_auto_save_afterhours_snapshot()
            scanner = registry.get(SCANNER_ID)
            if scanner is None:
                raise RuntimeError(f"Unknown scanner_id: {SCANNER_ID}")
            if not POLYGON_API_KEY:
                raise RuntimeError("Missing POLYGON_API_KEY in backend environment")

            polygon = PolygonService(api_key=POLYGON_API_KEY)
            result = await scanner.run(
                polygon,
                snapshot_store,
                workflow=SCANNER_WORKFLOW,
                max_symbols=SCANNER_MAX_SYMBOLS,
                min_price=SCANNER_MIN_PRICE,
                max_price=SCANNER_MAX_PRICE,
                min_volume=SCANNER_MIN_VOLUME,
                min_gap_pct=SCANNER_MIN_CHANGE_PCT,
                min_pm_range_pct=SCANNER_MIN_PM_RANGE_PCT,
                min_pm_dollar_volume=SCANNER_MIN_PM_DOLLAR_VOLUME,
                min_compression_score=SCANNER_MIN_COMPRESSION_SCORE,
                min_breakout_score=SCANNER_MIN_BREAKOUT_SCORE,
                hours_back=SCANNER_HOURS_BACK,
            )

            scanner_cache = result
            scanner_last_run = datetime.now(timezone.utc)
            scanner_last_error = None
            scanner_last_status = "running"
            scanner_run_count += 1

            print(
                f"[scanner-loop] updated count={result.get('count')} "
                f"session={result.get('session_mode')} run={scanner_run_count}",
                flush=True,
            )

        except asyncio.CancelledError:
            scanner_last_status = "cancelled"
            print("[scanner-loop] cancelled", flush=True)
            raise
        except Exception as exc:
            scanner_last_error = str(exc)
            scanner_last_status = "error"
            print("[scanner-loop] error:", exc, flush=True)
            traceback.print_exc()

        await asyncio.sleep(SCANNER_INTERVAL_SECONDS)


def start_scanner_task_if_needed() -> None:
    global scanner_task

    if scanner_task and not scanner_task.done():
        return

    scanner_task = asyncio.create_task(run_background_scanner_loop())


async def stop_scanner_task() -> None:
    global scanner_task

    task = scanner_task
    scanner_task = None

    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def scanner_cache_status() -> Dict[str, Any]:
    return {
        "ok": scanner_last_error is None,
        "enabled": SCANNER_BACKGROUND_ENABLED,
        "running": bool(scanner_task and not scanner_task.done()),
        "status": scanner_last_status,
        "last_run": scanner_last_run.isoformat() if scanner_last_run else None,
        "last_error": scanner_last_error,
        "run_count": scanner_run_count,
        "interval_seconds": SCANNER_INTERVAL_SECONDS,
        "filters": {
            "scanner_id": SCANNER_ID,
            "workflow": SCANNER_WORKFLOW,
            "max_symbols": SCANNER_MAX_SYMBOLS,
            "min_price": SCANNER_MIN_PRICE,
            "max_price": SCANNER_MAX_PRICE,
            "min_volume": SCANNER_MIN_VOLUME,
            "min_gap_pct": SCANNER_MIN_CHANGE_PCT,
            "min_pm_range_pct": SCANNER_MIN_PM_RANGE_PCT,
            "min_pm_dollar_volume": SCANNER_MIN_PM_DOLLAR_VOLUME,
            "min_compression_score": SCANNER_MIN_COMPRESSION_SCORE,
            "min_breakout_score": SCANNER_MIN_BREAKOUT_SCORE,
            "hours_back": SCANNER_HOURS_BACK,
        },
        "data": scanner_cache,
    }


@app.on_event("startup")
async def on_startup() -> None:
    get_polygon_http_client()
    start_backend_alert_task_if_needed()
    start_scanner_task_if_needed()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global POLYGON_HTTP_CLIENT
    await stop_backend_alert_task()
    await stop_scanner_task()
    if POLYGON_HTTP_CLIENT is not None and not POLYGON_HTTP_CLIENT.is_closed:
        await POLYGON_HTTP_CLIENT.aclose()


@app.get("/app-state/alpaca")
def get_shared_alpaca_state():
    empty_state = {
        "selectedSymbol": None,
        "watchlist": [],
        "manualWatchlist": [],
        "updatedAt": None,
    }
    if not ALPACA_APP_STATE_FILE.exists():
        return empty_state
    try:
        data = json.loads(ALPACA_APP_STATE_FILE.read_text(encoding="utf-8"))
        return {
            "selectedSymbol": data.get("selectedSymbol"),
            "watchlist": data.get("watchlist") if isinstance(data.get("watchlist"), list) else [],
            "manualWatchlist": data.get("manualWatchlist") if isinstance(data.get("manualWatchlist"), list) else [],
            "updatedAt": data.get("updatedAt"),
        }
    except Exception as exc:
        print("[app-state/alpaca] read error:", exc, flush=True)
        return empty_state


@app.put("/app-state/alpaca")
def put_shared_alpaca_state(payload: SharedAlpacaStatePayload):
    clean = _clean_alpaca_state(payload)
    tmp_file = ALPACA_APP_STATE_FILE.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(clean, indent=2), encoding="utf-8")
    tmp_file.replace(ALPACA_APP_STATE_FILE)
    return clean


@app.get("/health")
def health():
    return {
        "ok": True,
        "polygon_key_loaded": bool(POLYGON_API_KEY),
        "scanner_ids": [item["id"] for item in registry.list()],
        "pushover_configured": bool(
            os.getenv("PUSHOVER_USER_KEY", "").strip()
            and os.getenv("PUSHOVER_APP_TOKEN", "").strip()
        ),
        "backend_alert_loop": {
            "enabled": backend_alert_config.enabled,
            "running": bool(backend_alert_task and not backend_alert_task.done()),
            "symbols": backend_alert_config.symbols,
            "timeframe": backend_alert_config.timeframe,
            "poll_seconds": backend_alert_config.poll_seconds,
            "cooldown_seconds": backend_alert_config.cooldown_seconds,
            "lookback_bars": backend_alert_config.lookback_bars,
            "min_score_confirmed": backend_alert_config.min_score_confirmed,
            "min_score_prealert": backend_alert_config.min_score_prealert,
            "min_rvol": backend_alert_config.min_rvol,
            "require_vwap_reclaim": backend_alert_config.require_vwap_reclaim,
            "alert_on_prealert": backend_alert_config.alert_on_prealert,
            "structure_window": backend_alert_config.structure_window,
            "last_check": backend_alert_last_check.isoformat() if backend_alert_last_check else None,
            "last_error": backend_alert_last_error,
            "last_alert": backend_alert_last_alert,
        },
        "background_scanner": {
            "enabled": SCANNER_BACKGROUND_ENABLED,
            "running": bool(scanner_task and not scanner_task.done()),
            "status": scanner_last_status,
            "last_run": scanner_last_run.isoformat() if scanner_last_run else None,
            "last_error": scanner_last_error,
            "run_count": scanner_run_count,
            "interval_seconds": SCANNER_INTERVAL_SECONDS,
            "cached_count": (scanner_cache or {}).get("count") if scanner_cache else None,
        },
    }


@app.post("/alerts/push")
def push_alert(payload: AlertPayload):
    if not payload.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    title = (payload.title or "Trading Alert").strip() or "Trading Alert"
    message = payload.message.strip()
    result = send_pushover_alert(title=title, message=message, priority=payload.priority)

    return {
        "ok": True,
        "provider": "pushover",
        "title": title,
        "message": message,
        "result": result,
    }


@app.get("/backend-alerts/status")
def backend_alerts_status():
    return {
        "enabled": backend_alert_config.enabled,
        "running": bool(backend_alert_task and not backend_alert_task.done()),
        "symbols": backend_alert_config.symbols,
        "timeframe": backend_alert_config.timeframe,
        "poll_seconds": backend_alert_config.poll_seconds,
        "cooldown_seconds": backend_alert_config.cooldown_seconds,
        "lookback_bars": backend_alert_config.lookback_bars,
        "notify_phone": backend_alert_config.notify_phone,
        "notify_webhook": backend_alert_config.notify_webhook,
        "webhook_url": backend_alert_config.webhook_url,
        "alert_on_prealert": backend_alert_config.alert_on_prealert,
        "min_score_confirmed": backend_alert_config.min_score_confirmed,
        "min_score_prealert": backend_alert_config.min_score_prealert,
        "min_rvol": backend_alert_config.min_rvol,
        "require_vwap_reclaim": backend_alert_config.require_vwap_reclaim,
        "breakout_buffer_pct": backend_alert_config.breakout_buffer_pct,
        "structure_window": backend_alert_config.structure_window,
        "last_check": backend_alert_last_check.isoformat() if backend_alert_last_check else None,
        "last_error": backend_alert_last_error,
        "last_alert": backend_alert_last_alert,
        "recent_results": backend_alert_last_results[-20:],
        "signal_state": {
            key: value for key, value in list(backend_alert_signal_state.items())[-20:]
        },
    }


@app.post("/backend-alerts/config")
async def backend_alerts_config(update: BackendAlertLoopUpdate):
    if update.enabled is not None:
        backend_alert_config.enabled = update.enabled
    if update.symbols is not None:
        backend_alert_config.symbols = [item.strip().upper() for item in update.symbols if item.strip()]
    if update.timeframe is not None:
        backend_alert_config.timeframe = update.timeframe.strip().lower()
    if update.poll_seconds is not None:
        backend_alert_config.poll_seconds = max(5, int(update.poll_seconds))
    if update.cooldown_seconds is not None:
        backend_alert_config.cooldown_seconds = max(30, int(update.cooldown_seconds))
    if update.lookback_bars is not None:
        backend_alert_config.lookback_bars = max(5, int(update.lookback_bars))
    if update.webhook_url is not None:
        backend_alert_config.webhook_url = update.webhook_url.strip() or None
    if update.notify_phone is not None:
        backend_alert_config.notify_phone = update.notify_phone
    if update.notify_webhook is not None:
        backend_alert_config.notify_webhook = update.notify_webhook
    if update.alert_on_prealert is not None:
        backend_alert_config.alert_on_prealert = update.alert_on_prealert
    if update.min_score_confirmed is not None:
        backend_alert_config.min_score_confirmed = float(update.min_score_confirmed)
    if update.min_score_prealert is not None:
        backend_alert_config.min_score_prealert = float(update.min_score_prealert)
    if update.min_rvol is not None:
        backend_alert_config.min_rvol = float(update.min_rvol)
    if update.require_vwap_reclaim is not None:
        backend_alert_config.require_vwap_reclaim = update.require_vwap_reclaim
    if update.breakout_buffer_pct is not None:
        backend_alert_config.breakout_buffer_pct = float(update.breakout_buffer_pct)
    if update.structure_window is not None:
        backend_alert_config.structure_window = max(8, int(update.structure_window))

    start_backend_alert_task_if_needed()
    return backend_alerts_status()


@app.post("/backend-alerts/start")
async def backend_alerts_start(payload: Optional[BackendAlertLoopUpdate] = Body(default=None)):
    if payload is not None:
        await backend_alerts_config(payload)
    backend_alert_config.enabled = True
    start_backend_alert_task_if_needed()
    return backend_alerts_status()


@app.post("/backend-alerts/stop")
async def backend_alerts_stop():
    backend_alert_config.enabled = False
    return backend_alerts_status()


@app.get("/bars", response_model=BarsResponse)
async def get_bars(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query("1m"),
    date_str: Optional[str] = Query(None, alias="date"),
    lookback: Optional[str] = Query(None),
    limit: int = Query(MAX_BARS_DEFAULT, ge=50, le=5000),
):
    normalized_symbol = symbol.upper().strip()
    normalized_timeframe = timeframe.lower().strip()

    if date_str:
        requested_day = parse_requested_date(date_str)
        bars = await fetch_bars_for_day_async(normalized_symbol, normalized_timeframe, requested_day, limit_bars=limit)
        used_day = requested_day

        if not bars:
            probe = requested_day
            for _ in range(7):
                probe = previous_trading_day(probe - timedelta(days=1))
                bars = await fetch_bars_for_day_async(normalized_symbol, normalized_timeframe, probe, limit_bars=limit)
                if bars:
                    used_day = probe
                    break

        return BarsResponse(
            symbol=normalized_symbol,
            timeframe=normalized_timeframe,
            bars=bars,
            trading_date=used_day.strftime("%Y-%m-%d"),
        )

    cache_key = f"{normalized_symbol}::{normalized_timeframe}::{lookback or ''}::{limit}"
    now = datetime.now(timezone.utc)
    cached = BARS_CACHE.get(cache_key)
    if cached is not None:
        age = (now - cached["stored_at"]).total_seconds()
        if age <= BARS_CACHE_TTL_SECONDS:
            return cached["response"]

    in_flight = IN_FLIGHT_BARS_REQUESTS.get(cache_key)
    if in_flight is None or in_flight.done():
        in_flight = asyncio.create_task(
            fetch_bars_range_async(
                normalized_symbol,
                normalized_timeframe,
                lookback=lookback,
                limit_bars=limit,
            )
        )
        IN_FLIGHT_BARS_REQUESTS[cache_key] = in_flight

    try:
        bars, used_day = await in_flight
    finally:
        if IN_FLIGHT_BARS_REQUESTS.get(cache_key) is in_flight:
            IN_FLIGHT_BARS_REQUESTS.pop(cache_key, None)

    response = BarsResponse(
        symbol=normalized_symbol,
        timeframe=normalized_timeframe,
        bars=bars,
        trading_date=used_day.strftime("%Y-%m-%d"),
    )

    BARS_CACHE[cache_key] = {"stored_at": now, "response": response}

    # Keep cache bounded during long sessions.
    if len(BARS_CACHE) > 200:
        oldest_key = min(BARS_CACHE, key=lambda key: BARS_CACHE[key]["stored_at"])
        BARS_CACHE.pop(oldest_key, None)

    return response

@app.get("/last-trade", response_model=LastTradeResponse)
def get_last_trade(symbol: str = Query(..., min_length=1)):
    if not POLYGON_API_KEY:
        return LastTradeResponse(symbol=symbol.upper(), price=None)

    try:
        url = f"https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/{symbol.upper()}"
        params = {"apiKey": POLYGON_API_KEY}

        r = requests.get(url, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()

        ticker = data.get("ticker", {}) or {}
        price = ticker.get("lastTrade", {}).get("p") or ticker.get("day", {}).get("c")

        return LastTradeResponse(symbol=symbol.upper(), price=price)

    except Exception:
        return LastTradeResponse(symbol=symbol.upper(), price=None)


@app.websocket("/ws/market")
async def market_ws(websocket: WebSocket, symbol: str = Query(..., min_length=1)):
    await websocket.accept()
    print(f"[market_ws] accepted for {symbol}", flush=True)

    try:
        await polygon_ws_manager.subscribe_client(websocket, symbol)

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        print(f"[market_ws] frontend disconnected for {symbol}", flush=True)
    except Exception as exc:
        print(f"[market_ws] error for {symbol}: {exc}", flush=True)
        traceback.print_exc()
        try:
            await websocket.send_text(
                json.dumps(
                    [
                        {
                            "ev": "status",
                            "status": "error",
                            "message": str(exc),
                        }
                    ]
                )
            )
        except Exception:
            pass
    finally:
        print(f"[market_ws] closing for {symbol}", flush=True)
        try:
            await polygon_ws_manager.unsubscribe_client(websocket)
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.get("/scanner")
async def scanner_endpoint(
    max_symbols: int = Query(25, ge=1, le=100),
    min_price: float = Query(0.5, ge=0),
    max_price: float = Query(20.0, ge=0),
    min_volume: int = Query(100000, ge=0),
    min_change_pct: float = Query(3.0),
):
    try:
        return await build_scanner(
            max_symbols=max_symbols,
            min_price=min_price,
            max_price=max_price,
            min_volume=min_volume,
            min_change_pct=min_change_pct,
        )
    except Exception as exc:
        print("[scanner] error:", exc, flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/scanner/cache")
def scanner_cache_endpoint():
    return scanner_cache_status()


@app.post("/scanner/cache/refresh")
async def scanner_cache_refresh(
    scanner_id: str = Query(SCANNER_ID, min_length=1),
    workflow: str = Query(SCANNER_WORKFLOW),
    ah_date: Optional[str] = Query(None),
    max_symbols: int = Query(SCANNER_MAX_SYMBOLS, ge=1, le=100),
    min_price: float = Query(SCANNER_MIN_PRICE, ge=0),
    max_price: float = Query(SCANNER_MAX_PRICE, ge=0),
    min_volume: int = Query(SCANNER_MIN_VOLUME, ge=0),
    min_change_pct: float = Query(SCANNER_MIN_CHANGE_PCT),
    min_gap_pct: Optional[float] = Query(None),
    min_pm_range_pct: float = Query(SCANNER_MIN_PM_RANGE_PCT),
    min_pm_dollar_volume: float = Query(SCANNER_MIN_PM_DOLLAR_VOLUME, ge=0),
    min_compression_score: float = Query(SCANNER_MIN_COMPRESSION_SCORE),
    min_breakout_score: float = Query(SCANNER_MIN_BREAKOUT_SCORE),
    max_float_shares: Optional[float] = Query(None),
    low_float_only: bool = Query(False),
    min_short_interest_pct: float = Query(0.0),
    min_turnover_pct: float = Query(0.0),
    hours_back: int = Query(SCANNER_HOURS_BACK, ge=24),
):
    global scanner_cache, scanner_last_run, scanner_last_error, scanner_last_status, scanner_run_count

    try:
        scanner_last_status = "manual-refresh"
        scanner = registry.get(scanner_id)
        if scanner is None:
            raise HTTPException(status_code=404, detail=f"Unknown scanner_id: {scanner_id}")
        if not POLYGON_API_KEY:
            raise HTTPException(status_code=500, detail="Missing POLYGON_API_KEY in backend environment")

        polygon = PolygonService(api_key=POLYGON_API_KEY)
        result = await scanner.run(
            polygon,
            snapshot_store,
            workflow=workflow,
            ah_date=ah_date,
            max_symbols=max_symbols,
            min_price=min_price,
            max_price=max_price,
            min_volume=min_volume,
            min_gap_pct=min_gap_pct if min_gap_pct is not None else min_change_pct,
            min_pm_range_pct=min_pm_range_pct,
            min_pm_dollar_volume=min_pm_dollar_volume,
            min_compression_score=min_compression_score,
            min_breakout_score=min_breakout_score,
            max_float_shares=max_float_shares,
            low_float_only=low_float_only,
            min_short_interest_pct=min_short_interest_pct,
            min_turnover_pct=min_turnover_pct,
            hours_back=hours_back,
        )
        scanner_cache = result
        scanner_last_run = datetime.now(timezone.utc)
        scanner_last_error = None
        scanner_last_status = "running"
        scanner_run_count += 1
        return scanner_cache_status()
    except Exception as exc:
        scanner_last_error = str(exc)
        scanner_last_status = "error"
        print("[scanner/cache/refresh] error:", exc, flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/scanner-v2/list")
async def scanner_v2_list():
    return registry.list()


@app.get("/scanner-v2/overnight/snapshots")
async def scanner_v2_overnight_snapshots(scanner_id: str = Query("overnight_runner")):
    scanner = registry.get(scanner_id)
    if scanner is None:
        raise HTTPException(status_code=404, detail=f"Unknown scanner_id: {scanner_id}")

    dates = scanner.list_saved_snapshot_dates(snapshot_store)
    return {
        "scanner_id": scanner_id,
        "dates": dates,
        "latest": dates[0] if dates else None,
    }


@app.post("/scanner-v2/overnight/save-ah")
async def scanner_v2_save_afterhours(
    scanner_id: str = Query("overnight_runner", min_length=1),
    max_symbols: int = Query(50, ge=1, le=150),
    min_price: float = Query(0.5, ge=0),
    max_price: float = Query(20.0, ge=0),
    min_volume: int = Query(100000, ge=0),
    min_gap_pct: float = Query(0.0),
    min_dollar_volume: float = Query(100000.0, ge=0),
    hours_back: int = Query(96, ge=24),
):
    scanner = registry.get(scanner_id)
    if scanner is None:
        raise HTTPException(status_code=404, detail=f"Unknown scanner_id: {scanner_id}")

    if not POLYGON_API_KEY:
        raise HTTPException(status_code=500, detail="Missing POLYGON_API_KEY in backend environment")

    try:
        polygon = PolygonService(api_key=POLYGON_API_KEY)
        result = await scanner.save_afterhours_snapshot(
            polygon,
            snapshot_store,
            max_symbols=max_symbols,
            min_price=min_price,
            max_price=max_price,
            min_volume=min_volume,
            min_gap_pct=min_gap_pct,
            min_dollar_volume=min_dollar_volume,
            hours_back=hours_back,
        )

        if isinstance(result, dict):
            path = result.get("path") or result.get("saved_path")
            if path:
                print(f"[scanner-v2/save-ah] saved file: {path}", flush=True)

        return result
    except Exception as exc:
        print("[scanner-v2/save-ah] error:", exc, flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/scanner-v2/run")
async def scanner_v2_run(
    scanner_id: str = Query(..., min_length=1),
    workflow: str = Query("combined"),
    ah_date: Optional[str] = Query(None),
    max_symbols: int = Query(25, ge=1, le=100),
    min_price: float = Query(0.5, ge=0),
    max_price: float = Query(20.0, ge=0),
    min_volume: int = Query(100000, ge=0),
    min_gap_pct: float = Query(3.0),
    min_pm_range_pct: float = Query(4.5),
    min_pm_dollar_volume: float = Query(500000.0, ge=0),
    min_compression_score: float = Query(0.0),
    min_breakout_score: float = Query(0.0),
    max_float_shares: Optional[float] = Query(None),
    low_float_only: bool = Query(False),
    min_short_interest_pct: float = Query(0.0),
    min_turnover_pct: float = Query(0.0),
    hours_back: int = Query(96, ge=24),
):
    scanner = registry.get(scanner_id)
    if scanner is None:
        raise HTTPException(status_code=404, detail=f"Unknown scanner_id: {scanner_id}")

    if not POLYGON_API_KEY:
        raise HTTPException(status_code=500, detail="Missing POLYGON_API_KEY in backend environment")

    normalized_workflow = normalize_workflow(workflow)

    try:
        polygon = PolygonService(api_key=POLYGON_API_KEY)
        return await scanner.run(
            polygon,
            snapshot_store,
            workflow=normalized_workflow,
            ah_date=ah_date,
            max_symbols=max_symbols,
            min_price=min_price,
            max_price=max_price,
            min_volume=min_volume,
            min_gap_pct=min_gap_pct,
            min_pm_range_pct=min_pm_range_pct,
            min_pm_dollar_volume=min_pm_dollar_volume,
            min_compression_score=min_compression_score,
            min_breakout_score=min_breakout_score,
            max_float_shares=max_float_shares,
            low_float_only=low_float_only,
            min_short_interest_pct=min_short_interest_pct,
            min_turnover_pct=min_turnover_pct,
            hours_back=hours_back,
        )
    except Exception as exc:
        print("[scanner-v2/run] error:", exc, flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/alpaca/account")
def alpaca_account(mode: str = Query("paper")):
    print("ALPACA ACCOUNT ROUTE HIT:", mode, flush=True)
    try:
        service = get_alpaca_service(mode)
        result = service.get_account()
        print("ALPACA ACCOUNT SUCCESS", flush=True)
        return result
    except Exception as exc:
        print("ALPACA ACCOUNT ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/alpaca/positions")
def alpaca_positions(mode: str = Query("paper")):
    print("ALPACA POSITIONS ROUTE HIT:", mode, flush=True)
    try:
        service = get_alpaca_service(mode)
        result = service.get_positions()
        print("ALPACA POSITIONS SUCCESS", flush=True)
        return result
    except Exception as exc:
        print("ALPACA POSITIONS ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=str(exc))


@app.delete("/alpaca/order/{order_id}")
def cancel_alpaca_order(order_id: str, mode: str = Query("paper")):
    try:
        service = get_alpaca_service(mode)
        service.cancel_order(order_id)
        return {"ok": True, "order_id": order_id}
    except Exception as exc:
        print("ALPACA CANCEL ORDER ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/alpaca/orders")
def alpaca_orders(
    mode: str = Query("paper"),
    status: str = Query("open"),
    limit: int = Query(25, ge=1, le=200),
):
    print("ALPACA ORDERS ROUTE HIT:", mode, status, limit, flush=True)
    try:
        service = get_alpaca_service(mode)
        result = service.get_orders(status=status, limit=limit)
        print("ALPACA ORDERS SUCCESS", flush=True)
        return result
    except Exception as exc:
        print("ALPACA ORDERS ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=str(exc))


@app.patch("/alpaca/order/{order_id}")
def update_order(order_id: str, request: dict, mode: str = Query("paper")):
    try:
        service = get_alpaca_service(mode)

        updated = service.update_order(
            order_id=order_id,
            qty=request.get("qty"),
            limit_price=request.get("limit_price"),
            stop_price=request.get("stop_price"),
            time_in_force=request.get("time_in_force"),
        )

        return updated

    except Exception as exc:
        print("ALPACA UPDATE ORDER ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/alpaca/order")
def alpaca_order(request: AlpacaOrderRequest):
    print(
        "ALPACA ORDER ROUTE HIT:",
        request.mode,
        request.symbol,
        request.side,
        request.type,
        flush=True,
    )

    if not request.symbol.strip():
        raise HTTPException(status_code=400, detail="symbol is required")

    if request.qty is None and request.notional is None:
        raise HTTPException(status_code=400, detail="qty or notional is required")

    if request.qty is not None and request.qty <= 0:
        raise HTTPException(status_code=400, detail="qty must be greater than 0")

    if request.notional is not None and request.notional <= 0:
        raise HTTPException(status_code=400, detail="notional must be greater than 0")

    if request.type == "limit" and (request.limit_price is None or request.limit_price <= 0):
        raise HTTPException(status_code=400, detail="limit_price must be provided for limit orders")

    try:
        service = get_alpaca_service(request.mode)
        order = service.place_order(
            symbol=request.symbol,
            side=request.side,
            order_type=request.type,
            time_in_force=request.time_in_force,
            qty=request.qty,
            notional=request.notional,
            limit_price=request.limit_price,
            extended_hours=request.extended_hours,
        )
        print("ALPACA ORDER SUCCESS", flush=True)
        return order
    except Exception as exc:
        print("ALPACA ORDER ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=str(exc))
