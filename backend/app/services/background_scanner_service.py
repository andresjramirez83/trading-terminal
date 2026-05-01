from __future__ import annotations

import asyncio
import os
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import Body, HTTPException
from pydantic import BaseModel


class BackgroundScannerConfig(BaseModel):
    enabled: bool = True
    scanner_id: str = "overnight_runner"
    workflow: str = "auto"
    ah_date: Optional[str] = None
    poll_seconds: int = 20
    max_symbols: int = 25
    min_price: float = 0.5
    max_price: float = 20.0
    min_volume: int = 500000
    min_gap_pct: float = 3.0
    min_pm_range_pct: float = 4.5
    min_pm_dollar_volume: float = 500000.0
    min_compression_score: float = 0.0
    min_breakout_score: float = 0.0
    max_float_shares: Optional[float] = None
    low_float_only: bool = False
    min_short_interest_pct: float = 0.0
    min_turnover_pct: float = 0.0
    hours_back: int = 96


class BackgroundScannerConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    scanner_id: Optional[str] = None
    workflow: Optional[str] = None
    ah_date: Optional[str] = None
    poll_seconds: Optional[int] = None
    max_symbols: Optional[int] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    min_volume: Optional[int] = None
    min_gap_pct: Optional[float] = None
    min_pm_range_pct: Optional[float] = None
    min_pm_dollar_volume: Optional[float] = None
    min_compression_score: Optional[float] = None
    min_breakout_score: Optional[float] = None
    max_float_shares: Optional[float] = None
    low_float_only: Optional[bool] = None
    min_short_interest_pct: Optional[float] = None
    min_turnover_pct: Optional[float] = None
    hours_back: Optional[int] = None


