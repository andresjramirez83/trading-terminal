from __future__ import annotations

import json
import os
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.services.polygon_service import PolygonService


def _debug_enabled() -> bool:
    return os.getenv("DEBUG_SCANNER_UNIVERSE", "false").strip().lower() in {"1", "true", "yes", "on"}


def _debug(message: str) -> None:
    if _debug_enabled():
        print(f"[scanner-universe] {message}", flush=True)


def _cache_path() -> Path:
    raw = os.getenv("SCANNER_UNIVERSE_MAP_CACHE_PATH", "backend/app/data/scanner_cache/universe_map.json").strip()
    path = Path(raw)
    if path.is_absolute():
        return path
    return Path.cwd() / path


def _normalize_symbol(value: Any) -> str:
    return str(value or "").upper().strip()


def _snapshot_symbol(item: Dict[str, Any]) -> str:
    return _normalize_symbol(item.get("ticker") or item.get("symbol"))


def _ticker_universe_symbol(item: Dict[str, Any]) -> str:
    return _normalize_symbol(item.get("ticker") or item.get("symbol"))


def _clone_universe(universe: "OrderedDict[str, Dict[str, Any]]") -> "OrderedDict[str, Dict[str, Any]]":
    out: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
    for symbol, row in universe.items():
        out[symbol] = dict(row)
    return out


class ScannerUniverseService:
    """Central symbol universe provider for scanner modules.

    Scanners should not depend directly on live Polygon snapshot endpoints because those
    can be empty on weekends, holidays, or during endpoint outages. This service uses
    snapshot gainers/actives/losers first, then falls back to a cached/reference universe.
    """

    def __init__(self, *, cache_path: Optional[Path] = None) -> None:
        self.cache_path = cache_path or _cache_path()

    def _read_cached_map(self, *, max_age_seconds: Optional[float] = None) -> "OrderedDict[str, Dict[str, Any]]":
        try:
            if not self.cache_path.exists():
                return OrderedDict()
            payload = json.loads(self.cache_path.read_text())
            saved_at_epoch = float(payload.get("saved_at_epoch") or 0)
            if max_age_seconds is not None and saved_at_epoch > 0:
                if time.time() - saved_at_epoch > max_age_seconds:
                    return OrderedDict()

            rows = payload.get("rows") or []
            universe: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
            if isinstance(rows, list):
                for item in rows:
                    if not isinstance(item, dict):
                        continue
                    symbol = _snapshot_symbol(item)
                    if symbol:
                        universe[symbol] = dict(item)
            return universe
        except Exception as exc:
            _debug(f"cache read failed: {exc}")
            return OrderedDict()

    def _write_cached_map(self, universe: "OrderedDict[str, Dict[str, Any]]") -> None:
        if not universe:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "saved_at_epoch": time.time(),
                "count": len(universe),
                "rows": list(universe.values()),
            }
            self.cache_path.write_text(json.dumps(payload, indent=2, sort_keys=True))
        except Exception as exc:
            _debug(f"cache write failed: {exc}")

    async def _snapshot_universe(self, polygon: PolygonService, *, limit: int) -> "OrderedDict[str, Dict[str, Any]]":
        gainers: List[Dict[str, Any]] = []
        actives: List[Dict[str, Any]] = []
        losers: List[Dict[str, Any]] = []

        try:
            gainers = await polygon.get_snapshot_gainers(limit=limit)
        except Exception as exc:
            _debug(f"gainers failed: {exc}")

        try:
            actives = await polygon.get_snapshot_actives(limit=limit)
        except Exception as exc:
            _debug(f"actives failed: {exc}")

        get_losers = getattr(polygon, "get_snapshot_losers", None)
        if callable(get_losers):
            try:
                losers = await get_losers(limit=limit)
            except Exception as exc:
                _debug(f"losers failed: {exc}")

        universe: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        for source_name, rows in (("gainers", gainers), ("actives", actives), ("losers", losers)):
            for item in rows or []:
                if not isinstance(item, dict):
                    continue
                symbol = _snapshot_symbol(item)
                if not symbol or symbol in universe:
                    continue
                row = dict(item)
                row["ticker"] = symbol
                row["_universe_source"] = source_name
                universe[symbol] = row
        return universe

    async def _reference_universe(self, polygon: PolygonService, *, limit: int) -> "OrderedDict[str, Dict[str, Any]]":
        get_ticker_universe = getattr(polygon, "get_ticker_universe", None)
        if not callable(get_ticker_universe):
            return OrderedDict()

        try:
            rows = await get_ticker_universe(limit=limit)
        except Exception as exc:
            _debug(f"reference universe failed: {exc}")
            return OrderedDict()

        universe: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        for item in rows or []:
            if not isinstance(item, dict):
                continue
            symbol = _ticker_universe_symbol(item)
            if not symbol or symbol in universe:
                continue
            universe[symbol] = {
                "ticker": symbol,
                "symbol": symbol,
                "name": item.get("name"),
                "market": item.get("market"),
                "locale": item.get("locale"),
                "primary_exchange": item.get("primary_exchange"),
                "type": item.get("type"),
                "active": item.get("active"),
                "_universe_source": "reference_tickers",
            }
        return universe

    async def get_universe(
        self,
        polygon: PolygonService,
        *,
        limit: int = 1000,
        min_limit: Optional[int] = None,
        allow_stale_cache: bool = True,
    ) -> "OrderedDict[str, Dict[str, Any]]":
        requested_limit = max(1, int(limit or 1000))
        default_min = int(os.getenv("SCANNER_UNIVERSE_MIN_LIMIT", "1000") or "1000")
        safe_limit = max(requested_limit, int(min_limit or default_min))
        safe_limit = min(safe_limit, int(os.getenv("SCANNER_UNIVERSE_MAX_LIMIT", "5000") or "5000"))

        snapshot = await self._snapshot_universe(polygon, limit=safe_limit)
        if snapshot:
            self._write_cached_map(snapshot)
            _debug(f"source=snapshot count={len(snapshot)}")
            return _clone_universe(snapshot)

        cache_ttl = float(os.getenv("SCANNER_UNIVERSE_MAP_CACHE_TTL_SECONDS", "86400") or "86400")
        cached = self._read_cached_map(max_age_seconds=cache_ttl)
        if cached:
            for row in cached.values():
                row.setdefault("_universe_source", "cached_snapshot")
            _debug(f"source=cached count={len(cached)}")
            return _clone_universe(cached)

        reference = await self._reference_universe(polygon, limit=safe_limit)
        if reference:
            self._write_cached_map(reference)
            _debug(f"source=reference count={len(reference)}")
            return _clone_universe(reference)

        if allow_stale_cache:
            stale = self._read_cached_map(max_age_seconds=None)
            if stale:
                for row in stale.values():
                    row.setdefault("_universe_source", "stale_cache")
                _debug(f"source=stale_cache count={len(stale)}")
                return _clone_universe(stale)

        _debug("source=empty count=0")
        return OrderedDict()


scanner_universe_service = ScannerUniverseService()


async def get_scanner_universe(
    polygon: PolygonService,
    *,
    limit: int = 1000,
    min_limit: Optional[int] = None,
) -> "OrderedDict[str, Dict[str, Any]]":
    return await scanner_universe_service.get_universe(
        polygon,
        limit=limit,
        min_limit=min_limit,
    )
