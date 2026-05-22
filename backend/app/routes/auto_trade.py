from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, HTTPException

from app.autotrade.models import AutoTradeConfigUpdate
from app.autotrade.state import AutoTradeStore
from app.strategies.registry import StrategyRegistry

router = APIRouter(prefix="/auto-trade", tags=["auto-trade"])
store = AutoTradeStore()
strategies = StrategyRegistry()


@router.get("/status")
def auto_trade_status():
    return store.status_payload()


@router.get("/strategies")
def auto_trade_strategies():
    return {"strategies": strategies.list()}


@router.post("/config")
def auto_trade_config_update(update: AutoTradeConfigUpdate):
    cfg = store.update_config(update.dict(exclude_unset=True))
    return store.status_payload() | {"config": cfg.dict()}


@router.post("/start")
def auto_trade_start(update: Optional[AutoTradeConfigUpdate] = Body(default=None)):
    if update is not None:
        cfg = store.update_config(update.dict(exclude_unset=True))
    else:
        cfg = store.get_config()
    if cfg.mode == "live" and not cfg.allow_live:
        cfg.enabled = False
        store.set_config(cfg)
        raise HTTPException(status_code=400, detail="Auto trade live mode is locked. Use paper mode.")
    cfg.enabled = True
    store.set_config(cfg)
    return store.status_payload()


@router.post("/stop")
def auto_trade_stop():
    cfg = store.get_config()
    cfg.enabled = False
    store.set_config(cfg)
    return store.status_payload()


@router.post("/kill")
def auto_trade_kill():
    cfg = store.get_config()
    cfg.enabled = False
    store.set_config(cfg)
    store.log_event("kill_switch", {"reason": "manual kill switch"})
    return store.status_payload()


@router.post("/check-once")
def auto_trade_check_once():
    # The dedicated worker owns execution. This endpoint is intentionally a safe status refresh.
    # Use systemctl restart trading-autotrade to restart the worker if heartbeat is stale.
    return store.status_payload() | {"ok": True, "message": "Dedicated worker owns checks/execution."}
