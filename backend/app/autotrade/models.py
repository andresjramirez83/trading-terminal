from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field, validator

AutoTradeMode = Literal["paper", "live"]
AutoTradeSource = Literal["manual", "scanner", "both"]
SizingMode = Literal["dollars", "shares"]
RunnerMode = Literal["off", "scale_trail"]
EntryTriggerMode = Literal["reclaim_close", "sweep_touch"]
StrategyId = Literal["six_seven_sweep", "five_am_sweep", "overnite_hail_mary"]


class StrategyConfig(BaseModel):
    enabled: bool = True
    strategy_id: StrategyId = "six_seven_sweep"
    weight: float = 1.0
    min_score: float = 60.0


class AutoTradeConfig(BaseModel):
    enabled: bool = False
    mode: AutoTradeMode = "paper"
    allow_live: bool = False
    source: AutoTradeSource = "manual"
    timeframe: Literal["1m", "5m", "15m"] = "1m"
    sizing_mode: SizingMode = "dollars"
    trade_amount: float = 500.0
    fixed_shares: int = 100
    max_active_trades: int = 1
    min_profit_range: float = 0.15
    sweep_buffer_pct: float = 0.001
    stop_buffer_pct: float = 0.002
    target_r: float = 2.0
    poll_seconds: int = 5
    extended_hours: bool = True
    max_symbols: int = 12
    require_flat_account: bool = True
    max_signal_age_bars: int = 3
    runner_mode: RunnerMode = "off"
    entry_trigger_mode: EntryTriggerMode = "reclaim_close"
    scale_out_pct: float = 0.50
    trail_lookback_bars: int = 2
    trail_buffer_pct: float = 0.002
    strategies: List[StrategyConfig] = Field(default_factory=lambda: [StrategyConfig()])


class AutoTradeConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[AutoTradeMode] = None
    allow_live: Optional[bool] = None
    source: Optional[AutoTradeSource] = None
    timeframe: Optional[Literal["1m", "5m", "15m"]] = None
    sizing_mode: Optional[SizingMode] = None
    trade_amount: Optional[float] = None
    fixed_shares: Optional[int] = None
    max_active_trades: Optional[int] = None
    min_profit_range: Optional[float] = None
    sweep_buffer_pct: Optional[float] = None
    stop_buffer_pct: Optional[float] = None
    target_r: Optional[float] = None
    poll_seconds: Optional[int] = None
    extended_hours: Optional[bool] = None
    max_symbols: Optional[int] = None
    require_flat_account: Optional[bool] = None
    max_signal_age_bars: Optional[int] = None
    runner_mode: Optional[RunnerMode] = None
    entry_trigger_mode: Optional[EntryTriggerMode] = None
    scale_out_pct: Optional[float] = None
    trail_lookback_bars: Optional[int] = None
    trail_buffer_pct: Optional[float] = None
    strategies: Optional[List[StrategyConfig]] = None


class TradeSignal(BaseModel):
    strategy_id: str
    symbol: str
    side: Literal["buy", "sell"] = "buy"
    setup: str
    signal_id: str
    timeframe: str
    signal_time: str
    entry_price: float
    target_price: float
    stop_price: float
    score: float = 60.0
    profit_range: float
    qty: Optional[int] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ManualTradePlan(BaseModel):
    """Manual synthetic bracket request.

    The API stores this as a queued plan. The dedicated auto-trade worker is the
    only process that submits the entry and manages the synthetic stop/target.
    """

    symbol: str
    entry_price: float
    stop_price: float
    target_price: float
    qty: Optional[int] = None
    trade_amount: Optional[float] = None
    strategy_id: str = "overnite_hail_mary"
    setup: str = "overnite_hail_mary_limit_entry_stop_target"
    note: Optional[str] = None

    @validator("strategy_id")
    def clean_strategy_id(cls, value: str) -> str:
        cleaned = str(value or "overnite_hail_mary").strip()
        return cleaned or "overnite_hail_mary"

    @validator("symbol")
    def clean_symbol(cls, value: str) -> str:
        symbol = "".join(ch for ch in str(value or "").upper().strip() if ch.isalpha() or ch == ".")
        if not symbol:
            raise ValueError("symbol is required")
        return symbol

    @validator("entry_price", "stop_price", "target_price")
    def positive_price(cls, value: float) -> float:
        if float(value) <= 0:
            raise ValueError("prices must be greater than zero")
        return float(value)

    @validator("target_price")
    def target_above_entry(cls, value: float, values: Dict[str, Any]) -> float:
        entry = float(values.get("entry_price") or 0)
        if entry > 0 and float(value) <= entry:
            raise ValueError("target_price must be above entry_price for long trades")
        return float(value)

    @validator("stop_price")
    def stop_below_entry(cls, value: float, values: Dict[str, Any]) -> float:
        entry = float(values.get("entry_price") or 0)
        if entry > 0 and float(value) >= entry:
            raise ValueError("stop_price must be below entry_price for long trades")
        return float(value)


class EngineEvent(BaseModel):
    event: str
    ts: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    symbol: Optional[str] = None
    strategy_id: Optional[str] = None
    message: Optional[str] = None
    data: Dict[str, Any] = Field(default_factory=dict)
