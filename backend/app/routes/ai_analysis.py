"""Read-only AI chart research endpoints. Never imports order/execution modules."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Response, Request
from pydantic import BaseModel, Field

from app.services.ai_pattern_engine import closed_bars, summarize_pattern
from app.services.ai_chart_annotations import build_ai_annotations
from app.services.ai_chart_projections import build_ai_projections
from app.services.ai_mtf_fvg_respect import build_mtf_fvg_respect
from app.services.ai_liquidity_sweep_match import match_saved_liquidity_sweep
from app.services.ai_displacement_fvg_sweep import build_displacement_fvg_sweep
from app.services.ai_pattern_library import get_pattern_image, list_patterns, save_pattern
from app.services.ai_vision_service import chart_png, vision_analyze
import httpx
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
    include_multi_timeframe: bool = False  # opt-in; adds three historical data requests


class ScanRequest(BaseModel):
    symbols: List[str] = Field(min_length=1, max_length=30)
    # Visual comparison is opt-in to avoid unsolicited API charges.
    reference_id: Optional[str] = None
    visual_top_n: int = Field(default=0, ge=0, le=2)


SESSION_COOKIE = "tt_ai_session"
SESSION_DAYS = 30


def _session_valid(raw: str, secret: str) -> bool:
    try:
        version, expiry_text, signature = raw.split(".")
        expiry = int(expiry_text)
        if version != "v1" or expiry <= time.time() or expiry > time.time() + SESSION_DAYS*86400 + 120:
            return False
        msg = f"trading-terminal-ai-session:v1:{expiry}".encode()
        expected = hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)
    except (ValueError, AttributeError):
        return False


def _authorize(token: Optional[str], request: Optional[Request] = None):
    secret = os.getenv("AI_ANALYSIS_TOKEN", "").strip()
    if os.getenv("OPENAI_API_KEY", "").strip() and not secret:
        raise HTTPException(status_code=503, detail="Set AI_ANALYSIS_TOKEN before enabling OPENAI_API_KEY")
    if secret:
        token_ok = bool(token) and hmac.compare_digest(str(token), secret)
        cookie_ok = bool(request) and _session_valid(request.cookies.get(SESSION_COOKIE, ""), secret)
        if not token_ok and not cookie_ok:
            raise HTTPException(status_code=401, detail="AI session required. Sign in securely once in the Coach panel.")


@router.get("/session")
def ai_session_status(request: Request):
    secret = os.getenv("AI_ANALYSIS_TOKEN", "").strip()
    return {"authenticated": bool(secret and _session_valid(request.cookies.get(SESSION_COOKIE, ""), secret)),
            "requires_token": bool(secret)}


@router.post("/session")
def begin_ai_session(request: Request, response: Response,
                     x_ai_analysis_token: Optional[str] = Header(default=None)):
    # A persistent cookie must NEVER be issued over public HTTP. Run a genuine
    # HTTPS reverse proxy before enabling remember-me in the browser.
    if request.url.scheme != "https":
        raise HTTPException(status_code=403, detail="Secure AI sign-in requires HTTPS. Do not submit your token over HTTP.")
    secret = os.getenv("AI_ANALYSIS_TOKEN", "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="AI_ANALYSIS_TOKEN is not configured")
    if not x_ai_analysis_token or not hmac.compare_digest(x_ai_analysis_token, secret):
        raise HTTPException(status_code=401, detail="Incorrect AI access token")
    expiry = int(time.time()) + SESSION_DAYS*86400
    msg = f"trading-terminal-ai-session:v1:{expiry}".encode()
    signature = hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    response.set_cookie(key=SESSION_COOKIE, value=f"v1.{expiry}.{signature}",
                        max_age=SESSION_DAYS*86400, httponly=True, secure=True,
                        samesite="strict", path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"authenticated": True, "expires_at": expiry}


@router.delete("/session")
def end_ai_session(response: Response):
    response.delete_cookie(key=SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="strict")
    response.headers["Cache-Control"] = "no-store"
    return {"authenticated": False}


def _symbol(raw: str) -> str:
    symbol = str(raw or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,14}", symbol):
        raise HTTPException(status_code=400, detail="Invalid ticker symbol")
    return symbol


async def _bars(symbol: str):
    # The shared Alpaca httpx client may have been opened by a short-lived
    # asyncio.run() loop elsewhere in the application. Create a client solely
    # for this AI request so no closed-loop transport can be reused.
    service = AlpacaMarketService()
    async with httpx.AsyncClient(
        timeout=service.timeout,
        follow_redirects=True,
        http2=False,
        limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
    ) as client:
        # Per-instance override only; no changes to the shared market service
        # used by charts, orders, scanners, or background workers.
        service._client = lambda _timeout: client
        result = await asyncio.gather(
            service.get_bars(symbol, "1m", "extended", lookback="2d", limit=250),
            service.get_bars(symbol, "5m", "extended", lookback="5d", limit=160),
            return_exceptions=True,
        )
    return [row if isinstance(row, list) else [] for row in result], [str(row) for row in result if isinstance(row, Exception)]


async def _higher_timeframe_bars(symbol: str):
    """Isolated HTTP transport, as with _bars; never changes shared chart feeds."""
    service = AlpacaMarketService()
    specs = (("15m", "10d", 240), ("30m", "15d", 240), ("1h", "20d", 240))
    async with httpx.AsyncClient(
        timeout=service.timeout, follow_redirects=True, http2=False,
        limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
    ) as client:
        service._client = lambda _timeout: client
        results = await asyncio.gather(*(
            service.get_bars(symbol, tf, "extended", lookback=lookback, limit=limit)
            for tf, lookback, limit in specs
        ), return_exceptions=True)
    frames = {}
    errors = {}
    for (tf, _, _), result in zip(specs, results):
        if isinstance(result, BaseException):
            frames[tf] = []
            errors[tf] = str(result)[:160]
        else:
            frames[tf] = result if isinstance(result, list) else []
    return frames, errors


def _score(result: Dict[str, Any]) -> int:
    # Discovery sort order only; NOT a win probability or model similarity.
    points = 0
    c1, c5 = result["one_minute"], result["five_minute"]
    if result["structure"].get("available"): points += 1
    if c1.get("engulfing_recent_5"): points += 2
    if c5.get("strong_bullish_close"): points += 2
    if c5.get("red_body_recovery_pct", 0) and c5["red_body_recovery_pct"] >= 50: points += 1
    return points


async def _market_report(symbol: str, include_multi_timeframe: bool = False, reference_pattern: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    (one, five), errors = await _bars(symbol)
    report = summarize_pattern(symbol, one, five)
    report["data_errors"] = errors
    report["rank_points"] = _score(report)
    closed_one, closed_five = closed_bars(one, 1), closed_bars(five, 5)
    report["annotations"] = build_ai_annotations(closed_one, closed_five, report.get("structure") or {})
    # Dedicated causal setup: target is chosen from gaps known BEFORE its sweep.
    strategy = build_displacement_fvg_sweep(closed_five)
    report["displacement_fvg_sweep"] = strategy
    candidate = strategy.get("setup") or strategy.get("watch")
    if candidate:
        gap = candidate["gap"]
        zone = candidate["zone"]
        report["annotations"].extend([
            {"id": "dfs-liquidity-zone", "kind": "zone", "tone": "context", "timeframe": "5m",
             "low": zone["low"], "high": min(zone["high"], zone["low"] * 1.02),
             "label": f"Range lows · {zone['touches']} tests", "source": "closed_bars"},
            {"id": "dfs-fvg-target", "kind": "zone", "tone": "watch", "timeframe": "5m",
             "low": gap["low"], "high": gap["high"], "label": "Pre-sweep bearish FVG target",
             "source": "closed_bars"},
        ])
        if strategy.get("setup"):
            setup = strategy["setup"]
            for stage in setup["stages"]:
                report["annotations"].append({
                    "id": "dfs-" + stage["stage"], "kind": "marker", "tone": "confirmed" if stage["stage"] == "reclaim" else "watch",
                    "timeframe": "5m", "time_ms": stage["time_ms"], "price": stage["price"],
                    "label": "Fast reclaim" if stage["stage"] == "reclaim" else "Sweep below range", "source": "closed_bars",
                })
    projected = build_ai_projections(closed_one, closed_five)
    if errors:
        # Never display a directional forward path as live when market bars failed.
        projected["note"] += " Forecast paths suppressed because one or more feeds failed."
        projected["timeframes"] = {}
        projected["marks"] = []
    report["annotations"].extend(projected.pop("marks"))
    report["projections"] = projected
    if reference_pattern:
        tf = str(reference_pattern.get("timeframe") or "5m").lower()
        reference_bars = closed_one if tf == "1m" else closed_five if tf == "5m" else []
        report["pattern_match"] = match_saved_liquidity_sweep(reference_bars, reference_pattern)
    if include_multi_timeframe:
        # Reuse completed 1m/5m bars already fetched. Failures in higher intervals
        # do NOT poison the existing projections or fabricate missing evidence.
        try:
            higher, higher_errors = await _higher_timeframe_bars(symbol)
            frames = {"1m": closed_one, "5m": closed_five}
            frames.update({tf: closed_bars(higher.get(tf, []), minutes) for tf, minutes in
                           (("15m", 15), ("30m", 30), ("1h", 60))})
            report["multi_timeframe"] = build_mtf_fvg_respect(frames)
            report["multi_timeframe"]["feed_errors"] = higher_errors
        except Exception as exc:
            report["multi_timeframe"] = {"timeframes": {}, "ranked_open_gaps": [],
                                        "selected_gap": None, "dominant_timeframe": None,
                                        "feed_errors": {"multi_timeframe": str(exc)[:180]}}
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
def patterns(request: Request, x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token, request)
    return {"patterns": list_patterns(), "method": "Saved examples only; no automatic model training"}


@router.get("/patterns/{pattern_id}/image")
def pattern_image(pattern_id: str, request: Request, x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token, request)
    try:
        info, content = get_pattern_image(pattern_id)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=404, detail="Pattern image not found") from exc
    media = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[info["image_ext"]]
    return Response(content=content, media_type=media, headers={"Cache-Control": "private, no-store"})


@router.post("/patterns", status_code=201)
def upload_pattern(data: PatternUpload, request: Request, x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token, request)
    try:
        return save_pattern(data.name, data.label, data.timeframe, data.note, data.image_data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/analyze/{symbol}")
async def analyze(symbol: str, options: AnalysisRequest, request: Request,
                  x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token, request)
    symbol = _symbol(symbol)
    reference_pattern = None
    if options.reference_id:
        try:
            get_pattern_image(options.reference_id)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=404, detail="Pattern reference not found") from exc
        reference_pattern = next((p for p in list_patterns() if p.get("id") == options.reference_id), None)
    report = await _market_report(symbol, include_multi_timeframe=options.include_multi_timeframe,
                                  reference_pattern=reference_pattern)
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
async def scan(options: ScanRequest, request: Request, x_ai_analysis_token: Optional[str] = Header(default=None)):
    _authorize(x_ai_analysis_token, request)
    clean = list(dict.fromkeys(_symbol(raw) for raw in options.symbols))
    scan_reference = None
    if options.reference_id:
        try:
            get_pattern_image(options.reference_id)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=404, detail="Pattern reference not found") from exc
        scan_reference = next((p for p in list_patterns() if p.get("id") == options.reference_id), None)
    sem = asyncio.Semaphore(4)
    async def one(s: str):
        async with sem:
            try:
                return await _market_report(s, reference_pattern=scan_reference)
            except Exception as exc:
                return {"symbol": s, "data_errors": [str(exc)[:180]], "rank_points": 0, "phase": "unavailable"}
    results = await asyncio.gather(*(one(symbol) for symbol in clean))
    # When the user selects a saved sweep example, confirmed pattern matches
    # rank above generic continuation/pullback points. No match != a match.
    results.sort(key=lambda v: (bool((v.get("pattern_match") or {}).get("matched")) and
                                not bool((v.get("pattern_match") or {}).get("historical_only")),
                                int(v.get("rank_points", 0))), reverse=True)
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
