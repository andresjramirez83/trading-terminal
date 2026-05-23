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
            rank INTEGER,
            score REAL,
            payload_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(scanner, symbol, pick_date)
        )
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


def upsert_candles(symbol: str, timeframe: str, candles: List[Dict[str, Any]]) -> int:
    init_db()
    rows = []
    for c in candles:
        rows.append((
            symbol.upper(),
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


def get_candles(symbol: str, timeframe: str, start_date: Optional[str] = None, end_date: Optional[str] = None) -> List[Dict[str, Any]]:
    init_db()
    params: List[Any] = [symbol.upper(), timeframe.lower()]
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
