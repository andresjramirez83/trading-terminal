from fastapi import APIRouter
from pathlib import Path
import json

router = APIRouter(prefix="/chart", tags=["chart"])

BASE_DIR = Path("data/chart_storage")
BASE_DIR.mkdir(parents=True, exist_ok=True)


def _file(symbol: str, scope: str, kind: str):
    return BASE_DIR / f"{symbol.upper()}_{scope}_{kind}.json"


# ------------------------
# TRENDLINES
# ------------------------

@router.get("/trendlines/{symbol}/{scope}")
def get_trendlines(symbol: str, scope: str):
    path = _file(symbol, scope, "trendlines")
    if not path.exists():
        return []
    return json.loads(path.read_text())


@router.put("/trendlines/{symbol}/{scope}")
def save_trendlines(symbol: str, scope: str, data: list):
    path = _file(symbol, scope, "trendlines")
    path.write_text(json.dumps(data))
    return {"ok": True}


# ------------------------
# PROJECTIONS
# ------------------------

@router.get("/projections/{symbol}/{scope}")
def get_projections(symbol: str, scope: str):
    path = _file(symbol, scope, "projections")
    if not path.exists():
        return []
    return json.loads(path.read_text())


@router.put("/projections/{symbol}/{scope}")
def save_projections(symbol: str, scope: str, data: list):
    path = _file(symbol, scope, "projections")
    path.write_text(json.dumps(data))
    return {"ok": True}