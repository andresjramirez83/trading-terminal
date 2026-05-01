from fastapi import APIRouter, HTTPException, Query
from app.services.alpaca_service import AlpacaService, AlpacaMode

router = APIRouter(prefix="/api/alpaca", tags=["alpaca"])


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


@router.post("/order")
def place_order(
    symbol: str,
    side: str,
    order_type: str,
    time_in_force: str,
    qty: float | None = None,
    notional: float | None = None,
    limit_price: float | None = None,
    extended_hours: bool = False,
    mode: AlpacaMode = Query("paper"),
):
    try:
        alpaca = get_service(mode)
        return alpaca.place_order(
            symbol=symbol,
            side=side,
            order_type=order_type,
            time_in_force=time_in_force,
            qty=qty,
            notional=notional,
            limit_price=limit_price,
            extended_hours=extended_hours,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))