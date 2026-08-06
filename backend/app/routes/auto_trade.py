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


def _normalize_protected_plan(plan: ManualTradePlan) -> ManualTradePlan:
    plan.symbol = str(plan.symbol or "").strip().upper()
    if not plan.symbol:
        raise HTTPException(status_code=400, detail="Symbol is required.")

    entry = float(plan.entry_price or 0)
    stop = float(plan.stop_price or 0)
    target = float(plan.target_price or 0)
    if entry <= 0 or stop <= 0 or target <= 0:
        raise HTTPException(status_code=400, detail="Entry, stop, and target prices must be greater than zero.")
    if not stop < entry < target:
        raise HTTPException(status_code=400, detail="For a long order, prices must be Stop < Entry < Target.")

    requested_qty = int(plan.qty or plan.fixed_shares or 0)
    requested_dollars = float(plan.trade_amount or 0)
    if requested_qty > 0:
        plan.sizing_mode = "shares"
        plan.qty = requested_qty
        plan.fixed_shares = requested_qty
        if requested_dollars <= 0:
            plan.trade_amount = entry * requested_qty
    else:
        if requested_dollars <= 0:
            raise HTTPException(status_code=400, detail="Enter either a share quantity or a dollar amount.")
        plan.sizing_mode = "dollars"
        plan.qty = None
        plan.fixed_shares = 0
        plan.trade_amount = requested_dollars

    plan.strategy_id = "overnight_protected_order"
    plan.setup = "overnight_protected_limit_entry_stop_target"
    plan.extended_hours = True
    return plan


def _queue_manual_plan(plan: ManualTradePlan):
    cfg = store.get_config()
    if plan.mode == "live" and not cfg.allow_live:
        raise HTTPException(status_code=400, detail="Live auto trading is locked. Enable live auto trading before placing this order.")

    prefix = "overnight_protected_order" if plan.strategy_id in {"overnight_protected_order", "overnite_hail_mary"} else "manual"
    plan_id = f"{prefix}::{plan.symbol}::{int(datetime.now(timezone.utc).timestamp())}::{uuid4().hex[:8]}"
    payload = plan.dict()
    payload.update({
        "plan_id": plan_id,
        "queued_at": datetime.now(timezone.utc).isoformat(),
        "synthetic_bracket": True,
        "protection_owner": "server_worker",
    })
    store.enqueue_manual_trade_plan(plan_id, payload)
    store.log_event("manual_plan_queued", payload, plan.symbol, plan.strategy_id)

    cfg.enabled = True
    cfg.extended_hours = True
    store.set_config(cfg)
    return store.status_payload() | {"ok": True, "queued_plan": payload}


@router.post("/manual-plan")
def auto_trade_manual_plan(plan: ManualTradePlan):
    """Queue a manual synthetic entry/stop/target plan for the dedicated worker."""
    return _queue_manual_plan(plan)


@router.post("/overnight-protected-order")
def auto_trade_overnight_protected_order(plan: ManualTradePlan):
    """Queue an overnight limit entry protected by server-managed stop/target exits."""
    worker_status = store.status_payload()
    if not worker_status.get("running"):
        raise HTTPException(
            status_code=503,
            detail="The auto-trade worker is offline. Start trading-autotrade before placing a protected overnight order.",
        )
    return _queue_manual_plan(_normalize_protected_plan(plan))


@router.post("/overnite-hail-mary")
def auto_trade_overnite_hail_mary(plan: ManualTradePlan):
    """Legacy compatibility endpoint. New clients should use overnight-protected-order."""
    return auto_trade_overnight_protected_order(plan)


@router.delete("/manual-plan/{plan_id}")
def auto_trade_delete_manual_plan(plan_id: str):
    store.delete_manual_trade_plan(plan_id)
    store.log_event("manual_plan_deleted", {"plan_id": plan_id})
    return store.status_payload() | {"ok": True, "deleted_plan_id": plan_id}


@router.post("/check-once")
def auto_trade_check_once():
    return store.status_payload() | {"ok": True, "message": "Dedicated worker owns checks/execution."}
