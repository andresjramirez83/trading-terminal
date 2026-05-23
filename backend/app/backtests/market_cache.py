import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "market_cache.sqlite"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cur = conn.execute(f"PRAGMA table_info({table})")
    existing = {str(row[1]) for row in cur.fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db() -> None:
    with get_conn() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS candles (
            symbol TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            ts INTEGER NOT NULL,
            dt_utc TEXT NOT NULL,
            dt_et TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            PRIMARY KEY (symbol, timeframe, ts)
        )
        """)

        conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_date
        ON candles(symbol, timeframe, trade_date)
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS scanner_picks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scanner TEXT NOT NULL,
            symbol TEXT NOT NULL,
            pick_date TEXT NOT NULL,
            timeframe TEXT,
            rank INTEGER,
            score REAL,
            payload_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT,
            UNIQUE(scanner, symbol, pick_date)
        )
        """)

        # Auto-migrate existing SQLite files created by older table shapes.
        _ensure_column(conn, "scanner_picks", "timeframe", "TEXT")
        # SQLite cannot ALTER TABLE ADD COLUMN with DEFAULT CURRENT_TIMESTAMP.
        # Keep this as plain TEXT and set it during INSERT/UPDATE.
        _ensure_column(conn, "scanner_picks", "updated_at", "TEXT")

        conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_scanner_picks_scanner_date
        ON scanner_picks(scanner, pick_date)
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS backtest_trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_name TEXT NOT NULL,
            symbol TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            setup TEXT NOT NULL,
            direction TEXT NOT NULL,
            sweep_level REAL NOT NULL,
            entry_time TEXT,
            entry_price REAL,
            stop_price REAL,
            target_price REAL,
            exit_time TEXT,
            exit_price REAL,
            result TEXT NOT NULL,
            r_multiple REAL,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """)

        conn.commit()


def normalize_symbol(raw: Any) -> str:
    return "".join(ch for ch in str(raw or "").upper().strip() if ch.isalpha() or ch == ".")


def upsert_candles(symbol: str, timeframe: str, candles: List[Dict[str, Any]]) -> int:
    init_db()
    rows = []
    for c in candles:
        rows.append((
            normalize_symbol(symbol),
            timeframe.lower(),
            int(c["ts"]),
            str(c["dt_utc"]),
            str(c["dt_et"]),
            str(c["trade_date"]),
            float(c["open"]),
            float(c["high"]),
            float(c["low"]),
            float(c["close"]),
            float(c.get("volume", 0)),
        ))

    if not rows:
        return 0

    with get_conn() as conn:
        conn.executemany("""
        INSERT OR REPLACE INTO candles
        (symbol, timeframe, ts, dt_utc, dt_et, trade_date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, rows)
        conn.commit()

    return len(rows)