class BackgroundScannerService:
    def __init__(self, *, registry: Any, snapshot_store: Any, polygon_service_cls: Any, api_key: str):
        self.registry = registry
        self.snapshot_store = snapshot_store
        self.polygon_service_cls = polygon_service_cls
        self.api_key = api_key

        self.config = BackgroundScannerConfig(
            enabled=os.getenv("BACKGROUND_SCANNER_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"},
            scanner_id=os.getenv("BACKGROUND_SCANNER_ID", "overnight_runner").strip() or "overnight_runner",
            workflow=os.getenv("BACKGROUND_SCANNER_WORKFLOW", "auto").strip().lower() or "auto",
            poll_seconds=max(10, int(os.getenv("BACKGROUND_SCANNER_POLL_SECONDS", "20") or "20")),
            max_symbols=max(1, int(os.getenv("BACKGROUND_SCANNER_MAX_SYMBOLS", "25") or "25")),
            min_price=float(os.getenv("BACKGROUND_SCANNER_MIN_PRICE", "0.5") or "0.5"),
            max_price=float(os.getenv("BACKGROUND_SCANNER_MAX_PRICE", "20") or "20"),
            min_volume=max(0, int(os.getenv("BACKGROUND_SCANNER_MIN_VOLUME", "500000") or "500000")),
            min_gap_pct=float(os.getenv("BACKGROUND_SCANNER_MIN_GAP_PCT", "3") or "3"),
            min_pm_range_pct=float(os.getenv("BACKGROUND_SCANNER_MIN_PM_RANGE_PCT", "4.5") or "4.5"),
            min_pm_dollar_volume=float(os.getenv("BACKGROUND_SCANNER_MIN_PM_DOLLAR_VOLUME", "500000") or "500000"),
            min_compression_score=float(os.getenv("BACKGROUND_SCANNER_MIN_COMPRESSION_SCORE", "0") or "0"),
            min_breakout_score=float(os.getenv("BACKGROUND_SCANNER_MIN_BREAKOUT_SCORE", "0") or "0"),
            hours_back=max(24, int(os.getenv("BACKGROUND_SCANNER_HOURS_BACK", "96") or "96")),
        )

        self.task: Optional[asyncio.Task] = None
        self.cache: Optional[Dict[str, Any]] = None
        self.last_started: Optional[datetime] = None
        self.last_run: Optional[datetime] = None
        self.last_error: Optional[str] = None
        self.run_count: int = 0
        self.is_running_cycle: bool = False

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": self.config.enabled,
            "running": bool(self.task and not self.task.done()),
            "cycle_running": self.is_running_cycle,
            "scanner_id": self.config.scanner_id,
            "workflow": self.config.workflow,
            "ah_date": self.config.ah_date,
            "poll_seconds": self.config.poll_seconds,
            "max_symbols": self.config.max_symbols,
            "min_price": self.config.min_price,
            "max_price": self.config.max_price,
            "min_volume": self.config.min_volume,
            "min_gap_pct": self.config.min_gap_pct,
            "min_pm_range_pct": self.config.min_pm_range_pct,
            "min_pm_dollar_volume": self.config.min_pm_dollar_volume,
            "min_compression_score": self.config.min_compression_score,
            "min_breakout_score": self.config.min_breakout_score,
            "max_float_shares": self.config.max_float_shares,
            "low_float_only": self.config.low_float_only,
            "min_short_interest_pct": self.config.min_short_interest_pct,
            "min_turnover_pct": self.config.min_turnover_pct,
            "hours_back": self.config.hours_back,
            "last_started": self.last_started.isoformat() if self.last_started else None,
            "last_run": self.last_run.isoformat() if self.last_run else None,
            "last_error": self.last_error,
            "run_count": self.run_count,
            "cached_count": int((self.cache or {}).get("count") or 0),
        }

    async def run_once(self) -> Dict[str, Any]:
        scanner = self.registry.get(self.config.scanner_id)
        if scanner is None:
            raise RuntimeError(f"Unknown scanner_id: {self.config.scanner_id}")
        if not self.api_key:
            raise RuntimeError("Missing POLYGON_API_KEY in backend environment")

        polygon = self.polygon_service_cls(api_key=self.api_key)
        return await scanner.run(
            polygon,
            self.snapshot_store,
            workflow=self.config.workflow,
            ah_date=self.config.ah_date,
            max_symbols=self.config.max_symbols,
            min_price=self.config.min_price,
            max_price=self.config.max_price,
            min_volume=self.config.min_volume,
            min_gap_pct=self.config.min_gap_pct,
            min_pm_range_pct=self.config.min_pm_range_pct,
            min_pm_dollar_volume=self.config.min_pm_dollar_volume,
            min_compression_score=self.config.min_compression_score,
            min_breakout_score=self.config.min_breakout_score,
            max_float_shares=self.config.max_float_shares,
            low_float_only=self.config.low_float_only,
            min_short_interest_pct=self.config.min_short_interest_pct,
            min_turnover_pct=self.config.min_turnover_pct,
            hours_back=self.config.hours_back,
        )

    async def loop(self) -> None:
        print("[background-scanner] started", flush=True)
        while True:
            try:
                if not self.config.enabled:
                    await asyncio.sleep(1)
                    continue

                self.is_running_cycle = True
                self.last_started = datetime.now(timezone.utc)
                result = await self.run_once()
                self.cache = result
                self.last_run = datetime.now(timezone.utc)
                self.last_error = None
                self.run_count += 1

            except asyncio.CancelledError:
                print("[background-scanner] cancelled", flush=True)
                raise
            except Exception as exc:
                self.last_error = str(exc)
                print(f"[background-scanner] error: {exc}", flush=True)
                traceback.print_exc()
            finally:
                self.is_running_cycle = False

            await asyncio.sleep(max(10, int(self.config.poll_seconds)))

    def start(self) -> None:
        if self.task and not self.task.done():
            return
        self.task = asyncio.create_task(self.loop())

    async def stop(self) -> None:
        task = self.task
        self.task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    def apply_update(self, update: BackgroundScannerConfigUpdate) -> None:
        if update.enabled is not None:
            self.config.enabled = update.enabled
        if update.scanner_id is not None:
            scanner_id = update.scanner_id.strip() or "overnight_runner"
            if self.registry.get(scanner_id) is None:
                raise HTTPException(status_code=404, detail=f"Unknown scanner_id: {scanner_id}")
            self.config.scanner_id = scanner_id
        if update.workflow is not None:
            workflow = update.workflow.strip().lower() or "auto"
            if workflow not in {"auto", "combined", "live"}:
                raise HTTPException(status_code=400, detail="workflow must be auto, combined, or live")
            self.config.workflow = workflow
        if update.ah_date is not None:
            self.config.ah_date = update.ah_date.strip() or None
        if update.poll_seconds is not None:
            self.config.poll_seconds = max(10, int(update.poll_seconds))
        if update.max_symbols is not None:
            self.config.max_symbols = max(1, min(100, int(update.max_symbols)))
        if update.min_price is not None:
            self.config.min_price = max(0.0, float(update.min_price))
        if update.max_price is not None:
            self.config.max_price = max(0.0, float(update.max_price))
        if update.min_volume is not None:
            self.config.min_volume = max(0, int(update.min_volume))
        if update.min_gap_pct is not None:
            self.config.min_gap_pct = float(update.min_gap_pct)
        if update.min_pm_range_pct is not None:
            self.config.min_pm_range_pct = float(update.min_pm_range_pct)
        if update.min_pm_dollar_volume is not None:
            self.config.min_pm_dollar_volume = max(0.0, float(update.min_pm_dollar_volume))
        if update.min_compression_score is not None:
            self.config.min_compression_score = float(update.min_compression_score)
        if update.min_breakout_score is not None:
            self.config.min_breakout_score = float(update.min_breakout_score)
        if update.max_float_shares is not None:
            self.config.max_float_shares = None if update.max_float_shares <= 0 else float(update.max_float_shares)
        if update.low_float_only is not None:
            self.config.low_float_only = update.low_float_only
        if update.min_short_interest_pct is not None:
            self.config.min_short_interest_pct = float(update.min_short_interest_pct)
        if update.min_turnover_pct is not None:
            self.config.min_turnover_pct = float(update.min_turnover_pct)
        if update.hours_back is not None:
            self.config.hours_back = max(24, int(update.hours_back))


