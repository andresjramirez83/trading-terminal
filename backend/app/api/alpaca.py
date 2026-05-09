from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.alpaca_service import AlpacaMode, AlpacaService

router = APIRouter(prefix="/api/alpaca", tags=["alpaca"])


class AlpacaTakeProfitRequest(BaseModel):
    limit_price: Optional[float] = None


class AlpacaStopLossRequest(BaseModel):
    stop_price: Optional[float] = None
    limit_price: Optional[float] = None


class AlpacaOrderRequest(BaseModel):
    mode: AlpacaMode = "paper"
    symbol: str
    side: str
    qty: Optional[float] = None
    notional: Optional[float] = None
    type: str = "market"
    time_in_force: str = "day"
    limit_price: Optional[float] = None
    extended_hours: bool = False
    order_class: Optional[str] = None
    take_profit: Optional[AlpacaTakeProfitRequest] = None
    stop_loss: Optional[AlpacaStopLossRequest] = None


def get_service(mode: AlpacaMode) -> AlpacaService:
    return AlpacaService(mode=mode)


@router.get("/account")
def get_account(mode: AlpacaMode = Query("paper")):
    try:
        alpaca = get_service(mode)
        return alpaca.get_account()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/positions")
def get_positions(mode: AlpacaMode = Query("paper")):
    try:
        alpaca = get_service(mode)
        return alpaca.get_positions()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/orders")
def get_orders(
    mode: AlpacaMode = Query("paper"),
    status: str = "open",
    limit: int = 50,
):
    try:
        alpaca = get_service(mode)
        return alpaca.get_orders(status=status, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


def _clean_attached_order(value: Optional[BaseModel]) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    return value.dict(exclude_none=True)


@router.post("/order")
def place_order(request: AlpacaOrderRequest):
    try:
        if not request.symbol.strip():
            raise HTTPException(status_code=400, detail="symbol is required")

        if request.qty is None and request.notional is None:
            raise HTTPException(status_code=400, detail="qty or notional is required")

        if request.qty is not None and request.qty <= 0:
            raise HTTPException(status_code=400, detail="qty must be greater than 0")

        if request.notional is not None and request.notional <= 0:
            raise HTTPException(status_code=400, detail="notional must be greater than 0")

        if request.type == "limit" and (request.limit_price is None or request.limit_price <= 0):
            raise HTTPException(status_code=400, detail="limit_price must be provided for limit orders")

        order_class = (request.order_class or "").strip().lower() or None
        if order_class and order_class not in {"bracket", "oco", "oto"}:
            raise HTTPException(status_code=400, detail="order_class must be bracket, oco, or oto")

        take_profit = _clean_attached_order(request.take_profit)
        stop_loss = _clean_attached_order(request.stop_loss)

        if order_class in {"bracket", "oco", "oto"} and not take_profit and not stop_loss:
            raise HTTPException(status_code=400, detail="attached order requires take_profit or stop_loss")

        if take_profit and float(take_profit.get("limit_price") or 0) <= 0:
            raise HTTPException(status_code=400, detail="take_profit.limit_price must be greater than 0")

        if stop_loss and float(stop_loss.get("stop_price") or 0) <= 0:
            raise HTTPException(status_code=400, detail="stop_loss.stop_price must be greater than 0")

        alpaca = get_service(request.mode)
        return alpaca.place_order(
            symbol=request.symbol,
            side=request.side,
            order_type=request.type,
            time_in_force=request.time_in_force,
            qty=request.qty,
            notional=request.notional,
            limit_price=request.limit_price,
            extended_hours=request.extended_hours,
            order_class=order_class,
            take_profit=take_profit,
            stop_loss=stop_loss,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
