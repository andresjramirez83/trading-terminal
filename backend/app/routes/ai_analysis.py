"""Read-only AI chart research endpoints. Never imports order/execution modules."""
from __future__ import annotations

import asyncio
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, Field

from app.services.ai_pattern_engine import closed_bars, summarize_pattern
from app.services.ai_pattern_library import get_pattern_image, list_patterns, save_pattern
from app.services.ai_vision_service import chart_png, vision_analyze
from app.services.alpaca_market_service import AlpacaMarketService
from app.services.moomoo_level2_service import moomoo_level2_service
from app.services.symbol_intelligence_service import get_symbol_intelligence

router = APIRouter(prefix="/ai-analysis", tags=["ai-analysis"])


class PatternUpload(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    label: str = Field(default="interesting", max_length=32)
    timeframe: str = Field(default="5m", max_length=16)
    note: str = Field(default="", max_length=1500)
    image_data: str = Field(min_length=32, max_length=7_000_000)


class AnalysisRequest(BaseModel):
    reference_id: Optional[str] = None
    include_vision: bool = True
    include_level2: bool = True
    include_news: bool = True


class ScanRequest(BaseModel):
    symbols: List[str] = Field(min_length=1, max_length=30)
    # Visual comparison is opt-in to avoid unsolicited API charges.
    reference_id: Optional[str] = None
    visual_top_n: int = Field(default=0, ge=0, le=2)


def _authorize(token: Optional[str]):
    expected = os.getenv("AI_ANALYSIS_TOKEN", "").strip()
    # Refuse to expose a paid vision key through an unauthenticated HTTP route.
    if os.getenv("OPENAI_API_KEY", "").strip() and not expected:
        raise HTTPException(status_code=503, detail="Set AI_ANALYSIS_TOKEN before enabling OPENAI_API_KEY")
    if expected:
        import hmac
        if not token or not hmac.compare_digest(token, expected):
            raise HTTPException(status_code=401, detail="Invalid or missing AI analysis access token")


def _symbol(raw: str) -> str:
    symbol = str(raw or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,14}", symbol):
        raise HTTPException(status_code=400, detail="Invalid ticker symbol")
    return symbol


async def _bars(symbol: str):
    service = AlpacaMarketService()
    result = await asyncio.gather(
        service.get_bars(symbol, "1m", "extended", lookback="2d", limit=250),
        service.get_bars(symbol, "5m", "extended", lookback="5d", limit=160),
        return_exceptions=True,
    )
    return [row if isinstance(row, list) else [] for row in result], [str(row) for row in result if isinstance(row, Exception)]


def _score(result: Dict[str, Any]) -> int:
    # Discovery sort order only; NOT a win probability or model similarity.
    points = 0
    c1, c5 = result["one_minute"], result["five_minute"]
    if result["structure"].get("available"): points += 1
    if c1.get("engulfing_recent_5"): points += 2
    if c5.get("strong_bullish_close"): points += 2
    if c5.get("red_body_recovery_pct", 0) and c5["red_body_recovery_pct"] >= 50: points += 1
    return points


async def _market_report(symbol: str) -> Dict[str, Any]:
    (one, five), errors = await _bars(symbol)
    report = summarize_pattern(symbol, one, five)
    report["data_errors"] = errors
    report["rank_points"] = _score(report)
    return report


def _light_news(info: Dict[str, Any]) -> Dict[str, Any]:
    alerts = info.get("alerts", [])
    return {
        "as_of": info.get("as_of"),
        "alerts": alerts[:8],
        "headlines": [{"headline": row.get("headline"), "category": row.get("category"),
                       "created_at": row.get("created_at"), "url": row.get("url")}
                      for row in info.get("news", [])[:8]],
        "filings": [{"form": row.get("form"), "filing_date": row.get("filing_date"),
                     "category": row.get("category"), "url": row.get("url")}
                    for row in info.get("filings", [])[:8]],
        "sources": info.get("sources", {}), "active_halt": info.get("active_halt"),
    }


async def _fresh_level2(symbol: str) -> Dict[str, Any]:
    """Brief subscription to obtain a fresh snapshot, with guaranteed cleanup."""
    subscribed = False
    try:
        await asyncio.to_thread(moomoo_level2_service.add_consumer, symbol)
        subscribed = True
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            value = _current_level2(symbol)
            if value.get("available"):
                return value
            await asyncio.sleep(.10)
        return _current_level2(symbol)
    except Exception as exc:
        return {"available": False, "reason": f"Moomoo OpenD snapshot unavailable: {str(exc)[:160]}"}
    finally:
        if subscribed:
            await asyncio.to_thread(moomoo_level2_service.remove_consumer, symbol)


def _current_level2(symbol: str) -> Dict[str, Any]:
    snapshot = moomoo_level2_service.get_snapshot(symbol)
    if snapshot is None:
        return {"available": False, "reason": "No current Level 2 snapshot for this symbol"}
    age = time.time() - float(snapshot.get("received_at", 0))
    if not 0 <= age <= 10:
        return {"available": False, "reason": f"Level 2 snapshot is stale ({age:.0f}s old)"}
    return {
        "available": True, "age_seconds": round(age, 1),
        "spread": snapshot.get("spread"),
        "best_bid": snapshot.get("best_bid"), "best_ask": snapshot.get("best_ask"),
        "top5_imbalance": (snapshot.get("analytics") or {}).get("top5_imbalance"),
        "book_pressure": (snapshot.get("analytics") or {}).get("book_pressure"),
        "tape_5s": {
            key: (snapshot.get("breakout") or {}).get("metrics", {}).get(key)
            for key in ("aggressive_buy_volume_5s", "aggressive_sell_volume_5s", "trade_pressure_5s", "ticker_prints_5s")
        },
        "l2_ready": (snapshot.get("breakout") or {}).get("ready", False),
        "note": "Snapshot only. Tape statistics are classifications provided by the Moomoo service; verify quality and freshness. Visible book orders can be cancelled.",
    }


@router.get("/patterns")
def patterns(x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token)
    return {"patterns": list_patterns(), "method": "Saved examples only; no automatic model training"}


@router.get("/patterns/{pattern_id}/image")
def pattern_image(pattern_id: str, x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token)
    try:
        info, content = get_pattern_image(pattern_id)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=404, detail="Pattern image not found") from exc
    media = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[info["image_ext"]]
    return Response(content=content, media_type=media, headers={"Cache-Control": "private, no-store"})