def get_candles(
    symbol: str,
    timeframe: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> List[Dict[str, Any]]:
    init_db()
    params: List[Any] = [normalize_symbol(symbol), timeframe.lower()]
    where = "WHERE symbol = ? AND timeframe = ?"

    if start_date:
        where += " AND trade_date >= ?"
        params.append(start_date)
    if end_date:
        where += " AND trade_date <= ?"
        params.append(end_date)

    with get_conn() as conn:
        cur = conn.execute(f"""
        SELECT * FROM candles
        {where}
        ORDER BY ts ASC
        """, params)
        return [dict(row) for row in cur.fetchall()]


def clear_backtest_run(run_name: str) -> None:
    init_db()
    with get_conn() as conn:
        conn.execute("DELETE FROM backtest_trades WHERE run_name = ?", (run_name,))
        conn.commit()


def save_backtest_trade(trade: Dict[str, Any]) -> None:
    init_db()
    with get_conn() as conn:
        conn.execute("""
        INSERT INTO backtest_trades
        (
            run_name, symbol, trade_date, setup, direction,
            sweep_level, entry_time, entry_price, stop_price, target_price,
            exit_time, exit_price, result, r_multiple, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            trade["run_name"],
            trade["symbol"],
            trade["trade_date"],
            trade["setup"],
            trade["direction"],
            trade["sweep_level"],
            trade.get("entry_time"),
            trade.get("entry_price"),
            trade.get("stop_price"),
            trade.get("target_price"),
            trade.get("exit_time"),
            trade.get("exit_price"),
            trade["result"],
            trade.get("r_multiple"),
            trade.get("notes"),
        ))
        conn.commit()


def save_scanner_picks(
    scanner: str,
    pick_date: str,
    rows: List[Dict[str, Any]],
    timeframe: Optional[str] = None,
) -> Dict[str, Any]:
    """Save scanner output rows for scanner-only backtests.

    Duplicate-safe rule:
    UNIQUE(scanner, symbol, pick_date)

    If the background scanner saves the same symbol many times in one day,
    this updates the existing row instead of adding duplicates.
    """
    init_db()
    prepared = []
    skipped = 0

    clean_scanner = str(scanner or "").strip()
    clean_date = str(pick_date or "")[:10]

    if not clean_scanner:
        return {
            "ok": False,
            "scanner": clean_scanner,
            "pick_date": clean_date,
            "saved": 0,
            "skipped": len(rows or []),
            "error": "scanner is required",
        }
    if not clean_date:
        return {
            "ok": False,
            "scanner": clean_scanner,
            "pick_date": clean_date,
            "saved": 0,
            "skipped": len(rows or []),
            "error": "pick_date is required",
        }

    for idx, row in enumerate(rows or [], start=1):
        symbol = normalize_symbol(row.get("symbol") or row.get("ticker"))
        if not symbol:
            skipped += 1
            continue

        score_raw = (
            row.get("score")
            if row.get("score") is not None
            else row.get("runner_score")
            if row.get("runner_score") is not None
            else row.get("sweep_score")
            if row.get("sweep_score") is not None
            else row.get("ifvg_score")
            if row.get("ifvg_score") is not None
            else row.get("ah_score")
        )

        try:
            score = float(score_raw) if score_raw is not None else None
        except Exception:
            score = None

        row_timeframe = (
            timeframe
            or row.get("timeframe")
            or row.get("confirm_timeframe")
            or row.get("scan_timeframe")
        )

        prepared.append((
            clean_scanner,
            symbol,
            clean_date,
            str(row_timeframe).lower() if row_timeframe else None,
            idx,
            score,
            json.dumps(row, default=str),
        ))

    if not prepared:
        return {
            "ok": True,
            "scanner": clean_scanner,
            "pick_date": clean_date,
            "saved": 0,
            "skipped": skipped,
        }

    with get_conn() as conn:
        conn.executemany("""
        INSERT INTO scanner_picks
        (scanner, symbol, pick_date, timeframe, rank, score, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(scanner, symbol, pick_date) DO UPDATE SET
            timeframe = excluded.timeframe,
            rank = excluded.rank,
            score = excluded.score,
            payload_json = excluded.payload_json,
            updated_at = CURRENT_TIMESTAMP
        """, prepared)
        conn.commit()

    return {
        "ok": True,
        "scanner": clean_scanner,
        "pick_date": clean_date,
        "saved": len(prepared),
        "skipped": skipped,
        "duplicate_safe": True,
    }


def get_scanner_picks(
    scanner: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    min_score: Optional[float] = None,
    limit_per_day: Optional[int] = None,
) -> List[Dict[str, Any]]:
    init_db()
    params: List[Any] = [scanner]
    where = "WHERE scanner = ?"

    if start_date:
        where += " AND pick_date >= ?"
        params.append(start_date)
    if end_date:
        where += " AND pick_date <= ?"
        params.append(end_date)
    if min_score is not None:
        where += " AND (score IS NULL OR score >= ?)"
        params.append(float(min_score))

    with get_conn() as conn:
        cur = conn.execute(f"""
        SELECT *
        FROM scanner_picks
        {where}
        ORDER BY pick_date ASC, rank ASC, score DESC
        """, params)
        rows = [dict(row) for row in cur.fetchall()]

    if limit_per_day and limit_per_day > 0:
        counts: Dict[str, int] = {}
        filtered = []
        for row in rows:
            day = str(row["pick_date"])
            counts[day] = counts.get(day, 0) + 1
            if counts[day] <= limit_per_day:
                filtered.append(row)
        rows = filtered

    for row in rows:
        try:
            row["payload"] = json.loads(row.get("payload_json") or "{}")
        except Exception:
            row["payload"] = {}

    return rows


def get_scanner_symbols(
    scanner: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    min_score: Optional[float] = None,
    limit_per_day: Optional[int] = None,
) -> List[str]:
    rows = get_scanner_picks(
        scanner=scanner,
        start_date=start_date,
        end_date=end_date,
        min_score=min_score,
        limit_per_day=limit_per_day,
    )
    symbols: List[str] = []
    for row in rows:
        symbol = normalize_symbol(row.get("symbol"))
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def count_scanner_picks(scanner: str) -> Dict[str, Any]:
    init_db()
    with get_conn() as conn:
        cur = conn.execute("""
        SELECT
            COUNT(*) AS total,
            COUNT(DISTINCT symbol) AS symbols,
            COUNT(DISTINCT pick_date) AS dates,
            MIN(pick_date) AS first_date,
            MAX(pick_date) AS last_date
        FROM scanner_picks
        WHERE scanner = ?
        """, (scanner,))
        row = dict(cur.fetchone() or {})
    return {"scanner": scanner, **row}
