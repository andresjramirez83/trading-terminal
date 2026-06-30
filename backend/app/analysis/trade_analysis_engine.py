from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.analysis.trade_analysis_models import (
    ReadinessAnalysis,
    SessionAnalysis,
    StructureAnalysis,
    TradeAnalysis,
    TradeAnalysisScores,
    TrendAnalysis,
    VolatilityAnalysis,
    VolumeAnalysis,
)
from app.services.polygon_service import PolygonService
from app.services.scanner_cache_service import get_scanner_recent_1m_bars, get_scanner_ticker_details

ET = ZoneInfo("America/New_York")


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        number = float(value)
        if math.isfinite(number):
            return number
        return default
    except Exception:
        return default


def first_number(*values: Any) -> Optional[float]:
    for value in values:
        try:
            if value is None:
                continue
            number = float(value)
            if math.isfinite(number):
                return number
        except Exception:
            continue
    return None


def pct_change(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0
    return ((current - previous) / previous) * 100.0


def normalize_bar(bar: Dict[str, Any]) -> Dict[str, float]:
    return {
        "time": int(safe_float(bar.get("time", bar.get("t", 0)))),
        "open": safe_float(bar.get("open", bar.get("o"))),
        "high": safe_float(bar.get("high", bar.get("h"))),
        "low": safe_float(bar.get("low", bar.get("l"))),
        "close": safe_float(bar.get("close", bar.get("c"))),
        "volume": safe_float(bar.get("volume", bar.get("v"))),
    }


def valid_bars(raw_bars: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    bars = [normalize_bar(item) for item in raw_bars or []]
    return [
        item
        for item in bars
        if item["time"] > 0 and item["high"] > 0 and item["low"] > 0 and item["close"] > 0
    ]


def session_kind(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ET)
    hhmm = dt.hour * 100 + dt.minute

    if 400 <= hhmm < 930:
        return "premarket"
    if 930 <= hhmm < 1600:
        return "regular"
    if 1600 <= hhmm < 2000:
        return "afterhours"

    return "closed"


def et_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ET).strftime("%Y-%m-%d")


def ema(values: List[float], period: int) -> Optional[float]:
    clean = [float(value) for value in values if value > 0]

    if len(clean) < period:
        return None

    multiplier = 2.0 / (period + 1.0)
    current = sum(clean[:period]) / period

    for value in clean[period:]:
        current = (value - current) * multiplier + current

    return current


def calc_vwap(bars: List[Dict[str, float]]) -> Optional[float]:
    pv = 0.0
    volume = 0.0

    for bar in bars:
        typical = (bar["high"] + bar["low"] + bar["close"]) / 3.0
        bar_volume = safe_float(bar.get("volume"))

        if typical > 0 and bar_volume > 0:
            pv += typical * bar_volume
            volume += bar_volume

    if volume <= 0:
        return None

    return pv / volume


def calc_atr(bars: List[Dict[str, float]], period: int = 14) -> Optional[float]:
    if len(bars) < period + 1:
        return None

    true_ranges: List[float] = []

    for index in range(1, len(bars)):
        high = bars[index]["high"]
        low = bars[index]["low"]
        previous_close = bars[index - 1]["close"]

        true_ranges.append(
            max(
                high - low,
                abs(high - previous_close),
                abs(low - previous_close),
            )
        )

    recent = true_ranges[-period:]

    if not recent:
        return None

    return sum(recent) / len(recent)


def average_volume(bars: List[Dict[str, float]], period: int = 20) -> Optional[float]:
    volumes = [
        safe_float(item.get("volume"))
        for item in bars[-period:]
        if safe_float(item.get("volume")) > 0
    ]

    if not volumes:
        return None

    return sum(volumes) / len(volumes)


def average_range(bars: List[Dict[str, float]], period: int = 20) -> Optional[float]:
    ranges = [
        safe_float(item.get("high")) - safe_float(item.get("low"))
        for item in bars[-period:]
        if safe_float(item.get("high")) > safe_float(item.get("low"))
    ]

    if not ranges:
        return None

    return sum(ranges) / len(ranges)


def group_by_regular_day(bars: List[Dict[str, float]]) -> Dict[str, List[Dict[str, float]]]:
    grouped: Dict[str, List[Dict[str, float]]] = {}

    for bar in bars:
        if session_kind(int(bar["time"])) != "regular":
            continue

        grouped.setdefault(et_date(int(bar["time"])), []).append(bar)

    return grouped


def extract_share_stats(details: Dict[str, Any]) -> Dict[str, Optional[float]]:
    details = details or {}

    return {
        "float_shares": first_number(
            details.get("float_shares"),
            details.get("public_float"),
            details.get("float"),
            details.get("share_class_shares_outstanding"),
            details.get("weighted_shares_outstanding"),
        ),
        "shares_outstanding": first_number(
            details.get("share_class_shares_outstanding"),
            details.get("weighted_shares_outstanding"),
        ),
        "short_interest_pct": first_number(
            details.get("short_interest_pct"),
            details.get("short_percent_of_float"),
            details.get("percent_of_float_short"),
            details.get("short_float_percent"),
        ),
    }


def classify_ema_alignment(
    ema_9: Optional[float],
    ema_20: Optional[float],
    ema_50: Optional[float],
) -> str:
    if ema_9 and ema_20 and ema_50:
        if ema_9 > ema_20 > ema_50:
            return "bullish"
        if ema_9 < ema_20 < ema_50:
            return "bearish"

    if ema_9 and ema_20:
        if ema_9 > ema_20:
            return "bullish_partial"
        if ema_9 < ema_20:
            return "bearish_partial"

    return "neutral"


def trend_direction(ema_alignment: str, last_price: float, ema_20: Optional[float]) -> str:
    if ema_alignment in {"bullish", "bullish_partial"} and ema_20 and last_price > ema_20:
        return "bullish"

    if ema_alignment in {"bearish", "bearish_partial"} and ema_20 and last_price < ema_20:
        return "bearish"

    return "neutral"


def score_trend(ema_alignment: str, above_vwap: Optional[bool]) -> float:
    score = 50.0

    if ema_alignment == "bullish":
        score += 30.0
    elif ema_alignment == "bullish_partial":
        score += 15.0
    elif ema_alignment == "bearish":
        score -= 30.0
    elif ema_alignment == "bearish_partial":
        score -= 15.0

    if above_vwap is True:
        score += 10.0
    elif above_vwap is False:
        score -= 10.0

    return max(0.0, min(100.0, score))


def score_volume(relative_volume: Optional[float]) -> float:
    if relative_volume is None:
        return 0.0

    return max(0.0, min(100.0, relative_volume * 35.0))


def score_volatility(atr_pct: Optional[float], range_expansion: Optional[float]) -> float:
    score = 0.0

    if atr_pct is not None:
        score += min(atr_pct * 10.0, 50.0)

    if range_expansion is not None:
        score += min(range_expansion * 25.0, 50.0)

    return max(0.0, min(100.0, score))


def score_structure(close_position_pct: float) -> float:
    return max(0.0, min(100.0, close_position_pct))


def score_readiness(
    *,
    gap_pct: float,
    relative_volume: Optional[float],
    atr_pct: Optional[float],
    above_vwap: Optional[bool],
    ema_alignment: str,
    float_shares: Optional[float],
    short_interest_pct: Optional[float],
) -> float:
    score = 40.0

    if gap_pct > 0:
        score += min(gap_pct * 2.0, 18.0)
    else:
        score += max(gap_pct * 1.0, -12.0)

    if relative_volume is not None:
        score += min(max((relative_volume - 1.0) * 10.0, -8.0), 18.0)

    if atr_pct is not None:
        score += min(max(atr_pct * 2.0, 0.0), 12.0)

    if above_vwap is True:
        score += 10.0
    elif above_vwap is False:
        score -= 8.0

    if ema_alignment == "bullish":
        score += 12.0
    elif ema_alignment == "bullish_partial":
        score += 6.0
    elif ema_alignment == "bearish":
        score -= 12.0
    elif ema_alignment == "bearish_partial":
        score -= 6.0

    if float_shares and float_shares <= 50_000_000:
        score += 4.0

    if short_interest_pct and short_interest_pct >= 15:
        score += 4.0

    return max(0.0, min(100.0, score))


def readiness_grade(score: float) -> str:
    if score >= 80:
        return "excellent"
    if score >= 65:
        return "strong"
    if score >= 50:
        return "watch"
    if score >= 35:
        return "weak"

    return "avoid"


def structure_state(
    *,
    close_position_pct: float,
    last_price: float,
    session_high: Optional[float],
    session_low: Optional[float],
) -> str:
    if session_high and last_price >= session_high:
        return "breaking_high"

    if session_low and last_price <= session_low:
        return "breaking_low"

    if close_position_pct >= 70:
        return "upper_range"

    if close_position_pct <= 30:
        return "lower_range"

    return "mid_range"


class TradeAnalysisEngine:
    """Shared per-symbol market analysis used by scanners, alerts, charts, and Decision Center."""

    def __init__(self, *, hours_back: int = 96) -> None:
        self.hours_back = max(24, int(hours_back or 96))

    async def analyze_symbol(
        self,
        polygon: PolygonService,
        symbol: str,
        *,
        snapshot: Optional[Dict[str, Any]] = None,
        timeframe: str = "1m",
    ) -> Optional[TradeAnalysis]:
        symbol = str(symbol or "").upper().strip()

        if not symbol:
            return None

        raw_bars = await get_scanner_recent_1m_bars(
            polygon,
            symbol,
            hours_back=self.hours_back,
        )

        bars = valid_bars(raw_bars)

        if len(bars) < 20:
            return None

        snapshot = snapshot or {}
        last = bars[-1]
        last_price = safe_float(last.get("close"))

        previous_close = safe_float((snapshot.get("prevDay") or {}).get("c"))

        if previous_close <= 0:
            regular_days = group_by_regular_day(bars)
            day_keys = list(regular_days.keys())

            if len(day_keys) >= 2:
                previous_close = safe_float(regular_days[day_keys[-2]][-1].get("close"))

        gap_pct = pct_change(last_price, previous_close) if previous_close > 0 else 0.0

        latest_session = session_kind(int(last["time"]))
        latest_date = et_date(int(last["time"]))

        today_bars = [
            bar
            for bar in bars
            if et_date(int(bar["time"])) == latest_date
        ]

        regular_today = [
            bar
            for bar in today_bars
            if session_kind(int(bar["time"])) == "regular"
        ]

        session_bars = regular_today or today_bars[-120:] or bars[-120:]

        day_volume = sum(safe_float(item.get("volume")) for item in session_bars)
        current_volume = safe_float(last.get("volume"))
        avg_volume_20 = average_volume(bars, 20)
        relative_volume = (day_volume / avg_volume_20) if avg_volume_20 and avg_volume_20 > 0 else None

        closes = [safe_float(item.get("close")) for item in bars]

        ema_9 = ema(closes, 9)
        ema_20 = ema(closes, 20)
        ema_50 = ema(closes, 50)
        ema_200 = ema(closes, 200)

        vwap = calc_vwap(session_bars)
        above_vwap = last_price > vwap if vwap and vwap > 0 else None

        atr_14 = calc_atr(bars, 14)
        atr_pct = (atr_14 / last_price) * 100.0 if atr_14 and last_price > 0 else None

        current_range = safe_float(last.get("high")) - safe_float(last.get("low"))
        avg_range_20 = average_range(bars, 20)
        range_expansion = (
            current_range / avg_range_20
            if avg_range_20 and avg_range_20 > 0 and current_range > 0
            else None
        )

        session_high = max((safe_float(item.get("high")) for item in session_bars), default=0.0) or None
        session_low = min((safe_float(item.get("low")) for item in session_bars), default=0.0) or None

        close_position_pct = 0.0

        if session_high and session_low and session_high > session_low:
            close_position_pct = ((last_price - session_low) / (session_high - session_low)) * 100.0
            close_position_pct = max(0.0, min(100.0, close_position_pct))

        ema_alignment = classify_ema_alignment(ema_9, ema_20, ema_50)

        details = await get_scanner_ticker_details(polygon, symbol)
        share_stats = extract_share_stats(details)

        signals: List[str] = []
        warnings: List[str] = []

        if gap_pct >= 3:
            signals.append("Gap up")

        if relative_volume is not None and relative_volume >= 2:
            signals.append("Relative volume")

        if atr_pct is not None and atr_pct >= 3:
            signals.append("ATR expansion")

        if range_expansion is not None and range_expansion >= 1.5:
            signals.append("Range expansion")

        if above_vwap is True:
            signals.append("Above VWAP")

        if ema_alignment == "bullish":
            signals.append("EMA alignment")

        if share_stats.get("float_shares") and share_stats["float_shares"] <= 50_000_000:
            signals.append("Lower float")

        if share_stats.get("short_interest_pct") and share_stats["short_interest_pct"] >= 15:
            signals.append("Short interest")

        if above_vwap is False:
            warnings.append("Below VWAP")

        if ema_alignment == "bearish":
            warnings.append("Bearish EMA alignment")

        if relative_volume is not None and relative_volume < 0.75:
            warnings.append("Low relative volume")

        readiness_score = score_readiness(
            gap_pct=gap_pct,
            relative_volume=relative_volume,
            atr_pct=atr_pct,
            above_vwap=above_vwap,
            ema_alignment=ema_alignment,
            float_shares=share_stats.get("float_shares"),
            short_interest_pct=share_stats.get("short_interest_pct"),
        )

        trend_score = score_trend(ema_alignment, above_vwap)
        volume_score = score_volume(relative_volume)
        volatility_score = score_volatility(atr_pct, range_expansion)
        structure_score = score_structure(close_position_pct)

        trend = TrendAnalysis(
            direction=trend_direction(ema_alignment, last_price, ema_20),
            ema_9=ema_9,
            ema_20=ema_20,
            ema_50=ema_50,
            ema_200=ema_200,
            ema_alignment=ema_alignment,
            above_ema_9=last_price > ema_9 if ema_9 else None,
            above_ema_20=last_price > ema_20 if ema_20 else None,
            above_ema_50=last_price > ema_50 if ema_50 else None,
            strength=trend_score,
        )

        volume = VolumeAnalysis(
            current_volume=current_volume,
            average_volume_20=avg_volume_20,
            relative_volume=relative_volume,
            day_volume=day_volume,
            volume_score=volume_score,
        )

        volatility = VolatilityAnalysis(
            atr_14=atr_14,
            atr_pct=atr_pct,
            current_range=current_range,
            average_range_20=avg_range_20,
            range_expansion=range_expansion,
            volatility_score=volatility_score,
        )

        structure = StructureAnalysis(
            session_high=session_high,
            session_low=session_low,
            close_position_pct=close_position_pct,
            state=structure_state(
                close_position_pct=close_position_pct,
                last_price=last_price,
                session_high=session_high,
                session_low=session_low,
            ),
        )

        session = SessionAnalysis(
            session=latest_session,
            trade_date=latest_date,
            previous_close=previous_close,
            gap_pct=gap_pct,
            vwap=vwap,
            above_vwap=above_vwap,
        )

        readiness = ReadinessAnalysis(
            score=readiness_score,
            grade=readiness_grade(readiness_score),
            signals=signals,
            warnings=warnings,
        )

        scores = TradeAnalysisScores(
            trend=trend_score,
            momentum=trend_score,
            volume=volume_score,
            volatility=volatility_score,
            structure=structure_score,
            readiness=readiness_score,
        )

        return TradeAnalysis(
            symbol=symbol,
            timeframe=timeframe,
            bars_count=len(bars),
            last_price=last_price,
            trend=trend,
            volume=volume,
            volatility=volatility,
            structure=structure,
            session=session,
            readiness=readiness,
            scores=scores,
            float_shares=share_stats.get("float_shares"),
            shares_outstanding=share_stats.get("shares_outstanding"),
            short_interest_pct=share_stats.get("short_interest_pct"),
        )


trade_analysis_engine = TradeAnalysisEngine()


async def analyze_trade_symbol(
    polygon: PolygonService,
    symbol: str,
    *,
    snapshot: Optional[Dict[str, Any]] = None,
    timeframe: str = "1m",
) -> Optional[Dict[str, Any]]:
    analysis = await trade_analysis_engine.analyze_symbol(
        polygon,
        symbol,
        snapshot=snapshot,
        timeframe=timeframe,
    )

    return analysis.to_dict() if analysis else None