@router.post("/patterns", status_code=201)
def upload_pattern(data: PatternUpload, x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token)
    try:
        return save_pattern(data.name, data.label, data.timeframe, data.note, data.image_data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/analyze/{symbol}")
async def analyze(symbol: str, options: AnalysisRequest,
                  x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token)
    symbol = _symbol(symbol)
    if options.reference_id:
        try:
            get_pattern_image(options.reference_id)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=404, detail="Pattern reference not found") from exc
    report = await _market_report(symbol)
    if options.include_news:
        try:
            news = await asyncio.to_thread(get_symbol_intelligence, symbol)
            report["news"] = _light_news(news)
        except Exception as exc:
            report["news"] = {"sources": {"error": str(exc)[:180]}, "alerts": []}
    if options.include_level2:
        report["level2"] = await _fresh_level2(symbol)
    if options.include_vision:
        try:
            # Vision uses only *completed* chart candles.
            (one, five), _ = await _bars(symbol)
            chart = chart_png(closed_bars(five, 5) or closed_bars(one, 1))
            report["vision"] = await asyncio.to_thread(vision_analyze, chart, report, options.reference_id)
        except Exception as exc:
            report["vision"] = {"ok": False, "status": "unavailable", "message": str(exc)[:180]}
    else:
        report["vision"] = {"ok": False, "status": "disabled", "message": "Visual AI not requested"}
    report["advisory"] = "Research only. No order action. Missing or delayed feeds are not evidence of safety."
    return report


@router.post("/scan")
async def scan(options: ScanRequest, x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token)
    clean = list(dict.fromkeys(_symbol(raw) for raw in options.symbols))
    if options.reference_id:
        try:
            get_pattern_image(options.reference_id)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=404, detail="Pattern reference not found") from exc
    sem = asyncio.Semaphore(4)
    async def one(s: str):
        async with sem:
            try:
                return await _market_report(s)
            except Exception as exc:
                return {"symbol": s, "data_errors": [str(exc)[:180]], "rank_points": 0, "phase": "unavailable"}
    results = await asyncio.gather(*(one(symbol) for symbol in clean))
    results.sort(key=lambda v: int(v.get("rank_points", 0)), reverse=True)
    # Visual inspection only the highest-ranked symbols when explicitly requested.
    if options.visual_top_n:
        for candidate in results[:options.visual_top_n]:
            if candidate.get("data_errors") or candidate.get("candle_counts", {}).get("5m", 0) < 1:
                continue
            try:
                (_, five), _ = await _bars(candidate["symbol"])
                candidate["vision"] = await asyncio.to_thread(
                    vision_analyze, chart_png(closed_bars(five, 5)), candidate, options.reference_id)
            except Exception as exc:
                candidate["vision"] = {"ok": False, "message": str(exc)[:160]}
    return {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "rank_explanation": "0–6 rule-based discovery points, NOT a success probability or visual similarity percentage",
        "scope": "User-supplied symbols; scan runs only when clicked",
        "results": results,
    }
