from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, HTTPException

from app.autotrade.models import AutoTradeConfigUpdate, ManualTradePlan, StrategyConfig
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
    return store.status_payload() | {"ok": True, "message": "Dedicated worker owns checks/execution."}


def _validate_manual_plan(plan: ManualTradePlan) -> ManualTradePlan:
    symbol = "".join(ch for ch in str(plan.symbol or "").upper().strip() if ch.isalpha() or ch == ".")
    if not symbol:
        raise HTTPException(status_code=400, detail="symbol is required")

    entry = float(plan.entry_price)
    stop = float(plan.stop_price)
    target = float(plan.target_price)

    if entry <= 0 or stop <= 0 or target <= 0:
        raise HTTPException(status_code=400, detail="entry, stop, and target must be greater than 0")
    if stop >= entry:
        raise HTTPException(status_code=400, detail="stop must be below entry for a long trade")
    if target <= entry:
        raise HTTPException(status_code=400, detail="target must be above entry for a long trade")

    sizing_mode = str(plan.sizing_mode or "dollars").lower().strip()
    if sizing_mode not in {"dollars", "shares"}:
        raise HTTPException(status_code=400, detail="sizing_mode must be dollars or shares")

    trade_amount = float(plan.trade_amount or 0)
    fixed_shares = int(plan.fixed_shares or 0)

    if sizing_mode == "dollars" and trade_amount <= 0:
        raise HTTPException(status_code=400, detail="trade_amount must be greater than 0")
    if sizing_mode == "shares" and fixed_shares <= 0:
        raise HTTPException(status_code=400, detail="fixed_shares must be greater than 0")

    return plan.copy(update={
        "symbol": symbol,
        "strategy_id": "overnite_hail_mary",
        "setup": "overnite_hail_mary_limit_entry_stop_target",
        "timeframe": "manual",
        "signal_time": datetime.now(timezone.utc).isoformat(),
        "profit_range": round(target - entry, 4),
        "score": 100.0,
        "sizing_mode": sizing_mode,
        "trade_amount": trade_amount,
        "fixed_shares": fixed_shares,
        "extended_hours": bool(plan.extended_hours),
    })


@router.post("/manual-plan")
def auto_trade_manual_plan(plan: ManualTradePlan):
    plan = _validate_manual_plan(plan)
    payload = plan.dict()
    plan_id = str(payload.get("signal_id") or "").strip()
    if not plan_id:
        plan_id = f"manual::{payload['strategy_id']}::{payload['symbol']}::{int(time.time())}"
        payload["signal_id"] = plan_id

    store.enqueue_manual_trade_plan(plan_id, payload)

    cfg = store.get_config()
    if cfg.mode == "live" and not cfg.allow_live:
        raise HTTPException(status_code=400, detail="Auto trade live mode is locked. Use paper mode.")

    cfg.enabled = True
    cfg.mode = payload["mode"]
    cfg.source = "manual"
    cfg.sizing_mode = payload["sizing_mode"]
    cfg.trade_amount = float(payload["trade_amount"])
    cfg.fixed_shares = int(payload["fixed_shares"] or cfg.fixed_shares)
    cfg.extended_hours = bool(payload["extended_hours"])
    cfg.runner_mode = "off"
    cfg.strategies = [StrategyConfig(enabled=True, strategy_id="overnite_hail_mary", weight=1.0, min_score=0.0)]
    store.set_config(cfg)

    store.log_event("manual_plan_queued", payload, payload["symbol"], payload["strategy_id"])
    return store.status_payload() | {"ok": True, "queued_plan": payload}


@router.post("/overnite-hail-mary")
def auto_trade_overnite_hail_mary(plan: ManualTradePlan):
    # Alias used by the frontend. Do not mutate Pydantic fields outside the model;
    # _validate_manual_plan returns a clean updated model.
    return auto_trade_manual_plan(plan)
