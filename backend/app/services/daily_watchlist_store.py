from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo

try:
    import fcntl
except Exception:  # Windows/local dev fallback
    fcntl = None  # type: ignore

ET = ZoneInfo("America/New_York")


def _normalize_symbol(value: Any) -> str:
    return "".join(ch for ch in str(value or "").upper().strip() if ch.isalpha() or ch == ".")


def _normalize_symbols(values: Iterable[Any]) -> List[str]:
    seen = set()
    out: List[str] = []
    for value in values or []:
        symbol = _normalize_symbol(value)
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        out.append(symbol)
    return out


def _row_symbol(row: Dict[str, Any]) -> str:
    return _normalize_symbol(row.get("symbol") or row.get("ticker"))


class DailyWatchlistStore:
    """Persist the user's manual + scanner watchlists by ET trading date.

    One JSON document is maintained per ET date. Scanner cycles overwrite that day's
    scanner section with the newest rows while the manual section is updated whenever
    the manual watchlist changes. The same rows are also mirrored into the existing
    scanner_picks SQLite table so backtests can query them efficiently.
    """

    def __init__(self, base_dir: Optional[Path] = None) -> None:
        if base_dir is None:
            base_dir = Path(__file__).resolve().parents[1] / "data" / "daily_watchlists"
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._thread_lock = threading.RLock()
        self._lock_file = self.base_dir / ".daily_watchlists.lock"

    @contextmanager
    def _locked(self):
        with self._thread_lock:
            handle = self._lock_file.open("a+")
            try:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                yield
            finally:
                if fcntl is not None:
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                    except Exception:
                        pass
                handle.close()

    def _date(self, trade_date: Optional[str] = None) -> str:
        raw = str(trade_date or "").strip()
        if raw:
            return raw[:10]
        return datetime.now(ET).date().isoformat()

    def _path(self, trade_date: str) -> Path:
        return self.base_dir / f"{trade_date}.json"

    def _empty(self, trade_date: str) -> Dict[str, Any]:
        return {
            "tradeDate": trade_date,
            "updatedAt": None,
            "manual": {
                "symbols": [],
                "seenSymbols": [],
                "updatedAt": None,
            },
            "scanners": {},
            "scannerSymbols": [],
            "scannerSeenSymbols": [],
            "combinedSymbols": [],
            "combinedSeenSymbols": [],
        }

    def _read_unlocked(self, trade_date: str) -> Dict[str, Any]:
        path = self._path(trade_date)
        if not path.exists():
            return self._empty(trade_date)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return self._empty(trade_date)
        if not isinstance(data, dict):
            return self._empty(trade_date)
        data.setdefault("tradeDate", trade_date)
        data.setdefault("manual", {"symbols": [], "seenSymbols": [], "updatedAt": None})
        if isinstance(data.get("manual"), dict):
            data["manual"].setdefault("seenSymbols", list(data["manual"].get("symbols") or []))
        data.setdefault("scanners", {})
        data.setdefault("scannerSymbols", [])
        data.setdefault("scannerSeenSymbols", list(data.get("scannerSymbols") or []))
        data.setdefault("combinedSymbols", [])
        data.setdefault("combinedSeenSymbols", list(data.get("combinedSymbols") or []))
        return data

    def _write_unlocked(self, trade_date: str, payload: Dict[str, Any]) -> None:
        path = self._path(trade_date)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
        tmp.replace(path)

    def _recompute_symbols(self, payload: Dict[str, Any]) -> None:
        scanner_symbols: List[str] = []
        scanner_seen_symbols: List[str] = []
        scanners = payload.get("scanners") if isinstance(payload.get("scanners"), dict) else {}
        for scanner in scanners.values():
            if not isinstance(scanner, dict):
                continue
            scanner_symbols.extend(scanner.get("symbols") or [])
            scanner_seen_symbols.extend(scanner.get("seenSymbols") or scanner.get("symbols") or [])
        scanner_symbols = _normalize_symbols(scanner_symbols)
        scanner_seen_symbols = _normalize_symbols(scanner_seen_symbols)

        manual = payload.get("manual") if isinstance(payload.get("manual"), dict) else {}
        manual_symbols = _normalize_symbols(manual.get("symbols") or [])
        manual_seen_symbols = _normalize_symbols(manual.get("seenSymbols") or manual_symbols)

        payload["scannerSymbols"] = scanner_symbols
        payload["scannerSeenSymbols"] = scanner_seen_symbols
        payload["combinedSymbols"] = _normalize_symbols([*scanner_symbols, *manual_symbols])
        payload["combinedSeenSymbols"] = _normalize_symbols([*scanner_seen_symbols, *manual_seen_symbols])

    def _mirror_rows_to_backtest_db(
        self,
        *,
        trade_date: str,
        scanner_rows: Optional[Dict[str, List[Dict[str, Any]]]] = None,
        manual_symbols: Optional[List[str]] = None,
    ) -> None:
        # Lazy import avoids making the scanner service depend on SQLite at module import time.
        try:
            from app.backtests.market_cache import save_scanner_picks

            if scanner_rows is not None:
                union_rows: List[Dict[str, Any]] = []
                seen = set()
                for scanner_id, rows in scanner_rows.items():
                    save_scanner_picks(
                        scanner=scanner_id,
                        pick_date=trade_date,
                        rows=rows,
                    )
                    for row in rows:
                        symbol = _row_symbol(row)
                        if not symbol or symbol in seen:
                            continue
                        seen.add(symbol)
                        merged = dict(row)
                        merged["symbol"] = symbol
                        merged.setdefault("archive_source", scanner_id)
                        union_rows.append(merged)
                save_scanner_picks(
                    scanner="scanner_all",
                    pick_date=trade_date,
                    rows=union_rows,
                )

            if manual_symbols is not None:
                manual_rows = [
                    {"symbol": symbol, "source": "manual_watchlist"}
                    for symbol in _normalize_symbols(manual_symbols)
                ]
                save_scanner_picks(
                    scanner="manual_watchlist",
                    pick_date=trade_date,
                    rows=manual_rows,
                )
        except Exception as exc:
            print(f"[daily-watchlists] SQLite mirror failed: {exc}", flush=True)

    def save_manual(self, symbols: Iterable[Any], trade_date: Optional[str] = None) -> Dict[str, Any]:
        date_key = self._date(trade_date)
        clean = _normalize_symbols(symbols)
        now = datetime.now(ET).isoformat()

        with self._locked():
            payload = self._read_unlocked(date_key)
            previous_manual = payload.get("manual") if isinstance(payload.get("manual"), dict) else {}
            seen = _normalize_symbols([*(previous_manual.get("seenSymbols") or previous_manual.get("symbols") or []), *clean])
            payload["manual"] = {
                "symbols": clean,
                "seenSymbols": seen,
                "updatedAt": now,
            }
            payload["updatedAt"] = now
            self._recompute_symbols(payload)
            self._write_unlocked(date_key, payload)

        self._mirror_rows_to_backtest_db(
            trade_date=date_key,
            manual_symbols=clean,
        )
        return payload

    def save_scanner_cycle(
        self,
        scanner_caches: Dict[str, Dict[str, Any]],
        trade_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        date_key = self._date(trade_date)
        now = datetime.now(ET).isoformat()
        scanners_payload: Dict[str, Dict[str, Any]] = {}
        rows_for_db: Dict[str, List[Dict[str, Any]]] = {}

        for raw_id, result in (scanner_caches or {}).items():
            scanner_id = str(raw_id or "").strip()
            if not scanner_id or not isinstance(result, dict):
                continue
            raw_rows = result.get("rows") or []
            rows = [dict(row) for row in raw_rows if isinstance(row, dict)]
            symbols = _normalize_symbols(_row_symbol(row) for row in rows)
            scanners_payload[scanner_id] = {
                "symbols": symbols,
                "count": len(symbols),
                "rows": rows,
                "updatedAt": now,
                "workflow": result.get("workflow"),
                "source": result.get("source"),
            }
            rows_for_db[scanner_id] = rows

        with self._locked():
            payload = self._read_unlocked(date_key)
            previous_scanners = payload.get("scanners") if isinstance(payload.get("scanners"), dict) else {}
            for scanner_id, scanner_payload in scanners_payload.items():
                previous = previous_scanners.get(scanner_id) if isinstance(previous_scanners.get(scanner_id), dict) else {}
                scanner_payload["seenSymbols"] = _normalize_symbols([
                    *(previous.get("seenSymbols") or previous.get("symbols") or []),
                    *(scanner_payload.get("symbols") or []),
                ])
            # Keep a prior scanner section if that scanner errored during this cycle and
            # therefore was not present in the new payload. This preserves the day's history.
            for scanner_id, previous in previous_scanners.items():
                if scanner_id not in scanners_payload and isinstance(previous, dict):
                    scanners_payload[scanner_id] = previous
            payload["scanners"] = scanners_payload
            payload["updatedAt"] = now
            self._recompute_symbols(payload)
            self._write_unlocked(date_key, payload)

        self._mirror_rows_to_backtest_db(
            trade_date=date_key,
            scanner_rows=rows_for_db,
        )
        return payload

    def load(self, trade_date: str) -> Optional[Dict[str, Any]]:
        date_key = self._date(trade_date)
        with self._locked():
            path = self._path(date_key)
            if not path.exists():
                return None
            return self._read_unlocked(date_key)

    def list_dates(self) -> List[str]:
        dates: List[str] = []
        for path in self.base_dir.glob("????-??-??.json"):
            dates.append(path.stem)
        return sorted(set(dates), reverse=True)

    def get_symbols(
        self,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        include_scanner: bool = True,
        include_manual: bool = True,
        scanner_ids: Optional[List[str]] = None,
    ) -> Dict[str, List[str]]:
        allowed_scanners = {str(x).strip() for x in scanner_ids or [] if str(x).strip()}
        out: Dict[str, List[str]] = {}

        for trade_date in sorted(self.list_dates()):
            if start_date and trade_date < start_date:
                continue
            if end_date and trade_date > end_date:
                continue
            payload = self.load(trade_date)
            if not payload:
                continue

            symbols: List[str] = []
            if include_manual:
                manual = payload.get("manual") if isinstance(payload.get("manual"), dict) else {}
                symbols.extend(manual.get("seenSymbols") or manual.get("symbols") or [])

            if include_scanner:
                scanners = payload.get("scanners") if isinstance(payload.get("scanners"), dict) else {}
                for scanner_id, scanner in scanners.items():
                    if allowed_scanners and scanner_id not in allowed_scanners:
                        continue
                    if isinstance(scanner, dict):
                        symbols.extend(scanner.get("seenSymbols") or scanner.get("symbols") or [])

            clean = _normalize_symbols(symbols)
            if clean:
                out[trade_date] = clean

        return out


__all__ = ["DailyWatchlistStore"]
