from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from app.services.polygon_service import PolygonService


def _debug_enabled() -> bool:
    return os.getenv("DEBUG_SCANNER_CACHE", "false").strip().lower() in {"1", "true", "yes", "on"}


def _debug(message: str) -> None:
    if _debug_enabled():
        print(f"[scanner-cache] {message}", flush=True)


def _clone_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [dict(row) for row in rows or []]


def _clone_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    return dict(row or {})


class ScannerCacheService:
    """Small async in-memory cache for scanner data.

    This prevents every scanner cycle from hammering Polygon for the same bars
    and ticker details. It is intentionally process-local because the scanner
    loop is already protected by the background worker lock.
    """

    def __init__(self) -> None:
        self._bars_cache: "OrderedDict[str, Tuple[float, List[Dict[str, Any]]]]" = OrderedDict()
        self._details_cache: "OrderedDict[str, Tuple[float, Dict[str, Any]]]" = OrderedDict()
        self._bars_in_flight: Dict[str, asyncio.Task[List[Dict[str, Any]]]] = {}
        self._details_in_flight: Dict[str, asyncio.Task[Dict[str, Any]]] = {}

        self.max_bars_items = max(50, int(os.getenv("SCANNER_CACHE_MAX_BARS_ITEMS", "1000") or "1000"))
        self.max_details_items = max(50, int(os.getenv("SCANNER_CACHE_MAX_DETAILS_ITEMS", "5000") or "5000"))

    def _bars_ttl_seconds(self) -> float:
        return max(5.0, float(os.getenv("SCANNER_BARS_CACHE_TTL_SECONDS", "60") or "60"))

    def _details_ttl_seconds(self) -> float:
        return max(300.0, float(os.getenv("SCANNER_DETAILS_CACHE_TTL_SECONDS", "21600") or "21600"))

    def _get_bars_cached(self, key: str) -> Optional[List[Dict[str, Any]]]:
        item = self._bars_cache.get(key)
        if item is None:
            return None
        expires_at, rows = item
        if expires_at <= time.time():
            self._bars_cache.pop(key, None)
            return None
        self._bars_cache.move_to_end(key)
        return _clone_rows(rows)

    def _set_bars_cached(self, key: str, rows: List[Dict[str, Any]]) -> None:
        self._bars_cache[key] = (time.time() + self._bars_ttl_seconds(), _clone_rows(rows))
        self._bars_cache.move_to_end(key)
        while len(self._bars_cache) > self.max_bars_items:
            self._bars_cache.popitem(last=False)

    def _get_details_cached(self, key: str) -> Optional[Dict[str, Any]]:
        item = self._details_cache.get(key)
        if item is None:
            return None
        expires_at, row = item
        if expires_at <= time.time():
            self._details_cache.pop(key, None)
            return None
        self._details_cache.move_to_end(key)
        return _clone_dict(row)

    def _set_details_cached(self, key: str, row: Dict[str, Any]) -> None:
        self._details_cache[key] = (time.time() + self._details_ttl_seconds(), _clone_dict(row))
        self._details_cache.move_to_end(key)
        while len(self._details_cache) > self.max_details_items:
            self._details_cache.popitem(last=False)

    async def get_recent_1m_bars(
        self,
        polygon: PolygonService,
        symbol: str,
        *,
        hours_back: int = 96,
    ) -> List[Dict[str, Any]]:
        symbol_u = str(symbol or "").upper().strip()
        safe_hours_back = max(1, int(hours_back or 96))
        key = f"bars::{symbol_u}::{safe_hours_back}"

        cached = self._get_bars_cached(key)
        if cached is not None:
            _debug(f"bars hit {symbol_u} hours_back={safe_hours_back} count={len(cached)}")
            return cached

        task = self._bars_in_flight.get(key)
        if task is None or task.done():
            task = asyncio.create_task(
                polygon.get_recent_1m_bars(symbol_u, hours_back=safe_hours_back)
            )
            self._bars_in_flight[key] = task

        try:
            rows = await task
        except Exception as exc:
            _debug(f"bars miss/error {symbol_u}: {exc}")
            rows = []
        finally:
            if self._bars_in_flight.get(key) is task:
                self._bars_in_flight.pop(key, None)

        self._set_bars_cached(key, rows)
        _debug(f"bars store {symbol_u} hours_back={safe_hours_back} count={len(rows)}")
        return _clone_rows(rows)

    async def get_ticker_details(
        self,
        polygon: PolygonService,
        symbol: str,
    ) -> Dict[str, Any]:
        symbol_u = str(symbol or "").upper().strip()
        key = f"details::{symbol_u}"

        cached = self._get_details_cached(key)
        if cached is not None:
            _debug(f"details hit {symbol_u}")
            return cached

        task = self._details_in_flight.get(key)
        if task is None or task.done():
            task = asyncio.create_task(polygon.get_ticker_details(symbol_u))
            self._details_in_flight[key] = task

        try:
            details = await task
        except Exception as exc:
            _debug(f"details miss/error {symbol_u}: {exc}")
            details = {}
        finally:
            if self._details_in_flight.get(key) is task:
                self._details_in_flight.pop(key, None)

        self._set_details_cached(key, details)
        _debug(f"details store {symbol_u}")
        return _clone_dict(details)

    def status(self) -> Dict[str, Any]:
        now = time.time()
        return {
            "bars_items": len(self._bars_cache),
            "details_items": len(self._details_cache),
            "bars_in_flight": len(self._bars_in_flight),
            "details_in_flight": len(self._details_in_flight),
            "bars_ttl_seconds": self._bars_ttl_seconds(),
            "details_ttl_seconds": self._details_ttl_seconds(),
            "max_bars_items": self.max_bars_items,
            "max_details_items": self.max_details_items,
            "bars_live_items": sum(1 for expires_at, _ in self._bars_cache.values() if expires_at > now),
            "details_live_items": sum(1 for expires_at, _ in self._details_cache.values() if expires_at > now),
        }

    def clear(self) -> Dict[str, Any]:
        bars = len(self._bars_cache)
        details = len(self._details_cache)
        self._bars_cache.clear()
        self._details_cache.clear()
        self._bars_in_flight.clear()
        self._details_in_flight.clear()
        return {"cleared_bars": bars, "cleared_details": details}


scanner_cache_service = ScannerCacheService()


async def get_scanner_recent_1m_bars(
    polygon: PolygonService,
    symbol: str,
    *,
    hours_back: int = 96,
) -> List[Dict[str, Any]]:
    return await scanner_cache_service.get_recent_1m_bars(
        polygon,
        symbol,
        hours_back=hours_back,
    )


async def get_scanner_ticker_details(
    polygon: PolygonService,
    symbol: str,
) -> Dict[str, Any]:
    return await scanner_cache_service.get_ticker_details(polygon, symbol)


def scanner_cache_status() -> Dict[str, Any]:
    return scanner_cache_service.status()


def clear_scanner_cache() -> Dict[str, Any]:
    return scanner_cache_service.clear()
