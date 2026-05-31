from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException

from app.autotrade.models import AutoTradeConfigUpdate, ManualTradePlan
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
        raise HTTPException(status_code=400, detail="Auto trade live mode is locked. Use paper mode or explicitly set allow_live first.")
    cfg.enabled = True
    # Synthetic overnight logic needs extended hours enabled.
    cfg.extended_hours = True
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


@router.post("/manual-plan")
def auto_trade_manual_plan(plan: ManualTradePlan):
    """Queue a manual synthetic entry/stop/target plan.

    This endpoint does not place the order from the FastAPI worker. It writes a
    plan into SQLite; the dedicated auto-trade worker picks it up and becomes the
    only process that submits the entry and manages the synthetic exit.
    """
    cfg = store.get_config()
    if cfg.mode == "live" and not cfg.allow_live:
        raise HTTPException(status_code=400, detail="Live mode is locked. Use paper mode or explicitly allow live first.")

    prefix = "overnite_hail_mary" if plan.strategy_id == "overnite_hail_mary" else "manual"
    plan_id = f"{prefix}::{plan.symbol}::{int(datetime.now(timezone.utc).timestamp())}::{uuid4().hex[:8]}"
    payload = plan.dict()
    payload.update({
        "plan_id": plan_id,
        "queued_at": datetime.now(timezone.utc).isoformat(),
        "synthetic_bracket": True,
    })
    store.enqueue_manual_trade_plan(plan_id, payload)
    store.log_event("manual_plan_queued", payload, plan.symbol, plan.strategy_id)

    # Enable worker if the user queues a plan. The worker/service still must be running.
    cfg.enabled = True
    cfg.extended_hours = True
    store.set_config(cfg)
    return store.status_payload() | {"ok": True, "queued_plan": payload}


@router.post("/overnite-hail-mary")
def auto_trade_overnite_hail_mary(plan: ManualTradePlan):
    """Queue an Overnite Hail Mary manual synthetic trade plan.

    This is intentionally just a named wrapper around manual-plan behavior so the
    frontend can call a clear strategy-specific endpoint without changing the
    execution lifecycle.
    """
    plan.strategy_id = "overnite_hail_mary"
    plan.setup = "overnite_hail_mary_limit_entry_stop_target"
    return auto_trade_manual_plan(plan)


@router.delete("/manual-plan/{plan_id}")
def auto_trade_delete_manual_plan(plan_id: str):
    store.delete_manual_trade_plan(plan_id)
    store.log_event("manual_plan_deleted", {"plan_id": plan_id})
    return store.status_payload() | {"ok": True, "deleted_plan_id": plan_id}


@router.post("/check-once")
def auto_trade_check_once():
    # Execution is owned by the dedicated worker. This is intentionally a safe status refresh.
    return store.status_payload() | {"ok": True, "message": "Dedicated worker owns checks/execution."}
