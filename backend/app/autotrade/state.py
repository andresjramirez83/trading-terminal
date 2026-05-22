from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.autotrade.models import AutoTradeConfig

DEFAULT_STATE_DIR = Path(__file__).resolve().parents[1] / "data" / "autotrade"
DEFAULT_STATE_DIR.mkdir(parents=True, exist_ok=True)
DEFAULT_DB_PATH = DEFAULT_STATE_DIR / "autotrade.sqlite3"


class AutoTradeStore:
    """SQLite-backed state shared by FastAPI workers and the dedicated auto-trade worker.

    This removes split-brain state from Gunicorn memory. Web workers only read/write
    config/status; the dedicated worker owns signal scanning and order execution.
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self.db_path = Path(db_path or DEFAULT_DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS kv (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS fired_signals (
                    signal_id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    strategy_id TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS engine_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL,
                    event TEXT NOT NULL,
                    symbol TEXT,
                    strategy_id TEXT,
                    payload TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runner_states (
                    symbol TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_entries (
                    order_id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    strategy_id TEXT NOT NULL,
                    signal_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            if self.get_raw("config") is None:
                self.set_config(AutoTradeConfig())
            if self.get_raw("worker") is None:
                self.set_worker_status({"running": False, "status": "stopped"})

    def get_raw(self, key: str) -> Optional[Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
            if row is None:
                return None
            try:
                return json.loads(row["value"])
            except Exception:
                return None

    def set_raw(self, key: str, value: Any) -> None:
        payload = json.dumps(value, separators=(",", ":"), default=str)
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, payload, now),
            )

    def get_config(self) -> AutoTradeConfig:
        data = self.get_raw("config") or {}
        return AutoTradeConfig(**data)

    def set_config(self, config: AutoTradeConfig) -> None:
        self.set_raw("config", config.dict())

    def update_config(self, patch: Dict[str, Any]) -> AutoTradeConfig:
        cfg = self.get_config()
        data = cfg.dict()
        for key, value in patch.items():
            if value is None or key not in data:
                continue
            data[key] = value
        next_cfg = AutoTradeConfig(**data)
        if next_cfg.mode == "live" and not next_cfg.allow_live:
            next_cfg.enabled = False
        self.set_config(next_cfg)
        return next_cfg

    def set_worker_status(self, payload: Dict[str, Any]) -> None:
        payload = dict(payload)
        payload.setdefault("heartbeat", time.time())
        self.set_raw("worker", payload)

    def get_worker_status(self) -> Dict[str, Any]:
        return self.get_raw("worker") or {"running": False, "status": "stopped"}

    def mark_signal_fired(self, signal_id: str, symbol: str, strategy_id: str) -> bool:
        now = time.time()
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO fired_signals(signal_id, symbol, strategy_id, created_at) VALUES(?, ?, ?, ?)",
                    (signal_id, symbol.upper(), strategy_id, now),
                )
            return True
        except sqlite3.IntegrityError:
            return False

    def signal_was_fired(self, signal_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute("SELECT 1 FROM fired_signals WHERE signal_id = ?", (signal_id,)).fetchone()
            return row is not None

    def prune_old_fired_signals(self, max_age_seconds: int = 7 * 24 * 3600) -> None:
        cutoff = time.time() - max_age_seconds
        with self._connect() as conn:
            conn.execute("DELETE FROM fired_signals WHERE created_at < ?", (cutoff,))

    def log_event(self, event: str, payload: Dict[str, Any], symbol: Optional[str] = None, strategy_id: Optional[str] = None) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO engine_events(ts, event, symbol, strategy_id, payload) VALUES(?, ?, ?, ?, ?)",
                (time.time(), event, symbol, strategy_id, json.dumps(payload, default=str)),
            )
            conn.execute(
                "DELETE FROM engine_events WHERE id NOT IN (SELECT id FROM engine_events ORDER BY id DESC LIMIT 500)"
            )

    def recent_events(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, ts, event, symbol, strategy_id, payload FROM engine_events ORDER BY id DESC LIMIT ?",
                (max(1, min(limit, 200)),),
            ).fetchall()
        out: List[Dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except Exception:
                payload = {}
            out.append({
                "id": row["id"],
                "ts": row["ts"],
                "event": row["event"],
                "symbol": row["symbol"],
                "strategy_id": row["strategy_id"],
                "payload": payload,
            })
        return out

    def get_runner_states(self) -> Dict[str, Any]:
        with self._connect() as conn:
            rows = conn.execute("SELECT symbol, payload FROM runner_states").fetchall()
        out: Dict[str, Any] = {}
        for row in rows:
            try:
                out[row["symbol"]] = json.loads(row["payload"])
            except Exception:
                out[row["symbol"]] = {}
        return out

    def upsert_runner_state(self, symbol: str, payload: Dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO runner_states(symbol, payload, updated_at) VALUES(?, ?, ?) "
                "ON CONFLICT(symbol) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
                (symbol.upper(), json.dumps(payload, default=str), time.time()),
            )

    def delete_runner_state(self, symbol: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM runner_states WHERE symbol = ?", (symbol.upper(),))

    def upsert_pending_entry(self, order_id: str, payload: Dict[str, Any]) -> None:
        symbol = str(payload.get("symbol") or "").upper()
        strategy_id = str(payload.get("strategy_id") or "")
        signal_id = str(payload.get("signal_id") or "")
        now = time.time()
        with self._connect() as conn:
            existing = conn.execute("SELECT created_at FROM pending_entries WHERE order_id = ?", (order_id,)).fetchone()
            created_at = float(existing["created_at"]) if existing else now
            conn.execute(
                "INSERT INTO pending_entries(order_id, symbol, strategy_id, signal_id, payload, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(order_id) DO UPDATE SET "
                "symbol=excluded.symbol, strategy_id=excluded.strategy_id, signal_id=excluded.signal_id, "
                "payload=excluded.payload, updated_at=excluded.updated_at",
                (order_id, symbol, strategy_id, signal_id, json.dumps(payload, default=str), created_at, now),
            )

    def list_pending_entries(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT order_id, symbol, strategy_id, signal_id, payload, created_at, updated_at "
                "FROM pending_entries ORDER BY created_at ASC"
            ).fetchall()
        out: List[Dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except Exception:
                payload = {}
            out.append({
                "order_id": row["order_id"],
                "symbol": row["symbol"],
                "strategy_id": row["strategy_id"],
                "signal_id": row["signal_id"],
                "payload": payload,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            })
        return out

    def delete_pending_entry(self, order_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM pending_entries WHERE order_id = ?", (order_id,))

    def status_payload(self) -> Dict[str, Any]:
        cfg = self.get_config()
        worker = self.get_worker_status()
        heartbeat = float(worker.get("heartbeat") or 0)
        alive = bool(worker.get("running")) and (time.time() - heartbeat) < max(20, int(cfg.poll_seconds) * 3)
        events = self.recent_events(30)
        return {
            "config": cfg.dict(),
            "running": alive,
            "worker": worker,
            "status": worker.get("status", "stopped"),
            "last_check": worker.get("last_check"),
            "last_error": worker.get("last_error"),
            "last_skip": worker.get("last_skip"),
            "last_signal": worker.get("last_signal"),
            "last_order": worker.get("last_order"),
            "runner_states": self.get_runner_states(),
            "history": events,
        }
