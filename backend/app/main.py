
import asyncio
import json
import os
import traceback
import sys
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
    import fcntl  # Linux server background-lock guard
except Exception:  # Windows/local dev fallback
    fcntl = None  # type: ignore


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
BARS_CACHE_TTL_SECONDS = 45
MAX_BARS_DEFAULT = 650
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


class AlpacaTakeProfitRequest(BaseModel):
    limit_price: Optional[float] = None


class AlpacaStopLossRequest(BaseModel):
    stop_price: Optional[float] = None
    limit_price: Optional[float] = None


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
    order_class: Optional[str] = None
    take_profit: Optional[AlpacaTakeProfitRequest] = None
    stop_loss: Optional[AlpacaStopLossRequest] = None


class AlertPayload(BaseModel):
    message: str
    title: Optional[str] = "Trading Alert"
    priority: int = 1


class SharedAlpacaStatePayload(BaseModel):
    selectedSymbol: Optional[str] = None
    timeframe: Optional[str] = None
    activeChart: Optional[str] = None
    watchlist: List[str] = []
    manualWatchlist: List[str] = []
    studyVisibility: Optional[Dict[str, Any]] = None
    chartRanges: Dict[str, Dict[str, float]] = {}
    updatedAt: Optional[float] = None


APP_STATE_DIR = Path(__file__).resolve().parent / "data" / "app_state"
APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
ALPACA_APP_STATE_FILE = APP_STATE_DIR / "alpaca_state.json"

# Gunicorn can run multiple workers. Without a process lock, each worker starts
# its own scanner + backend-alert loop. This lock lets only one worker run
# background loops while every worker can still serve API/chart/websocket traffic.
BACKGROUND_LOCK_FILE = APP_STATE_DIR / "background_worker.lock"
BACKGROUND_LOCK_HANDLE: Optional[Any] = None
BACKGROUND_LOCK_HELD = False
BACKGROUND_EVENT_LOOP: Optional[asyncio.AbstractEventLoop] = None


