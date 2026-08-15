from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException

from app.autotrade.models import (
    AutoTradeConfigUpdate,
    ManualTradePlan,
    ProtectedOrderPriceUpdate,
)
from app.autotrade.state import AutoTradeStore
from app.services.alpaca_service import AlpacaService
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


def _protected_levels(payload: dict, update: ProtectedOrderPriceUpdate) -> tuple[float, float, float]:
    entry = float(payload.get("entry_price") or 0)
    stop = float(payload.get("stop_price") or 0)
    target = float(payload.get("target_price") or 0)
    price = float(update.price or 0)

    if price <= 0:
        raise HTTPException(status_code=400, detail="Price must be greater than zero.")

    if update.level == "entry":
        entry = price
    elif update.level == "stop":
        stop = price
    else:
        target = price

    if entry <= 0 or stop <= 0 or target <= 0:
        raise HTTPException(status_code=400, detail="Entry, stop, and target prices must be greater than zero.")
    if not stop < entry < target:
        raise HTTPException(status_code=400, detail="For a long order, prices must remain Stop < Entry < Target.")

    return entry, stop, target


def _is_protected_strategy(value: object) -> bool:
    return str(value or "") in {"overnight_protected_order", "overnite_hail_mary"}


@router.patch("/overnight-protected-order/{symbol}")
def auto_trade_move_overnight_protected_order_level(
    symbol: str,
    update: ProtectedOrderPriceUpdate,
):
    """Move entry/stop/target without detaching the server protection worker."""
    safe_symbol = str(symbol or "").strip().upper()
    if not safe_symbol:
        raise HTTPException(status_code=400, detail="Symbol is required.")

    states = store.get_runner_states()
    runner = states.get(safe_symbol)
    if isinstance(runner, dict) and _is_protected_strategy(runner.get("strategy_id")):
        phase = str(runner.get("phase") or "")
        if phase == "exit_submitted":
            raise HTTPException(status_code=409, detail="The protected exit is already submitted and can no longer be moved.")
        if update.level == "entry" and phase == "active_synthetic":
            raise HTTPException(status_code=409, detail="The entry is already filled. Move only the stop or target.")

        entry, stop, target = _protected_levels(runner, update)
        next_state = dict(runner)
        next_state.update({
            "entry_price": entry,
            "stop_price": stop,
            "target_price": target,
            "profit_range": max(0.0, target - entry),
            "chart_level_updated_at": datetime.now(timezone.utc).isoformat(),
            "chart_level_updated": update.level,
        })

        old_order_id = str(runner.get("order_id") or runner.get("entry_order_id") or "").strip()
        pending_item = next(
            (
                item
                for item in store.list_pending_entries()
                if str(item.get("symbol") or "").strip().upper() == safe_symbol
                and _is_protected_strategy(item.get("strategy_id"))
            ),
            None,
        )

        if update.level == "entry" and phase in {"entry_submitted", "entry_cancel_requested"}:
            if not old_order_id:
                raise HTTPException(status_code=409, detail="The working entry order ID is unavailable.")

            mode = "live" if str(runner.get("mode") or "paper").lower() == "live" else "paper"
            try:
                replacement = AlpacaService(mode=mode).update_order(
                    old_order_id,
                    limit_price=entry,
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"Alpaca could not move the entry order: {exc}") from exc

            new_order_id = str((replacement or {}).get("id") or old_order_id).strip()
            next_state["order_id"] = new_order_id
            next_state["entry_order_id"] = new_order_id
            if new_order_id != old_order_id:
                next_state["replaced_order_id"] = old_order_id

            pending_payload = dict((pending_item or {}).get("payload") or runner)
            pending_payload.update(next_state)
            if new_order_id != old_order_id:
                store.delete_pending_entry(old_order_id)
            store.upsert_pending_entry(new_order_id, pending_payload)
        elif pending_item is not None and phase in {"entry_submitted", "entry_cancel_requested"}:
            pending_order_id = str(pending_item.get("order_id") or old_order_id).strip()
            if pending_order_id:
                pending_payload = dict(pending_item.get("payload") or {})
                pending_payload.update(next_state)
                store.upsert_pending_entry(pending_order_id, pending_payload)

        store.upsert_runner_state(safe_symbol, next_state)
        store.log_event(
            "protected_order_chart_level_moved",
            {
                "level": update.level,
                "price": float(update.price),
                "phase": phase,
                "entry_price": entry,
                "stop_price": stop,
                "target_price": target,
                "order_id": next_state.get("order_id"),
            },
            safe_symbol,
            str(runner.get("strategy_id") or "overnight_protected_order"),
        )
        return store.status_payload() | {"ok": True, "updated_level": update.level, "updated_price": float(update.price)}

    queued_plan = next(
        (
            item
            for item in store.list_manual_trade_plans()
            if str(item.get("symbol") or "").strip().upper() == safe_symbol
            and _is_protected_strategy(item.get("strategy_id"))
        ),
        None,
    )
    if queued_plan is not None:
        payload = dict(queued_plan.get("payload") or {})
        entry, stop, target = _protected_levels(payload, update)
        payload.update({
            "entry_price": entry,
            "stop_price": stop,
            "target_price": target,
            "profit_range": max(0.0, target - entry),
            "chart_level_updated_at": datetime.now(timezone.utc).isoformat(),
            "chart_level_updated": update.level,
        })
        plan_id = str(queued_plan.get("plan_id") or payload.get("plan_id") or "").strip()
        if not plan_id:
            raise HTTPException(status_code=409, detail="The queued protected order ID is unavailable.")
        store.enqueue_manual_trade_plan(plan_id, payload)
        store.log_event(
            "queued_protected_order_chart_level_moved",
            {
                "plan_id": plan_id,
                "level": update.level,
                "price": float(update.price),
                "entry_price": entry,
                "stop_price": stop,
                "target_price": target,
            },
            safe_symbol,
            str(queued_plan.get("strategy_id") or "overnight_protected_order"),
        )
        return store.status_payload() | {"ok": True, "updated_level": update.level, "updated_price": float(update.price)}

    raise HTTPException(status_code=404, detail=f"No editable Overnight Protected Order was found for {safe_symbol}.")


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
