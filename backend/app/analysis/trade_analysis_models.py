from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class TradeAnalysisBar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class TradeAnalysisScores:
    trend: float = 0.0
    momentum: float = 0.0
    volume: float = 0.0
    volatility: float = 0.0
    structure: float = 0.0
    readiness: float = 0.0

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


@dataclass
class TrendAnalysis:
    direction: str = "neutral"
    ema_9: Optional[float] = None
    ema_20: Optional[float] = None
    ema_50: Optional[float] = None
    ema_200: Optional[float] = None
    ema_alignment: str = "neutral"
    above_ema_9: Optional[bool] = None
    above_ema_20: Optional[bool] = None
    above_ema_50: Optional[bool] = None
    strength: float = 0.0


@dataclass
class VolumeAnalysis:
    current_volume: float = 0.0
    average_volume_20: Optional[float] = None
    relative_volume: Optional[float] = None
    day_volume: float = 0.0
    volume_score: float = 0.0


@dataclass
class VolatilityAnalysis:
    atr_14: Optional[float] = None
    atr_pct: Optional[float] = None
    current_range: float = 0.0
    average_range_20: Optional[float] = None
    range_expansion: Optional[float] = None
    volatility_score: float = 0.0


@dataclass
class StructureAnalysis:
    session_high: Optional[float] = None
    session_low: Optional[float] = None
    close_position_pct: float = 0.0
    higher_high: bool = False
    higher_low: bool = False
    lower_high: bool = False
    lower_low: bool = False
    state: str = "neutral"


@dataclass
class SessionAnalysis:
    session: str = "closed"
    trade_date: Optional[str] = None
    previous_close: Optional[float] = None
    gap_pct: float = 0.0
    vwap: Optional[float] = None
    above_vwap: Optional[bool] = None


@dataclass
class ReadinessAnalysis:
    score: float = 0.0
    grade: str = "neutral"
    signals: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


@dataclass
class TradeAnalysis:
    symbol: str
    timeframe: str
    bars_count: int
    last_price: float

    trend: TrendAnalysis = field(default_factory=TrendAnalysis)
    volume: VolumeAnalysis = field(default_factory=VolumeAnalysis)
    volatility: VolatilityAnalysis = field(default_factory=VolatilityAnalysis)
    structure: StructureAnalysis = field(default_factory=StructureAnalysis)
    session: SessionAnalysis = field(default_factory=SessionAnalysis)
    readiness: ReadinessAnalysis = field(default_factory=ReadinessAnalysis)
    scores: TradeAnalysisScores = field(default_factory=TradeAnalysisScores)

    float_shares: Optional[float] = None
    shares_outstanding: Optional[float] = None
    short_interest_pct: Optional[float] = None

    notes: List[str] = field(default_factory=list)
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["scores"] = self.scores.to_dict()

        payload.update(
            {
                "prev_close": self.session.previous_close,
                "previous_close": self.session.previous_close,
                "gap_pct": round(self.session.gap_pct, 2),
                "change_pct": round(self.session.gap_pct, 2),
                "day_volume": int(self.volume.day_volume),
                "avg_volume_20": self._round_optional(self.volume.average_volume_20),
                "average_volume": self._round_optional(self.volume.average_volume_20),
                "rvol": self._round_optional(self.volume.relative_volume),
                "relative_volume": self._round_optional(self.volume.relative_volume),
                "atr_14": self._round_optional(self.volatility.atr_14),
                "atr": self._round_optional(self.volatility.atr_14),
                "atr_pct": self._round_optional(self.volatility.atr_pct),
                "ema_9": self._round_optional(self.trend.ema_9),
                "ema_20": self._round_optional(self.trend.ema_20),
                "ema_50": self._round_optional(self.trend.ema_50),
                "ema_fast": self._round_optional(self.trend.ema_9),
                "ema_slow": self._round_optional(self.trend.ema_20),
                "vwap": self._round_optional(self.session.vwap),
                "above_vwap": self.session.above_vwap,
                "ema_alignment": self.trend.ema_alignment,
                "session_high": self._round_optional(self.structure.session_high),
                "session_low": self._round_optional(self.structure.session_low),
                "close_position_pct": round(self.structure.close_position_pct, 2),
                "session_name": self.session.session,
                "trade_date": self.session.trade_date,
                "readiness_score": round(self.readiness.score, 2),
                "signals": list(self.readiness.signals),
                "warnings": list(self.readiness.warnings),
            }
        )

        payload["last_price"] = round(self.last_price, 4)
        return payload

    @staticmethod
    def _round_optional(value: Optional[float]) -> Optional[float]:
        if value is None:
            return None
        return round(float(value), 4)