def acquire_background_worker_lock() -> bool:
    global BACKGROUND_LOCK_HANDLE, BACKGROUND_LOCK_HELD

    if BACKGROUND_LOCK_HELD:
        return True

    if fcntl is None:
        # Local Windows/dev fallback: do not block startup. On production Linux,
        # fcntl is available and prevents duplicate scanner/alert loops.
        BACKGROUND_LOCK_HELD = True
        return True

    try:
        BACKGROUND_LOCK_HANDLE = BACKGROUND_LOCK_FILE.open("w")
        fcntl.flock(BACKGROUND_LOCK_HANDLE.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        BACKGROUND_LOCK_HANDLE.write(f"pid={os.getpid()} started={datetime.now(timezone.utc).isoformat()}\n")
        BACKGROUND_LOCK_HANDLE.flush()
        BACKGROUND_LOCK_HELD = True
        print(f"[background-lock] acquired by pid={os.getpid()}", flush=True)
        return True
    except BlockingIOError:
        BACKGROUND_LOCK_HELD = False
        print(f"[background-lock] another worker owns scanner/alerts; pid={os.getpid()} serving API only", flush=True)
        return False
    except Exception as exc:
        BACKGROUND_LOCK_HELD = False
        print(f"[background-lock] failed to acquire: {exc}", flush=True)
        return False


def release_background_worker_lock() -> None:
    global BACKGROUND_LOCK_HANDLE, BACKGROUND_LOCK_HELD
    if BACKGROUND_LOCK_HANDLE is None:
        BACKGROUND_LOCK_HELD = False
        return
    try:
        if fcntl is not None:
            fcntl.flock(BACKGROUND_LOCK_HANDLE.fileno(), fcntl.LOCK_UN)
        BACKGROUND_LOCK_HANDLE.close()
    except Exception:
        pass
    finally:
        BACKGROUND_LOCK_HANDLE = None
        BACKGROUND_LOCK_HELD = False


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
    timeframe = str(payload.timeframe or "1m").lower().strip()
    if timeframe not in {"1m", "5m", "15m", "30m", "1h", "1d", "day"}:
        timeframe = "1m"

    active_chart = str(payload.activeChart or "").lower().strip()
    if active_chart not in {"1m", "5m", "15m"}:
        active_chart = timeframe if timeframe in {"1m", "5m", "15m"} else ""

    chart_ranges: Dict[str, Dict[str, float]] = {}
    if isinstance(payload.chartRanges, dict):
        for raw_key, raw_range in payload.chartRanges.items():
            if not isinstance(raw_range, dict):
                continue
            try:
                from_value = float(raw_range.get("from"))
                to_value = float(raw_range.get("to"))
            except Exception:
                continue
            if to_value <= from_value:
                continue
            clean_key = str(raw_key).upper().strip()[:80]
            if clean_key:
                chart_ranges[clean_key] = {"from": from_value, "to": to_value}

    study_visibility = payload.studyVisibility if isinstance(payload.studyVisibility, dict) else {}

    return {
        "selectedSymbol": selected or None,
        "timeframe": timeframe,
        "activeChart": active_chart or None,
        "watchlist": watchlist,
        "manualWatchlist": manual,
        "studyVisibility": study_visibility,
        "chartRanges": chart_ranges,
        "updatedAt": payload.updatedAt or datetime.now(timezone.utc).timestamp() * 1000,
    }


class BackendAlertLoopConfig(BaseModel):
    enabled: bool = False
    symbols: List[str] = []
    # Multi-timeframe alert engine. Keep timeframe for backward compatibility.
    timeframe: str = "1m"
    timeframes: List[str] = ["1m"]
    confluence_mode: str = "any"  # "any" or "all"
    alert_setups: List[str] = [
        "compression_abs_breakout",
        "failed_breakdown_reclaim",
        "aggressive_buyers_reclaim",
        "bullish_structure_shift",
    ]
    poll_seconds: int = 5
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
    # Smart alert scaling keeps alerts fast during active sessions and light overnight.
    smart_scaling_enabled: bool = True
    use_scanner_symbols_when_empty: bool = True
    max_dynamic_symbols: int = 8
    min_poll_seconds: int = 10
    max_poll_seconds: int = 45


class BackendAlertLoopUpdate(BaseModel):
    enabled: Optional[bool] = None
    symbols: Optional[List[str]] = None
    # Accept both old single-timeframe payloads and new multi-timeframe payloads.
    timeframe: Optional[str] = None
    timeframes: Optional[List[str]] = None
    confluence_mode: Optional[str] = None
    alert_setups: Optional[List[str]] = None
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
    smart_scaling_enabled: Optional[bool] = None
    use_scanner_symbols_when_empty: Optional[bool] = None
    max_dynamic_symbols: Optional[int] = None
    min_poll_seconds: Optional[int] = None
    max_poll_seconds: Optional[int] = None


class InstantChartAlertPayload(BaseModel):
    symbol: str
    timeframe: str = "1m"
    setup: str
    phase: str = "confirmed"
    score: float = 80.0
    message: str
    reason: Optional[str] = None
    features: Dict[str, Any] = {}
    source: str = "frontend"
    debounce_key: Optional[str] = None



SUPPORTED_ALERT_TIMEFRAMES = {"1m", "5m", "15m", "30m", "1h"}
SUPPORTED_ALERT_SETUPS = {
    "compression_abs_breakout",
    "failed_breakdown_reclaim",
    "aggressive_buyers_reclaim",
    "bullish_structure_shift",
    "ifvg_retest",
    "ifvg_bounce_confirmed",
    "ifvg_failure",
    # Chart/drawing alert setups
    "trendline_close_cross",
    "trendline_near",
    "projection_touch_cross",
    "vwap_reclaim",
    "pmh_break",
    "rth_high_break",
    "ah_high_break",
}


def normalize_alert_timeframes(values: Optional[List[str]], fallback: str = "1m") -> List[str]:
    out: List[str] = []
    for raw in values or []:
        tf = str(raw or "").lower().strip()
        if tf in SUPPORTED_ALERT_TIMEFRAMES and tf not in out:
            out.append(tf)
    if not out:
        fb = str(fallback or "1m").lower().strip()
        out = [fb if fb in SUPPORTED_ALERT_TIMEFRAMES else "1m"]
    return out


def normalize_alert_setups(values: Optional[List[str]]) -> List[str]:
    out: List[str] = []
    for raw in values or []:
        setup = str(raw or "").strip()
        if setup in SUPPORTED_ALERT_SETUPS and setup not in out:
            out.append(setup)
    return out or sorted(SUPPORTED_ALERT_SETUPS)


# No default symbols. The alert list should be controlled only from the UI.
# This prevents AAPL/NVDA/TSLA/AMD or env defaults from reappearing on fresh starts.
DEFAULT_ALERT_SYMBOLS: List[str] = []
ALERT_SYMBOLS_FILE = APP_STATE_DIR / "backend_alert_selected_symbols.json"


def load_persisted_alert_symbols() -> List[str]:
    try:
        if not ALERT_SYMBOLS_FILE.exists():
            return []
        data = json.loads(ALERT_SYMBOLS_FILE.read_text(encoding="utf-8"))
        raw = data.get("symbols") if isinstance(data, dict) else data
        return _normalize_symbol_list(list(raw or []))
    except Exception as exc:
        print(f"[backend-alerts] failed to load selected symbols: {exc}", flush=True)
        return []


def save_persisted_alert_symbols(symbols: List[str]) -> None:
    clean = _normalize_symbol_list(symbols)
    payload = {
        "symbols": clean,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source": "app_selected",
    }
    tmp_file = ALERT_SYMBOLS_FILE.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp_file.replace(ALERT_SYMBOLS_FILE)


backend_alert_config = BackendAlertLoopConfig(
    enabled=os.getenv("BACKEND_ALERTS_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"},
    symbols=load_persisted_alert_symbols() or DEFAULT_ALERT_SYMBOLS,
    timeframe=os.getenv("BACKEND_ALERTS_TIMEFRAME", "1m").strip().lower() or "1m",
    timeframes=normalize_alert_timeframes(
        os.getenv("BACKEND_ALERTS_TIMEFRAMES", os.getenv("BACKEND_ALERTS_TIMEFRAME", "1m")).split(",")
    ),
    confluence_mode=(os.getenv("BACKEND_ALERTS_CONFLUENCE_MODE", "any").strip().lower() if os.getenv("BACKEND_ALERTS_CONFLUENCE_MODE", "any").strip().lower() in {"any", "all"} else "any"),
    alert_setups=normalize_alert_setups(os.getenv("BACKEND_ALERTS_ALERT_SETUPS", "").split(",")),
    poll_seconds=max(5, int(os.getenv("BACKEND_ALERTS_POLL_SECONDS", "5") or "5")),
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
    smart_scaling_enabled=os.getenv("BACKEND_ALERTS_SMART_SCALING_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"},
    use_scanner_symbols_when_empty=os.getenv("BACKEND_ALERTS_USE_SCANNER_SYMBOLS_WHEN_EMPTY", "false").strip().lower() in {"1", "true", "yes", "on"},
    max_dynamic_symbols=max(1, int(os.getenv("BACKEND_ALERTS_MAX_DYNAMIC_SYMBOLS", "8") or "8")),
    min_poll_seconds=max(10, int(os.getenv("BACKEND_ALERTS_MIN_POLL_SECONDS", "10") or "10")),
    max_poll_seconds=max(10, int(os.getenv("BACKEND_ALERTS_MAX_POLL_SECONDS", "45") or "45")),
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


# === AUTO TRADE STATE (paper-first guarded execution) ===
class AutoTradeConfig(BaseModel):
    enabled: bool = False
    mode: str = "paper"  # hard-guarded to paper unless allow_live=True
    allow_live: bool = False
    source: str = "manual"  # manual | scanner | both
    timeframe: str = "1m"
    sizing_mode: str = "dollars"  # dollars | shares
    trade_amount: float = 500.0
    fixed_shares: int = 100
    max_active_trades: int = 1
    min_profit_range: float = 0.15
    sweep_buffer_pct: float = 0.001
    stop_buffer_pct: float = 0.002
    poll_seconds: int = 10
    extended_hours: bool = False
    max_symbols: int = 12
    require_flat_account: bool = True
    max_signal_age_bars: int = 3
    runner_mode: str = "off"  # off | scale_trail
    scale_out_pct: float = 0.50
    trail_lookback_bars: int = 2
    trail_buffer_pct: float = 0.002


class AutoTradeConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = None
    allow_live: Optional[bool] = None
    source: Optional[str] = None
    timeframe: Optional[str] = None
    sizing_mode: Optional[str] = None
    trade_amount: Optional[float] = None
    fixed_shares: Optional[int] = None
    max_active_trades: Optional[int] = None
    min_profit_range: Optional[float] = None
    sweep_buffer_pct: Optional[float] = None
    stop_buffer_pct: Optional[float] = None
    poll_seconds: Optional[int] = None
    extended_hours: Optional[bool] = None
    max_symbols: Optional[int] = None
    require_flat_account: Optional[bool] = None
    max_signal_age_bars: Optional[int] = None
    runner_mode: Optional[str] = None
    scale_out_pct: Optional[float] = None
    trail_lookback_bars: Optional[int] = None
    trail_buffer_pct: Optional[float] = None


auto_trade_config = AutoTradeConfig()
auto_trade_task: Optional[asyncio.Task] = None
auto_trade_last_check: Optional[datetime] = None
auto_trade_last_error: Optional[str] = None
auto_trade_last_status: str = "stopped"
auto_trade_last_skip: Optional[Dict[str, Any]] = None
auto_trade_last_signal: Optional[Dict[str, Any]] = None
auto_trade_last_order: Optional[Dict[str, Any]] = None
auto_trade_history: List[Dict[str, Any]] = []
auto_trade_fired_signal_ids: Dict[str, str] = {}
auto_trade_runner_states: Dict[str, Dict[str, Any]] = {}


def _auto_trade_log(event: Dict[str, Any]) -> None:
    event = {**event, "ts": datetime.now(timezone.utc).isoformat()}
    auto_trade_history.append(event)
    if len(auto_trade_history) > 100:
        del auto_trade_history[:-100]


def _auto_trade_status_payload() -> Dict[str, Any]:
    return {
        "config": auto_trade_config.dict(),
        "running": bool(auto_trade_task and not auto_trade_task.done()),
        "status": auto_trade_last_status,
        "last_check": auto_trade_last_check.isoformat() if auto_trade_last_check else None,
        "last_error": auto_trade_last_error,
        "last_skip": auto_trade_last_skip,
        "last_signal": auto_trade_last_signal,
        "last_order": auto_trade_last_order,
        "runner_states": auto_trade_runner_states,
        "history": auto_trade_history[-30:],
    }


def _apply_auto_trade_update(update: AutoTradeConfigUpdate) -> None:
    data = update.dict(exclude_unset=True)
    for key, value in data.items():
        if key == "mode":
            value = str(value or "paper").lower().strip()
            if value not in {"paper", "live"}:
                raise HTTPException(status_code=400, detail="mode must be paper or live")
        if key == "source":
            value = str(value or "manual").lower().strip()
            if value not in {"manual", "scanner", "both"}:
                raise HTTPException(status_code=400, detail="source must be manual, scanner, or both")
        if key == "timeframe":
            value = str(value or "1m").lower().strip()
            if value not in {"1m", "5m", "15m"}:
                raise HTTPException(status_code=400, detail="timeframe must be 1m, 5m, or 15m")
        if key == "sizing_mode":
            value = str(value or "dollars").lower().strip()
            if value not in {"dollars", "shares"}:
                raise HTTPException(status_code=400, detail="sizing_mode must be dollars or shares")
        if key == "runner_mode":
            value = str(value or "off").lower().strip()
            if value not in {"off", "scale_trail"}:
                raise HTTPException(status_code=400, detail="runner_mode must be off or scale_trail")
        if key in {"trade_amount", "min_profit_range", "sweep_buffer_pct", "stop_buffer_pct", "trail_buffer_pct"}:
            value = max(0.0, float(value))
        if key == "scale_out_pct":
            value = max(0.1, min(0.9, float(value)))
        if key in {"fixed_shares", "max_active_trades", "poll_seconds", "max_symbols", "max_signal_age_bars", "trail_lookback_bars"}:
            value = max(1, int(value))
        setattr(auto_trade_config, key, value)

    # hard safety: live cannot be enabled by accident from the simple UI
    if auto_trade_config.mode == "live" and not auto_trade_config.allow_live:
        auto_trade_config.enabled = False
        raise HTTPException(status_code=400, detail="Auto trade live mode is locked. Keep mode paper or explicitly allow_live first.")


def _load_auto_trade_manual_symbols() -> List[str]:
    try:
        if not ALPACA_APP_STATE_FILE.exists():
            return []
        data = json.loads(ALPACA_APP_STATE_FILE.read_text(encoding="utf-8"))
        manual = data.get("manualWatchlist") if isinstance(data, dict) else []
        selected = data.get("selectedSymbol") if isinstance(data, dict) else None
        return _normalize_symbol_list([*(manual or []), selected or ""])
    except Exception:
        return []


def _load_auto_trade_scanner_symbols() -> List[str]:
    rows = (scanner_cache or {}).get("rows") if isinstance(scanner_cache, dict) else []
    symbols = [str(row.get("symbol") or "") for row in rows or [] if isinstance(row, dict)]
    return _normalize_symbol_list(symbols)


def _auto_trade_symbols() -> List[str]:
    source = auto_trade_config.source
    symbols: List[str] = []
    if source in {"manual", "both"}:
        symbols.extend(_load_auto_trade_manual_symbols())
    if source in {"scanner", "both"}:
        symbols.extend(_load_auto_trade_scanner_symbols())
    return _normalize_symbol_list(symbols)[: max(1, int(auto_trade_config.max_symbols))]


def _bar_et_datetime(row: Dict[str, Any]) -> datetime:
    raw = int(float(row.get("time", row.get("t", 0)) or 0))
    if raw < 10_000_000_000:
        raw *= 1000
    return datetime.fromtimestamp(raw / 1000, ET)


def _find_bullish_six_seven_signal(symbol: str, timeframe: str) -> Optional[Dict[str, Any]]:
    bars = fetch_signal_bars(symbol, timeframe)
    if len(bars) < 20:
        return None

    latest_day = _bar_et_datetime(bars[-1]).date()
    day_bars = [b for b in bars if _bar_et_datetime(b).date() == latest_day]
    range_bars = []
    after_bars = []
    for bar in day_bars:
        dt = _bar_et_datetime(bar)
        hhmm = dt.hour * 100 + dt.minute
        if 900 <= hhmm < 1000:
            range_bars.append(bar)
        elif hhmm >= 1000:
            after_bars.append(bar)

    if not range_bars or not after_bars:
        return None

    range_low = min(_safe_price(b.get("low")) for b in range_bars)
    range_close = _safe_price(range_bars[-1].get("close"))
    if range_low <= 0 or range_close <= 0 or range_close <= range_low:
        return None

    min_range = float(auto_trade_config.min_profit_range)
    profit_range = range_close - range_low
    if profit_range < min_range:
        return {
            "symbol": symbol.upper(),
            "tradable": False,
            "skip_reason": f"range too small: ${profit_range:.2f} < ${min_range:.2f}",
            "entry_price": round(range_low, 4),
            "target_price": round(range_close, 4),
            "profit_range": round(profit_range, 4),
        }

    threshold = range_low * (1.0 - float(auto_trade_config.sweep_buffer_pct))
    sweep_low: Optional[float] = None
    signal_bar_index: Optional[int] = None
    signal_bar: Optional[Dict[str, Any]] = None

    for idx, bar in enumerate(after_bars):
        low = _safe_price(bar.get("low"))
        close = _safe_price(bar.get("close"))
        if low < threshold:
            sweep_low = low if sweep_low is None else min(sweep_low, low)
        if sweep_low is not None and close > range_low:
            signal_bar_index = idx
            signal_bar = bar

    if signal_bar is None or signal_bar_index is None or sweep_low is None:
        return None

    bars_since = len(after_bars) - 1 - signal_bar_index
    if bars_since > max(1, int(auto_trade_config.max_signal_age_bars)):
        return None

    signal_dt = _bar_et_datetime(signal_bar)
    signal_id = f"six_seven_bull::{symbol.upper()}::{latest_day.isoformat()}::{int(float(signal_bar.get('time', signal_bar.get('t', 0)) or 0))}"
    entry_price = round(range_low, 4)
    target_price = round(range_close, 4)
    stop_price = round(float(sweep_low) * (1.0 - float(auto_trade_config.stop_buffer_pct)), 4)

    return {
        "symbol": symbol.upper(),
        "tradable": True,
        "signal_id": signal_id,
        "setup": "bullish_6_7_low_sweep_retest",
        "timeframe": timeframe,
        "signal_time": signal_dt.isoformat(),
        "entry_price": entry_price,
        "target_price": target_price,
        "stop_price": stop_price,
        "range_low": round(range_low, 4),
        "range_close": target_price,
        "sweep_low": round(float(sweep_low), 4),
        "profit_range": round(target_price - entry_price, 4),
        "bars_since_signal": bars_since,
    }


def _auto_trade_active_count(positions: List[Dict[str, Any]], orders: List[Dict[str, Any]]) -> int:
    open_orders = [o for o in orders or [] if str(o.get("status") or "").lower() not in {"filled", "canceled", "expired", "rejected"}]
    open_positions = []
    for p in positions or []:
        try:
            qty = abs(float(p.get("qty") or 0))
        except Exception:
            qty = 0.0
        if qty > 0:
            open_positions.append(p)
    if auto_trade_config.require_flat_account:
        return len(open_orders) + len(open_positions)
    auto_orders = [o for o in open_orders if str(o.get("client_order_id") or "").startswith("autotrade_")]
    return len(auto_orders)


def _auto_trade_required_qty(entry_price: float, buying_power: float) -> int:
    if auto_trade_config.sizing_mode == "shares":
        qty = int(auto_trade_config.fixed_shares)
        required = qty * entry_price
        if required > buying_power:
            return 0
        return max(0, qty)
    dollars = min(float(auto_trade_config.trade_amount), buying_power)
    return max(0, int(dollars // entry_price))


def _auto_trade_try_execute(symbol: str) -> Dict[str, Any]:
    signal = _find_bullish_six_seven_signal(symbol, auto_trade_config.timeframe)
    if not signal:
        return {"symbol": symbol.upper(), "action": "none", "reason": "no fresh bullish 6-7 sweep"}
    if not signal.get("tradable"):
        return {"symbol": symbol.upper(), "action": "skip", "reason": signal.get("skip_reason"), "signal": signal}

    signal_id = str(signal.get("signal_id"))
    if auto_trade_fired_signal_ids.get(symbol.upper()) == signal_id:
        return {"symbol": symbol.upper(), "action": "skip", "reason": "signal already handled", "signal": signal}

    mode = auto_trade_config.mode
    if mode == "live" and not auto_trade_config.allow_live:
        return {"symbol": symbol.upper(), "action": "skip", "reason": "live mode locked", "signal": signal}

    service = get_alpaca_service(mode)
    account = service.get_account()
    positions = service.get_positions()
    orders = service.get_orders(status="open", limit=100, nested=True)

    active_count = _auto_trade_active_count(positions, orders)
    if active_count >= int(auto_trade_config.max_active_trades):
        return {"symbol": symbol.upper(), "action": "skip", "reason": "active trade/order lockout", "active_count": active_count, "signal": signal}

    buying_power = _safe_price(account.get("buying_power"), default=_safe_price(account.get("cash")))
    entry_price = float(signal["entry_price"])
    qty = _auto_trade_required_qty(entry_price, buying_power)
    if qty <= 0:
        return {"symbol": symbol.upper(), "action": "skip", "reason": "insufficient buying power", "buying_power": buying_power, "signal": signal}

    client_order_id = f"autotrade_{symbol.upper()}_{int(datetime.now(timezone.utc).timestamp())}"

    if auto_trade_config.runner_mode == "scale_trail" and qty >= 2:
        # Runner mode: place the entry only. Once it fills, the loop submits
        # a 50% OCO target/stop and a separate dynamic runner stop for the rest.
        order = service.place_order(
            symbol=symbol,
            side="buy",
            order_type="limit",
            time_in_force="day",
            qty=qty,
            limit_price=entry_price,
            extended_hours=bool(auto_trade_config.extended_hours),
            client_order_id=client_order_id,
        )
        auto_trade_runner_states[symbol.upper()] = {
            "phase": "entry_submitted",
            "symbol": symbol.upper(),
            "signal_id": signal_id,
            "entry_order_id": order.get("id"),
            "entry_price": entry_price,
            "target_price": float(signal["target_price"]),
            "stop_price": float(signal["stop_price"]),
            "qty": qty,
            "scale_qty": max(1, int(qty * float(auto_trade_config.scale_out_pct))),
            "runner_qty": max(1, qty - max(1, int(qty * float(auto_trade_config.scale_out_pct)))),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    else:
        order = service.place_order(
            symbol=symbol,
            side="buy",
            order_type="limit",
            time_in_force="day",
            qty=qty,
            limit_price=entry_price,
            extended_hours=bool(auto_trade_config.extended_hours),
            client_order_id=client_order_id,
            order_class="bracket",
            take_profit={"limit_price": float(signal["target_price"])},
            stop_loss={"stop_price": float(signal["stop_price"])},
        )

    auto_trade_fired_signal_ids[symbol.upper()] = signal_id
    return {"symbol": symbol.upper(), "action": "ordered", "qty": qty, "order": order, "signal": signal, "runner_mode": auto_trade_config.runner_mode}


def _auto_trade_latest_trail_stop(symbol: str, current_stop: float) -> Optional[float]:
    """Raise-only trailing stop under the last N completed candle lows."""
    try:
        bars = fetch_signal_bars(symbol, auto_trade_config.timeframe)
    except Exception:
        return None
    lookback = max(1, int(auto_trade_config.trail_lookback_bars))
    closed = bars[:-1] if len(bars) > lookback + 1 else bars
    recent = closed[-lookback:]
    lows = [_safe_price(b.get("low")) for b in recent]
    lows = [x for x in lows if x > 0]
    if not lows:
        return None
    candidate = round(min(lows) * (1.0 - float(auto_trade_config.trail_buffer_pct)), 4)
    if candidate > float(current_stop):
        return candidate
    return None


def _auto_trade_position_qty(positions: List[Dict[str, Any]], symbol: str) -> float:
    symbol_u = symbol.upper()
    for pos in positions or []:
        if str(pos.get("symbol") or "").upper() != symbol_u:
            continue
        try:
            return abs(float(pos.get("qty") or 0))
        except Exception:
            return 0.0
    return 0.0


def _auto_trade_manage_runner_states() -> None:
    """Manage filled runner-mode entries and raise runner stops.

    This is deliberately conservative and paper-first:
    - entry order is placed first
    - after fill, half gets OCO target/stop
    - remaining shares get a stop that only moves upward
    """
    if not auto_trade_runner_states:
        return
    mode = auto_trade_config.mode
    service = get_alpaca_service(mode)
    positions = service.get_positions()

    for symbol, state in list(auto_trade_runner_states.items()):
        phase = str(state.get("phase") or "")
        try:
            if phase == "entry_submitted":
                order_id = str(state.get("entry_order_id") or "")
                if not order_id:
                    state["phase"] = "error"
                    state["error"] = "missing entry order id"
                    continue
                order = service.get_order(order_id, nested=True)
                status = str(order.get("status") or "").lower()
                if status in {"canceled", "expired", "rejected"}:
                    state["phase"] = status
                    continue
                filled_qty = int(float(order.get("filled_qty") or 0))
                if status != "filled" and filled_qty <= 0:
                    continue

                qty = max(1, int(float(order.get("filled_qty") or state.get("qty") or 0)))
                scale_qty = max(1, min(qty - 1, int(qty * float(auto_trade_config.scale_out_pct)))) if qty >= 2 else qty
                runner_qty = max(0, qty - scale_qty)
                target = float(state.get("target_price") or 0)
                stop = float(state.get("stop_price") or 0)

                scale_order = None
                runner_stop = None
                if scale_qty > 0 and target > 0 and stop > 0:
                    scale_order = service.place_order(
                        symbol=symbol,
                        side="sell",
                        order_type="limit",
                        time_in_force="day",
                        qty=scale_qty,
                        limit_price=target,
                        extended_hours=bool(auto_trade_config.extended_hours),
                        client_order_id=f"autotrade_scale_{symbol}_{int(datetime.now(timezone.utc).timestamp())}",
                        order_class="oco",
                        take_profit={"limit_price": target},
                        stop_loss={"stop_price": stop},
                    )
                if runner_qty > 0 and stop > 0:
                    runner_stop = service.place_order(
                        symbol=symbol,
                        side="sell",
                        order_type="stop",
                        time_in_force="day",
                        qty=runner_qty,
                        stop_price=stop,
                        extended_hours=bool(auto_trade_config.extended_hours),
                        client_order_id=f"autotrade_runner_stop_{symbol}_{int(datetime.now(timezone.utc).timestamp())}",
                    )

                state.update({
                    "phase": "exits_submitted",
                    "filled_qty": qty,
                    "scale_qty": scale_qty,
                    "runner_qty": runner_qty,
                    "scale_order_id": (scale_order or {}).get("id"),
                    "runner_stop_id": (runner_stop or {}).get("id"),
                    "runner_stop_price": stop,
                    "filled_at": datetime.now(timezone.utc).isoformat(),
                })
                _auto_trade_log({"event": "runner_exits_submitted", "symbol": symbol, "state": dict(state)})
                continue

            if phase == "exits_submitted":
                pos_qty = _auto_trade_position_qty(positions, symbol)
                if pos_qty <= 0:
                    state["phase"] = "closed"
                    state["closed_at"] = datetime.now(timezone.utc).isoformat()
                    _auto_trade_log({"event": "runner_closed", "symbol": symbol, "state": dict(state)})
                    continue

                runner_stop_id = str(state.get("runner_stop_id") or "")
                current_stop = float(state.get("runner_stop_price") or state.get("stop_price") or 0)
                if not runner_stop_id or current_stop <= 0:
                    continue

                next_stop = _auto_trade_latest_trail_stop(symbol, current_stop)
                if next_stop is None:
                    continue

                try:
                    updated = service.update_order(runner_stop_id, stop_price=next_stop)
                    state["runner_stop_price"] = next_stop
                    state["last_trail_update"] = datetime.now(timezone.utc).isoformat()
                    state["last_trail_order"] = updated
                    _auto_trade_log({"event": "runner_stop_raised", "symbol": symbol, "stop_price": next_stop})
                except Exception as exc:
                    # Do not kill the whole auto-trade loop if Alpaca rejects a replace while filling.
                    state["last_trail_error"] = str(exc)

        except Exception as exc:
            state["phase"] = "error"
            state["error"] = str(exc)
            _auto_trade_log({"event": "runner_error", "symbol": symbol, "error": str(exc)})


async def run_auto_trade_loop() -> None:
    global auto_trade_last_check, auto_trade_last_error, auto_trade_last_status, auto_trade_last_skip, auto_trade_last_signal, auto_trade_last_order
    print("[auto-trade-loop] started", flush=True)
    while True:
        try:
            if not auto_trade_config.enabled:
                auto_trade_last_status = "disabled"
                await asyncio.sleep(1)
                continue

            await asyncio.to_thread(_auto_trade_manage_runner_states)

            auto_trade_last_status = "scanning"
            symbols = _auto_trade_symbols()
            auto_trade_last_check = datetime.now(timezone.utc)
            if not symbols:
                auto_trade_last_skip = {"reason": "no symbols selected", "source": auto_trade_config.source}
                auto_trade_last_status = "idle"
                await asyncio.sleep(max(3, int(auto_trade_config.poll_seconds)))
                continue

            for symbol in symbols:
                result = await asyncio.to_thread(_auto_trade_try_execute, symbol)
                action = result.get("action")
                if action == "ordered":
                    auto_trade_last_order = result
                    auto_trade_last_signal = result.get("signal")
                    auto_trade_last_skip = None
                    auto_trade_last_status = "ordered"
                    _auto_trade_log({"event": "ordered", **result})
                    break
                if action == "skip":
                    auto_trade_last_skip = result
                    _auto_trade_log({"event": "skip", **result})
            else:
                auto_trade_last_status = "watching"

            auto_trade_last_error = None
        except asyncio.CancelledError:
            auto_trade_last_status = "cancelled"
            print("[auto-trade-loop] cancelled", flush=True)
            raise
        except Exception as exc:
            auto_trade_last_error = str(exc)
            auto_trade_last_status = "error"
            print(f"[auto-trade-loop] error: {exc}", flush=True)
            traceback.print_exc()

        await asyncio.sleep(max(3, int(auto_trade_config.poll_seconds)))


def start_auto_trade_task_if_needed() -> None:
    global auto_trade_task
    if auto_trade_task and not auto_trade_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
        auto_trade_task = loop.create_task(run_auto_trade_loop())
        return
    except RuntimeError:
        pass
    loop = BACKGROUND_EVENT_LOOP
    if loop is not None and loop.is_running():
        def _start_on_loop() -> None:
            global auto_trade_task
            if auto_trade_task and not auto_trade_task.done():
                return
            auto_trade_task = loop.create_task(run_auto_trade_loop())
        loop.call_soon_threadsafe(_start_on_loop)


async def stop_auto_trade_task() -> None:
    global auto_trade_task
    task = auto_trade_task
    auto_trade_task = None
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

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


def is_intraday_timeframe(timeframe: str) -> bool:
    return timeframe.lower().strip() in {"1m", "5m", "15m", "30m", "1h"}


def is_daily_timeframe(timeframe: str) -> bool:
    return timeframe.lower().strip() in {"1d", "day", "daily", "d"}


def normalize_daily_session(session: Optional[str]) -> str:
    value = str(session or "regular").lower().strip()
    if value in {"regular", "rth", "market", "reg", "normal"}:
        return "regular"
    if value in {"extended", "ext", "full", "full_session", "all", "ah", "afterhours", "premarket"}:
        return "extended"
    raise HTTPException(status_code=400, detail="session must be 'regular'/'rth' or 'extended'/'ext'")


def bar_is_in_daily_session(ms: int, session: str) -> bool:
    dt = datetime.fromtimestamp(ms / 1000, ET)
    hhmm = dt.hour * 100 + dt.minute
    if session == "extended":
        return 400 <= hhmm < 2000
    return 930 <= hhmm < 1600


def aggregate_intraday_to_daily_bars(
    intraday_bars: List[Candle],
    *,
    session: str,
    limit_bars: Optional[int] = MAX_BARS_DEFAULT,
) -> List[Candle]:
    """Build live 1D candles from intraday bars.

    Polygon daily aggregates can lag until the day is complete. This function
    creates the current in-progress daily candle from 1m bars so the 1D chart
    updates during the active session.
    """
    grouped: Dict[date, Dict[str, Any]] = {}

    for bar in sorted(intraday_bars, key=lambda item: int(item.time)):
        if not bar_is_in_daily_session(int(bar.time), session):
            continue

        dt = datetime.fromtimestamp(int(bar.time) / 1000, ET)
        day = dt.date()
        bucket = grouped.get(day)

        if bucket is None:
            open_dt = datetime(day.year, day.month, day.day, 9, 30 if session == "regular" else 0, tzinfo=ET)
            if session == "extended":
                open_dt = datetime(day.year, day.month, day.day, 4, 0, tzinfo=ET)
            bucket = {
                "time": int(open_dt.timestamp() * 1000),
                "open": float(bar.open),
                "high": float(bar.high),
                "low": float(bar.low),
                "close": float(bar.close),
                "volume": float(bar.volume),
                "last_time": int(bar.time),
            }
            grouped[day] = bucket
            continue

        bucket["high"] = max(float(bucket["high"]), float(bar.high))
        bucket["low"] = min(float(bucket["low"]), float(bar.low))
        bucket["close"] = float(bar.close)
        bucket["volume"] = float(bucket["volume"]) + float(bar.volume)
        bucket["last_time"] = int(bar.time)

    daily = [
        Candle(
            time=int(row["time"]),
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=float(row["volume"]),
        )
        for _, row in sorted(grouped.items(), key=lambda item: item[0])
    ]

    if limit_bars is not None and limit_bars > 0 and len(daily) > limit_bars:
        daily = daily[-limit_bars:]

    return daily


def daily_session_trading_date(bars: List[Candle]) -> date:
    if bars:
        return datetime.fromtimestamp(int(bars[-1].time) / 1000, ET).date()
    return previous_trading_day()


def extended_session_window_ms(
    *,
    timeframe: str,
    lookback: Optional[str] = None,
    end_day: Optional[date] = None,
) -> tuple[int, int, date]:
    """Return an exact Polygon aggregate window.

    Intraday charts are anchored to the full extended-hours equity session in ET:
    04:00 through 20:00. This prevents charts from being cut at the regular
    close / partial date boundary and lets prior days show AH candles through 20:00
    when Polygon has trades for those bars. Daily charts keep the old full-day
    behavior.
    """
    now_et = datetime.now(ET)
    requested_today = end_day is None
    final_day = previous_trading_day(end_day or now_et.date())
    lookback_days = resolve_lookback_days(lookback, timeframe)
    start_day = final_day - timedelta(days=lookback_days)

    if is_intraday_timeframe(timeframe):
        start_dt = datetime(start_day.year, start_day.month, start_day.day, 4, 0, tzinfo=ET)
        full_ah_end = datetime(final_day.year, final_day.month, final_day.day, 20, 0, tzinfo=ET)

        # For live/current-day charts, do not ask Polygon for a future end time.
        # For historical date requests, always ask through 20:00 ET so AH is complete.
        if requested_today and now_et.date() == final_day and now_et < full_ah_end:
            end_dt = now_et
        else:
            end_dt = full_ah_end
    else:
        start_dt = datetime(start_day.year, start_day.month, start_day.day, 0, 0, tzinfo=ET)
        end_dt = datetime(final_day.year, final_day.month, final_day.day, 23, 59, 59, 999000, tzinfo=ET)

    return int(start_dt.timestamp() * 1000), int(end_dt.timestamp() * 1000), final_day


def _intraday_step_ms(timeframe: str) -> int:
    tf = timeframe.lower().strip()
    if tf in {"1m", "1min", "1"}:
        return 60_000
    if tf in {"5m", "5min", "5"}:
        return 5 * 60_000
    if tf in {"15m", "15min", "15"}:
        return 15 * 60_000
    if tf in {"30m", "30min", "30"}:
        return 30 * 60_000
    if tf in {"1h", "60m", "60min", "hour"}:
        return 60 * 60_000
    return 60_000


def _session_tail_end_ms(final_day: date, timeframe: str, end_ms: int) -> int:
    """End of the visible extended-hours chart tail.

    For live/current-day data before 20:00 ET, end_ms is already capped at now.
    For completed days, this is 20:00 ET. The returned value is snapped down to
    the chart interval so the final flat bar lands cleanly on the time scale.
    """
    if not is_intraday_timeframe(timeframe):
        return end_ms

    step_ms = _intraday_step_ms(timeframe)
    ah_end = datetime(final_day.year, final_day.month, final_day.day, 20, 0, tzinfo=ET)
    target_ms = min(int(ah_end.timestamp() * 1000), int(end_ms))
    return (target_ms // step_ms) * step_ms


def fill_intraday_tail_to_extended_close(
    bars: List[Candle],
    *,
    timeframe: str,
    final_day: date,
    end_ms: int,
) -> List[Candle]:
    """Add zero-volume flat bars from the last real trade to the visible AH end.

    Polygon only returns aggregate bars when trades occur. If the last after-hours
    trade is at 16:45, Lightweight Charts thinks the time scale ends at 16:45.
    TOS keeps the extended-hours axis open until 20:00. These synthetic tail bars
    only extend the visual timeline; they preserve price by using the last close
    and volume=0.
    """
    if not bars or not is_intraday_timeframe(timeframe):
        return bars

    bars = sorted(bars, key=lambda bar: bar.time)
    last = bars[-1]

    try:
        last_dt = datetime.fromtimestamp(last.time / 1000, ET)
    except Exception:
        return bars

    # Only extend the final loaded trading day. Do not fill old days inside a
    # multi-day lookback because that would add too many artificial candles.
    if last_dt.date() != final_day:
        return bars

    step_ms = _intraday_step_ms(timeframe)
    target_ms = _session_tail_end_ms(final_day, timeframe, end_ms)
    next_ms = ((int(last.time) // step_ms) + 1) * step_ms

    if next_ms > target_ms:
        return bars

    existing = {int(bar.time) for bar in bars}
    close = float(last.close)
    tail: List[Candle] = []

    current_ms = next_ms
    # Hard cap prevents runaway if a bad timeframe/end leaks in.
    max_fill = 1_200
    while current_ms <= target_ms and len(tail) < max_fill:
        if current_ms not in existing:
            tail.append(
                Candle(
                    time=current_ms,
                    open=close,
                    high=close,
                    low=close,
                    close=close,
                    volume=0.0,
                )
            )
        current_ms += step_ms

    if tail:
        print(
            f"[bars] filled AH tail timeframe={timeframe} "
            f"from={datetime.fromtimestamp(next_ms / 1000, ET).strftime('%H:%M')} "
            f"to={datetime.fromtimestamp(target_ms / 1000, ET).strftime('%H:%M')} "
            f"count={len(tail)}",
            flush=True,
        )

    return bars + tail


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
    start_ms, end_ms, final_day = extended_session_window_ms(
        timeframe=timeframe,
        lookback=lookback,
        end_day=end_day,
    )

    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{symbol.upper()}/range/"
        f"{multiplier}/{timespan}/{start_ms}/{end_ms}"
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

    bars = fill_intraday_tail_to_extended_close(
        bars,
        timeframe=timeframe,
        final_day=final_day,
        end_ms=end_ms,
    )

    if limit_bars is not None and limit_bars > 0 and len(bars) > limit_bars:
        bars = bars[-limit_bars:]

    return bars, final_day


async def fetch_bars_for_day_async(
    symbol: str,
    timeframe: str,
    trading_day: date,
    limit_bars: Optional[int] = MAX_BARS_DEFAULT,
    session: str = "regular",
) -> List[Candle]:
    if is_daily_timeframe(timeframe):
        intraday_bars, _ = await fetch_bars_range_async(symbol, "1m", "1d", trading_day, limit_bars=None)
        daily = aggregate_intraday_to_daily_bars(intraday_bars, session=session, limit_bars=limit_bars)
        return [bar for bar in daily if datetime.fromtimestamp(bar.time / 1000, ET).date() == trading_day]

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
    start_ms, end_ms, final_day = extended_session_window_ms(
        timeframe=timeframe,
        lookback=lookback,
        end_day=end_day,
    )

    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{symbol.upper()}/range/"
        f"{multiplier}/{timespan}/{start_ms}/{end_ms}"
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

    bars = fill_intraday_tail_to_extended_close(
        bars,
        timeframe=timeframe,
        final_day=final_day,
        end_ms=end_ms,
    )

    if limit_bars is not None and limit_bars > 0 and len(bars) > limit_bars:
        bars = bars[-limit_bars:]

    return bars, final_day

def fetch_bars_for_day(
    symbol: str,
    timeframe: str,
    trading_day: date,
    limit_bars: Optional[int] = MAX_BARS_DEFAULT,
    session: str = "regular",
) -> List[Candle]:
    if is_daily_timeframe(timeframe):
        intraday_bars, _ = fetch_bars_range(symbol, "1m", "1d", trading_day, limit_bars=None)
        daily = aggregate_intraday_to_daily_bars(intraday_bars, session=session, limit_bars=limit_bars)
        return [bar for bar in daily if datetime.fromtimestamp(bar.time / 1000, ET).date() == trading_day]

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
    """Fetch alert bars through the same bounded in-memory cache used by charts.

    The old alert loop could refetch Polygon bars for every symbol/timeframe on
    every cycle. This keeps alerts responsive while preventing the alert engine
    from competing with the chart UI for network and CPU.
    """
    normalized_symbol = symbol.upper().strip()
    normalized_timeframe = timeframe.lower().strip()
    lookback = "2d"
    limit = min(MAX_BARS_DEFAULT, 650)
    cache_key = f"SIGNAL::{normalized_symbol}::{normalized_timeframe}::{lookback}::{limit}"
    now = datetime.now(timezone.utc)

    cached = BARS_CACHE.get(cache_key)
    if cached is not None:
        age = (now - cached["stored_at"]).total_seconds()
        if age <= min(BARS_CACHE_TTL_SECONDS, 30):
            response = cached.get("response")
            cached_bars = getattr(response, "bars", None)
            if cached_bars is not None:
                return [
                    {
                        "time": bar.time,
                        "open": bar.open,
                        "high": bar.high,
                        "low": bar.low,
                        "close": bar.close,
                        "volume": bar.volume,
                    }
                    for bar in cached_bars
                ]

    bars, used_day = fetch_bars_range(normalized_symbol, normalized_timeframe, lookback=lookback, limit_bars=limit)
    response = BarsResponse(
        symbol=normalized_symbol,
        timeframe=normalized_timeframe,
        bars=bars,
        trading_date=used_day.strftime("%Y-%m-%d"),
    )
    BARS_CACHE[cache_key] = {"stored_at": datetime.now(timezone.utc), "response": response}

    if len(BARS_CACHE) > 250:
        oldest_key = min(BARS_CACHE, key=lambda key: BARS_CACHE[key]["stored_at"])
        BARS_CACHE.pop(oldest_key, None)

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




def setup_allowed(signal: Dict[str, Any]) -> bool:
    setup = signal.get("setup")
    if not setup:
        return True
    allowed = normalize_alert_setups(backend_alert_config.alert_setups)
    return str(setup) in set(allowed)


def signal_is_deliverable(signal: Dict[str, Any]) -> bool:
    if not signal.get("triggered"):
        return False
    if not setup_allowed(signal):
        return False
    phase = str(signal.get("phase") or "none")
    return phase == "confirmed" or (phase == "prealert" and backend_alert_config.alert_on_prealert)


def pick_best_signal(signals: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not signals:
        return {}
    return max(signals, key=lambda s: float(s.get("score") or 0.0))


# -----------------------------
# Chart/drawing alert helpers
# -----------------------------

def _bar_time_seconds(bar: Dict[str, Any]) -> int:
    raw = bar.get("time", bar.get("t", 0))
    try:
        value = int(float(raw))
    except Exception:
        return 0
    return value // 1000 if value > 10_000_000_000 else value


def _safe_price(value: Any, default: float = 0.0) -> float:
    try:
        price = float(value)
        return price if price > 0 and price < 1_000_000 else default
    except Exception:
        return default


def _build_chart_alert_signal(
    *,
    symbol: str,
    timeframe: str,
    setup: str,
    phase: str,
    score: float,
    message: str,
    reason: str,
    features: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "symbol": symbol.upper(),
        "timeframe": timeframe,
        "triggered": phase in {"confirmed", "prealert"},
        "phase": phase,
        "setup": setup,
        "score": round(float(score), 2),
        "became_new": True,
        "reason": reason,
        "features": features or {},
        "message": message,
    }


def _line_price_at_time(line: Dict[str, Any], chart_time: int) -> Optional[float]:
    try:
        slope = float(line.get("slope"))
    except Exception:
        slope = float("nan")
    try:
        intercept = float(line.get("intercept"))
    except Exception:
        intercept = float("nan")

    if slope == slope and intercept == intercept:  # not NaN
        price = slope * chart_time + intercept
        if price > 0 and price < 1_000_000:
            return price

    t1 = _safe_price(line.get("t1"))
    t2 = _safe_price(line.get("t2"))
    p1 = _safe_price(line.get("p1"))
    p2 = _safe_price(line.get("p2"))
    if not t1 or not t2 or not p1 or not p2:
        return None
    if t1 == t2:
        return p2
    return p1 + (p2 - p1) * ((chart_time - t1) / (t2 - t1))


def _get_saved_trendlines_for_alerts(symbol: str, timeframe: str) -> List[Dict[str, Any]]:
    shared = _read_chart_items(symbol, "shared", "trendlines")
    local = _read_chart_items(symbol, timeframe, "trendlines")
    by_id: Dict[str, Dict[str, Any]] = {}
    for item in [*shared, *local]:
        if not isinstance(item, dict):
            continue
        line_id = str(item.get("id") or "")
        if not line_id:
            continue
        by_id[line_id] = item
    return list(by_id.values())


def _get_saved_projections_for_alerts(symbol: str) -> List[Dict[str, Any]]:
    rows = _read_chart_items(symbol, "shared", "projections")
    return [row for row in rows if isinstance(row, dict)]


def _near_pct(price: float, level: float) -> float:
    if level <= 0:
        return 999.0
    return abs(price - level) / level


def _crossed_level(prev_close: float, close: float, level: float) -> Optional[str]:
    if prev_close <= level < close:
        return "above"
    if prev_close >= level > close:
        return "below"
    return None


def _session_kind_for_bar_ms(ms: int) -> str:
    try:
        dt = datetime.fromtimestamp(ms / 1000, ET)
    except Exception:
        return "unknown"
    hhmm = dt.hour * 100 + dt.minute
    if 400 <= hhmm < 930:
        return "premarket"
    if 930 <= hhmm < 1600:
        return "regular"
    if 1600 <= hhmm < 2000:
        return "afterhours"
    return "overnight"


def _same_et_date_ms(a_ms: int, b_ms: int) -> bool:
    try:
        return datetime.fromtimestamp(a_ms / 1000, ET).date() == datetime.fromtimestamp(b_ms / 1000, ET).date()
    except Exception:
        return False


def _rolling_vwap_from_bars(bars: List[Dict[str, Any]], window: int = 40) -> float:
    recent = bars[-window:] if len(bars) > window else bars
    pv = 0.0
    vol = 0.0
    for bar in recent:
        h = _safe_price(bar.get("high"))
        l = _safe_price(bar.get("low"))
        c = _safe_price(bar.get("close"))
        v = _safe_price(bar.get("volume"), default=0.0)
        if h > 0 and l > 0 and c > 0 and v > 0:
            pv += ((h + l + c) / 3.0) * v
            vol += v
    return pv / vol if vol > 0 else 0.0


def evaluate_chart_study_alerts(symbol: str, timeframe: str, raw_bars: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if len(raw_bars) < 2:
        return []

    bars = raw_bars
    prev = bars[-2]
    last = bars[-1]
    prev_close = _safe_price(prev.get("close"))
    close = _safe_price(last.get("close"))
    high = _safe_price(last.get("high"))
    low = _safe_price(last.get("low"))
    last_time_s = _bar_time_seconds(last)
    prev_time_s = _bar_time_seconds(prev)
    symbol_u = symbol.upper()
    out: List[Dict[str, Any]] = []
    near_threshold = 0.0025  # 0.25% near-line/level warning

    # Manual/saved trendlines
    for line in _get_saved_trendlines_for_alerts(symbol_u, timeframe):
        curr_line = _line_price_at_time(line, last_time_s)
        prev_line = _line_price_at_time(line, prev_time_s)
        if curr_line is None or prev_line is None or close <= 0 or prev_close <= 0:
            continue
        line_label = str(line.get("label") or line.get("id") or "trendline")[:40]
        direction = None
        if prev_close <= prev_line < close:
            direction = "above"
        elif prev_close >= prev_line > close:
            direction = "below"
        if direction:
            out.append(_build_chart_alert_signal(
                symbol=symbol_u,
                timeframe=timeframe,
                setup="trendline_close_cross",
                phase="confirmed",
                score=92.0,
                message=f"{symbol_u} closed {direction} trendline on {timeframe} | close {close:.4f} | line {curr_line:.4f}",
                reason=f"Trendline close cross | line={line_label} | close={close:.4f} | line_price={curr_line:.4f}",
                features={"trendline_id": line.get("id"), "line_price": curr_line, "direction": direction},
            ))
            continue
        dist = _near_pct(close, curr_line)
        if dist <= near_threshold:
            out.append(_build_chart_alert_signal(
                symbol=symbol_u,
                timeframe=timeframe,
                setup="trendline_near",
                phase="prealert",
                score=max(55.0, 78.0 - dist * 6000.0),
                message=f"{symbol_u} is near trendline on {timeframe} | close {close:.4f} | line {curr_line:.4f}",
                reason=f"Near trendline | distance={dist * 100:.2f}% | line={line_label}",
                features={"trendline_id": line.get("id"), "line_price": curr_line, "distance_pct": dist * 100.0},
            ))

    # Saved projection/support/resistance levels
    for proj in _get_saved_projections_for_alerts(symbol_u):
        level = _safe_price(proj.get("price"))
        if level <= 0:
            continue
        title = str(proj.get("title") or "saved projection")[:60]
        cross = _crossed_level(prev_close, close, level)
        touched = low <= level <= high if high > 0 and low > 0 else False
        if cross or touched:
            phase = "confirmed" if cross else "prealert"
            action = f"crossed {cross}" if cross else "touched"
            out.append(_build_chart_alert_signal(
                symbol=symbol_u,
                timeframe=timeframe,
                setup="projection_touch_cross",
                phase=phase,
                score=88.0 if cross else 68.0,
                message=f"{symbol_u} {action} saved projection on {timeframe} | level {level:.4f} | close {close:.4f}",
                reason=f"Saved projection {action} | {title} | level={level:.4f}",
                features={"projection_id": proj.get("id"), "level": level, "action": action},
            ))
            continue
        dist = _near_pct(close, level)
        if dist <= near_threshold:
            out.append(_build_chart_alert_signal(
                symbol=symbol_u,
                timeframe=timeframe,
                setup="projection_touch_cross",
                phase="prealert",
                score=max(54.0, 72.0 - dist * 5000.0),
                message=f"{symbol_u} is near saved projection on {timeframe} | level {level:.4f} | close {close:.4f}",
                reason=f"Near saved projection | distance={dist * 100:.2f}% | {title}",
                features={"projection_id": proj.get("id"), "level": level, "distance_pct": dist * 100.0},
            ))

    # VWAP reclaim from recent bars
    vwap = _rolling_vwap_from_bars(bars, window=max(backend_alert_config.lookback_bars * 3, 20))
    if vwap > 0 and prev_close > 0 and close > 0:
        if prev_close <= vwap < close:
            out.append(_build_chart_alert_signal(
                symbol=symbol_u,
                timeframe=timeframe,
                setup="vwap_reclaim",
                phase="confirmed",
                score=86.0,
                message=f"{symbol_u} reclaimed VWAP on {timeframe} | close {close:.4f} | VWAP {vwap:.4f}",
                reason=f"VWAP reclaim | prev_close={prev_close:.4f} | close={close:.4f} | vwap={vwap:.4f}",
                features={"vwap": vwap},
            ))
        elif _near_pct(close, vwap) <= near_threshold:
            out.append(_build_chart_alert_signal(
                symbol=symbol_u,
                timeframe=timeframe,
                setup="vwap_reclaim",
                phase="prealert",
                score=62.0,
                message=f"{symbol_u} is near VWAP on {timeframe} | close {close:.4f} | VWAP {vwap:.4f}",
                reason=f"Near VWAP | distance={_near_pct(close, vwap) * 100:.2f}%",
                features={"vwap": vwap},
            ))

    # Session reference levels from the latest ET date in loaded bars
    latest_ms = int(float(last.get("time", last.get("t", 0)) or 0))
    same_day_bars = [b for b in bars if _same_et_date_ms(int(float(b.get("time", b.get("t", 0)) or 0)), latest_ms)]
    levels: Dict[str, float] = {}
    for session, setup in [("premarket", "pmh_break"), ("regular", "rth_high_break"), ("afterhours", "ah_high_break")]:
        session_bars = [b for b in same_day_bars[:-1] if _session_kind_for_bar_ms(int(float(b.get("time", b.get("t", 0)) or 0))) == session]
        highs = [_safe_price(b.get("high")) for b in session_bars]
        highs = [x for x in highs if x > 0]
        if highs:
            levels[setup] = max(highs)

    for setup, level in levels.items():
        cross = _crossed_level(prev_close, close, level)
        if cross == "above":
            pretty = {"pmh_break": "PMH", "rth_high_break": "RTH high", "ah_high_break": "AH high"}.get(setup, setup)
            out.append(_build_chart_alert_signal(
                symbol=symbol_u,
                timeframe=timeframe,
                setup=setup,
                phase="confirmed",
                score=84.0,
                message=f"{symbol_u} broke {pretty} on {timeframe} | close {close:.4f} | level {level:.4f}",
                reason=f"{pretty} break | close={close:.4f} | level={level:.4f}",
                features={"level": level, "reference": pretty},
            ))

    return out

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



def _current_et_session_label() -> str:
    now_et = datetime.now(ET)
    hhmm = now_et.hour * 100 + now_et.minute
    if 400 <= hhmm < 930:
        return "premarket"
    if 930 <= hhmm < 1600:
        return "regular"
    if 1600 <= hhmm < 2000:
        return "afterhours"
    return "closed"


def get_dynamic_alert_symbols() -> List[str]:
    """Return app-selected symbols for backend alerts.

    Pro mode rule: alerts never auto-arm every scanner symbol. The scanner can
    discover candidates, but the UI must explicitly arm each symbol. This keeps
    the backend fast and stops phone/webhook spam when the scanner list changes.
    """
    selected = _normalize_symbol_list(backend_alert_config.symbols)
    return selected[: max(1, int(backend_alert_config.max_dynamic_symbols))]


def selected_symbol_is_armed(symbol: str) -> bool:
    clean = _normalize_symbol_list([symbol])
    if not clean:
        return False
    return clean[0] in set(get_dynamic_alert_symbols())

def get_effective_alert_poll_seconds(symbol_count: int) -> int:
    """Smart scaling: fast when it matters, slower when the market is quiet."""
    base = max(5, int(backend_alert_config.poll_seconds))
    if not backend_alert_config.smart_scaling_enabled:
        return base

    session = _current_et_session_label()
    if session == "regular":
        target = max(10, min(base, 15))
    elif session in {"premarket", "afterhours"}:
        target = max(12, min(base, 20))
    else:
        target = max(base, 30)

    # Keep the backend smooth if the scanner returns a large active list.
    if symbol_count >= 12:
        target = max(target, 20)
    elif symbol_count >= 8:
        target = max(target, 15)

    low = max(5, int(backend_alert_config.min_poll_seconds))
    high = max(low, int(backend_alert_config.max_poll_seconds))
    return max(low, min(high, int(target)))

async def run_backend_alerts_loop() -> None:
    global backend_alert_last_check, backend_alert_last_error, backend_alert_last_results, backend_alert_last_alert

    print("[backend-alert-loop] started", flush=True)

    while True:
        try:
            if not backend_alert_config.enabled:
                await asyncio.sleep(1)
                continue

            active_alert_symbols = get_dynamic_alert_symbols()
            effective_poll_seconds = get_effective_alert_poll_seconds(len(active_alert_symbols))

            if not active_alert_symbols:
                backend_alert_last_results = []
                backend_alert_last_check = datetime.now(timezone.utc)
                backend_alert_last_error = None
                await asyncio.sleep(effective_poll_seconds)
                continue

            cycle_results: List[Dict[str, Any]] = []

            for raw_symbol in active_alert_symbols:
                symbol = raw_symbol.strip().upper()
                if not symbol:
                    continue

                try:
                    timeframes = normalize_alert_timeframes(
                        backend_alert_config.timeframes,
                        fallback=backend_alert_config.timeframe,
                    )
                    tf_results: List[Dict[str, Any]] = []

                    for tf in timeframes:
                        bars_for_tf = await asyncio.to_thread(fetch_signal_bars, symbol, tf)
                        signal = await asyncio.to_thread(
                            evaluate_symbol_signal,
                            symbol,
                            tf,
                            bars_for_tf,
                            signal_state_from_dict(backend_alert_signal_state.get(signal_state_key(symbol, tf))),
                            build_signal_engine_config(),
                        )
                        state = signal.get("state")
                        if state is not None:
                            backend_alert_signal_state[signal_state_key(symbol, tf)] = signal_state_to_dict(state)

                        tf_signals = [signal]
                        tf_signals.extend(evaluate_chart_study_alerts(symbol, tf, bars_for_tf))

                        for candidate in tf_signals:
                            tf_results.append(candidate)
                            cycle_results.append({
                                "symbol": symbol,
                                "timeframe": tf,
                                "triggered": bool(candidate.get("triggered")) and setup_allowed(candidate),
                                "phase": candidate.get("phase"),
                                "setup": candidate.get("setup"),
                                "score": candidate.get("score"),
                                "message": candidate.get("message"),
                                "reason": candidate.get("reason"),
                                "became_new": bool(candidate.get("became_new")),
                                "features": candidate.get("features"),
                            })

                    deliverable = [sig for sig in tf_results if signal_is_deliverable(sig)]

                    if backend_alert_config.confluence_mode == "all":
                        deliverable_timeframes = {str(sig.get("timeframe")) for sig in deliverable if sig.get("timeframe")}
                        if not set(timeframes).issubset(deliverable_timeframes):
                            continue
                        signal = pick_best_signal(deliverable)
                    else:
                        if not deliverable:
                            continue
                        signal = pick_best_signal(deliverable)

                    if not signal:
                        continue
                    if not can_send_backend_alert(signal, backend_alert_config.cooldown_seconds):
                        continue

                    phase = str(signal.get("phase") or "none")
                    triggered_timeframes = [str(sig.get("timeframe")) for sig in deliverable if sig.get("timeframe")]
                    title = f"{phase.title()} · {signal['symbol']} ({signal.get('timeframe')})"
                    if backend_alert_config.confluence_mode == "all" and len(triggered_timeframes) > 1:
                        title = f"Confluence {phase.title()} · {signal['symbol']} ({'/'.join(triggered_timeframes)})"

                    message = str(signal.get("message") or "")
                    if triggered_timeframes:
                        message = f"{message} | TFs: {', '.join(triggered_timeframes)}"

                    if backend_alert_config.notify_phone:
                        await asyncio.to_thread(
                            send_pushover_alert,
                            title,
                            message,
                            1 if phase == "confirmed" else 0,
                        )

                    if backend_alert_config.notify_webhook and backend_alert_config.webhook_url:
                        await asyncio.to_thread(
                            post_json_webhook,
                            backend_alert_config.webhook_url,
                            {
                                "title": title,
                                "message": message,
                                "signal": signal,
                                "timeframes": triggered_timeframes,
                                "confluence_mode": backend_alert_config.confluence_mode,
                            },
                        )

                    mark_backend_alert_sent(signal)
                    backend_alert_last_alert = {
                        "symbol": signal.get("symbol"),
                        "timeframe": signal.get("timeframe"),
                        "timeframes": triggered_timeframes,
                        "confluence_mode": backend_alert_config.confluence_mode,
                        "setup": signal.get("setup"),
                        "phase": signal.get("phase"),
                        "score": signal.get("score"),
                        "message": message,
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

        await asyncio.sleep(get_effective_alert_poll_seconds(len(get_dynamic_alert_symbols())))


def start_backend_alert_task_if_needed() -> None:
    """Start the backend alert loop only from an active asyncio event loop.

    Gunicorn/FastAPI can execute normal def routes inside a worker thread. Those
    threads do not have a running event loop, so calling asyncio.create_task()
    from a bell-toggle route can raise: RuntimeError: no running event loop.

    We capture the startup event loop in BACKGROUND_EVENT_LOOP and schedule the
    task thread-safely when this function is called from a sync route.
    """
    global backend_alert_task

    if backend_alert_task and not backend_alert_task.done():
        return

    try:
        loop = asyncio.get_running_loop()
        backend_alert_task = loop.create_task(run_backend_alerts_loop())
        return
    except RuntimeError:
        pass

    loop = BACKGROUND_EVENT_LOOP
    if loop is not None and loop.is_running():
        def _start_on_loop() -> None:
            global backend_alert_task
            if backend_alert_task and not backend_alert_task.done():
                return
            backend_alert_task = loop.create_task(run_backend_alerts_loop())

        loop.call_soon_threadsafe(_start_on_loop)
        return

    # No running loop is available in this process/thread. This can happen if a
    # non-background Gunicorn worker receives the API request. The locked
    # background worker will start/continue the loop from startup.
    print("[backend-alert-loop] start skipped: no running event loop in this worker", flush=True)


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
    """Start the scanner loop only from an active asyncio event loop."""
    global scanner_task

    if scanner_task and not scanner_task.done():
        return

    try:
        loop = asyncio.get_running_loop()
        scanner_task = loop.create_task(run_background_scanner_loop())
        return
    except RuntimeError:
        pass

    loop = BACKGROUND_EVENT_LOOP
    if loop is not None and loop.is_running():
        def _start_on_loop() -> None:
            global scanner_task
            if scanner_task and not scanner_task.done():
                return
            scanner_task = loop.create_task(run_background_scanner_loop())

        loop.call_soon_threadsafe(_start_on_loop)
        return

    print("[scanner-loop] start skipped: no running event loop in this worker", flush=True)


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
    global BACKGROUND_EVENT_LOOP

    BACKGROUND_EVENT_LOOP = asyncio.get_running_loop()
    get_polygon_http_client()

    if acquire_background_worker_lock():
        start_backend_alert_task_if_needed()
        start_scanner_task_if_needed()
        start_auto_trade_task_if_needed()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global POLYGON_HTTP_CLIENT
    if BACKGROUND_LOCK_HELD:
        await stop_backend_alert_task()
        await stop_scanner_task()
        await stop_auto_trade_task()
        release_background_worker_lock()
    if POLYGON_HTTP_CLIENT is not None and not POLYGON_HTTP_CLIENT.is_closed:
        await POLYGON_HTTP_CLIENT.aclose()


@app.get("/app-state/alpaca")
def get_shared_alpaca_state():
    empty_state = {
        "selectedSymbol": None,
        "timeframe": None,
        "activeChart": None,
        "watchlist": [],
        "manualWatchlist": [],
        "studyVisibility": {},
        "chartRanges": {},
        "updatedAt": None,
    }
    if not ALPACA_APP_STATE_FILE.exists():
        return empty_state
    try:
        data = json.loads(ALPACA_APP_STATE_FILE.read_text(encoding="utf-8"))
        return {
            "selectedSymbol": data.get("selectedSymbol"),
            "timeframe": data.get("timeframe"),
            "activeChart": data.get("activeChart"),
            "watchlist": data.get("watchlist") if isinstance(data.get("watchlist"), list) else [],
            "manualWatchlist": data.get("manualWatchlist") if isinstance(data.get("manualWatchlist"), list) else [],
            "studyVisibility": data.get("studyVisibility") if isinstance(data.get("studyVisibility"), dict) else {},
            "chartRanges": data.get("chartRanges") if isinstance(data.get("chartRanges"), dict) else {},
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
            "background_worker_lock_held": BACKGROUND_LOCK_HELD,
            "enabled": backend_alert_config.enabled,
            "running": bool(backend_alert_task and not backend_alert_task.done()),
            "symbols": backend_alert_config.symbols,
            "effective_symbols": get_dynamic_alert_symbols(),
            "selected_symbols": get_dynamic_alert_symbols(),
            "scanner_auto_arm": False,
            "smart_scaling_enabled": backend_alert_config.smart_scaling_enabled,
            "effective_poll_seconds": get_effective_alert_poll_seconds(len(get_dynamic_alert_symbols())),
            "timeframe": backend_alert_config.timeframe,
            "timeframes": normalize_alert_timeframes(backend_alert_config.timeframes, backend_alert_config.timeframe),
            "confluence_mode": backend_alert_config.confluence_mode,
            "alert_setups": normalize_alert_setups(backend_alert_config.alert_setups),
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
            "background_worker_lock_held": BACKGROUND_LOCK_HELD,
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

    # Safety gate: generic push alerts are disabled by default. The only
    # production alert path should be /backend-alerts/instant-chart or the
    # backend alert loop, both of which verify that the symbol was armed from
    # the UI. Set ALLOW_GENERIC_PUSH_ALERTS=true only for manual testing.
    allow_generic = os.getenv("ALLOW_GENERIC_PUSH_ALERTS", "false").strip().lower() in {"1", "true", "yes", "on"}
    if not allow_generic:
        return {
            "ok": True,
            "delivered": False,
            "reason": "generic push alerts disabled",
        }

    title = (payload.title or "Trading Alert").strip() or "Trading Alert"
    message = payload.message.strip()
    result = send_pushover_alert(title=title, message=message, priority=payload.priority)

    return {
        "ok": True,
        "delivered": True,
        "provider": "pushover",
        "title": title,
        "message": message,
        "result": result,
    }


@app.get("/backend-alerts/selected-symbols")
def backend_alerts_selected_symbols():
    symbols = get_dynamic_alert_symbols()
    return {
        "ok": True,
        "symbols": symbols,
        "count": len(symbols),
        "source": "app_selected",
        "scanner_auto_arm": False,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.put("/backend-alerts/selected-symbols")
def backend_alerts_put_selected_symbols(payload: dict = Body(default={})):
    raw_symbols = payload.get("symbols") if isinstance(payload, dict) else []
    symbols = _normalize_symbol_list(list(raw_symbols or []))
    backend_alert_config.symbols = symbols
    backend_alert_config.use_scanner_symbols_when_empty = False
    save_persisted_alert_symbols(symbols)
    start_backend_alert_task_if_needed()
    return {
        "ok": True,
        "symbols": symbols,
        "count": len(symbols),
        "source": "app_selected",
        "scanner_auto_arm": False,
    }


@app.post("/backend-alerts/selected-symbols/toggle")
def backend_alerts_toggle_selected_symbol(payload: dict = Body(default={})):
    symbol = _normalize_symbol_list([payload.get("symbol") if isinstance(payload, dict) else ""])
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    target = symbol[0]
    current = _normalize_symbol_list(backend_alert_config.symbols)
    enabled = bool(payload.get("enabled")) if isinstance(payload, dict) and payload.get("enabled") is not None else target not in current
    if enabled and target not in current:
        current.append(target)
    if not enabled:
        current = [item for item in current if item != target]
    backend_alert_config.symbols = current
    backend_alert_config.use_scanner_symbols_when_empty = False
    save_persisted_alert_symbols(current)
    start_backend_alert_task_if_needed()
    return {
        "ok": True,
        "symbol": target,
        "enabled": target in current,
        "symbols": current,
        "count": len(current),
    }


@app.get("/backend-alerts/status")
def backend_alerts_status():
    return {
        "enabled": backend_alert_config.enabled,
        "running": bool(backend_alert_task and not backend_alert_task.done()),
        "symbols": backend_alert_config.symbols,
        "effective_symbols": get_dynamic_alert_symbols(),
        "selected_symbols": get_dynamic_alert_symbols(),
        "scanner_auto_arm": False,
        "smart_scaling_enabled": backend_alert_config.smart_scaling_enabled,
        "effective_poll_seconds": get_effective_alert_poll_seconds(len(get_dynamic_alert_symbols())),
        "timeframe": backend_alert_config.timeframe,
        "timeframes": normalize_alert_timeframes(backend_alert_config.timeframes, backend_alert_config.timeframe),
        "confluence_mode": backend_alert_config.confluence_mode,
        "alert_setups": normalize_alert_setups(backend_alert_config.alert_setups),
        "config": {
            "enabled": backend_alert_config.enabled,
            "symbols": backend_alert_config.symbols,
            "effective_symbols": get_dynamic_alert_symbols(),
            "selected_symbols": get_dynamic_alert_symbols(),
            "scanner_auto_arm": False,
            "smart_scaling_enabled": backend_alert_config.smart_scaling_enabled,
            "use_scanner_symbols_when_empty": backend_alert_config.use_scanner_symbols_when_empty,
            "max_dynamic_symbols": backend_alert_config.max_dynamic_symbols,
            "min_poll_seconds": backend_alert_config.min_poll_seconds,
            "max_poll_seconds": backend_alert_config.max_poll_seconds,
            "effective_poll_seconds": get_effective_alert_poll_seconds(len(get_dynamic_alert_symbols())),
            "timeframe": backend_alert_config.timeframe,
            "timeframes": normalize_alert_timeframes(backend_alert_config.timeframes, backend_alert_config.timeframe),
            "confluence_mode": backend_alert_config.confluence_mode,
            "alert_setups": normalize_alert_setups(backend_alert_config.alert_setups),
            "poll_seconds": backend_alert_config.poll_seconds,
            "cooldown_seconds": backend_alert_config.cooldown_seconds,
            "lookback_bars": backend_alert_config.lookback_bars,
            "notify_phone": backend_alert_config.notify_phone,
            "notify_webhook": backend_alert_config.notify_webhook,
            "webhook_url": backend_alert_config.webhook_url,
            "alert_on_prealert": backend_alert_config.alert_on_prealert,
        },
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


@app.post("/backend-alerts/instant-chart")
async def backend_alerts_instant_chart(payload: InstantChartAlertPayload):
    """Receive lightweight real-time chart events from the frontend.

    This is the hybrid TradingView-style path: the chart detects active IFVG
    state changes instantly from the live stream, while the backend handles
    cooldown, phone/webhook delivery, and recent-alert logging. The normal
    backend polling loop remains as a backup.
    """
    global backend_alert_last_alert, backend_alert_last_results

    symbol = "".join(ch for ch in str(payload.symbol or "").upper().strip() if ch.isalpha() or ch == ".")
    timeframe = str(payload.timeframe or "1m").lower().strip()
    setup = str(payload.setup or "").strip()
    phase = str(payload.phase or "confirmed").strip().lower()

    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")
    if timeframe not in SUPPORTED_ALERT_TIMEFRAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe}")
    if setup not in SUPPORTED_ALERT_SETUPS:
        raise HTTPException(status_code=400, detail=f"Unsupported setup: {setup}")
    if not str(payload.message or "").strip():
        raise HTTPException(status_code=400, detail="message is required")

    signal = _build_chart_alert_signal(
        symbol=symbol,
        timeframe=timeframe,
        setup=setup,
        phase="confirmed" if phase == "confirmed" else "prealert" if phase == "prealert" else "none",
        score=float(payload.score or 80.0),
        message=str(payload.message).strip(),
        reason=str(payload.reason or payload.message).strip(),
        features={**(payload.features or {}), "source": payload.source or "frontend"},
    )

    result_row = {
        "symbol": symbol,
        "timeframe": timeframe,
        "triggered": bool(signal.get("triggered")) and setup_allowed(signal),
        "phase": signal.get("phase"),
        "setup": signal.get("setup"),
        "score": signal.get("score"),
        "message": signal.get("message"),
        "reason": signal.get("reason"),
        "became_new": True,
        "features": signal.get("features"),
    }

    backend_alert_last_results = (backend_alert_last_results + [result_row])[-100:]

    if not backend_alert_config.enabled:
        return {"ok": True, "delivered": False, "reason": "backend alerts disabled", "signal": result_row}
    if not selected_symbol_is_armed(symbol):
        return {"ok": True, "delivered": False, "reason": "symbol not armed from app", "signal": result_row}
    if not setup_allowed(signal):
        return {"ok": True, "delivered": False, "reason": "setup not enabled", "signal": result_row}
    if not signal_is_deliverable(signal):
        return {"ok": True, "delivered": False, "reason": "phase not deliverable", "signal": result_row}
    if not can_send_backend_alert(signal, backend_alert_config.cooldown_seconds):
        return {"ok": True, "delivered": False, "reason": "cooldown", "signal": result_row}

    title = f"{str(signal.get('phase') or 'Alert').title()} · {symbol} ({timeframe})"
    message = str(signal.get("message") or "")

    if backend_alert_config.notify_phone:
        await asyncio.to_thread(
            send_pushover_alert,
            title,
            message,
            1 if signal.get("phase") == "confirmed" else 0,
        )

    if backend_alert_config.notify_webhook and backend_alert_config.webhook_url:
        await asyncio.to_thread(
            post_json_webhook,
            backend_alert_config.webhook_url,
            {"title": title, "message": message, "signal": signal},
        )

    mark_backend_alert_sent(signal)
    backend_alert_last_alert = {
        "symbol": symbol,
        "timeframe": timeframe,
        "setup": setup,
        "phase": signal.get("phase"),
        "score": signal.get("score"),
        "message": message,
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "source": payload.source or "frontend",
    }

    return {"ok": True, "delivered": True, "signal": result_row}


@app.post("/backend-alerts/config")
async def backend_alerts_config(update: BackendAlertLoopUpdate):
    if update.enabled is not None:
        backend_alert_config.enabled = update.enabled
    if update.symbols is not None:
        backend_alert_config.symbols = _normalize_symbol_list(update.symbols)
        backend_alert_config.use_scanner_symbols_when_empty = False
        save_persisted_alert_symbols(backend_alert_config.symbols)
    if update.timeframe is not None:
        backend_alert_config.timeframe = update.timeframe.strip().lower()
        backend_alert_config.timeframes = normalize_alert_timeframes([backend_alert_config.timeframe], backend_alert_config.timeframe)
    if update.timeframes is not None:
        backend_alert_config.timeframes = normalize_alert_timeframes(update.timeframes, backend_alert_config.timeframe)
        backend_alert_config.timeframe = backend_alert_config.timeframes[0]
    if update.confluence_mode is not None:
        mode = update.confluence_mode.strip().lower()
        backend_alert_config.confluence_mode = mode if mode in {"any", "all"} else "any"
    if update.alert_setups is not None:
        backend_alert_config.alert_setups = normalize_alert_setups(update.alert_setups)
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
    if update.smart_scaling_enabled is not None:
        backend_alert_config.smart_scaling_enabled = bool(update.smart_scaling_enabled)
    if update.use_scanner_symbols_when_empty is not None:
        # Pro alert mode: scanner rows are candidates only, never auto-armed.
        backend_alert_config.use_scanner_symbols_when_empty = False
    if update.max_dynamic_symbols is not None:
        backend_alert_config.max_dynamic_symbols = max(1, min(50, int(update.max_dynamic_symbols)))
    if update.min_poll_seconds is not None:
        backend_alert_config.min_poll_seconds = max(5, int(update.min_poll_seconds))
    if update.max_poll_seconds is not None:
        backend_alert_config.max_poll_seconds = max(backend_alert_config.min_poll_seconds, int(update.max_poll_seconds))

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


async def fetch_chart_bars_async(
    symbol: str,
    timeframe: str,
    *,
    lookback: Optional[str],
    limit_bars: Optional[int],
    session: str,
) -> tuple[List[Candle], date]:
    if is_daily_timeframe(timeframe):
        # Pull 1m data and aggregate it into live 1D candles. This makes the
        # current day form in real time instead of waiting for Polygon's
        # completed daily aggregate.
        intraday_bars, _ = await fetch_bars_range_async(
            symbol,
            "1m",
            lookback=lookback or DEFAULT_LOOKBACK_BY_TIMEFRAME.get("1d", "6m"),
            limit_bars=None,
        )
        daily_bars = aggregate_intraday_to_daily_bars(intraday_bars, session=session, limit_bars=limit_bars)
        return daily_bars, daily_session_trading_date(daily_bars)

    return await fetch_bars_range_async(
        symbol,
        timeframe,
        lookback=lookback,
        limit_bars=limit_bars,
    )


@app.get("/bars", response_model=BarsResponse)
async def get_bars(
    symbol: str = Query(..., min_length=1),
    timeframe: str = Query("1m"),
    date_str: Optional[str] = Query(None, alias="date"),
    lookback: Optional[str] = Query(None),
    limit: int = Query(MAX_BARS_DEFAULT, ge=50, le=5000),
    session: str = Query("regular"),
):
    normalized_symbol = symbol.upper().strip()
    normalized_timeframe = timeframe.lower().strip()
    normalized_session = normalize_daily_session(session)

    if date_str:
        requested_day = parse_requested_date(date_str)
        bars = await fetch_bars_for_day_async(
            normalized_symbol,
            normalized_timeframe,
            requested_day,
            limit_bars=limit,
            session=normalized_session,
        )
        used_day = requested_day

        if not bars:
            probe = requested_day
            for _ in range(7):
                probe = previous_trading_day(probe - timedelta(days=1))
                bars = await fetch_bars_for_day_async(
                    normalized_symbol,
                    normalized_timeframe,
                    probe,
                    limit_bars=limit,
                    session=normalized_session,
                )
                if bars:
                    used_day = probe
                    break

        return BarsResponse(
            symbol=normalized_symbol,
            timeframe=normalized_timeframe,
            bars=bars,
            trading_date=used_day.strftime("%Y-%m-%d"),
        )

    cache_key = f"{normalized_symbol}::{normalized_timeframe}::{normalized_session}::{lookback or ''}::{limit}"
    now = datetime.now(timezone.utc)
    cached = BARS_CACHE.get(cache_key)
    if cached is not None:
        age = (now - cached["stored_at"]).total_seconds()
        if age <= BARS_CACHE_TTL_SECONDS:
            return cached["response"]

    in_flight = IN_FLIGHT_BARS_REQUESTS.get(cache_key)
    if in_flight is None or in_flight.done():
        in_flight = asyncio.create_task(
            fetch_chart_bars_async(
                normalized_symbol,
                normalized_timeframe,
                lookback=lookback,
                limit_bars=limit,
                session=normalized_session,
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

    BARS_CACHE[cache_key] = {"stored_at": datetime.now(timezone.utc), "response": response}

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


# === CLOUD CHART DRAWING STORAGE ===
# Persistent JSON-backed storage for trendlines and projections.
# This removes 404s from /chart/trendlines/* and /chart/projections/*
# and lets drawings persist through page reloads, timeframe changes, and devices
# hitting the same cloud backend.
CHART_STORAGE_DIR = Path(__file__).resolve().parent / "data" / "chart_storage"
CHART_STORAGE_DIR.mkdir(parents=True, exist_ok=True)


def _clean_chart_part(value: str) -> str:
    cleaned = "".join(ch for ch in str(value).upper().strip() if ch.isalnum() or ch in {".", "-", "_"})
    return cleaned or "UNKNOWN"


def _chart_storage_file(symbol: str, scope: str, kind: str) -> Path:
    safe_symbol = _clean_chart_part(symbol)
    safe_scope = _clean_chart_part(scope)
    safe_kind = _clean_chart_part(kind).lower()
    return CHART_STORAGE_DIR / f"{safe_symbol}__{safe_scope}__{safe_kind}.json"


def _extract_chart_items(data: Any, kind: str) -> List[Dict[str, Any]]:
    """Accept both legacy list payloads and object payloads like {trendlines: [...]} / {projections: [...]}."""
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        if isinstance(data.get("items"), list):
            return [item for item in data["items"] if isinstance(item, dict)]
        if kind == "trendlines" and isinstance(data.get("trendlines"), list):
            return [item for item in data["trendlines"] if isinstance(item, dict)]
        if kind == "projections" and isinstance(data.get("projections"), list):
            return [item for item in data["projections"] if isinstance(item, dict)]
    return []


def _read_chart_items(symbol: str, scope: str, kind: str) -> List[Dict[str, Any]]:
    path = _chart_storage_file(symbol, scope, kind)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return _extract_chart_items(data, kind)
    except Exception as exc:
        print(f"[chart-storage] read error {path}: {exc}", flush=True)
        return []


def _write_chart_items(symbol: str, scope: str, kind: str, items: Any) -> Dict[str, Any]:
    path = _chart_storage_file(symbol, scope, kind)
    payload = _extract_chart_items(items, kind)
    tmp_file = path.with_suffix(".tmp")
    # Store as an object so both backend alerts and frontend readers have a stable shape.
    key = "trendlines" if kind == "trendlines" else "projections"
    tmp_file.write_text(json.dumps({key: payload}, indent=2), encoding="utf-8")
    tmp_file.replace(path)
    return {
        "ok": True,
        "symbol": _clean_chart_part(symbol),
        "scope": _clean_chart_part(scope),
        "kind": kind,
        "count": len(payload),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/chart/trendlines/{symbol}/{scope}")
def get_chart_trendlines(symbol: str, scope: str):
    rows = _read_chart_items(symbol, scope, "trendlines")
    return {"trendlines": rows, "items": rows}


@app.put("/chart/trendlines/{symbol}/{scope}")
def put_chart_trendlines(symbol: str, scope: str, items: Any = Body(default=[])):
    return _write_chart_items(symbol, scope, "trendlines", items)


@app.get("/chart/projections/{symbol}/{scope}")
def get_chart_projections(symbol: str, scope: str):
    rows = _read_chart_items(symbol, scope, "projections")
    return {"projections": rows, "items": rows}


@app.put("/chart/projections/{symbol}/{scope}")
def put_chart_projections(symbol: str, scope: str, items: Any = Body(default=[])):
    return _write_chart_items(symbol, scope, "projections", items)



@app.get("/auto-trade/status")
def auto_trade_status():
    return _auto_trade_status_payload()


@app.post("/auto-trade/config")
def auto_trade_config_update(update: AutoTradeConfigUpdate):
    _apply_auto_trade_update(update)
    if auto_trade_config.enabled:
        start_auto_trade_task_if_needed()
    return _auto_trade_status_payload()


@app.post("/auto-trade/start")
def auto_trade_start(update: Optional[AutoTradeConfigUpdate] = Body(default=None)):
    if update is not None:
        _apply_auto_trade_update(update)
    auto_trade_config.enabled = True
    if auto_trade_config.mode == "live" and not auto_trade_config.allow_live:
        auto_trade_config.enabled = False
        raise HTTPException(status_code=400, detail="Auto trade live mode is locked. Use paper mode.")
    start_auto_trade_task_if_needed()
    return _auto_trade_status_payload()


@app.post("/auto-trade/stop")
def auto_trade_stop():
    auto_trade_config.enabled = False
    return _auto_trade_status_payload()


@app.post("/auto-trade/check-once")
async def auto_trade_check_once():
    await asyncio.to_thread(_auto_trade_manage_runner_states)
    symbols = _auto_trade_symbols()
    results = []
    for symbol in symbols:
        results.append(await asyncio.to_thread(_auto_trade_try_execute, symbol))
    return {"symbols": symbols, "results": results, "status": _auto_trade_status_payload()}

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

    order_class = (request.order_class or "").strip().lower() or None
    if order_class and order_class not in {"bracket", "oco", "oto"}:
        raise HTTPException(status_code=400, detail="order_class must be bracket, oco, or oto")

    take_profit = request.take_profit.dict(exclude_none=True) if request.take_profit else None
    stop_loss = request.stop_loss.dict(exclude_none=True) if request.stop_loss else None

    if order_class in {"bracket", "oco", "oto"} and not take_profit and not stop_loss:
        raise HTTPException(status_code=400, detail="attached order requires take_profit or stop_loss")

    if take_profit and float(take_profit.get("limit_price") or 0) <= 0:
        raise HTTPException(status_code=400, detail="take_profit.limit_price must be greater than 0")

    if stop_loss and float(stop_loss.get("stop_price") or 0) <= 0:
        raise HTTPException(status_code=400, detail="stop_loss.stop_price must be greater than 0")

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
            order_class=order_class,
            take_profit=take_profit,
            stop_loss=stop_loss,
        )
        print("ALPACA ORDER SUCCESS", flush=True)
        return order
    except Exception as exc:
        print("ALPACA ORDER ERROR:", repr(exc), flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=str(exc))
