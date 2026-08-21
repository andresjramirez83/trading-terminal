from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Body, HTTPException

from app.autotrade.models import (
    AutoTradeConfigUpdate,
    ConvertPositionToExtendedProtection,
    ManualTradePlan,
    ProtectedOrderPriceUpdate,
    ProtectedPositionAction,
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


def _live_position_qty(alpaca: AlpacaService, symbol: str) -> int:
    safe_symbol = str(symbol or "").strip().upper()
    for position in alpaca.get_positions() or []:
        if str(position.get("symbol") or "").strip().upper() != safe_symbol:
            continue
        try:
            return max(0, int(abs(float(position.get("qty") or 0))))
        except (TypeError, ValueError):
            return 0
    return 0


def _active_order(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    return str(value.get("status") or "").strip().lower() not in {
        "filled",
        "canceled",
        "cancelled",
        "expired",
        "replaced",
        "rejected",
        "done_for_day",
    }


def _collect_symbol_closing_order_ids(orders: list, symbol: str) -> list[str]:
    """Collect active sell orders for a long position without touching buy entries."""
    safe_symbol = str(symbol or "").strip().upper()
    found: list[str] = []

    def visit(value: object, inherited_symbol: str = "") -> None:
        if not isinstance(value, dict):
            return
        order_symbol = str(value.get("symbol") or inherited_symbol).strip().upper()
        side = str(value.get("side") or "").strip().lower()
        order_id = str(value.get("id") or value.get("order_id") or "").strip()
        if (
            order_symbol == safe_symbol
            and side == "sell"
            and order_id
            and _active_order(value)
            and order_id not in found
        ):
            found.append(order_id)

        for leg in value.get("legs") or []:
            visit(leg, order_symbol)

    for order in orders or []:
        visit(order)
    return found


@router.post("/overnight-protected-order/{symbol}/convert-position")
def auto_trade_convert_position_to_extended_protection(
    symbol: str,
    request: ConvertPositionToExtendedProtection,
):
    """Convert an existing long position/bracket to server-managed EXT protection.

    Alpaca native bracket exits do not work in extended hours. This endpoint
    verifies the live position, cancels only closing sell orders for the symbol,
    and atomically hands the remaining shares/levels to the AutoTrade worker.
    """
    safe_symbol = str(symbol or "").strip().upper()
    if not safe_symbol:
        raise HTTPException(status_code=400, detail="Symbol is required.")

    worker_status = store.status_payload()
    if not worker_status.get("running"):
        raise HTTPException(
            status_code=503,
            detail="The auto-trade worker is offline. Start trading-autotrade before converting a position to EXT protection.",
        )

    mode = "live" if str(request.mode or "paper").lower() == "live" else "paper"
    cfg = store.get_config()
    if mode == "live" and not cfg.allow_live:
        raise HTTPException(
            status_code=400,
            detail="Live auto trading is locked. Enable live auto trading before converting a live position to EXT protection.",
        )

    alpaca = AlpacaService(mode=mode)
    try:
        positions = alpaca.get_positions()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not verify the Alpaca position: {exc}") from exc

    live_position = next(
        (
            item
            for item in positions or []
            if str(item.get("symbol") or "").strip().upper() == safe_symbol
            and abs(float(item.get("qty") or 0)) > 0
        ),
        None,
    )
    if not isinstance(live_position, dict):
        raise HTTPException(status_code=409, detail=f"No live {safe_symbol} position was found to convert.")

    raw_qty = float(live_position.get("qty") or 0)
    if raw_qty <= 0:
        raise HTTPException(
            status_code=400,
            detail="Convert to EXT currently supports long positions only.",
        )

    qty = int(raw_qty)
    entry = float(live_position.get("avg_entry_price") or 0)
    stop = float(request.stop_price or 0)
    target = float(request.target_price or 0)
    if qty <= 0 or entry <= 0:
        raise HTTPException(status_code=409, detail="The live position quantity or average entry is unavailable.")
    if stop <= 0 or target <= 0:
        raise HTTPException(status_code=400, detail="Stop and target prices must be greater than zero.")
    if not stop < entry < target:
        raise HTTPException(status_code=400, detail="For a long EXT-protected position, prices must remain Stop < Entry < Target.")

    existing = store.get_runner_states().get(safe_symbol)
    if isinstance(existing, dict) and _is_protected_strategy(existing.get("strategy_id")):
        phase = str(existing.get("phase") or "")
        if phase in {"active_synthetic", "exit_submitted"}:
            return store.status_payload() | {
                "ok": True,
                "already_protected": True,
                "converted_symbol": safe_symbol,
            }

    now = datetime.now(timezone.utc).isoformat()
    conversion_state = {
        "phase": "conversion_pending",
        "symbol": safe_symbol,
        "strategy_id": "overnight_protected_order",
        "setup": "converted_regular_position_to_extended_protection",
        "mode": mode,
        "extended_hours": True,
        "synthetic_bracket": True,
        "protection_owner": "server_worker",
        "entry_price": entry,
        "stop_price": stop,
        "target_price": target,
        "profit_range": max(0.0, target - entry),
        "qty": qty,
        "filled_qty": qty,
        "converted_from_alpaca_bracket": True,
        "conversion_requested_at": now,
        "trail_enabled": False,
    }
    store.upsert_runner_state(safe_symbol, conversion_state)

    try:
        open_orders = alpaca.get_orders(
            status="open",
            limit=500,
            nested=True,
            symbols=[safe_symbol],
        )
        closing_ids = _collect_symbol_closing_order_ids(open_orders, safe_symbol)
        for order_id in closing_ids:
            try:
                alpaca.cancel_order(order_id)
            except Exception:
                # One bracket/OCO leg can cancel its sibling. The fresh broker
                # verification below decides whether conversion can continue.
                pass

        import time as _time
        deadline = _time.monotonic() + 5.0
        remaining_ids: list[str] = []
        while _time.monotonic() < deadline:
            remaining = alpaca.get_orders(
                status="open",
                limit=500,
                nested=True,
                symbols=[safe_symbol],
            )
            remaining_ids = _collect_symbol_closing_order_ids(remaining, safe_symbol)
            if not remaining_ids:
                break
            _time.sleep(0.15)

        if remaining_ids:
            raise RuntimeError(
                "Timed out waiting for the existing Alpaca bracket/closing orders to cancel: "
                + ", ".join(remaining_ids)
            )
    except Exception as exc:
        store.delete_runner_state(safe_symbol)
        store.log_event(
            "protected_position_conversion_failed",
            {"error": str(exc), "state": conversion_state},
            safe_symbol,
            "overnight_protected_order",
        )
        raise HTTPException(status_code=502, detail=f"Could not transfer the position to EXT protection: {exc}") from exc

    active_state = dict(conversion_state)
    active_state.update({
        "phase": "active_synthetic",
        "converted_at": datetime.now(timezone.utc).isoformat(),
        "filled_at": str(live_position.get("created_at") or now),
        "canceled_closing_order_ids": closing_ids,
    })
    store.upsert_runner_state(safe_symbol, active_state)
    store.log_event(
        "position_converted_to_extended_protection",
        {
            "symbol": safe_symbol,
            "qty": qty,
            "entry_price": entry,
            "stop_price": stop,
            "target_price": target,
            "canceled_closing_order_ids": closing_ids,
            "mode": mode,
        },
        safe_symbol,
        "overnight_protected_order",
    )

    # Do not turn on scanner/strategy auto-trading as a side effect of
    # protecting an existing position. The worker manages active synthetic
    # protection even when global strategy scanning is disabled.
    return store.status_payload() | {
        "ok": True,
        "converted_symbol": safe_symbol,
        "converted_position": active_state,
    }


@router.post("/overnight-protected-order/{symbol}/action")
def auto_trade_overnight_protected_position_action(
    symbol: str,
    request: ProtectedPositionAction,
):
    """Queue a scale-out/close/trailing action for the server protection worker.

    The route never submits an uncoordinated broker exit. It only records the
    requested risk action in the same runner state that owns the synthetic stop
    and target, so the worker can use fresh quotes, extended-hours-compliant
    limit orders, and then re-arm protection for whatever shares remain.
    """
    safe_symbol = str(symbol or "").strip().upper()
    if not safe_symbol:
        raise HTTPException(status_code=400, detail="Symbol is required.")

    runner = store.get_runner_states().get(safe_symbol)
    if not isinstance(runner, dict) or not _is_protected_strategy(runner.get("strategy_id")):
        raise HTTPException(
            status_code=404,
            detail=f"No active Overnight Protected Order was found for {safe_symbol}.",
        )

    phase = str(runner.get("phase") or "")
    if phase == "exit_submitted":
        raise HTTPException(status_code=409, detail="An exit is already working for this protected position.")

    mode = "live" if str(runner.get("mode") or "paper").lower() == "live" else "paper"
    try:
        alpaca = AlpacaService(mode=mode)
        live_qty = _live_position_qty(alpaca, safe_symbol)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not verify the live Alpaca position: {exc}") from exc

    if live_qty <= 0:
        if phase == "active_synthetic":
            store.delete_runner_state(safe_symbol)
        raise HTTPException(status_code=409, detail=f"No live Alpaca shares remain for {safe_symbol}.")

    if phase not in {"active_synthetic", "entry_submitted", "entry_cancel_requested"}:
        raise HTTPException(status_code=409, detail="The protected entry must be filled before position controls can be used.")

    # Alpaca can report the filled position one worker cycle before the runner
    # has promoted entry_submitted -> active_synthetic. Adopt the live shares
    # immediately so a risk-control click right after the fill cannot fail.
    next_state = dict(runner)
    if phase != "active_synthetic":
        next_state.update({
            "phase": "active_synthetic",
            "qty": live_qty,
            "filled_qty": live_qty,
            "filled_at": str(runner.get("filled_at") or datetime.now(timezone.utc).isoformat()),
        })
        entry_order_id = str(runner.get("order_id") or runner.get("entry_order_id") or "").strip()
        if entry_order_id:
            store.delete_pending_entry(entry_order_id)

    now = datetime.now(timezone.utc).isoformat()

    if request.action == "scale_out":
        percent = float(request.percent or 0)
        if not 0 < percent < 100:
            raise HTTPException(status_code=400, detail="Scale-out percent must be greater than 0 and less than 100.")
        exit_qty = max(1, int(live_qty * (percent / 100.0)))
        exit_qty = min(exit_qty, live_qty)
        if exit_qty >= live_qty:
            raise HTTPException(status_code=400, detail="Scale-out would close the entire position. Use Close All instead.")
        next_state.update({
            "manual_exit_action": "scale_out",
            "manual_exit_qty": exit_qty,
            "manual_exit_percent": percent,
            "manual_exit_requested_at": now,
            "manual_exit_request_id": uuid4().hex,
        })
    elif request.action == "close_all":
        next_state.update({
            "manual_exit_action": "close_all",
            "manual_exit_qty": live_qty,
            "manual_exit_percent": 100.0,
            "manual_exit_requested_at": now,
            "manual_exit_request_id": uuid4().hex,
        })
    elif request.action == "trail_start":
        next_state.update({
            "trail_enabled": True,
            "trail_initialized": False,
            "trail_enabled_at": now,
        })
        next_state.pop("trail_disabled_at", None)
    else:
        next_state.update({
            "trail_enabled": False,
            "trail_initialized": False,
            "trail_disabled_at": now,
        })

    store.upsert_runner_state(safe_symbol, next_state)
    store.log_event(
        "protected_position_action_requested",
        {
            "action": request.action,
            "percent": request.percent,
            "live_qty": live_qty,
            "manual_exit_qty": next_state.get("manual_exit_qty"),
            "trail_enabled": bool(next_state.get("trail_enabled")),
        },
        safe_symbol,
        str(runner.get("strategy_id") or "overnight_protected_order"),
    )

    return store.status_payload() | {
        "ok": True,
        "action": request.action,
        "symbol": safe_symbol,
        "live_qty": live_qty,
        "requested_exit_qty": next_state.get("manual_exit_qty"),
        "trail_enabled": bool(next_state.get("trail_enabled")),
    }


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
