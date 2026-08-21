from fastapi import APIRouter, HTTPException, Query

from app.services.symbol_intelligence_service import get_symbol_intelligence


router = APIRouter(prefix="/symbol-intelligence", tags=["symbol-intelligence"])


@router.get("/{symbol}")
def symbol_intelligence(
    symbol: str,
    news_limit: int = Query(20, ge=1, le=50),
    filings_limit: int = Query(12, ge=1, le=30),
):
    try:
        return get_symbol_intelligence(
            symbol,
            news_limit=news_limit,
            filings_limit=filings_limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