def setup_background_scanner_routes(*, app: Any, service: BackgroundScannerService) -> None:
    @app.get("/scanner-v2/cache")
    def scanner_v2_cache():
        return {
            "ok": service.cache is not None and service.last_error is None,
            "data": service.cache,
            "status": service.status(),
        }

    @app.get("/scanner/cache")
    def scanner_cache():
        return {
            "ok": service.cache is not None and service.last_error is None,
            "data": service.cache,
            "status": service.status(),
        }

    @app.get("/scanner-v2/background/status")
    def scanner_v2_background_status():
        return service.status()

    @app.post("/scanner-v2/background/config")
    async def scanner_v2_background_config(update: BackgroundScannerConfigUpdate):
        service.apply_update(update)
        service.start()
        return service.status()

    @app.post("/scanner-v2/background/start")
    async def scanner_v2_background_start(payload: Optional[BackgroundScannerConfigUpdate] = Body(default=None)):
        if payload is not None:
            service.apply_update(payload)
        service.config.enabled = True
        service.start()
        return service.status()

    @app.post("/scanner-v2/background/stop")
    async def scanner_v2_background_stop():
        service.config.enabled = False
        return service.status()

    @app.post("/scanner-v2/background/refresh")
    async def scanner_v2_background_refresh():
        if service.is_running_cycle:
            return {
                "ok": False,
                "message": "Scanner cycle is already running.",
                "data": service.cache,
                "status": service.status(),
            }

        try:
            service.is_running_cycle = True
            service.last_started = datetime.now(timezone.utc)
            result = await service.run_once()
            service.cache = result
            service.last_run = datetime.now(timezone.utc)
            service.last_error = None
            service.run_count += 1
            return {"ok": True, "data": service.cache, "status": service.status()}
        except Exception as exc:
            service.last_error = str(exc)
            print("[background-scanner/refresh] error:", exc, flush=True)
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(exc))
        finally:
            service.is_running_cycle = False
