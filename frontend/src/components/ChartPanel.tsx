import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { fetchBars, fetchLastTrade } from "../services/api";
import { marketSocket } from "../services/marketSocket";
import type { Candle } from "../types/market";

export type OverlayVisibility = {
  pmh: boolean;
  vwap: boolean;
  compression: boolean;
  choch: boolean;
  sessionBands: boolean;
  projections: boolean;
  trendlines: boolean;

  // Auto-populated chart studies / markers
  fakeEngulfing?: boolean;
  significantCandles?: boolean;
  liquiditySweeps?: boolean;
  volumeSignals?: boolean;
  bodyBreakDots?: boolean;
  closeAbovePrevCloseDots?: boolean;
  atrExpansionCandles?: boolean;
  resistanceBreakoutConfirm?: boolean;
  trendlineCloseAlerts?: boolean;
};

export type TrendlineControlAction =
  | { type: "toggle_draw" }
  | { type: "cancel_draw" }
  | { type: "delete_last" }
  | { type: "clear_all" }
  | { type: "none" };

export type TrendlineSnapMode = "auto" | "wick" | "body";
export type TrendlineScope = "shared" | "timeframe";

type Stats = {
  last: number | null;
  pmh: number | null;
  vwap: number | null;
  barsCount: number;
};

type Props = {
  symbol: string;
  timeframe: string;
  visibility: OverlayVisibility;
  onStatsUpdate: (stats: Stats) => void;
  trendlineAction?: TrendlineControlAction;
  trendlineSnapMode?: TrendlineSnapMode;
  onTrendlineActionHandled?: () => void;
  onTrendlineStateChange?: (state: {
    drawMode: boolean;
    pendingPoint: boolean;
    count: number;
  }) => void;
  onRequestAddSymbolToWatchlist?: (symbol: string) => void;
  showInChartWatchlistAdder?: boolean;
  lookback?: string;
  loadDelayMs?: number;
  enableLiveStream?: boolean;

  // Optional order-line layer. Parent pages can pass Alpaca/open order objects here.
  // Supports straight buy/sell limit lines, bracket entry lines, take-profit lines, and stop-loss lines.
  openOrders?: ChartOrder[];
  onCancelOrder?: (order: ChartOrder, line: NormalizedOrderLine) => void | Promise<void>;
  onReplaceOrderPrice?: (order: ChartOrder, line: NormalizedOrderLine, nextPrice: number) => void | Promise<void>;
};

export type ChartOrderTemplate =
  | "straight"
  | "limit"
  | "market"
  | "bracket"
  | "oco"
  | "oto";

export type ChartOrderLineKind =
  | "entry"
  | "limit"
  | "stop"
  | "stop_loss"
  | "take_profit";

export type ChartOrder = {
  id: string;
  symbol?: string;
  side?: "buy" | "sell" | string;
  qty?: number | string;
  status?: string;
  template?: ChartOrderTemplate | string;
  orderTemplate?: ChartOrderTemplate | string;
  type?: string;
  order_type?: string;
  orderClass?: string;
  order_class?: string;
  price?: number | string | null;
  limitPrice?: number | string | null;
  limit_price?: number | string | null;
  stopPrice?: number | string | null;
  stop_price?: number | string | null;
  takeProfitPrice?: number | string | null;
  take_profit_price?: number | string | null;
  stopLossPrice?: number | string | null;
  stop_loss_price?: number | string | null;
  legs?: ChartOrder[];
  take_profit?: { limit_price?: number | string | null; price?: number | string | null };
  stop_loss?: { stop_price?: number | string | null; limit_price?: number | string | null; price?: number | string | null };
  [key: string]: unknown;
};

type NormalizedOrderLine = {
  lineId: string;
  orderId: string;
  order: ChartOrder;
  kind: ChartOrderLineKind;
  template: ChartOrderTemplate | string;
  side: string;
  qty: string;
  price: number;
  label: string;
  color: string;
  canMove: boolean;
};

type CandlePoint = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

type VolumePoint = {
  time: UTCTimestamp;
  value: number;
  color: string;
};

type LinePoint = {
  time: UTCTimestamp;
  value: number;
};

type CompressionDirection = "bull" | "bear";

type CompressionZone = {
  top: number;
  bottom: number;
  startTime: UTCTimestamp;
  endTime: UTCTimestamp;
  direction: CompressionDirection;
  label: string;
  breakoutTime?: UTCTimestamp;
  breakoutPrice?: number;
  breakoutLabel?: string;
};

type SignalPoint = {
  time: UTCTimestamp;
  price: number;
  label: string;
};

type RectOverlay = {
  left: number;
  width: number;
  top: number;
  height: number;
  label: string;
  direction: CompressionDirection;
};

type MarkerOverlay = {
  left: number;
  top: number;
  label: string;
  color: string;
  direction: "up" | "down";
  dotSize?: number;
};

type TrendlineHandleOverlay = {
  id: string;
  trendlineId: string;
  anchor: TrendlineAnchorKey;
  left: number;
  top: number;
  selected: boolean;
};

type TrendlineFocusOverlay = {
  trendlineId: string;
  left: number;
  top: number;
  label: string;
};

type OrderLineOverlay = {
  lineId: string;
  orderId: string;
  top: number;
  price: number;
  label: string;
  detail: string;
  color: string;
  order: ChartOrder;
  line: NormalizedOrderLine;
};

type SessionKind = "premarket" | "regular" | "afterhours" | "overnight";

type SessionBandRange = {
  kind: SessionKind;
  label: string;
  startTime: UTCTimestamp;
  endTime: UTCTimestamp;
};

type SessionBandOverlay = SessionBandRange & {
  left: number;
  width: number;
};

type SessionStats = {
  currentSession: SessionKind;
  currentSessionLabel: string;
  premarketHigh: number | null;
  regularHigh: number | null;
  afterHoursHigh: number | null;
  extendedHigh: number | null;
};

type LegendState = {
  last: number | null;
  pmh: number | null;
  vwap: number | null;
  tradingDate: string | null;
  compressionLabel: string | null;
  session: SessionStats;
};

type HoveredCandleState = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};


function toHoveredCandleState(bar: Candle | null): HoveredCandleState | null {
  if (!bar) return null;

  return {
    time: toChartTime(bar.time) as UTCTimestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

type TradeMessage = {
  ev: "T";
  sym: string;
  p?: number;
  s?: number;
  t?: number;
};

type SecondAggregateMessage = {
  ev: "A";
  sym: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  s?: number;
};

type MinuteAggregateMessage = {
  ev: "AM";
  sym: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  s?: number;
};

type PolygonMessage =
  | TradeMessage
  | SecondAggregateMessage
  | MinuteAggregateMessage
  | Record<string, unknown>;

type Trendline = {
  id: string;
  symbol: string;
  timeframe: string;
  scope: TrendlineScope;
  t1: UTCTimestamp;
  p1: number;
  t2: UTCTimestamp;
  p2: number;
  slope: number;
  intercept: number;
  extendLeft: boolean;
  extendRight: boolean;
  color?: string;
  width?: number;
  createdAt: number;
  label?: string;
};

type PendingTrendPoint = {
  time: UTCTimestamp;
  price: number;
  snapKind?: "high" | "low" | "open" | "close";
};

type ProjectionLineKind =
  | "body_high"
  | "body_low"
  | "wick_high"
  | "wick_low"
  | "body_resistance"
  | "body_support"
  | "range_resistance"
  | "range_support"
  | "anchor_range_support"
  | "anchor_range_resistance"
  | "support_prediction"
  | "resistance_prediction";

type ProjectionLevel = {
  id: string;
  kind: ProjectionLineKind;
  price: number;
  color: string;
  lineStyle: LineStyle;
  lineWidth: number;
  title: string;
};

type ProjectionSelection = {
  candleTime: UTCTimestamp;
  bodyRange: number;
  fullRange: number;
  levels: ProjectionLevel[];
  anchorOpen?: number;
  anchorClose?: number;
  anchorHigh?: number;
  anchorLow?: number;
};

type SavedProjectionPriceLine = {
  id: string;
  line: any;
  price: number;
  title: string;
  color: string;
  lineStyle: LineStyle;
  lineWidth: number;
  createdAt?: number;
};

type StoredProjectionPriceLine = {
  id: string;
  price: number;
  title: string;
  color: string;
  lineStyle: LineStyle;
  lineWidth: number;
  createdAt: number;
};

const PROJECTION_STORAGE_VERSION = 1;
const LOCAL_PROJECTION_STORAGE_KEY = "trading_terminal_saved_projections_v1";
const PROJECTION_SYNC_API_BASE = "http://127.0.0.1:8000";

type LineVisibilityState = {
  pmh: boolean;
  vwap: boolean;
  compression: boolean;
  choch: boolean;
  sessionBands: boolean;
  projections: boolean;
  trendlines: boolean;
  fakeEngulfing: boolean;
  significantCandles: boolean;
  liquiditySweeps: boolean;
  volumeSignals: boolean;
  trendlineCloseAlerts: boolean;
  bodyBreakDots: boolean;
  closeAbovePrevCloseDots: boolean;
  atrExpansionCandles: boolean;
  resistanceBreakoutConfirm: boolean;
};

type ChartFunctionId =
  | "none"
  | "price_projection_body"
  | "price_projection_high_low_wicks"
  | "price_projection_anchor_range"
  | "support_prediction_wick_range"
  | "resistance_prediction_wick_range";

type ChartFunctionCategory = "projection" | "structure" | "volatility" | "orderflow";

type ChartFunctionDefinition = {
  id: ChartFunctionId;
  label: string;
  description: string;
  category: ChartFunctionCategory;
  buildSelection: (bar: Candle) => ProjectionSelection;
};

type TrendlineAnchorKey = "p1" | "p2";

type DragState = {
  trendlineId: string;
  anchor: TrendlineAnchorKey;
};

type OrderDragState = {
  lineId: string;
  pointerId: number;
  startingPrice: number;
  currentPrice: number;
  startY: number;
  latestY: number;
  hasMoved: boolean;
};

type TrendlineAlertKind =
  | "near"
  | "cross_up"
  | "cross_down"
  | "prebreak_bull"
  | "prebreak_bear"
  | "absorption_bull"
  | "aggressive_buyers"
  | "failed_breakdown";

type TrendlineAlert = {
  id: string;
  trendlineId: string;
  kind: TrendlineAlertKind;
  message: string;
  createdAt: number;
};

type PreBreakSignal = {
  score: number;
  distancePct: number;
  touchCount: number;
  volumeRatio: number;
  closePos: number;
  aboveVwap: boolean;
  side: "bull" | "bear";
};

type TapeSnapshot = {
  upVol: number;
  downVol: number;
  totalVol: number;
  lastPrice: number | null;
  currentMinute: number | null;
};

type OrderFlowSignal = {
  score: number;
  message: string;
  markerLabel: string;
  markerPrice: number;
  markerTime: UTCTimestamp;
  markerColor: string;
  markerDirection: "up" | "down";
};

type ControlState = {
  label: string;
  color: string;
  detail: string;
};


type ChochMarkerPoint = {
  time: UTCTimestamp;
  price: number;
  label: string;
  color: string;
  direction: "up" | "down";
};

type SignalMarkerPoint = {
  time: UTCTimestamp;
  price: number;
  label: string;
  color: string;
  direction: "up" | "down";
  dotSize?: number;
};


function toChartTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function formatPacificTime(epochSeconds: number, includeDate = false): string {
  const date = new Date(epochSeconds * 1000);

  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: includeDate ? "2-digit" : undefined,
    day: includeDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatPrice(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "N/A";
  return value >= 10 ? value.toFixed(2) : value.toFixed(4);
}

function formatVolume(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "N/A";
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (absValue >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absValue >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(0);
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function closePositionInBar(bar: Candle): number {
  const range = bar.high - bar.low;
  if (range <= 0) return 0.5;
  return (bar.close - bar.low) / range;
}

function calcVWAP(bars: Candle[]): number[] {
  let cumulativePV = 0;
  let cumulativeV = 0;

  return bars.map((bar) => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    cumulativePV += typical * bar.volume;
    cumulativeV += bar.volume;
    return cumulativeV > 0 ? cumulativePV / cumulativeV : 0;
  });
}

function computeCompressionZone(
  bars: Candle[],
  lookback = 8
): CompressionZone | null {
  if (bars.length < Math.max(lookback + 2, 20)) return null;

  const recent = bars.slice(-lookback);
  const highs = recent.map((b) => b.high);
  const lows = recent.map((b) => b.low);

  const top = Math.max(...highs);
  const bottom = Math.min(...lows);
  const mid = (top + bottom) / 2;

  if (mid <= 0) return null;

  const rangePct = ((top - bottom) / mid) * 100;
  if (rangePct > 1.2) return null;

  const firstHalf = recent.slice(0, Math.floor(lookback / 2));
  const secondHalf = recent.slice(Math.floor(lookback / 2));

  const firstRange =
    Math.max(...firstHalf.map((b) => b.high)) -
    Math.min(...firstHalf.map((b) => b.low));

  const secondRange =
    Math.max(...secondHalf.map((b) => b.high)) -
    Math.min(...secondHalf.map((b) => b.low));

  if (secondRange > firstRange * 1.05) return null;

  let higherLows = 0;
  let lowerHighs = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].low >= recent[i - 1].low) higherLows++;
    if (recent[i].high <= recent[i - 1].high) lowerHighs++;
  }

  const higherLowRatio = higherLows / (recent.length - 1);
  const lowerHighRatio = lowerHighs / (recent.length - 1);

  const recent20 = bars.slice(-20);
  const recentHigh = Math.max(...recent20.map((b) => b.high));
  const recentLow = Math.min(...recent20.map((b) => b.low));

  const distanceFromHigh =
    recentHigh > 0 ? ((recentHigh - top) / recentHigh) * 100 : 999;
  const distanceFromLow =
    recentLow > 0 ? ((bottom - recentLow) / recentLow) * 100 : 999;

  let direction: CompressionDirection | null = null;
  let label = "";

  if (higherLowRatio >= 0.6 && distanceFromHigh <= 2.0) {
    direction = "bull";
    label = "Bull Compression";
  } else if (lowerHighRatio >= 0.6 && distanceFromLow <= 2.0) {
    direction = "bear";
    label = "Bear Compression";
  } else {
    return null;
  }

  const lastBar = bars[bars.length - 1];
  const recentVol = average(recent.slice(0, -1).map((b) => b.volume));
  const volumeSpike = recentVol > 0 ? lastBar.volume >= recentVol * 1.2 : false;
  const closePos = closePositionInBar(lastBar);

  const zone: CompressionZone = {
    top,
    bottom,
    startTime: toChartTime(recent[0].time),
    endTime: toChartTime(recent[recent.length - 1].time),
    direction,
    label,
  };

  if (
    direction === "bull" &&
    lastBar.close > top * 1.0015 &&
    closePos >= 0.7 &&
    volumeSpike
  ) {
    zone.breakoutTime = toChartTime(lastBar.time);
    zone.breakoutPrice = lastBar.high;
    zone.breakoutLabel = "Bull Break";
  }

  if (
    direction === "bear" &&
    lastBar.close < bottom * 0.9985 &&
    closePos <= 0.3 &&
    volumeSpike
  ) {
    zone.breakoutTime = toChartTime(lastBar.time);
    zone.breakoutPrice = lastBar.low;
    zone.breakoutLabel = "Bear Break";
  }

  return zone;
}

function computeVWAPReclaimSignals(
  bars: Candle[],
  vwapValues: number[]
): SignalPoint[] {
  const signals: SignalPoint[] = [];

  for (let i = 1; i < bars.length; i++) {
    const prevBar = bars[i - 1];
    const bar = bars[i];
    const prevVwap = vwapValues[i - 1];
    const vwap = vwapValues[i];

    if (
      prevVwap == null ||
      vwap == null ||
      !Number.isFinite(prevVwap) ||
      !Number.isFinite(vwap)
    ) {
      continue;
    }

    const prevCloseBelow = prevBar.close < prevVwap;
    const currentCloseAbove = bar.close > vwap;
    const closePos = closePositionInBar(bar);

    if (prevCloseBelow && currentCloseAbove && closePos >= 0.55) {
      signals.push({
        time: toChartTime(bar.time),
        price: bar.low,
        label: "VWAP Reclaim",
      });
    }
  }

  return signals.slice(-3);
}


function findPivotHighIndices(bars: Candle[], left = 2, right = 2): number[] {
  const out: number[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const high = bars[i].high;
    let ok = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= high) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findPivotLowIndices(bars: Candle[], left = 2, right = 2): number[] {
  const out: number[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const low = bars[i].low;
    let ok = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].low <= low) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function computeChochSignals(bars: Candle[]): ChochMarkerPoint[] {
  if (bars.length < 12) return [];

  const pivotHighs = findPivotHighIndices(bars, 2, 2);
  const pivotLows = findPivotLowIndices(bars, 2, 2);
  const signals: ChochMarkerPoint[] = [];

  let structureBias: "bull" | "bear" | "neutral" = "neutral";
  let lastBullBreakPivotHighIdx = -1;
  let lastBearBreakPivotLowIdx = -1;

  for (let i = 8; i < bars.length; i++) {
    const bar = bars[i];

    const recentHighs = pivotHighs.filter((idx) => idx < i);
    const recentLows = pivotLows.filter((idx) => idx < i);
    if (!recentHighs.length || !recentLows.length) continue;

    const lastHighIdx = recentHighs[recentHighs.length - 1];
    const lastLowIdx = recentLows[recentLows.length - 1];

    const prevHighIdx = recentHighs.length >= 2 ? recentHighs[recentHighs.length - 2] : null;
    const prevLowIdx = recentLows.length >= 2 ? recentLows[recentLows.length - 2] : null;

    const brokeAboveLastHigh = bar.close > bars[lastHighIdx].high;
    const brokeBelowLastLow = bar.close < bars[lastLowIdx].low;

    const hadLowerHighs =
      prevHighIdx != null ? bars[lastHighIdx].high < bars[prevHighIdx].high : false;
    const hadLowerLows =
      prevLowIdx != null ? bars[lastLowIdx].low < bars[prevLowIdx].low : false;

    const hadHigherHighs =
      prevHighIdx != null ? bars[lastHighIdx].high > bars[prevHighIdx].high : false;
    const hadHigherLows =
      prevLowIdx != null ? bars[lastLowIdx].low > bars[prevLowIdx].low : false;

    const bearishContext =
      structureBias === "bear" ||
      (hadLowerHighs && hadLowerLows) ||
      (hadLowerHighs && closePositionInBar(bar) >= 0.55);

    const bullishContext =
      structureBias === "bull" ||
      (hadHigherHighs && hadHigherLows) ||
      (hadHigherLows && closePositionInBar(bar) <= 0.45);

    if (
      brokeAboveLastHigh &&
      bearishContext &&
      lastHighIdx !== lastBullBreakPivotHighIdx
    ) {
      signals.push({
        time: toChartTime(bar.time),
        price: bar.low,
        label: "CHOCH ↑",
        color: "#22c55e",
        direction: "up",
      });
      structureBias = "bull";
      lastBullBreakPivotHighIdx = lastHighIdx;
      continue;
    }

    if (
      brokeBelowLastLow &&
      bullishContext &&
      lastLowIdx !== lastBearBreakPivotLowIdx
    ) {
      signals.push({
        time: toChartTime(bar.time),
        price: bar.high,
        label: "CHOCH ↓",
        color: "#ef4444",
        direction: "down",
      });
      structureBias = "bear";
      lastBearBreakPivotLowIdx = lastLowIdx;
      continue;
    }

    if (hadHigherHighs && hadHigherLows) {
      structureBias = "bull";
    } else if (hadLowerHighs && hadLowerLows) {
      structureBias = "bear";
    }
  }

  return signals.slice(-8);
}

function averageVolumeBefore(bars: Candle[], index: number, lookback = 20): number {
  const start = Math.max(0, index - lookback);
  const values = bars
    .slice(start, index)
    .map((bar) => bar.volume)
    .filter((value) => Number.isFinite(value) && value > 0);
  return average(values);
}

function computeLiquiditySweepSignals(bars: Candle[]): SignalMarkerPoint[] {
  if (bars.length < 12) return [];

  const atrValues = computeRollingAtrValues(bars, 14);
  const signals: SignalMarkerPoint[] = [];
  const supportLookback = 8;
  const confirmWindow = 3;

  for (let i = supportLookback; i < bars.length - 1; i++) {
    const sweep = bars[i];
    const prior = bars.slice(i - supportLookback, i);
    const atr = atrValues[i] || sweep.high - sweep.low;
    if (!Number.isFinite(atr) || atr <= 0) continue;

    const avgVol = averageVolumeBefore(bars, i, 20);
    const volumeRatio = avgVol > 0 ? sweep.volume / avgVol : 1;
    const buffer = Math.max(atr * 0.08, sweep.close * 0.001);
    const range = sweep.high - sweep.low;
    if (range <= 0) continue;

    const support = Math.min(...prior.map((bar) => bar.low));
    const resistance = Math.max(...prior.map((bar) => bar.high));
    const closePos = closePositionInBar(sweep);
    const lowerWick = Math.min(sweep.open, sweep.close) - sweep.low;
    const upperWick = sweep.high - Math.max(sweep.open, sweep.close);
    const lowVolumeSweep = volumeRatio <= 1.15;

    const brokeSupport = sweep.low < support - buffer || sweep.close < support - buffer;
    const supportRejection = lowerWick >= range * 0.25 || closePos >= 0.35;

    if (brokeSupport && lowVolumeSweep && supportRejection) {
      const maxJ = Math.min(bars.length - 1, i + confirmWindow);
      for (let j = i + 1; j <= maxJ; j++) {
        const confirm = bars[j];
        const reclaimedSupport = confirm.close > support || (confirm.high > support && closePositionInBar(confirm) >= 0.55);
        const heldSweepLow = confirm.low >= sweep.low - buffer;

        if (reclaimedSupport && heldSweepLow) {
          signals.push({
            time: toChartTime(confirm.time),
            price: Math.min(confirm.low, support),
            label: "Low-Vol Support Sweep ↑",
            color: "#38bdf8",
            direction: "up",
          });
          break;
        }
      }
    }

    const brokeResistance = sweep.high > resistance + buffer || sweep.close > resistance + buffer;
    const resistanceRejection = upperWick >= range * 0.25 || closePos <= 0.65;

    if (brokeResistance && lowVolumeSweep && resistanceRejection) {
      const maxJ = Math.min(bars.length - 1, i + confirmWindow);
      for (let j = i + 1; j <= maxJ; j++) {
        const confirm = bars[j];
        const lostResistance = confirm.close < resistance || (confirm.low < resistance && closePositionInBar(confirm) <= 0.45);
        const heldSweepHigh = confirm.high <= sweep.high + buffer;

        if (lostResistance && heldSweepHigh) {
          signals.push({
            time: toChartTime(confirm.time),
            price: Math.max(confirm.high, resistance),
            label: "Low-Vol Resistance Sweep ↓",
            color: "#f59e0b",
            direction: "down",
          });
          break;
        }
      }
    }
  }

  return signals.slice(-12);
}

function computeVolumeSignalMarkers(bars: Candle[]): SignalMarkerPoint[] {
  if (bars.length < 25) return [];

  const atrValues = computeRollingAtrValues(bars, 14);
  const signals: SignalMarkerPoint[] = [];

  for (let i = 20; i < bars.length; i++) {
    const bar = bars[i];
    const atr = atrValues[i];
    if (!Number.isFinite(atr) || atr <= 0) continue;

    const range = Math.max(bar.high - bar.low, 0);
    if (range <= 0) continue;

    const avgVol = averageVolumeBefore(bars, i, 20);
    if (!Number.isFinite(avgVol) || avgVol <= 0) continue;

    const volumeRatio = bar.volume / avgVol;
    const closePos = closePositionInBar(bar);
    const prior = bars.slice(Math.max(0, i - 10), i);
    const priorHigh = prior.length ? Math.max(...prior.map((b) => b.high)) : bar.high;
    const priorLow = prior.length ? Math.min(...prior.map((b) => b.low)) : bar.low;

    const bullishBreakout =
      bar.close > bar.open &&
      bar.close > priorHigh &&
      range >= atr * 1.25 &&
      volumeRatio >= 1.5 &&
      closePos >= 0.65;

    if (bullishBreakout) {
      signals.push({
        time: toChartTime(bar.time),
        price: (bar.open + bar.close) / 2,
        label: `High-Vol Breakout ${volumeRatio.toFixed(1)}x`,
        color: "#22c55e",
        direction: "up",
        dotSize: 11,
      });
      continue;
    }

    const bearishBreakdown =
      bar.close < bar.open &&
      bar.close < priorLow &&
      range >= atr * 1.25 &&
      volumeRatio >= 1.5 &&
      closePos <= 0.35;

    if (bearishBreakdown) {
      signals.push({
        time: toChartTime(bar.time),
        price: (bar.open + bar.close) / 2,
        label: `High-Vol Breakdown ${volumeRatio.toFixed(1)}x`,
        color: "#ef4444",
        direction: "down",
        dotSize: 11,
      });
      continue;
    }

    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const climaxVolume = volumeRatio >= 2.8 && range >= atr * 1.2;
    const wickRejection = upperWick >= range * 0.35 || lowerWick >= range * 0.35;

    if (climaxVolume && wickRejection) {
      const isTopRejection = upperWick >= lowerWick;
      signals.push({
        time: toChartTime(bar.time),
        price: isTopRejection ? bar.high : bar.low,
        label: `Volume Climax ${volumeRatio.toFixed(1)}x`,
        color: "#fb923c",
        direction: isTopRejection ? "down" : "up",
        dotSize: 12,
      });
    }
  }

  return signals.slice(-30);
}

function isBearishBodyEngulfing(prev: Candle, bar: Candle): boolean {
  return (
    prev.close > prev.open &&
    bar.close < bar.open &&
    bar.open >= prev.close &&
    bar.close <= prev.open
  );
}

function isBullishBodyEngulfing(prev: Candle, bar: Candle): boolean {
  return (
    prev.close < prev.open &&
    bar.close > bar.open &&
    bar.open <= prev.close &&
    bar.close >= prev.open
  );
}

function computeFakeEngulfingSignals(bars: Candle[]): SignalMarkerPoint[] {
  if (bars.length < 5) return [];

  const atrValues = computeRollingAtrValues(bars, 14);
  const signals: SignalMarkerPoint[] = [];
  const confirmWindow = 3;

  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1];
    const engulf = bars[i];
    const engulfMid = (engulf.open + engulf.close) / 2;
    const atr = atrValues[i] || Math.max(engulf.high - engulf.low, prev.high - prev.low, 0);
    const buffer = Math.max(atr * 0.25, engulf.close * 0.001);
    const maxJ = Math.min(bars.length - 1, i + confirmWindow);

    if (isBearishBodyEngulfing(prev, engulf)) {
      let lowestAfter = engulf.low;

      for (let j = i + 1; j <= maxJ; j++) {
        const confirm = bars[j];
        lowestAfter = Math.min(lowestAfter, confirm.low);

        const noRealBreakdown = lowestAfter >= engulf.low - buffer;
        const reclaimedBody = confirm.close > Math.max(engulfMid, prev.close);
        const strongClose = closePositionInBar(confirm) >= 0.55;

        if (noRealBreakdown && reclaimedBody && strongClose) {
          signals.push({
            time: toChartTime(confirm.time),
            price: confirm.low,
            label: "Fake Bear Engulf ↑",
            color: "#22c55e",
            direction: "up",
          });
          break;
        }
      }
    }

    if (isBullishBodyEngulfing(prev, engulf)) {
      let highestAfter = engulf.high;

      for (let j = i + 1; j <= maxJ; j++) {
        const confirm = bars[j];
        highestAfter = Math.max(highestAfter, confirm.high);

        const noRealBreakout = highestAfter <= engulf.high + buffer;
        const lostBody = confirm.close < Math.min(engulfMid, prev.close);
        const weakClose = closePositionInBar(confirm) <= 0.45;

        if (noRealBreakout && lostBody && weakClose) {
          signals.push({
            time: toChartTime(confirm.time),
            price: confirm.high,
            label: "Fake Bull Engulf ↓",
            color: "#ef4444",
            direction: "down",
          });
          break;
        }
      }
    }
  }

  return signals.slice(-10);
}

function minuteBucketStart(ms: number): number {
  return Math.floor(ms / 60000) * 60000;
}

function timeframeToMinutes(timeframe: string): number {
  const tf = String(timeframe || "1m").trim().toLowerCase();
  if (tf === "1m") return 1;
  if (tf === "5m") return 5;
  if (tf === "15m") return 15;
  if (tf === "30m") return 30;
  if (tf === "1h" || tf === "60m") return 60;
  return 1;
}

function chartLookbackForTimeframe(timeframe: string): string {
  // Use wider windows so late night / weekends do not return empty 1m or 5m charts.
  // Backend still limits final bars, so this will not overload the chart.
  const tf = String(timeframe || "1m").trim().toLowerCase();
  if (tf === "1m") return "5d";
  if (tf === "5m") return "10d";
  if (tf === "15m") return "20d";
  if (tf === "30m") return "30d";
  if (tf === "1h" || tf === "60m") return "60d";
  if (tf === "1d" || tf === "day") return "6m";
  return "10d";
}

function normalizeBarsForChart(rawBars: unknown): Candle[] {
  if (!Array.isArray(rawBars)) return [];

  const byTime = new Map<number, Candle>();

  for (const row of rawBars) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;

    const rawTime = Number(item.time ?? item.t);
    const time = Number.isFinite(rawTime)
      ? rawTime < 10_000_000_000
        ? rawTime * 1000
        : rawTime
      : NaN;

    const open = Number(item.open ?? item.o);
    const high = Number(item.high ?? item.h);
    const low = Number(item.low ?? item.l);
    const close = Number(item.close ?? item.c);
    const volume = Number(item.volume ?? item.v ?? 0);

    if (
      !Number.isFinite(time) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      time <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0
    ) {
      continue;
    }

    byTime.set(time, {
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}
function bucketStartForTimeframe(ms: number, timeframe: string): number {
  const minutes = Math.max(1, timeframeToMinutes(timeframe));
  const bucketSizeMs = minutes * 60_000;
  return Math.floor(ms / bucketSizeMs) * bucketSizeMs;
}

function mergeIncomingBarIntoTimeframe(
  currentBars: Candle[],
  incomingBar: Candle,
  timeframe: string
): { bars: Candle[]; lastPrice: number | null; changed: boolean } {
  const bucketMs = bucketStartForTimeframe(incomingBar.time, timeframe);
  const nextBars = [...currentBars];
  const aggregatedBar: Candle = {
    time: bucketMs,
    open: incomingBar.open,
    high: incomingBar.high,
    low: incomingBar.low,
    close: incomingBar.close,
    volume: incomingBar.volume,
  };

  const lastIdx = nextBars.length - 1;
  if (lastIdx === -1) {
    nextBars.push(aggregatedBar);
    return { bars: nextBars, lastPrice: aggregatedBar.close, changed: true };
  }

  const lastBar = nextBars[lastIdx];
  if (bucketMs === lastBar.time) {
    nextBars[lastIdx] = {
      ...lastBar,
      high: Math.max(lastBar.high, aggregatedBar.high),
      low: Math.min(lastBar.low, aggregatedBar.low),
      close: aggregatedBar.close,
      volume: Math.max(lastBar.volume, aggregatedBar.volume),
    };
    return { bars: nextBars, lastPrice: aggregatedBar.close, changed: true };
  }

  if (bucketMs > lastBar.time) {
    nextBars.push(aggregatedBar);
    return { bars: nextBars, lastPrice: aggregatedBar.close, changed: true };
  }

  return { bars: currentBars, lastPrice: aggregatedBar.close, changed: false };
}

function applyMinuteAggregateToBars(
  currentBars: Candle[],
  msg: MinuteAggregateMessage
): Candle[] {
  const open = typeof msg.o === "number" ? msg.o : null;
  const high = typeof msg.h === "number" ? msg.h : null;
  const low = typeof msg.l === "number" ? msg.l : null;
  const close = typeof msg.c === "number" ? msg.c : null;
  const volume = typeof msg.v === "number" ? msg.v : 0;
  const startMs = typeof msg.s === "number" ? msg.s : null;

  if (open == null || high == null || low == null || close == null || startMs == null) {
    return currentBars;
  }

  const nextBars = [...currentBars];
  const liveBar: Candle = {
    time: startMs,
    open,
    high,
    low,
    close,
    volume,
  };

  const lastIdx = nextBars.length - 1;

  if (lastIdx >= 0 && nextBars[lastIdx].time === liveBar.time) {
    nextBars[lastIdx] = liveBar;
    return nextBars;
  }

  if (lastIdx >= 0 && nextBars[lastIdx].time < liveBar.time) {
    nextBars.push(liveBar);
    return nextBars;
  }

  if (lastIdx === -1) {
    nextBars.push(liveBar);
    return nextBars;
  }

  return nextBars;
}

function applySecondAggregateToBars(
  currentBars: Candle[],
  msg: SecondAggregateMessage
): { bars: Candle[]; lastPrice: number | null; changed: boolean } {
  const secondOpen = typeof msg.o === "number" ? msg.o : null;
  const secondHigh = typeof msg.h === "number" ? msg.h : null;
  const secondLow = typeof msg.l === "number" ? msg.l : null;
  const secondClose = typeof msg.c === "number" ? msg.c : null;
  const secondVolume = typeof msg.v === "number" ? msg.v : 0;
  const secondStart = typeof msg.s === "number" ? msg.s : null;

  if (
    secondOpen == null ||
    secondHigh == null ||
    secondLow == null ||
    secondClose == null ||
    secondStart == null
  ) {
    return { bars: currentBars, lastPrice: null, changed: false };
  }

  const bucketMs = minuteBucketStart(secondStart);
  const nextBars = [...currentBars];
  const lastIdx = nextBars.length - 1;

  if (lastIdx === -1) {
    nextBars.push({
      time: bucketMs,
      open: secondOpen,
      high: secondHigh,
      low: secondLow,
      close: secondClose,
      volume: secondVolume,
    });
    return { bars: nextBars, lastPrice: secondClose, changed: true };
  }

  const lastBar = nextBars[lastIdx];

  if (bucketMs === lastBar.time) {
    nextBars[lastIdx] = {
      ...lastBar,
      high: Math.max(lastBar.high, secondHigh),
      low: Math.min(lastBar.low, secondLow),
      close: secondClose,
      volume: Math.max(lastBar.volume, secondVolume),
    };
    return { bars: nextBars, lastPrice: secondClose, changed: true };
  }

  if (bucketMs > lastBar.time) {
    nextBars.push({
      time: bucketMs,
      open: secondOpen,
      high: secondHigh,
      low: secondLow,
      close: secondClose,
      volume: secondVolume,
    });
    return { bars: nextBars, lastPrice: secondClose, changed: true };
  }

  return { bars: currentBars, lastPrice: secondClose, changed: false };
}

function applyTradeToBars(
  currentBars: Candle[],
  msg: TradeMessage
): { bars: Candle[]; lastPrice: number | null; changed: boolean } {
  const tradePrice = typeof msg.p === "number" ? msg.p : null;
  const tradeTime = typeof msg.t === "number" ? msg.t : null;
  const tradeSize =
    typeof msg.s === "number" && Number.isFinite(msg.s) ? msg.s : 0;

  if (tradePrice == null || tradeTime == null) {
    return { bars: currentBars, lastPrice: tradePrice, changed: false };
  }

  const bucketMs = minuteBucketStart(tradeTime);
  const nextBars = [...currentBars];
  const lastIdx = nextBars.length - 1;

  if (lastIdx === -1) {
    nextBars.push({
      time: bucketMs,
      open: tradePrice,
      high: tradePrice,
      low: tradePrice,
      close: tradePrice,
      volume: tradeSize,
    });
    return { bars: nextBars, lastPrice: tradePrice, changed: true };
  }

  const lastBar = nextBars[lastIdx];

  if (bucketMs === lastBar.time) {
    nextBars[lastIdx] = {
      ...lastBar,
      high: Math.max(lastBar.high, tradePrice),
      low: Math.min(lastBar.low, tradePrice),
      close: tradePrice,
      volume: lastBar.volume + tradeSize,
    };
    return { bars: nextBars, lastPrice: tradePrice, changed: true };
  }

  if (bucketMs > lastBar.time) {
    nextBars.push({
      time: bucketMs,
      open: tradePrice,
      high: tradePrice,
      low: tradePrice,
      close: tradePrice,
      volume: tradeSize,
    });
    return { bars: nextBars, lastPrice: tradePrice, changed: true };
  }

  return { bars: currentBars, lastPrice: tradePrice, changed: false };
}

function bodyHigh(bar: Candle): number {
  return Math.max(bar.open, bar.close);
}

function bodyLow(bar: Candle): number {
  return Math.min(bar.open, bar.close);
}

function getPriceTolerance(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0.003;
  if (price < 1) return Math.max(0.003, price * 0.0075);
  if (price < 5) return Math.max(0.0075, price * 0.004);
  return Math.max(0.015, price * 0.003);
}

function scoreResistanceLevel(
  bars: Candle[],
  centerIndex: number,
  candidate: number,
  left = 2,
  right = 2
): number {
  const start = Math.max(0, centerIndex - left);
  const end = Math.min(bars.length - 1, centerIndex + right);
  const tolerance = getPriceTolerance(candidate);

  let score = 0;
  const touchedBars = new Set<number>();

  for (let i = start; i <= end; i++) {
    const bar = bars[i];

    const openHit = Math.abs(bar.open - candidate) <= tolerance;
    const closeHit = Math.abs(bar.close - candidate) <= tolerance;
    const bodyHit = Math.abs(bodyHigh(bar) - candidate) <= tolerance;
    const wickHit = Math.abs(bar.high - candidate) <= tolerance;

    let touched = false;

    if (openHit) {
      score += 3;
      touched = true;
    }

    if (closeHit) {
      score += 3;
      touched = true;
    }

    if (bodyHit) {
      score += 2;
      touched = true;
    }

    if (wickHit) {
      score += 0.5;
      touched = true;
    }

    if (touched) {
      touchedBars.add(i);
    }
  }

  score += touchedBars.size * 2;
  score += candidate * 0.0001;

  return score;
}

function getClusteredBodyResistance(
  bars: Candle[],
  centerIndex: number,
  left = 2,
  right = 2
): number {
  const start = Math.max(0, centerIndex - left);
  const end = Math.min(bars.length - 1, centerIndex + right);

  const candidates: number[] = [];

  for (let i = start; i <= end; i++) {
    candidates.push(bars[i].open);
    candidates.push(bars[i].close);
    candidates.push(bodyHigh(bars[i]));
  }

  if (candidates.length === 0) {
    return bodyHigh(bars[centerIndex]);
  }

  let bestPrice = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreResistanceLevel(bars, centerIndex, candidate, left, right);

    if (score > bestScore) {
      bestScore = score;
      bestPrice = candidate;
    }
  }

  return bestPrice;
}

function computeAtrApprox(bars: Candle[], period = 14): number {
  if (bars.length < 2) return 0;

  const start = Math.max(1, bars.length - period);
  const trs: number[] = [];

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i];
    const prevClose = bars[i - 1]?.close ?? bar.close;
    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose)
    );
    trs.push(tr);
  }

  return average(trs);
}

function computeRollingAtrValues(bars: Candle[], period = 14): number[] {
  const atrValues = new Array<number>(bars.length).fill(0);
  if (bars.length < 2) return atrValues;

  const trueRanges = new Array<number>(bars.length).fill(0);

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const prevClose = bars[i - 1]?.close ?? bar.close;
    trueRanges[i] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose)
    );
  }

  for (let i = 1; i < bars.length; i++) {
    const start = Math.max(1, i - period + 1);
    const slice = trueRanges.slice(start, i + 1).filter((value) => value > 0);
    atrValues[i] = average(slice);
  }

  return atrValues;
}

function isSignificantExpansionCandle(
  bar: Candle,
  atr: number,
  multiplier = 1.5
): boolean {
  if (!Number.isFinite(atr) || atr <= 0) return false;
  const fullWickRange = bar.high - bar.low;
  return fullWickRange >= atr * multiplier;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getExpansionDotSize(bar: Candle, atr: number): number {
  if (!Number.isFinite(atr) || atr <= 0) return 9;
  const range = Math.max(bar.high - bar.low, 0);
  const rangeToAtr = range / atr;
  return Math.round(clampNumber(7 + rangeToAtr * 2.4, 9, 16));
}

function computeBodyBreakDotSignals(bars: Candle[]): { blackDots: SignalMarkerPoint[]; whiteDots: SignalMarkerPoint[] } {
  const blackDots: SignalMarkerPoint[] = [];
  const whiteDots: SignalMarkerPoint[] = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const previous = bars[i - 1];
    if (!current || !previous) continue;

    const currentTime = toChartTime(current.time);
    const previousBodyLow = Math.min(previous.open, previous.close);

    if (current.open < previousBodyLow || current.close < previousBodyLow) {
      const dotPrice = current.close < previousBodyLow ? current.close : current.open;

      blackDots.push({
        time: currentTime,
        price: dotPrice,
        label: "Open/Close Below Prev Body",
        color: "#020617",
        direction: "down",
        dotSize: 7,
      });
    }

    if (current.close > previous.close) {
      whiteDots.push({
        time: currentTime,
        price: current.close,
        label: "Close Above Previous Close",
        color: "#ffffff",
        direction: "up",
        dotSize: 7,
      });
    }
  }

  return {
    blackDots: blackDots.slice(-250),
    whiteDots: whiteDots.slice(-250),
  };
}

function getActiveResistanceProjectionPrice(selection: ProjectionSelection | null): number | null {
  if (!selection?.levels?.length) return null;

  const resistanceLevel = selection.levels.find((level) =>
    level.kind === "resistance_prediction" ||
    level.kind === "anchor_range_resistance" ||
    level.kind === "body_resistance" ||
    level.kind === "range_resistance" ||
    level.title.toLowerCase().includes("resist")
  );

  if (!resistanceLevel || !Number.isFinite(resistanceLevel.price)) return null;
  return resistanceLevel.price;
}

function computeAtrExpansionAndResistanceBreakoutSignals(
  bars: Candle[],
  atrValues: number[],
  selection: ProjectionSelection | null,
  multiplier = 1.5
): { expansionDots: SignalMarkerPoint[]; breakoutConfirmations: SignalMarkerPoint[] } {
  const expansionDots: SignalMarkerPoint[] = [];
  const breakoutConfirmations: SignalMarkerPoint[] = [];
  const resistancePrice = getActiveResistanceProjectionPrice(selection);
  const anchorTime = selection?.candleTime ?? null;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const previous = bars[i - 1];
    const atr = atrValues[i];
    const isExpansion = isSignificantExpansionCandle(bar, atr, multiplier);
    if (!isExpansion) continue;

    const candleTime = toChartTime(bar.time);
    const midBodyPrice = (bar.open + bar.close) / 2;

    expansionDots.push({
      time: candleTime,
      price: Number.isFinite(midBodyPrice) ? midBodyPrice : bar.close,
      label: `ATR Expansion ${((bar.high - bar.low) / Math.max(atr, 0.000001)).toFixed(2)}x`,
      color: "#facc15",
      direction: bar.close >= bar.open ? "up" : "down",
      dotSize: getExpansionDotSize(bar, atr),
    });

    if (
      resistancePrice != null &&
      anchorTime != null &&
      candleTime > anchorTime &&
      previous.close <= resistancePrice &&
      bar.close > resistancePrice
    ) {
      breakoutConfirmations.push({
        time: candleTime,
        price: bar.high,
        label: `ATR Breakout > ${formatPrice(resistancePrice)}`,
        color: "#22c55e",
        direction: "up",
        dotSize: 11,
      });
    }
  }

  return {
    expansionDots: expansionDots.slice(-120),
    breakoutConfirmations: breakoutConfirmations.slice(-60),
  };
}

function isSqueezeExpansionSetup(bars: Candle[], index: number, atrValues: number[], lookback = 6): boolean {
  if (index < lookback + 1) return false;

  const priorBars = bars.slice(index - lookback, index);
  const priorAtr = atrValues[index - 1] || average(atrValues.slice(Math.max(0, index - lookback), index).filter((value) => value > 0));
  if (!Number.isFinite(priorAtr) || priorAtr <= 0) return false;

  const priorRanges = priorBars.map((bar) => Math.max(bar.high - bar.low, 0));
  const avgPriorRange = average(priorRanges);
  const priorHigh = Math.max(...priorBars.map((bar) => bar.high));
  const priorLow = Math.min(...priorBars.map((bar) => bar.low));
  const priorMid = (priorHigh + priorLow) / 2;
  const priorRangePct = priorMid > 0 ? ((priorHigh - priorLow) / priorMid) * 100 : 999;

  return avgPriorRange <= priorAtr * 0.85 && priorRangePct <= 1.4;
}

function getDynamicNearTolerance(linePrice: number, bars: Candle[]): number {
  const atr = computeAtrApprox(bars, 14);
  const atrPart = atr > 0 ? atr * 0.25 : 0;
  const pctPart = linePrice > 0 ? linePrice * 0.0018 : 0;
  const floor = linePrice < 1 ? 0.003 : linePrice < 5 ? 0.01 : 0.02;
  return Math.max(floor, atrPart, pctPart);
}

function countRecentLineTouches(
  bars: Candle[],
  line: Trendline,
  lookback = 8
): number {
  if (!bars.length) return 0;

  const start = Math.max(0, bars.length - lookback);
  let touches = 0;

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i];
    const t = toChartTime(bar.time);
    const expected = getTrendlinePrice(line, t);
    if (!Number.isFinite(expected) || expected <= 0) continue;

    const tol = getDynamicNearTolerance(expected, bars.slice(0, i + 1));
    const touched =
      Math.abs(bar.high - expected) <= tol ||
      Math.abs(bar.close - expected) <= tol ||
      (bar.low <= expected && bar.high >= expected);

    if (touched) touches++;
  }

  return touches;
}

function computePreBreakSignal(
  bars: Candle[],
  line: Trendline,
  vwapValues: number[]
): PreBreakSignal | null {
  if (bars.length < 6) return null;

  const bar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];
  const time = toChartTime(bar.time);
  const linePrice = getTrendlinePrice(line, time);

  if (!Number.isFinite(linePrice) || linePrice <= 0) return null;

  const tolerance = getDynamicNearTolerance(linePrice, bars);
  const distance = bar.close - linePrice;
  const distancePct = Math.abs(distance) / linePrice * 100;
  const closePos = closePositionInBar(bar);

  const recentVolBase = average(
    bars.slice(Math.max(0, bars.length - 6), bars.length - 1).map((b) => b.volume)
  );
  const volumeRatio = recentVolBase > 0 ? bar.volume / recentVolBase : 0;

  const vwap = vwapValues[vwapValues.length - 1] ?? null;
  const aboveVwap = vwap != null && Number.isFinite(vwap) ? bar.close >= vwap : false;
  const touchCount = countRecentLineTouches(bars, line, 8);

  const shrinkingGap =
    Math.abs(bar.close - linePrice) < Math.abs(prevBar.close - getTrendlinePrice(line, toChartTime(prevBar.time)));

  const aboveLineIntrabar = bar.high >= linePrice - tolerance;
  const belowLineIntrabar = bar.low <= linePrice + tolerance;

  let bullScore = 0;
  let bearScore = 0;

  if (Math.abs(distance) <= tolerance * 1.5) {
    bullScore += 18;
    bearScore += 18;
  }

  if (shrinkingGap) {
    bullScore += 10;
    bearScore += 10;
  }

  if (volumeRatio >= 1.2) {
    bullScore += 16;
    bearScore += 16;
  } else if (volumeRatio >= 1.05) {
    bullScore += 8;
    bearScore += 8;
  }

  if (touchCount >= 2) {
    bullScore += Math.min(18, touchCount * 4);
    bearScore += Math.min(18, touchCount * 4);
  }

  if (distance <= tolerance && aboveLineIntrabar) {
    bullScore += 10;
  }

  if (distance >= -tolerance && belowLineIntrabar) {
    bearScore += 10;
  }

  if (closePos >= 0.72) {
    bullScore += 18;
  } else if (closePos >= 0.58) {
    bullScore += 10;
  }

  if (closePos <= 0.28) {
    bearScore += 18;
  } else if (closePos <= 0.42) {
    bearScore += 10;
  }

  if (aboveVwap) {
    bullScore += 12;
  } else {
    bearScore += 12;
  }

  if (distance > 0) {
    bullScore += 10;
  } else if (distance < 0) {
    bearScore += 10;
  }

  if (bullScore >= bearScore && bullScore >= 55) {
    return {
      score: bullScore,
      distancePct,
      touchCount,
      volumeRatio,
      closePos,
      aboveVwap,
      side: "bull",
    };
  }

  if (bearScore > bullScore && bearScore >= 55) {
    return {
      score: bearScore,
      distancePct,
      touchCount,
      volumeRatio,
      closePos,
      aboveVwap,
      side: "bear",
    };
  }

  return null;
}


function resetTapeSnapshot(tape: TapeSnapshot) {
  tape.upVol = 0;
  tape.downVol = 0;
  tape.totalVol = 0;
  tape.lastPrice = null;
  tape.currentMinute = null;
}

function updateTapeSnapshot(tape: TapeSnapshot, msg: TradeMessage) {
  const price = typeof msg.p === "number" ? msg.p : null;
  const size = typeof msg.s === "number" && Number.isFinite(msg.s) ? msg.s : 0;
  const time = typeof msg.t === "number" ? msg.t : null;

  if (price == null || time == null) return;

  const minute = minuteBucketStart(time);
  if (tape.currentMinute == null) {
    tape.currentMinute = minute;
  } else if (minute !== tape.currentMinute) {
    tape.upVol = 0;
    tape.downVol = 0;
    tape.totalVol = 0;
    tape.currentMinute = minute;
  }

  tape.totalVol += size;

  if (tape.lastPrice != null) {
    if (price > tape.lastPrice) {
      tape.upVol += size;
    } else if (price < tape.lastPrice) {
      tape.downVol += size;
    }
  }

  tape.lastPrice = price;
}

function getTapeDeltaPercent(tape: TapeSnapshot): number {
  if (tape.totalVol <= 0) return 0;
  return (tape.upVol - tape.downVol) / tape.totalVol;
}

function getRecentVolumeRatio(bars: Candle[], lookback = 6): number {
  if (bars.length < 2) return 0;
  const bar = bars[bars.length - 1];
  const recent = bars.slice(Math.max(0, bars.length - (lookback + 1)), bars.length - 1);
  const avgVol = average(recent.map((b) => b.volume));
  return avgVol > 0 ? bar.volume / avgVol : 0;
}

function computeControlState(
  bars: Candle[],
  tape: TapeSnapshot,
  vwapValues: number[]
): ControlState {
  if (!bars.length) {
    return { label: "NEUTRAL", color: "#cbd5e1", detail: "No bars" };
  }

  const bar = bars[bars.length - 1];
  const deltaPercent = getTapeDeltaPercent(tape);
  const closePos = closePositionInBar(bar);
  const volumeRatio = getRecentVolumeRatio(bars, 6);
  const vwap = vwapValues[vwapValues.length - 1] ?? null;
  const aboveVwap = vwap != null && Number.isFinite(vwap) ? bar.close >= vwap : false;

  let score = 0;
  if (deltaPercent >= 0.2) score += 2;
  else if (deltaPercent >= 0.08) score += 1;
  else if (deltaPercent <= -0.2) score -= 2;
  else if (deltaPercent <= -0.08) score -= 1;

  if (closePos >= 0.7) score += 1;
  else if (closePos <= 0.3) score -= 1;

  if (volumeRatio >= 1.2) {
    score += score >= 0 ? 1 : -1;
  }

  if (aboveVwap) score += 1;
  else score -= 1;

  if (score >= 3) {
    return {
      label: "BUYERS STRONG",
      color: "#86efac",
      detail: `Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
    };
  }

  if (score >= 1) {
    return {
      label: "BUYERS LEAN",
      color: "#bbf7d0",
      detail: `Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
    };
  }

  if (score <= -3) {
    return {
      label: "SELLERS STRONG",
      color: "#fca5a5",
      detail: `Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
    };
  }

  if (score <= -1) {
    return {
      label: "SELLERS LEAN",
      color: "#fecaca",
      detail: `Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
    };
  }

  return {
    label: "NEUTRAL",
    color: "#cbd5e1",
    detail: `Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
  };
}

function detectBullishAbsorption(
  bars: Candle[],
  line: Trendline,
  tape: TapeSnapshot,
  vwapValues: number[]
): OrderFlowSignal | null {
  if (bars.length < 3) return null;

  const bar = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const t = toChartTime(bar.time);
  const level = getTrendlinePrice(line, t);
  if (!Number.isFinite(level) || level <= 0) return null;

  const tol = getDynamicNearTolerance(level, bars);
  const deltaPercent = getTapeDeltaPercent(tape);
  const volumeRatio = getRecentVolumeRatio(bars, 6);
  const vwap = vwapValues[vwapValues.length - 1] ?? null;
  const aboveVwap = vwap != null && Number.isFinite(vwap) ? bar.close >= vwap : false;

  let score = 0;
  if (bar.low <= level + tol) score += 20;
  if (bar.close >= level - tol * 0.2) score += 18;
  if (bar.low >= prev.low - tol * 0.35) score += 10;
  if (closePositionInBar(bar) >= 0.55) score += 10;
  if (volumeRatio >= 1.1) score += 12;
  if (deltaPercent >= 0.08) score += 14;
  if (aboveVwap) score += 6;

  if (score < 56) return null;

  return {
    score,
    message: `Bullish absorption · score ${score} · Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
    markerLabel: "ABS",
    markerPrice: bar.low,
    markerTime: t,
    markerColor: "#22c55e",
    markerDirection: "up",
  };
}

function detectAggressiveBuyers(
  bars: Candle[],
  line: Trendline,
  tape: TapeSnapshot,
  vwapValues: number[]
): OrderFlowSignal | null {
  if (bars.length < 3) return null;

  const bar = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const t = toChartTime(bar.time);
  const level = getTrendlinePrice(line, t);
  if (!Number.isFinite(level) || level <= 0) return null;

  const tol = getDynamicNearTolerance(level, bars);
  const deltaPercent = getTapeDeltaPercent(tape);
  const volumeRatio = getRecentVolumeRatio(bars, 6);
  const vwap = vwapValues[vwapValues.length - 1] ?? null;
  const aboveVwap = vwap != null && Number.isFinite(vwap) ? bar.close >= vwap : false;

  let score = 0;
  if (bar.close > level + tol * 0.15) score += 22;
  if (closePositionInBar(bar) >= 0.72) score += 18;
  if (bar.close > prev.close) score += 10;
  if (Math.abs(bar.close - bar.open) > Math.abs(prev.close - prev.open)) score += 10;
  if (volumeRatio >= 1.15) score += 14;
  if (deltaPercent >= 0.12) score += 18;
  if (aboveVwap) score += 6;

  if (score < 60) return null;

  return {
    score,
    message: `Aggressive buyers · score ${score} · Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
    markerLabel: "BUY",
    markerPrice: bar.low,
    markerTime: t,
    markerColor: "#38bdf8",
    markerDirection: "up",
  };
}

function detectFailedBreakdown(
  bars: Candle[],
  line: Trendline,
  tape: TapeSnapshot,
  vwapValues: number[]
): OrderFlowSignal | null {
  if (bars.length < 3) return null;

  const bar = bars[bars.length - 1];
  const t = toChartTime(bar.time);
  const level = getTrendlinePrice(line, t);
  if (!Number.isFinite(level) || level <= 0) return null;

  const tol = getDynamicNearTolerance(level, bars);
  const deltaPercent = getTapeDeltaPercent(tape);
  const volumeRatio = getRecentVolumeRatio(bars, 6);
  const vwap = vwapValues[vwapValues.length - 1] ?? null;
  const aboveVwap = vwap != null && Number.isFinite(vwap) ? bar.close >= vwap : false;

  let score = 0;
  if (bar.low < level - tol * 0.2) score += 24;
  if (bar.close > level) score += 22;
  if (closePositionInBar(bar) >= 0.65) score += 12;
  if (volumeRatio >= 1.1) score += 12;
  if (deltaPercent >= 0.08) score += 12;
  if (aboveVwap) score += 6;

  if (score < 58) return null;

  return {
    score,
    message: `Failed breakdown · score ${score} · Δ ${(deltaPercent * 100).toFixed(0)}% · vol ${volumeRatio.toFixed(2)}x`,
    markerLabel: "FDB",
    markerPrice: bar.low,
    markerTime: t,
    markerColor: "#f59e0b",
    markerDirection: "up",
  };
}

function trendlineStorageKey(symbol: string, timeframe: string): string {
  return `manual-trendlines:${symbol.toUpperCase()}:${timeframe}`;
}

function sharedTrendlineStorageKey(symbol: string): string {
  return `manual-trendlines-shared:${symbol.toUpperCase()}`;
}

function timeframeTrendlineStorageKey(symbol: string, timeframe: string): string {
  return `manual-trendlines-local:${symbol.toUpperCase()}:${timeframe}`;
}


function createTrendline(
  symbol: string,
  timeframe: string,
  a: PendingTrendPoint,
  b: PendingTrendPoint,
  options?: {
    scope?: TrendlineScope;
    extendLeft?: boolean;
    extendRight?: boolean;
    color?: string;
    width?: number;
  }
): Trendline | null {
  if (a.time === b.time) return null;

  const first = a.time < b.time ? a : b;
  const second = a.time < b.time ? b : a;

  const slope = (second.price - first.price) / (second.time - first.time);
  const intercept = first.price - slope * first.time;

  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    symbol: symbol.toUpperCase(),
    timeframe,
    scope: options?.scope ?? "shared",
    t1: first.time,
    p1: first.price,
    t2: second.time,
    p2: second.price,
    slope,
    intercept,
    extendLeft: options?.extendLeft ?? true,
    extendRight: options?.extendRight ?? true,
    color: options?.color ?? "#00e5ff",
    width: options?.width ?? 2,
    createdAt: Date.now(),
  };
}

function getTrendlinePrice(line: Trendline, time: number): number {
  return line.slope * time + line.intercept;
}

function findClosestBarIndexByChartTime(bars: Candle[], target: UTCTimestamp): number {
  if (!bars.length) return 0;

  let bestIdx = 0;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (let i = 0; i < bars.length; i++) {
    const diff = Math.abs(toChartTime(bars[i].time) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function getTrendlinePriceAtBarIndex(line: Trendline, bars: Candle[], targetIndex: number): number {
  if (!bars.length) return line.p2;

  const i1 = findClosestBarIndexByChartTime(bars, line.t1);
  const i2 = findClosestBarIndexByChartTime(bars, line.t2);

  if (i1 === i2) return line.p2;

  const slopePerBar = (line.p2 - line.p1) / (i2 - i1);
  return line.p1 + slopePerBar * (targetIndex - i1);
}

function normalizeStoredTrendline(line: Trendline): Trendline {
  return {
    ...line,
    symbol: (line.symbol || "").toUpperCase(),
    scope: line.scope === "timeframe" ? "timeframe" : "shared",
    extendLeft: line.extendLeft ?? true,
    extendRight: line.extendRight ?? true,
    color: typeof line.color === "string" ? line.color : "#00e5ff",
    width:
      typeof line.width === "number" && Number.isFinite(line.width) && line.width >= 1
        ? Math.max(1, Math.min(5, Math.round(line.width)))
        : 2,
  };
}

function readTrendlineArray(storageKey: string): Trendline[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Trendline[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (line) =>
          line &&
          typeof line.id === "string" &&
          typeof line.t1 === "number" &&
          typeof line.p1 === "number" &&
          typeof line.t2 === "number" &&
          typeof line.p2 === "number" &&
          typeof line.slope === "number" &&
          typeof line.intercept === "number"
      )
      .map((line) => normalizeStoredTrendline(line));
  } catch {
    return [];
  }
}

function loadTrendlines(symbol: string, timeframe: string): Trendline[] {
  const shared = readTrendlineArray(sharedTrendlineStorageKey(symbol)).map((line) => ({
    ...line,
    scope: "shared" as const,
  }));
  const localRaw = readTrendlineArray(timeframeTrendlineStorageKey(symbol, timeframe));
  const local =
    localRaw.length > 0
      ? localRaw.map((line) => ({
          ...line,
          scope: "timeframe" as const,
        }))
      : readTrendlineArray(trendlineStorageKey(symbol, timeframe)).map((line) => ({
          ...line,
          scope: line.scope === "timeframe" ? "timeframe" as const : "shared" as const,
        }));

  const deduped = new Map<string, Trendline>();
  for (const line of [...shared, ...local]) {
    deduped.set(line.id, normalizeStoredTrendline(line));
  }
  return [...deduped.values()];
}

function saveTrendlines(symbol: string, timeframe: string, trendlines: Trendline[]) {
  try {
    const manualLines = trendlines.map(normalizeStoredTrendline);
    const shared = manualLines.filter((line) => line.scope === "shared");
    const local = manualLines.filter((line) => line.scope === "timeframe");

    localStorage.setItem(sharedTrendlineStorageKey(symbol), JSON.stringify(shared));
    localStorage.setItem(timeframeTrendlineStorageKey(symbol, timeframe), JSON.stringify(local));

    const legacyKey = trendlineStorageKey(symbol, timeframe);
    if (localStorage.getItem(legacyKey) != null) {
      localStorage.removeItem(legacyKey);
    }
  } catch {
    // ignore storage issues
  }
}

function sameTrendlineSet(a: Trendline[], b: Trendline[]): boolean {
  const clean = (items: Trendline[]) =>
    items
      .map(normalizeStoredTrendline)
      .map(({ id, symbol, timeframe, scope, t1, p1, t2, p2, slope, intercept, extendLeft, extendRight, color, width }) => ({
        id,
        symbol,
        timeframe,
        scope,
        t1,
        p1,
        t2,
        p2,
        slope,
        intercept,
        extendLeft,
        extendRight,
        color,
        width,
      }))
      .sort((x, y) => x.id.localeCompare(y.id));

  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

function mergeTrendlineSets(...groups: Trendline[][]): Trendline[] {
  const byId = new Map<string, Trendline>();
  for (const group of groups) {
    for (const line of group) {
      if (!line || typeof line.id !== "string") continue;
      byId.set(line.id, normalizeStoredTrendline(line));
    }
  }
  return [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function normalizeRemoteTrendlineArray(rows: unknown, symbol: string, timeframe: string, scope: TrendlineScope): Trendline[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((raw) => raw as Partial<Trendline>)
    .filter((line) =>
      line &&
      typeof line.id === "string" &&
      typeof line.t1 === "number" &&
      typeof line.p1 === "number" &&
      typeof line.t2 === "number" &&
      typeof line.p2 === "number"
    )
    .map((line) => {
      const t1 = Number(line.t1);
      const t2 = Number(line.t2);
      const p1 = Number(line.p1);
      const p2 = Number(line.p2);
      const slope = Number.isFinite(Number(line.slope)) && t1 !== t2 ? Number(line.slope) : (p2 - p1) / (t2 - t1);
      const intercept = Number.isFinite(Number(line.intercept)) ? Number(line.intercept) : p1 - slope * t1;
      return normalizeStoredTrendline({
        ...(line as Trendline),
        symbol: normalizeSymbolKey(line.symbol || symbol),
        timeframe: scope === "shared" ? "shared" : String(line.timeframe || timeframe),
        scope,
        t1,
        p1,
        t2,
        p2,
        slope,
        intercept,
        extendLeft: line.extendLeft ?? true,
        extendRight: line.extendRight ?? true,
        color: typeof line.color === "string" ? line.color : "#00e5ff",
        width: typeof line.width === "number" ? line.width : 2,
        createdAt: Number.isFinite(Number(line.createdAt)) ? Number(line.createdAt) : Date.now(),
      });
    })
    .filter((line) => Number.isFinite(line.slope) && Number.isFinite(line.intercept));
}

async function readRemoteTrendlines(symbol: string, timeframe: string): Promise<Trendline[] | null> {
  const sym = encodeURIComponent(normalizeSymbolKey(symbol));
  const tf = encodeURIComponent((timeframe || "1m").toLowerCase().trim());
  try {
    const [sharedRes, localRes] = await Promise.all([
      fetch(`${PROJECTION_SYNC_API_BASE}/chart/trendlines/${sym}/shared`, { method: "GET" }),
      fetch(`${PROJECTION_SYNC_API_BASE}/chart/trendlines/${sym}/${tf}`, { method: "GET" }),
    ]);

    const sharedData = sharedRes.ok ? await sharedRes.json() as { trendlines?: unknown } : { trendlines: [] };
    const localData = localRes.ok ? await localRes.json() as { trendlines?: unknown } : { trendlines: [] };

    const shared = normalizeRemoteTrendlineArray(sharedData.trendlines, symbol, "shared", "shared");
    const local = normalizeRemoteTrendlineArray(localData.trendlines, symbol, timeframe, "timeframe");
    return mergeTrendlineSets(shared, local);
  } catch {
    return null;
  }
}

async function writeRemoteTrendlines(symbol: string, timeframe: string, trendlines: Trendline[]): Promise<void> {
  const sym = encodeURIComponent(normalizeSymbolKey(symbol));
  const tf = encodeURIComponent((timeframe || "1m").toLowerCase().trim());
  const clean = trendlines.map(normalizeStoredTrendline);
  const shared = clean.filter((line) => line.scope === "shared").map((line) => ({ ...line, timeframe: "shared" }));
  const local = clean.filter((line) => line.scope === "timeframe").map((line) => ({ ...line, timeframe }));

  try {
    await Promise.all([
      fetch(`${PROJECTION_SYNC_API_BASE}/chart/trendlines/${sym}/shared`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trendlines: shared }),
      }),
      fetch(`${PROJECTION_SYNC_API_BASE}/chart/trendlines/${sym}/${tf}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trendlines: local }),
      }),
    ]);
  } catch {
    // Remote sync is best-effort. Local persistence keeps drawings stable if backend is offline.
  }
}

function normalizeClickedTime(rawTime: unknown): UTCTimestamp | null {
  if (typeof rawTime === "number" && Number.isFinite(rawTime)) {
    return rawTime as UTCTimestamp;
  }

  if (
    rawTime &&
    typeof rawTime === "object" &&
    "timestamp" in rawTime &&
    typeof (rawTime as { timestamp?: unknown }).timestamp === "number"
  ) {
    return (rawTime as { timestamp: number }).timestamp as UTCTimestamp;
  }

  return null;
}

function findNearestBarByTime(bars: Candle[], targetTime: UTCTimestamp): Candle | null {
  if (!bars.length) return null;

  let bestBar: Candle | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (const bar of bars) {
    const barTime = toChartTime(bar.time);
    const diff = Math.abs(barTime - targetTime);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestBar = bar;
    }
  }

  return bestBar;
}

function snapPriceToBarWick(
  bar: Candle,
  clickedPrice: number,
  mode: TrendlineSnapMode,
  preferredKind?: PendingTrendPoint["snapKind"]
): { price: number; snapKind: PendingTrendPoint["snapKind"] } {
  const bodyHigh = Math.max(bar.open, bar.close);
  const bodyLow = Math.min(bar.open, bar.close);

  const nearest = <T extends { price: number; snapKind: PendingTrendPoint["snapKind"] }>(
    values: T[]
  ) =>
    values.reduce((best, candidate) =>
      Math.abs(candidate.price - clickedPrice) < Math.abs(best.price - clickedPrice)
        ? candidate
        : best
    );

  const wickCandidates = [
    { price: bar.high, snapKind: "high" as const },
    { price: bar.low, snapKind: "low" as const },
  ];

  const bodyCandidates = [
    { price: bodyHigh, snapKind: "open" as const },
    { price: bodyLow, snapKind: "close" as const },
  ];

  if (mode === "wick") {
    if (preferredKind === "high") return { price: bar.high, snapKind: "high" };
    if (preferredKind === "low") return { price: bar.low, snapKind: "low" };
    return nearest(wickCandidates);
  }

  if (mode === "body") {
    if (preferredKind === "open") return { price: bodyHigh, snapKind: "open" };
    if (preferredKind === "close") return { price: bodyLow, snapKind: "close" };
    return nearest(bodyCandidates);
  }

  const fullRange = Math.max(bar.high - bar.low, 0.0000001);
  const bodySize = Math.max(Math.abs(bar.close - bar.open), 0.0000001);
  const topWick = Math.max(bar.high - bodyHigh, 0);
  const bottomWick = Math.max(bodyLow - bar.low, 0);
  const bodyMid = (bodyHigh + bodyLow) / 2;
  const upperMid = (bar.high + bodyHigh) / 2;
  const lowerMid = (bar.low + bodyLow) / 2;

  // Keep second anchor on the same side/family when possible.
  if (preferredKind === "high") return { price: bar.high, snapKind: "high" };
  if (preferredKind === "low") return { price: bar.low, snapKind: "low" };
  if (preferredKind === "open") return { price: bodyHigh, snapKind: "open" };
  if (preferredKind === "close") return { price: bodyLow, snapKind: "close" };

  // Tiny-body / doji candles should snap to the nearest explicit level.
  if (bodySize / fullRange <= 0.14) {
    return nearest([...wickCandidates, ...bodyCandidates]);
  }

  // Strong preference for body in auto mode unless user is clearly aiming at a wick.
  const wickBiasThreshold = Math.max(fullRange * 0.18, bodySize * 0.45);

  if (clickedPrice >= upperMid || Math.abs(clickedPrice - bar.high) <= wickBiasThreshold) {
    return { price: bar.high, snapKind: "high" };
  }

  if (clickedPrice <= lowerMid || Math.abs(clickedPrice - bar.low) <= wickBiasThreshold) {
    return { price: bar.low, snapKind: "low" };
  }

  // Inside the candle body zone, snap to the nearest body edge.
  if (clickedPrice >= bodyMid) {
    return { price: bodyHigh, snapKind: "open" };
  }

  return { price: bodyLow, snapKind: "close" };
}

function buildSnappedTrendPointFromClick(
  bars: Candle[],
  clickedTime: UTCTimestamp,
  clickedPrice: number,
  mode: TrendlineSnapMode,
  avoidTime?: UTCTimestamp | null,
  preferredKind?: PendingTrendPoint["snapKind"]
): PendingTrendPoint | null {
  const nearestBar = findNearestBarByTime(bars, clickedTime);
  if (!nearestBar) return null;

  let snappedBar = nearestBar;
  const nearestIndex = bars.findIndex((bar) => bar.time === nearestBar.time);

  if (avoidTime != null && toChartTime(snappedBar.time) === avoidTime) {
    const candidates = [
      nearestIndex + 1,
      nearestIndex - 1,
      nearestIndex + 2,
      nearestIndex - 2,
      nearestIndex + 3,
      nearestIndex - 3,
    ];

    for (const idx of candidates) {
      const altBar = bars[idx];
      if (!altBar) continue;
      const altTime = toChartTime(altBar.time);
      if (altTime !== avoidTime) {
        snappedBar = altBar;
        break;
      }
    }
  }

  const snapped = snapPriceToBarWick(
    snappedBar,
    clickedPrice,
    mode,
    preferredKind
  );

  return {
    time: toChartTime(snappedBar.time),
    price: snapped.price,
    snapKind: snapped.snapKind,
  };
}



type ProjectionMath = {
  candleTime: UTCTimestamp;
  bodyHigh: number;
  bodyLow: number;
  candleHigh: number;
  candleLow: number;
  bodyRange: number;
  fullRange: number;
};

function getProjectionMath(bar: Candle): ProjectionMath {
  const candleTime = toChartTime(bar.time);
  const candleBodyHigh = bodyHigh(bar);
  const candleBodyLow = bodyLow(bar);
  const candleHigh = bar.high;
  const candleLow = bar.low;
  const rawBodyRange = Math.max(0, candleBodyHigh - candleBodyLow);
  const fullRange = Math.max(0, candleHigh - candleLow);
  const bodyRange = rawBodyRange > 0 ? rawBodyRange : fullRange;

  return {
    candleTime,
    bodyHigh: candleBodyHigh,
    bodyLow: candleBodyLow,
    candleHigh,
    candleLow,
    bodyRange,
    fullRange,
  };
}

function buildBodyProjectionLevels(math: ProjectionMath): ProjectionLevel[] {
  const levels: ProjectionLevel[] = [
    {
      id: `body-res-${math.candleTime}`,
      kind: "body_resistance",
      price: math.bodyHigh + math.bodyRange,
      color: "#ef4444",
      lineStyle: LineStyle.Solid,
      lineWidth: 2,
      title: `Proj Body R ${formatPrice(math.bodyHigh + math.bodyRange)}`,
    },
    {
      id: `body-sup-${math.candleTime}`,
      kind: "body_support",
      price: math.bodyLow - math.bodyRange,
      color: "#3b82f6",
      lineStyle: LineStyle.Solid,
      lineWidth: 2,
      title: `Proj Body S ${formatPrice(math.bodyLow - math.bodyRange)}`,
    },
  ];

  return levels.filter((level) => Number.isFinite(level.price));
}

function buildHighLowWickProjectionLevels(math: ProjectionMath): ProjectionLevel[] {
  const levels: ProjectionLevel[] = [
    {
      id: `wick-res-${math.candleTime}`,
      kind: "range_resistance",
      price: math.candleHigh + math.fullRange,
      color: "#ef4444",
      lineStyle: LineStyle.Dashed,
      lineWidth: 2,
      title: `Proj Wick R ${formatPrice(math.candleHigh + math.fullRange)}`,
    },
    {
      id: `wick-sup-${math.candleTime}`,
      kind: "range_support",
      price: math.candleLow - math.fullRange,
      color: "#3b82f6",
      lineStyle: LineStyle.Dashed,
      lineWidth: 2,
      title: `Proj Wick S ${formatPrice(math.candleLow - math.fullRange)}`,
    },
  ];

  return levels.filter((level) => Number.isFinite(level.price));
}

function buildBodyProjectionSelection(bar: Candle): ProjectionSelection {
  const math = getProjectionMath(bar);

  return {
    candleTime: math.candleTime,
    bodyRange: math.bodyRange,
    fullRange: math.fullRange,
    levels: buildBodyProjectionLevels(math),
  };
}

function buildHighLowWickProjectionSelection(bar: Candle): ProjectionSelection {
  const math = getProjectionMath(bar);

  return {
    candleTime: math.candleTime,
    bodyRange: math.bodyRange,
    fullRange: math.fullRange,
    levels: buildHighLowWickProjectionLevels(math),
  };
}

function buildAnchorRangeProjectionSelection(bar: Candle): ProjectionSelection {
  const math = getProjectionMath(bar);
  const fullRange = math.fullRange;
  const supportPrice = bar.close + fullRange;
  const resistancePrice = bar.open + fullRange;

  const supportLevel: ProjectionLevel = {
    id: `anchor-range-support-${math.candleTime}`,
    kind: "anchor_range_support",
    price: supportPrice,
    color: "#3b82f6",
    lineStyle: LineStyle.Solid,
    lineWidth: 2,
    title: `Proj Support ${formatPrice(supportPrice)}`,
  };

  const resistanceLevel: ProjectionLevel = {
    id: `anchor-range-resistance-${math.candleTime}`,
    kind: "anchor_range_resistance",
    price: resistancePrice,
    color: "#ef4444",
    lineStyle: LineStyle.Solid,
    lineWidth: 2,
    title: `Proj Resist ${formatPrice(resistancePrice)}`,
  };

  const levels: ProjectionLevel[] = [supportLevel, resistanceLevel].filter((level) => Number.isFinite(level.price));

  return {
    candleTime: math.candleTime,
    bodyRange: math.bodyRange,
    fullRange,
    levels,
    anchorOpen: bar.open,
    anchorClose: bar.close,
    anchorHigh: bar.high,
    anchorLow: bar.low,
  };
}

function buildSupportPredictionWickRangeSelection(bar: Candle): ProjectionSelection {
  const math = getProjectionMath(bar);
  const supportPrice = math.candleLow - math.fullRange;

  const supportLevel: ProjectionLevel = {
    id: `support-prediction-${math.candleTime}`,
    kind: "support_prediction",
    price: supportPrice,
    color: "#3b82f6",
    lineStyle: LineStyle.Solid,
    lineWidth: 2,
    title: `Support Pred ${formatPrice(supportPrice)}`,
  };

  return {
    candleTime: math.candleTime,
    bodyRange: math.bodyRange,
    fullRange: math.fullRange,
    levels: Number.isFinite(supportPrice) ? [supportLevel] : [],
    anchorOpen: bar.open,
    anchorHigh: bar.high,
    anchorLow: bar.low,
  };
}

function buildResistancePredictionWickRangeSelection(bar: Candle): ProjectionSelection {
  const math = getProjectionMath(bar);
  const resistancePrice = math.candleHigh + math.fullRange;

  const resistanceLevel: ProjectionLevel = {
    id: `resistance-prediction-${math.candleTime}`,
    kind: "resistance_prediction",
    price: resistancePrice,
    color: "#ef4444",
    lineStyle: LineStyle.Solid,
    lineWidth: 2,
    title: `Resistance Pred ${formatPrice(resistancePrice)}`,
  };

  return {
    candleTime: math.candleTime,
    bodyRange: math.bodyRange,
    fullRange: math.fullRange,
    levels: Number.isFinite(resistancePrice) ? [resistanceLevel] : [],
    anchorOpen: bar.open,
    anchorHigh: bar.high,
    anchorLow: bar.low,
  };
}

function buildEmptyProjectionSelection(bar: Candle): ProjectionSelection {
  return {
    candleTime: toChartTime(bar.time),
    bodyRange: 0,
    fullRange: 0,
    levels: [],
  };
}

const CHART_FUNCTIONS: ChartFunctionDefinition[] = [
  {
    id: "none",
    label: "None",
    description: "No function projection lines. Only PMH, VWAP, compression, and other reference overlays remain visible.",
    category: "structure",
    buildSelection: buildEmptyProjectionSelection,
  },
  {
    id: "support_prediction_wick_range",
    label: "Support Prediction Only",
    description:
      "Click an anchor candle to draw one support prediction line only. Math: anchor low - full candle range, where range = high - low including wicks.",
    category: "projection",
    buildSelection: buildSupportPredictionWickRangeSelection,
  },
  {
    id: "resistance_prediction_wick_range",
    label: "Resistance Prediction Only",
    description:
      "Click an anchor candle to draw one resistance prediction line only. Math: anchor high + full candle range, where range = high - low including wicks.",
    category: "projection",
    buildSelection: buildResistancePredictionWickRangeSelection,
  },
  {
    id: "price_projection_anchor_range",
    label: "Price Projection Anchor Range",
    description:
      "Click a candle to anchor. Uses the full high-low range including wicks. Blue support = anchor close + range. Red resistance = anchor open + range. If a new candle closes below the anchor close, it re-anchors and redraws.",
    category: "projection",
    buildSelection: buildAnchorRangeProjectionSelection,
  },
  {
    id: "price_projection_body",
    label: "Price Projection Body",
    description:
      "Projects support and resistance from the candle body only. Resistance uses body high plus body range, and support uses body low minus body range.",
    category: "projection",
    buildSelection: buildBodyProjectionSelection,
  },
  {
    id: "price_projection_high_low_wicks",
    label: "Price Projection High / Low + Wicks",
    description:
      "Projects support and resistance from the full candle range including the wick high and wick low.",
    category: "projection",
    buildSelection: buildHighLowWickProjectionSelection,
  },
];

const DEFAULT_CHART_FUNCTION_ID: ChartFunctionId = "support_prediction_wick_range";

function getChartFunctionDefinition(id: ChartFunctionId): ChartFunctionDefinition {
  return CHART_FUNCTIONS.find((item) => item.id === id) ?? CHART_FUNCTIONS[0];
}

function getNearestTrendlineInteraction(
  lines: Trendline[],
  time: UTCTimestamp,
  price: number,
  bars: Candle[]
): {
  lineId: string;
  kind: "anchor" | "line";
  anchor?: TrendlineAnchorKey;
  distance: number;
} | null {
  if (!lines.length || !Number.isFinite(price)) return null;

  const priceTolerance = getDynamicNearTolerance(price, bars) * 1.4;
  const timeTolerance = Math.max(120, Math.round((bars.length > 1
    ? Math.abs(toChartTime(bars[bars.length - 1].time) - toChartTime(bars[Math.max(0, bars.length - 2)].time))
    : 60) * 3));

  let best: {
    lineId: string;
    kind: "anchor" | "line";
    anchor?: TrendlineAnchorKey;
    distance: number;
  } | null = null;

  for (const line of lines) {
    const anchorCandidates = [
      { anchor: "p1" as const, time: line.t1, price: line.p1 },
      { anchor: "p2" as const, time: line.t2, price: line.p2 },
    ];

    for (const candidate of anchorCandidates) {
      const priceDiff = Math.abs(candidate.price - price);
      const timeDiff = Math.abs(candidate.time - time);
      if (priceDiff <= priceTolerance && timeDiff <= timeTolerance) {
        const score = priceDiff + timeDiff * 0.0005;
        if (!best || score < best.distance) {
          best = {
            lineId: line.id,
            kind: "anchor",
            anchor: candidate.anchor,
            distance: score,
          };
        }
      }
    }

    const linePrice = getTrendlinePrice(line, time);
    if (!Number.isFinite(linePrice)) continue;

    const lineDiff = Math.abs(linePrice - price);
    if (lineDiff <= priceTolerance) {
      const score = lineDiff + 0.25;
      if (!best || score < best.distance) {
        best = {
          lineId: line.id,
          kind: "line",
          distance: score,
        };
      }
    }
  }

  return best;
}

function updateTrendlineAnchor(
  line: Trendline,
  anchor: TrendlineAnchorKey,
  point: PendingTrendPoint
): Trendline | null {
  const nextA = anchor === "p1" ? point : { time: line.t1, price: line.p1 };
  const nextB = anchor === "p2" ? point : { time: line.t2, price: line.p2 };

  const rebuilt = createTrendline(line.symbol, line.timeframe, nextA, nextB);
  if (!rebuilt) return null;

  return {
    ...rebuilt,
    id: line.id,
    createdAt: line.createdAt,
    label: line.label,
    scope: line.scope ?? "shared",
    extendLeft: line.extendLeft,
    extendRight: line.extendRight,
    color: line.color ?? "#00e5ff",
    width: line.width ?? 2,
  };
}

function updateTrendlineManualPrices(
  line: Trendline,
  p1: number,
  p2: number
): Trendline | null {
  if (!Number.isFinite(p1) || !Number.isFinite(p2)) return null;

  const rebuilt = createTrendline(
    line.symbol,
    line.timeframe,
    { time: line.t1, price: p1 },
    { time: line.t2, price: p2 },
    {
      scope: line.scope,
      extendLeft: line.extendLeft,
      extendRight: line.extendRight,
      color: line.color,
      width: line.width,
    }
  );

  if (!rebuilt) return null;

  return {
    ...rebuilt,
    id: line.id,
    createdAt: line.createdAt,
    label: line.label,
    scope: line.scope ?? "shared",
    extendLeft: line.extendLeft,
    extendRight: line.extendRight,
    color: line.color ?? "#00e5ff",
    width: line.width ?? 2,
  };
}

function getEtBarParts(ms: number): {
  date: string;
  hour: number;
  minute: number;
  hm: number;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(new Date(ms));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  const day = parts.find((p) => p.type === "day")?.value ?? "00";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  return {
    date: `${year}-${month}-${day}`,
    hour,
    minute,
    hm: hour * 100 + minute,
  };
}


function getSessionKindFromHm(hm: number): SessionKind {
  if (hm >= 400 && hm < 930) return "premarket";
  if (hm >= 930 && hm < 1600) return "regular";
  if (hm >= 1600 && hm < 2000) return "afterhours";
  return "overnight";
}

function getSessionLabel(kind: SessionKind): string {
  if (kind === "premarket") return "PRE";
  if (kind === "regular") return "RTH";
  if (kind === "afterhours") return "AH";
  return "OVN";
}

function getCurrentEtSessionKind(): SessionKind {
  return getSessionKindFromHm(getEtBarParts(Date.now()).hm);
}

function isCurrentEtExtendedHours(): boolean {
  const kind = getCurrentEtSessionKind();
  return kind !== "regular";
}

function computeSessionStats(
  bars: Candle[],
  tradingDate: string | null
): SessionStats {
  const currentSession = getCurrentEtSessionKind();
  const empty: SessionStats = {
    currentSession,
    currentSessionLabel: getSessionLabel(currentSession),
    premarketHigh: null,
    regularHigh: null,
    afterHoursHigh: null,
    extendedHigh: null,
  };

  if (!bars.length || !tradingDate) return empty;

  const dayBars = bars.filter((bar) => getEtBarParts(bar.time).date === tradingDate);
  if (!dayBars.length) return empty;

  const premarketBars = dayBars.filter((bar) => getSessionKindFromHm(getEtBarParts(bar.time).hm) === "premarket");
  const regularBars = dayBars.filter((bar) => getSessionKindFromHm(getEtBarParts(bar.time).hm) === "regular");
  const afterHoursBars = dayBars.filter((bar) => getSessionKindFromHm(getEtBarParts(bar.time).hm) === "afterhours");

  const premarketHigh = premarketBars.length ? Math.max(...premarketBars.map((bar) => bar.high)) : null;
  const regularHigh = regularBars.length ? Math.max(...regularBars.map((bar) => bar.high)) : null;
  const afterHoursHigh = afterHoursBars.length ? Math.max(...afterHoursBars.map((bar) => bar.high)) : null;

  const extCandidates = [premarketHigh, afterHoursHigh].filter(
    (value): value is number => value != null && Number.isFinite(value)
  );

  return {
    currentSession,
    currentSessionLabel: getSessionLabel(currentSession),
    premarketHigh,
    regularHigh,
    afterHoursHigh,
    extendedHigh: extCandidates.length ? Math.max(...extCandidates) : null,
  };
}

function computeSessionBandRanges(
  bars: Candle[],
  tradingDate: string | null
): SessionBandRange[] {
  if (!bars.length || !tradingDate) return [];

  const ranges: SessionBandRange[] = [];
  const dayBars = bars.filter((bar) => {
    const et = getEtBarParts(bar.time);
    return et.date === tradingDate;
  });

  if (!dayBars.length) return ranges;

  let activeKind: SessionKind | null = null;
  let activeStart: UTCTimestamp | null = null;
  let activeEnd: UTCTimestamp | null = null;

  const flush = () => {
    if (activeKind == null || activeStart == null || activeEnd == null) return;
    if (activeKind !== "overnight") {
      ranges.push({
        kind: activeKind,
        label: getSessionLabel(activeKind),
        startTime: activeStart,
        endTime: activeEnd,
      });
    }
  };

  for (const bar of dayBars) {
    const time = toChartTime(bar.time);
    const kind = getSessionKindFromHm(getEtBarParts(bar.time).hm);

    if (kind === "overnight") continue;

    if (activeKind == null) {
      activeKind = kind;
      activeStart = time;
      activeEnd = time;
      continue;
    }

    if (kind === activeKind) {
      activeEnd = time;
      continue;
    }

    flush();
    activeKind = kind;
    activeStart = time;
    activeEnd = time;
  }

  flush();
  return ranges;
}

function getPreviousTradingDateFromBars(
  bars: Candle[],
  targetDate: string
): string | null {
  const dates = Array.from(
    new Set(
      bars
        .map((bar) => getEtBarParts(bar.time).date)
        .filter((date) => date < targetDate)
    )
  ).sort();

  return dates.length ? dates[dates.length - 1] : null;
}

function isInExtendedWindowForMorningSetup(
  bar: Candle,
  currentDate: string,
  previousDate: string | null
): boolean {
  const et = getEtBarParts(bar.time);

  const isPrevAfterHours =
    previousDate !== null &&
    et.date === previousDate &&
    et.hm >= 1600 &&
    et.hm <= 2359;

  const isCurrentMorningSession =
    et.date === currentDate &&
    et.hm >= 400 &&
    et.hm <= 1300;

  return isPrevAfterHours || isCurrentMorningSession;
}

type ResistanceAnchor = {
  index: number;
  time: UTCTimestamp;
  rawHigh: number;
  anchorPrice: number;
  isSpike: boolean;
  kind: "top_zone" | "lower_high";
  rejectionScore: number;
};

function getUpperWick(bar: Candle): number {
  return bar.high - Math.max(bar.open, bar.close);
}

function getBodySize(bar: Candle): number {
  return Math.abs(bar.close - bar.open);
}

function getAnchorTolerance(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0.03;
  if (price < 1) return Math.max(0.01, price * 0.01);
  if (price < 5) return Math.max(0.02, price * 0.006);
  return Math.max(0.03, price * 0.004);
}

function isLoosePivotHigh(
  bars: Candle[],
  index: number,
  left = 1,
  right = 1
): boolean {
  if (index < left || index + right >= bars.length) return false;

  const candidate = bars[index].high;
  const tol = getAnchorTolerance(candidate);

  for (let i = index - left; i <= index + right; i++) {
    if (i === index) continue;
    if (bars[i].high > candidate + tol) {
      return false;
    }
  }

  return true;
}

function isSpikeHigh(
  bars: Candle[],
  index: number
): boolean {
  const bar = bars[index];
  const upperWick = getUpperWick(bar);
  const body = getBodySize(bar);
  const prevHigh = index > 0 ? bars[index - 1].high : bar.high;
  const nextHigh = index < bars.length - 1 ? bars[index + 1].high : bar.high;
  const neighborHigh = Math.max(prevHigh, nextHigh);

  const wickVsBody = upperWick > Math.max(0.12, body * 1.75);
  const extensionVsNeighbors = bar.high > neighborHigh * 1.04;

  return wickVsBody && extensionVsNeighbors;
}

function getClusterBoundsByHigh(
  bars: Candle[],
  centerIndex: number,
  tolerancePct = 0.004
): { start: number; end: number } {
  const refHigh = bars[centerIndex].high;
  const tol = Math.max(0.03, refHigh * tolerancePct);

  let start = centerIndex;
  let end = centerIndex;

  for (let i = centerIndex - 1; i >= 0; i--) {
    if (Math.abs(bars[i].high - refHigh) <= tol) {
      start = i;
    } else {
      break;
    }
  }

  for (let i = centerIndex + 1; i < bars.length; i++) {
    if (Math.abs(bars[i].high - refHigh) <= tol) {
      end = i;
    } else {
      break;
    }
  }

  return { start, end };
}

function getClusterAnchorPrice(
  bars: Candle[],
  start: number,
  end: number,
  preferAcceptedPrice = true
): number {
  const candidates: number[] = [];

  for (let i = start; i <= end; i++) {
    candidates.push(bodyHigh(bars[i]));
    candidates.push((bars[i].high + bodyHigh(bars[i])) / 2);

    if (!preferAcceptedPrice) {
      candidates.push(bars[i].high);
    }
  }

  const filtered = candidates
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  if (!filtered.length) {
    return bodyHigh(bars[start]);
  }

  return filtered[Math.floor(filtered.length / 2)];
}

function scoreRejectionAfter(
  bars: Candle[],
  index: number,
  lookahead = 4
): number {
  const end = Math.min(bars.length - 1, index + lookahead);
  const anchorBar = bars[index];

  let score = 0;

  for (let i = index + 1; i <= end; i++) {
    const bar = bars[i];

    if (bar.low < anchorBar.low) score += 2;
    if (bar.close < anchorBar.close) score += 2;
    if (bodyHigh(bar) < bodyHigh(anchorBar)) score += 1.5;
    if (bar.close < bar.open) score += 1;
  }

  return score;
}

function buildResistanceAnchorFromCluster(
  bars: Candle[],
  centerIndex: number,
  kind: "top_zone" | "lower_high"
): ResistanceAnchor {
  const spike = isSpikeHigh(bars, centerIndex);
  const bounds = getClusterBoundsByHigh(bars, centerIndex, 0.004);

  const anchorIndex = bounds.start;
  const rawHigh = bars[centerIndex].high;

  const anchorPrice = spike
    ? getClusterAnchorPrice(bars, bounds.start, bounds.end, true)
    : getClusterAnchorPrice(bars, bounds.start, bounds.end, false);

  const rejectionScore = scoreRejectionAfter(bars, centerIndex, 4);

  return {
    index: anchorIndex,
    time: toChartTime(bars[anchorIndex].time),
    rawHigh,
    anchorPrice,
    isSpike: spike,
    kind,
    rejectionScore,
  };
}

function dedupeAnchorsByTime(anchors: ResistanceAnchor[]): ResistanceAnchor[] {
  const out: ResistanceAnchor[] = [];
  const seen = new Set<number>();

  for (const anchor of anchors) {
    if (seen.has(anchor.index)) continue;
    seen.add(anchor.index);
    out.push(anchor);
  }

  return out;
}

function findTopZoneAnchors(bars: Candle[]): ResistanceAnchor[] {
  if (!bars.length) return [];

  const sessionHigh = Math.max(...bars.map((b) => b.high));
  const topZoneFloor = sessionHigh * 0.94;
  const anchors: ResistanceAnchor[] = [];

  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i].high < topZoneFloor) continue;
    if (!isLoosePivotHigh(bars, i, 1, 1)) continue;

    const anchor = buildResistanceAnchorFromCluster(bars, i, "top_zone");

    if (anchor.rejectionScore >= 3) {
      anchors.push(anchor);
    }
  }

  return dedupeAnchorsByTime(anchors);
}

function findLowerHighAnchors(
  bars: Candle[],
  topAnchor: ResistanceAnchor
): ResistanceAnchor[] {
  const anchors: ResistanceAnchor[] = [];
  const minStart = topAnchor.index + 1;
  const maxHighAllowed = topAnchor.anchorPrice - getAnchorTolerance(topAnchor.anchorPrice);

  for (let i = minStart + 1; i < bars.length - 1; i++) {
    const bar = bars[i];

    if (bar.high >= maxHighAllowed) continue;
    if (!isLoosePivotHigh(bars, i, 1, 1)) continue;

    const anchor = buildResistanceAnchorFromCluster(bars, i, "lower_high");

    if (anchor.anchorPrice >= topAnchor.anchorPrice) continue;
    if (anchor.rejectionScore < 2) continue;

    anchors.push(anchor);
  }

  return dedupeAnchorsByTime(anchors);
}

function getLineValueAtIndex(
  aIndex: number,
  aPrice: number,
  bIndex: number,
  bPrice: number,
  targetIndex: number
): number {
  if (bIndex === aIndex) return aPrice;
  const slope = (bPrice - aPrice) / (bIndex - aIndex);
  return aPrice + slope * (targetIndex - aIndex);
}

function scoreProResistanceLine(
  bars: Candle[],
  a: ResistanceAnchor,
  b: ResistanceAnchor
): number {
  if (b.index <= a.index) return Number.NEGATIVE_INFINITY;
  if (b.anchorPrice >= a.anchorPrice) return Number.NEGATIVE_INFINITY;

  let respectTouches = 0;
  let violations = 0;
  let closeRespects = 0;

  for (let i = a.index; i < bars.length; i++) {
    const expected = getLineValueAtIndex(
      a.index,
      a.anchorPrice,
      b.index,
      b.anchorPrice,
      i
    );

    const tol = getAnchorTolerance(expected);
    const bar = bars[i];

    if (Math.abs(bar.high - expected) <= tol) {
      respectTouches += 1;
    }

    if (Math.abs(bodyHigh(bar) - expected) <= tol) {
      closeRespects += 1;
    }

    if (i > b.index && bar.high > expected + tol * 1.5) {
      violations += 1;
    }
  }

  const spanScore = Math.max(0, b.index - a.index) * 0.4;
  const dropScore = Math.max(0, a.anchorPrice - b.anchorPrice) * 10;
  const rejectionScore = a.rejectionScore * 4 + b.rejectionScore * 5;
  const spikePenalty = a.isSpike ? 14 : 0;

  return (
    respectTouches * 7 +
    closeRespects * 9 +
    spanScore +
    dropScore +
    rejectionScore -
    violations * 18 -
    spikePenalty
  );
}

function numberFromOrderValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getOrderTemplate(order: ChartOrder): ChartOrderTemplate | string {
  const raw = String(
    order.template ??
      order.orderTemplate ??
      order.order_class ??
      order.orderClass ??
      order.type ??
      order.order_type ??
      "limit"
  ).toLowerCase();

  if (raw.includes("bracket")) return "bracket";
  if (raw.includes("oco")) return "oco";
  if (raw.includes("oto")) return "oto";
  if (raw.includes("market")) return "market";
  if (raw.includes("stop")) return "stop";
  if (raw.includes("limit")) return "limit";
  return raw || "limit";
}

function getOrderSide(order: ChartOrder): string {
  return String(order.side ?? "order").toUpperCase();
}

function getOrderQty(order: ChartOrder): string {
  const qty = order.qty;
  if (qty == null || qty === "") return "";
  return String(qty);
}

function getOrderLineColor(kind: ChartOrderLineKind, side: string): string {
  if (kind === "stop" || kind === "stop_loss") return "#ef4444";
  if (kind === "take_profit") return "#22c55e";
  if (side.toLowerCase() === "buy") return "#38bdf8";
  if (side.toLowerCase() === "sell") return "#f59e0b";
  return "#dbeafe";
}

function makeOrderLine(
  order: ChartOrder,
  kind: ChartOrderLineKind,
  price: number | null,
  labelSuffix: string,
  index = 0
): NormalizedOrderLine | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;

  const orderId = String(order.id);
  const template = getOrderTemplate(order);
  const side = getOrderSide(order);
  const qty = getOrderQty(order);
  const color = getOrderLineColor(kind, side);
  const qtyText = qty ? ` ${qty}` : "";
  const label = `${side}${qtyText} ${labelSuffix}`.trim();

  return {
    lineId: `${orderId}:${kind}:${index}`,
    orderId,
    order,
    kind,
    template,
    side,
    qty,
    price,
    label,
    color,
    canMove: true,
  };
}

function normalizeOrderLines(openOrders: ChartOrder[] | undefined, symbol: string): NormalizedOrderLine[] {
  if (!Array.isArray(openOrders) || !openOrders.length) return [];

  const currentSymbol = symbol.trim().toUpperCase();
  const lines: NormalizedOrderLine[] = [];

  for (const order of openOrders) {
    if (!order || !order.id) continue;

    const orderSymbol = typeof order.symbol === "string" ? order.symbol.toUpperCase() : currentSymbol;
    if (orderSymbol && currentSymbol && orderSymbol !== currentSymbol) continue;

    const status = String(order.status ?? "open").toLowerCase();
    if (["filled", "canceled", "cancelled", "expired", "rejected"].includes(status)) continue;

    const template = getOrderTemplate(order);
    const type = String(order.type ?? order.order_type ?? template ?? "limit").toLowerCase();

    const entryPrice =
      numberFromOrderValue(order.limitPrice) ??
      numberFromOrderValue(order.limit_price) ??
      numberFromOrderValue(order.price);

    const stopPrice =
      numberFromOrderValue(order.stopLossPrice) ??
      numberFromOrderValue(order.stop_loss_price) ??
      numberFromOrderValue(order.stop_loss?.stop_price) ??
      numberFromOrderValue(order.stop_loss?.price) ??
      numberFromOrderValue(order.stopPrice) ??
      numberFromOrderValue(order.stop_price);

    const takeProfitPrice =
      numberFromOrderValue(order.takeProfitPrice) ??
      numberFromOrderValue(order.take_profit_price) ??
      numberFromOrderValue(order.take_profit?.limit_price) ??
      numberFromOrderValue(order.take_profit?.price);

    const entryKind: ChartOrderLineKind = type.includes("stop") && entryPrice == null ? "stop" : "limit";
    const entryLabel = template === "market" ? "MKT" : entryKind === "stop" ? "STOP" : template === "bracket" ? "ENTRY" : "LIMIT";
    const entryLine = makeOrderLine(order, entryKind, entryPrice, entryLabel, 0);
    if (entryLine) lines.push(entryLine);

    const tpLine = makeOrderLine(order, "take_profit", takeProfitPrice, "TP", 1);
    if (tpLine) lines.push(tpLine);

    const slLine = makeOrderLine(order, "stop_loss", stopPrice, "SL", 2);
    if (slLine) lines.push(slLine);

    if (Array.isArray(order.legs)) {
      order.legs.forEach((leg, index) => {
        const legType = String(leg.type ?? leg.order_type ?? "").toLowerCase();
        const legLimit = numberFromOrderValue(leg.limitPrice) ?? numberFromOrderValue(leg.limit_price) ?? numberFromOrderValue(leg.price);
        const legStop = numberFromOrderValue(leg.stopPrice) ?? numberFromOrderValue(leg.stop_price);
        const legKind: ChartOrderLineKind = legType.includes("stop") ? "stop_loss" : "take_profit";
        const legPrice = legKind === "stop_loss" ? legStop ?? legLimit : legLimit ?? legStop;
        const legLabel = legKind === "stop_loss" ? "SL" : "TP";
        const legLine = makeOrderLine({ ...leg, id: String(leg.id ?? `${order.id}-leg-${index}`) }, legKind, legPrice, legLabel, index + 10);
        if (legLine) lines.push({ ...legLine, lineId: `${order.id}:${legKind}:leg-${index}`, order });
      });
    }
  }

  const deduped = new Map<string, NormalizedOrderLine>();
  for (const line of lines) deduped.set(line.lineId, line);
  return [...deduped.values()];
}

function formatOrderLineDetail(line: NormalizedOrderLine): string {
  const template = String(line.template || "limit").toUpperCase();
  const qty = line.qty ? ` · Qty ${line.qty}` : "";
  return `${template}${qty} · ${formatPrice(line.price)}`;
}

function roundOrderDragPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  const step = price >= 1 ? 0.01 : 0.0001;
  return Math.max(step, Math.round(price / step) * step);
}

function getSessionInfo(ms: number) {
  const et = getEtBarParts(ms); // you already have this
  const hm = et.hm;

  // Sessions in ET
  const isPre = hm >= 400 && hm < 930;
  const isRth = hm >= 930 && hm < 1600;
  const isAh = hm >= 1600 && hm < 2000;

  let session: "PRE" | "RTH" | "AH" | "CLOSED" = "CLOSED";

  if (isPre) session = "PRE";
  else if (isRth) session = "RTH";
  else if (isAh) session = "AH";

  return {
    session,
    isPre,
    isRth,
    isAh,
    isClosed: !isPre && !isRth && !isAh,
    etTime: et.hm,
    date: et.date,
  };
}


function normalizeSymbolKey(symbol: string): string {
  return (symbol || "").trim().toUpperCase();
}

function normalizeStoredProjection(item: Partial<StoredProjectionPriceLine> | null | undefined): StoredProjectionPriceLine | null {
  if (!item) return null;
  const price = Number(item.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const lineStyleValue = Number(item.lineStyle);
  const lineWidthValue = Number(item.lineWidth);
  return {
    id: String(item.id || `saved-projection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    price,
    title: String(item.title || `SAVED Projection ${formatPrice(price)}`),
    color: String(item.color || "#3b82f6"),
    lineStyle: (Number.isFinite(lineStyleValue) ? lineStyleValue : LineStyle.Solid) as LineStyle,
    lineWidth: Math.min(4, Math.max(1, Number.isFinite(lineWidthValue) ? lineWidthValue : 2)),
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
  };
}

function getLocalProjectionStore(): Record<string, StoredProjectionPriceLine[]> {
  try {
    const raw = window.localStorage.getItem(LOCAL_PROJECTION_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const parsedObject = parsed as {
      version?: number;
      symbols?: Record<string, StoredProjectionPriceLine[]>;
      [key: string]: unknown;
    };

    const maybeSymbols =
      parsedObject.symbols && typeof parsedObject.symbols === "object" && !Array.isArray(parsedObject.symbols)
        ? parsedObject.symbols
        : parsedObject;

    const cleanStore: Record<string, StoredProjectionPriceLine[]> = {};

    for (const [key, value] of Object.entries(maybeSymbols)) {
      if (key === "version" || key === "symbols") continue;
      if (!Array.isArray(value)) continue;

      const cleanRows = value
        .map((item) => normalizeStoredProjection(item as Partial<StoredProjectionPriceLine>))
        .filter((item): item is StoredProjectionPriceLine => Boolean(item));

      if (cleanRows.length) cleanStore[normalizeSymbolKey(key)] = cleanRows;
    }

    return cleanStore;
  } catch {
    return {};
  }
}

function readLocalProjections(symbol: string): StoredProjectionPriceLine[] {
  const key = normalizeSymbolKey(symbol);
  const store = getLocalProjectionStore();
  const rows = Array.isArray(store[key]) ? store[key] : [];
  return rows.map(normalizeStoredProjection).filter((item): item is StoredProjectionPriceLine => Boolean(item));
}

function writeLocalProjections(symbol: string, projections: StoredProjectionPriceLine[]) {
  try {
    const key = normalizeSymbolKey(symbol);
    const store = getLocalProjectionStore();
    store[key] = projections.map((item) => ({ ...item, lineStyle: item.lineStyle, lineWidth: item.lineWidth }));
    window.localStorage.setItem(LOCAL_PROJECTION_STORAGE_KEY, JSON.stringify({ version: PROJECTION_STORAGE_VERSION, symbols: store }));
  } catch {
    // localStorage can fail in private mode or if storage is full. Drawing still works in-memory.
  }
}

async function readRemoteProjections(symbol: string): Promise<StoredProjectionPriceLine[] | null> {
  try {
    const key = encodeURIComponent(normalizeSymbolKey(symbol));
    // Saved projection price lines are symbol-level so they intentionally sync across all chart timeframes.
    const res = await fetch(`${PROJECTION_SYNC_API_BASE}/chart/projections/${key}/shared`, { method: "GET" });
    if (!res.ok) return null;
    const data = await res.json() as { projections?: StoredProjectionPriceLine[] };
    const rows = Array.isArray(data.projections) ? data.projections : [];
    return rows.map(normalizeStoredProjection).filter((item): item is StoredProjectionPriceLine => Boolean(item));
  } catch {
    return null;
  }
}

async function writeRemoteProjections(symbol: string, projections: StoredProjectionPriceLine[]): Promise<void> {
  try {
    const key = encodeURIComponent(normalizeSymbolKey(symbol));
    await fetch(`${PROJECTION_SYNC_API_BASE}/chart/projections/${key}/shared`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projections }),
    });
  } catch {
    // Remote sync is best-effort. localStorage keeps the chart stable even if backend is offline.
  }
}

function sameStoredProjectionSet(a: StoredProjectionPriceLine[], b: StoredProjectionPriceLine[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a.map(({ id, price, title, color, lineStyle, lineWidth }) => ({ id, price, title, color, lineStyle, lineWidth }))) ===
    JSON.stringify(b.map(({ id, price, title, color, lineStyle, lineWidth }) => ({ id, price, title, color, lineStyle, lineWidth })));
}

function ChartPanelComponent({
  symbol,
  timeframe: timeframeProp,
  visibility,
  onStatsUpdate,
  trendlineAction = { type: "none" },
  trendlineSnapMode = "auto",
  onTrendlineActionHandled,
  onTrendlineStateChange,
  onRequestAddSymbolToWatchlist,
  showInChartWatchlistAdder = false,
  openOrders = [],
  onCancelOrder,
  onReplaceOrderPrice,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const projectionScaleAnchorSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const pmhSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const compressionTopSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const compressionBottomSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const projectionPriceLinesRef = useRef<any[]>([]);
  const savedProjectionPriceLinesRef = useRef<SavedProjectionPriceLine[]>([]);
  const selectedSavedProjectionIdRef = useRef<string | null>(null);
  const projectionSelectionRef = useRef<ProjectionSelection | null>(null);
  const saveProjectionLinesRef = useRef(false);
  const projectionModeRef = useRef(false);
  const activeChartFunctionIdRef = useRef<ChartFunctionId>(DEFAULT_CHART_FUNCTION_ID);

  const latestCompressionRef = useRef<CompressionZone | null>(null);
  const latestVwapSignalsRef = useRef<SignalPoint[]>([]);
  const latestSignalMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestFakeEngulfingMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestSignificantCandleMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestLiquiditySweepMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestVolumeSignalMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestTrendlineCloseMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestBodyBreakDotMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestCloseAbovePrevCloseDotMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestAtrExpansionMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestResistanceBreakoutMarkersRef = useRef<SignalMarkerPoint[]>([]);
  const latestChochMarkersRef = useRef<ChochMarkerPoint[]>([]);
  const latestLineVisibilityRef = useRef<LineVisibilityState>({
    pmh: visibility.pmh,
    vwap: visibility.vwap,
    compression: visibility.compression,
    choch: visibility.choch,
    sessionBands: visibility.sessionBands,
    projections: visibility.projections,
    trendlines: visibility.trendlines,
    fakeEngulfing: visibility.fakeEngulfing ?? true,
    significantCandles: visibility.significantCandles ?? true,
    liquiditySweeps: visibility.liquiditySweeps ?? true,
    volumeSignals: visibility.volumeSignals ?? true,
    trendlineCloseAlerts: visibility.trendlineCloseAlerts ?? true,
    bodyBreakDots: visibility.bodyBreakDots ?? true,
    closeAbovePrevCloseDots: visibility.closeAbovePrevCloseDots ?? true,
    atrExpansionCandles: visibility.atrExpansionCandles ?? true,
    resistanceBreakoutConfirm: visibility.resistanceBreakoutConfirm ?? true,
  });
  const onStatsUpdateRef = useRef(onStatsUpdate);
  const autoFitPendingRef = useRef(true);
  const lastKeyRef = useRef("");
  const hydratedTrendlineKeyRef = useRef("");
  const trendlineRemoteHydratingRef = useRef(false);
  const trendlineRemoteSaveTimerRef = useRef<number | null>(null);
  const lastRemoteTrendlineWriteRef = useRef("");
  const barsRef = useRef<Candle[]>([]);
  const tradingDateRef = useRef<string | null>(null);
  const liveStartedRef = useRef(false);
  const openOrdersRef = useRef<ChartOrder[]>(openOrders);
  const onCancelOrderRef = useRef(onCancelOrder);
  const onReplaceOrderPriceRef = useRef(onReplaceOrderPrice);
  const orderDragStateRef = useRef<OrderDragState | null>(null);
  const orderPriceOverridesRef = useRef<Record<string, number>>({});

  const applyNormalVisibleRange = useCallback((bars: Candle[]) => {
    const chart = chartRef.current;
    if (!chart || bars.length <= 0) return;

    const tf = (timeframeProp || "15m").toLowerCase().trim();
    const targetBars =
      tf === "1m" ? 160 :
      tf === "5m" ? 130 :
      tf === "15m" ? 95 :
      tf === "30m" ? 85 :
      tf === "1h" || tf === "60m" ? 75 :
      tf === "1d" || tf === "day" ? 120 :
      100;

    const rightPaddingBars = 8;
    const visibleBars = Math.min(bars.length, targetBars);
    const from = Math.max(0, bars.length - visibleBars);
    const to = bars.length - 1 + rightPaddingBars;

    chart.timeScale().applyOptions({
      rightOffset: rightPaddingBars,
      barSpacing: 8,
      minBarSpacing: 3,
    });

    chart.timeScale().setVisibleLogicalRange({ from, to });
  }, [timeframeProp]);

  const trendlineSeriesMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const trendlinesRef = useRef<Trendline[]>([]);
  const drawModeRef = useRef(false);
  const pendingTrendPointRef = useRef<PendingTrendPoint | null>(null);
  const selectedTrendlineIdRef = useRef<string | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const seenAlertKeysRef = useRef<Set<string>>(new Set());
  const alertTimeoutsRef = useRef<number[]>([]);
  const liveTapeRef = useRef<TapeSnapshot>({
    upVol: 0,
    downVol: 0,
    totalVol: 0,
    lastPrice: null,
    currentMinute: null,
  });

  const legendRef = useRef<LegendState>({
    last: null,
    pmh: null,
    vwap: null,
    tradingDate: null,
    compressionLabel: null,
    session: {
      currentSession: getCurrentEtSessionKind(),
      currentSessionLabel: getSessionLabel(getCurrentEtSessionKind()),
      premarketHigh: null,
      regularHigh: null,
      afterHoursHigh: null,
      extendedHigh: null,
    },
  });

  const [chartTimeframe, setChartTimeframe] = useState(timeframeProp || "15m");
  const timeframe = chartTimeframe;

  const [error, setError] = useState("");
  const [compressionRect, setCompressionRect] = useState<RectOverlay | null>(null);
  const [breakoutMarker, setBreakoutMarker] = useState<MarkerOverlay | null>(null);
  const [vwapMarkers, setVwapMarkers] = useState<MarkerOverlay[]>([]);
  const [signalMarkers, setSignalMarkers] = useState<MarkerOverlay[]>([]);
  const [fakeEngulfingMarkers, setFakeEngulfingMarkers] = useState<MarkerOverlay[]>([]);
  const [significantCandleMarkers, setSignificantCandleMarkers] = useState<MarkerOverlay[]>([]);
  const [liquiditySweepMarkers, setLiquiditySweepMarkers] = useState<MarkerOverlay[]>([]);
  const [volumeSignalMarkers, setVolumeSignalMarkers] = useState<MarkerOverlay[]>([]);
  const [trendlineCloseMarkers, setTrendlineCloseMarkers] = useState<MarkerOverlay[]>([]);
  const [bodyBreakDotMarkers, setBodyBreakDotMarkers] = useState<MarkerOverlay[]>([]);
  const [closeAbovePrevCloseDotMarkers, setCloseAbovePrevCloseDotMarkers] = useState<MarkerOverlay[]>([]);
  const [atrExpansionMarkers, setAtrExpansionMarkers] = useState<MarkerOverlay[]>([]);
  const [resistanceBreakoutMarkers, setResistanceBreakoutMarkers] = useState<MarkerOverlay[]>([]);
  const [trendlineHandleOverlays, setTrendlineHandleOverlays] = useState<TrendlineHandleOverlay[]>([]);
  const [trendlineFocusOverlay, setTrendlineFocusOverlay] = useState<TrendlineFocusOverlay | null>(null);
  const [orderLineOverlays, setOrderLineOverlays] = useState<OrderLineOverlay[]>([]);
  const [orderPriceOverrides, setOrderPriceOverrides] = useState<Record<string, number>>({});
  const [chochMarkers, setChochMarkers] = useState<MarkerOverlay[]>([]);
  const [expandedSignalLabelKey, setExpandedSignalLabelKey] = useState<string | null>(null);
  const [sessionBands, setSessionBands] = useState<SessionBandOverlay[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [pendingTrendPoint, setPendingTrendPoint] = useState<PendingTrendPoint | null>(null);
  const [trendlines, setTrendlines] = useState<Trendline[]>([]);
  const [selectedTrendlineId, setSelectedTrendlineId] = useState<string | null>(null);
  const [manualTrendlineScope, setManualTrendlineScope] = useState<TrendlineScope>("shared");
  const [manualTrendlineColor, setManualTrendlineColor] = useState("#00e5ff");
  const [manualTrendlineWidth, setManualTrendlineWidth] = useState(2);
  const [manualExtendLeft, setManualExtendLeft] = useState(true);
  const [manualExtendRight, setManualExtendRight] = useState(true);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [projectionMode, setProjectionMode] = useState(false);
  const [saveProjectionLines, setSaveProjectionLines] = useState(false);
  const [projectionSettingsOpen, setProjectionSettingsOpen] = useState(false);
  const [lineSettingsOpen, setLineSettingsOpen] = useState(false);
  const [lineVisibility, setLineVisibility] = useState<LineVisibilityState>({
    pmh: true,
    vwap: true,
    compression: true,
    choch: true,
    sessionBands: true,
    projections: true,
    trendlines: true,
    fakeEngulfing: true,
    significantCandles: true,
    liquiditySweeps: true,
    volumeSignals: true,
    trendlineCloseAlerts: true,
    bodyBreakDots: true,
    closeAbovePrevCloseDots: true,
    atrExpansionCandles: true,
    resistanceBreakoutConfirm: true,
  });
  const [activeChartFunctionId, setActiveChartFunctionId] = useState<ChartFunctionId>(DEFAULT_CHART_FUNCTION_ID);
  const [projectionSelection, setProjectionSelection] = useState<ProjectionSelection | null>(null);
  const [selectedSavedProjectionId, setSelectedSavedProjectionId] = useState<string | null>(null);
  const [trendlineAlerts, setTrendlineAlerts] = useState<TrendlineAlert[]>([]);
  const [symbolInput, setSymbolInput] = useState(symbol.toUpperCase());
  const [addWatchlistFeedback, setAddWatchlistFeedback] = useState("");
  const [legend, setLegend] = useState<LegendState>({
    last: null,
    pmh: null,
    vwap: null,
    tradingDate: null,
    compressionLabel: null,
    session: {
      currentSession: getCurrentEtSessionKind(),
      currentSessionLabel: getSessionLabel(getCurrentEtSessionKind()),
      premarketHigh: null,
      regularHigh: null,
      afterHoursHigh: null,
      extendedHigh: null,
    },
  });
  const [hoveredCandle, setHoveredCandle] = useState<HoveredCandleState | null>(null);
  const [controlState, setControlState] = useState<ControlState>({
    label: "NEUTRAL",
    color: "#cbd5e1",
    detail: "Δ 0% · vol 0.00x",
  });

  const effectiveLineVisibility = useMemo<LineVisibilityState>(
    () => ({
      pmh: visibility.pmh && lineVisibility.pmh,
      vwap: visibility.vwap && lineVisibility.vwap,
      compression: visibility.compression && lineVisibility.compression,
      choch: visibility.choch && lineVisibility.choch,
      sessionBands: visibility.sessionBands && lineVisibility.sessionBands,
      projections: visibility.projections && lineVisibility.projections,
      trendlines: visibility.trendlines && lineVisibility.trendlines,
      fakeEngulfing: (visibility.fakeEngulfing ?? true) && lineVisibility.fakeEngulfing,
      significantCandles: (visibility.significantCandles ?? true) && lineVisibility.significantCandles,
      liquiditySweeps: (visibility.liquiditySweeps ?? true) && lineVisibility.liquiditySweeps,
      volumeSignals: (visibility.volumeSignals ?? true) && lineVisibility.volumeSignals,
      trendlineCloseAlerts: (visibility.trendlineCloseAlerts ?? true) && lineVisibility.trendlineCloseAlerts,
      bodyBreakDots: (visibility.bodyBreakDots ?? true) && lineVisibility.bodyBreakDots,
      closeAbovePrevCloseDots: (visibility.closeAbovePrevCloseDots ?? true) && lineVisibility.closeAbovePrevCloseDots,
      atrExpansionCandles: (visibility.atrExpansionCandles ?? true) && lineVisibility.atrExpansionCandles,
      resistanceBreakoutConfirm: (visibility.resistanceBreakoutConfirm ?? true) && lineVisibility.resistanceBreakoutConfirm,
    }),
    [
      visibility.pmh,
      visibility.vwap,
      visibility.compression,
      visibility.choch,
      visibility.sessionBands,
      visibility.projections,
      visibility.trendlines,
      visibility.fakeEngulfing,
      visibility.significantCandles,
      visibility.liquiditySweeps,
      visibility.volumeSignals,
      visibility.trendlineCloseAlerts,
      visibility.bodyBreakDots,
      visibility.closeAbovePrevCloseDots,
      visibility.atrExpansionCandles,
      visibility.resistanceBreakoutConfirm,
      lineVisibility,
    ]
  );

  useEffect(() => {
    legendRef.current = legend;
  }, [legend]);

  useEffect(() => {
    latestLineVisibilityRef.current = effectiveLineVisibility;
  }, [effectiveLineVisibility]);

  useEffect(() => {
    onStatsUpdateRef.current = onStatsUpdate;
  }, [onStatsUpdate]);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    pendingTrendPointRef.current = pendingTrendPoint;
  }, [pendingTrendPoint]);

  useEffect(() => {
    selectedTrendlineIdRef.current = selectedTrendlineId;
  }, [selectedTrendlineId]);

  useEffect(() => {
    orderPriceOverridesRef.current = orderPriceOverrides;
  }, [orderPriceOverrides]);

  useEffect(() => {
    projectionModeRef.current = projectionMode;
  }, [projectionMode]);

  useEffect(() => {
    saveProjectionLinesRef.current = saveProjectionLines;
  }, [saveProjectionLines]);

  useEffect(() => {
    projectionSelectionRef.current = projectionSelection;
  }, [projectionSelection]);

  useEffect(() => {
    return () => {
      if (trendlineRemoteSaveTimerRef.current != null) {
        window.clearTimeout(trendlineRemoteSaveTimerRef.current);
        trendlineRemoteSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    selectedSavedProjectionIdRef.current = selectedSavedProjectionId;
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;
    for (const item of savedProjectionPriceLinesRef.current) {
      item.line.applyOptions?.({
        color: item.id === selectedSavedProjectionId ? "#ffffff" : item.color,
        lineWidth: (item.id === selectedSavedProjectionId ? 3 : item.lineWidth) as 1 | 2 | 3 | 4,
        title: item.id === selectedSavedProjectionId ? "SELECTED " + item.title : item.title,
      });
    }
  }, [selectedSavedProjectionId]);

  useEffect(() => {
    const selected = trendlines.find((line) => line.id === selectedTrendlineId);
    if (!selected) return;
    setManualTrendlineScope(selected.scope ?? "shared");
    setManualTrendlineColor(selected.color ?? "#00e5ff");
    setManualTrendlineWidth(selected.width ?? 2);
    setManualExtendLeft(selected.extendLeft ?? true);
    setManualExtendRight(selected.extendRight ?? true);
  }, [selectedTrendlineId, trendlines]);

  useEffect(() => {
    setSymbolInput(symbol.toUpperCase());
  }, [symbol]);

  useEffect(() => {
    if (timeframeProp && timeframeProp !== chartTimeframe) {
      setChartTimeframe(timeframeProp);
    }
  }, [timeframeProp]);

  const scheduleRemoteTrendlineSave = useCallback((targetSymbol: string, targetTimeframe: string, nextTrendlines: Trendline[]) => {
    const clean = nextTrendlines.map(normalizeStoredTrendline);
    const serialized = JSON.stringify({
      symbol: normalizeSymbolKey(targetSymbol),
      timeframe: targetTimeframe,
      trendlines: clean.map(({ id, symbol, timeframe, scope, t1, p1, t2, p2, slope, intercept, extendLeft, extendRight, color, width }) => ({
        id, symbol, timeframe, scope, t1, p1, t2, p2, slope, intercept, extendLeft, extendRight, color, width,
      })),
    });

    if (lastRemoteTrendlineWriteRef.current === serialized) return;

    if (trendlineRemoteSaveTimerRef.current != null) {
      window.clearTimeout(trendlineRemoteSaveTimerRef.current);
    }

    trendlineRemoteSaveTimerRef.current = window.setTimeout(() => {
      lastRemoteTrendlineWriteRef.current = serialized;
      void writeRemoteTrendlines(targetSymbol, targetTimeframe, clean);
    }, 350);
  }, []);

  useEffect(() => {
    trendlinesRef.current = trendlines;
    if (
      selectedTrendlineIdRef.current &&
      !trendlines.some((line) => line.id === selectedTrendlineIdRef.current)
    ) {
      setSelectedTrendlineId(null);
    }

    const key = `${symbol}|${timeframe}`;
    if (hydratedTrendlineKeyRef.current === key && !trendlineRemoteHydratingRef.current) {
      saveTrendlines(symbol, timeframe, trendlines);
      scheduleRemoteTrendlineSave(symbol, timeframe, trendlines);
    }

    onTrendlineStateChange?.({
      drawMode,
      pendingPoint: pendingTrendPoint !== null,
      count: trendlines.length,
    });
  }, [symbol, timeframe, trendlines, drawMode, pendingTrendPoint, onTrendlineStateChange, scheduleRemoteTrendlineSave]);

  useEffect(() => {
    const key = `${symbol}|${timeframe}`;
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      hydratedTrendlineKeyRef.current = key;
      autoFitPendingRef.current = true;
      liveStartedRef.current = false;
      seenAlertKeysRef.current = new Set();
      const candleSeries = candleSeriesRef.current;
      if (candleSeries) {
        for (const line of projectionPriceLinesRef.current) {
          candleSeries.removePriceLine(line);
        }
        for (const item of savedProjectionPriceLinesRef.current) {
          candleSeries.removePriceLine(item.line);
        }
      }
      projectionPriceLinesRef.current = [];
      savedProjectionPriceLinesRef.current = [];
      selectedSavedProjectionIdRef.current = null;
      setSelectedSavedProjectionId(null);
      projectionSelectionRef.current = null;
      setDrawMode(false);
      setProjectionMode(false);
      setProjectionSelection(null);
      setPendingTrendPoint(null);
      setSelectedTrendlineId(null);
      dragStateRef.current = null;
      setTrendlineAlerts([]);
      const loadedTrendlines = loadTrendlines(symbol, timeframe);
      trendlineRemoteHydratingRef.current = true;
      hydratedTrendlineKeyRef.current = "";
      trendlinesRef.current = loadedTrendlines;
      setTrendlines(loadedTrendlines);

      void readRemoteTrendlines(symbol, timeframe).then((remoteTrendlines) => {
        if (lastKeyRef.current !== key) return;
        const mergedTrendlines = remoteTrendlines
          ? mergeTrendlineSets(loadedTrendlines, remoteTrendlines)
          : loadedTrendlines;
        saveTrendlines(symbol, timeframe, mergedTrendlines);
        trendlinesRef.current = mergedTrendlines;
        setTrendlines((prev) => sameTrendlineSet(prev, mergedTrendlines) ? prev : mergedTrendlines);
      }).finally(() => {
        if (lastKeyRef.current !== key) return;
        hydratedTrendlineKeyRef.current = key;
        trendlineRemoteHydratingRef.current = false;
        window.requestAnimationFrame(() => {
          syncTrendlineSeries();
          updateOverlayPositions();
        });
      });

      latestSignalMarkersRef.current = [];
      latestChochMarkersRef.current = [];
      resetTapeSnapshot(liveTapeRef.current);
      setSignalMarkers([]);
      setTrendlineCloseMarkers([]);
      setBodyBreakDotMarkers([]);
      setCloseAbovePrevCloseDotMarkers([]);
      setChochMarkers([]);
      setLiquiditySweepMarkers([]);
      setControlState({
        label: "NEUTRAL",
        color: "#cbd5e1",
        detail: "Δ 0% · vol 0.00x",
      });
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    const reloadFromStorage = () => {
      const key = `${symbol}|${timeframe}`;
      const loadedTrendlines = loadTrendlines(symbol, timeframe);
      trendlineRemoteHydratingRef.current = true;
      void readRemoteTrendlines(symbol, timeframe).then((remoteTrendlines) => {
        if (`${symbol}|${timeframe}` !== key) return;
        const mergedTrendlines = remoteTrendlines
          ? mergeTrendlineSets(loadedTrendlines, remoteTrendlines)
          : loadedTrendlines;
        saveTrendlines(symbol, timeframe, mergedTrendlines);
        hydratedTrendlineKeyRef.current = key;
        trendlinesRef.current = mergedTrendlines;
        setTrendlines((prev) => sameTrendlineSet(prev, mergedTrendlines) ? prev : mergedTrendlines);
      }).finally(() => {
        if (`${symbol}|${timeframe}` !== key) return;
        trendlineRemoteHydratingRef.current = false;
        window.requestAnimationFrame(() => {
          syncTrendlineSeries();
          updateOverlayPositions();
        });
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        reloadFromStorage();
      }
    };

    window.addEventListener("focus", reloadFromStorage);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", reloadFromStorage);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    if (!addWatchlistFeedback) return;
    const id = window.setTimeout(() => setAddWatchlistFeedback(""), 1800);
    return () => window.clearTimeout(id);
  }, [addWatchlistFeedback]);

  const pushTrendlineAlert = useCallback(
    (trendlineId: string, kind: TrendlineAlertKind, message: string) => {
      const alertId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const nextAlert: TrendlineAlert = {
        id: alertId,
        trendlineId,
        kind,
        message,
        createdAt: Date.now(),
      };

      setTrendlineAlerts((prev) => [nextAlert, ...prev].slice(0, 8));

      const timeoutId = window.setTimeout(() => {
        setTrendlineAlerts((prev) => prev.filter((item) => item.id !== alertId));
      }, 5500);

      alertTimeoutsRef.current.push(timeoutId);
    },
    []
  );

  const clearProjectionSelection = useCallback(() => {
    const candleSeries = candleSeriesRef.current;
    if (candleSeries) {
      for (const line of projectionPriceLinesRef.current) {
        candleSeries.removePriceLine(line);
      }
    }
    projectionPriceLinesRef.current = [];
    projectionScaleAnchorSeriesRef.current?.setData([]);
    projectionSelectionRef.current = null;
    setProjectionSelection(null);
  }, []);

  const getStoredSavedProjectionLines = useCallback((): StoredProjectionPriceLine[] => {
    return savedProjectionPriceLinesRef.current.map((item) => ({
      id: item.id,
      price: item.price,
      title: item.title,
      color: item.color,
      lineStyle: item.lineStyle,
      lineWidth: item.lineWidth,
      createdAt: Number.isFinite(Number((item as any).createdAt)) ? Number((item as any).createdAt) : Date.now(),
    }));
  }, []);

  const persistSavedProjectionLines = useCallback((symbolOverride?: string) => {
    const targetSymbol = normalizeSymbolKey(symbolOverride || symbol);
    const stored = getStoredSavedProjectionLines();
    writeLocalProjections(targetSymbol, stored);
    void writeRemoteProjections(targetSymbol, stored);
  }, [getStoredSavedProjectionLines, symbol]);

  const refreshProjectionScaleAnchor = useCallback(() => {
    const anchorBars = barsRef.current;
    const savedPrices = savedProjectionPriceLinesRef.current
      .map((item) => item.price)
      .filter((price) => Number.isFinite(price) && price > 0);
    const activePrices = projectionSelectionRef.current?.levels
      ?.map((level) => level.price)
      .filter((price) => Number.isFinite(price) && price > 0) ?? [];
    const prices = [...savedPrices, ...activePrices];

    if (!anchorBars.length || !prices.length) {
      projectionScaleAnchorSeriesRef.current?.setData([]);
      return;
    }

    const firstTime = toChartTime(anchorBars[0].time);
    const lastTime = toChartTime(anchorBars[anchorBars.length - 1].time);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    projectionScaleAnchorSeriesRef.current?.setData(
      firstTime === lastTime
        ? [{ time: firstTime, value: minPrice }]
        : [
            { time: firstTime, value: minPrice },
            { time: lastTime, value: maxPrice },
          ]
    );
  }, []);

  const replaceSavedProjectionLines = useCallback((storedRows: StoredProjectionPriceLine[]) => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    for (const item of savedProjectionPriceLinesRef.current) {
      try {
        candleSeries.removePriceLine(item.line);
      } catch {
        // already removed
      }
    }

    const normalizedRows = storedRows
      .map(normalizeStoredProjection)
      .filter((item): item is StoredProjectionPriceLine => Boolean(item))
      .sort((a, b) => a.createdAt - b.createdAt);

    savedProjectionPriceLinesRef.current = normalizedRows.map((item) => {
      const selected = selectedSavedProjectionIdRef.current === item.id;
      const line = candleSeries.createPriceLine({
        price: item.price,
        color: selected ? "#ffffff" : item.color,
        lineStyle: item.lineStyle,
        lineWidth: (selected ? 3 : item.lineWidth) as 1 | 2 | 3 | 4,
        axisLabelVisible: true,
        title: selected ? "SELECTED " + item.title : item.title,
      });

      return {
        id: item.id,
        line,
        price: item.price,
        title: item.title,
        color: item.color,
        lineStyle: item.lineStyle,
        lineWidth: item.lineWidth,
      };
    });

    if (
      selectedSavedProjectionIdRef.current &&
      !savedProjectionPriceLinesRef.current.some((item) => item.id === selectedSavedProjectionIdRef.current)
    ) {
      selectedSavedProjectionIdRef.current = null;
      setSelectedSavedProjectionId(null);
    }

    refreshProjectionScaleAnchor();
  }, [refreshProjectionScaleAnchor]);

  const loadSavedProjectionLinesFromPersistence = useCallback(async () => {
    const targetSymbol = normalizeSymbolKey(symbol);
    if (!targetSymbol || !candleSeriesRef.current) return;

    const localRows = readLocalProjections(targetSymbol);
    replaceSavedProjectionLines(localRows);

    const remoteRows = await readRemoteProjections(targetSymbol);
    if (!remoteRows) return;

    const currentRows = getStoredSavedProjectionLines();
    if (!sameStoredProjectionSet(currentRows, remoteRows)) {
      writeLocalProjections(targetSymbol, remoteRows);
      replaceSavedProjectionLines(remoteRows);
    }
  }, [getStoredSavedProjectionLines, replaceSavedProjectionLines, symbol]);

  useEffect(() => {
    const reloadSavedProjections = () => {
      void loadSavedProjectionLinesFromPersistence();
    };

    window.addEventListener("focus", reloadSavedProjections);
    document.addEventListener("visibilitychange", reloadSavedProjections);

    return () => {
      window.removeEventListener("focus", reloadSavedProjections);
      document.removeEventListener("visibilitychange", reloadSavedProjections);
    };
  }, [loadSavedProjectionLinesFromPersistence]);

  useEffect(() => {
    activeChartFunctionIdRef.current = activeChartFunctionId;
    if (activeChartFunctionId === "none") {
      projectionModeRef.current = false;
      setProjectionMode(false);
      clearProjectionSelection();
    }
  }, [activeChartFunctionId, clearProjectionSelection]);

  useEffect(() => {
    if (!effectiveLineVisibility.projections) {
      projectionModeRef.current = false;
      setProjectionMode(false);
      clearProjectionSelection();
    }
  }, [effectiveLineVisibility.projections, clearProjectionSelection]);

  useEffect(() => {
    if (!effectiveLineVisibility.trendlines) {
      setSelectedTrendlineId(null);
    }
  }, [effectiveLineVisibility.trendlines]);

  const drawProjectionSelection = useCallback((selection: ProjectionSelection | null) => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    for (const line of projectionPriceLinesRef.current) {
      candleSeries.removePriceLine(line);
    }
    projectionPriceLinesRef.current = [];

    if (!selection) {
      projectionScaleAnchorSeriesRef.current?.setData([]);
      projectionSelectionRef.current = null;
      setProjectionSelection(null);
      return;
    }

    const bars = barsRef.current;
    const visiblePrices = bars.flatMap((bar) => [bar.low, bar.high]).filter(Number.isFinite);
    const visibleLow = visiblePrices.length ? Math.min(...visiblePrices) : null;
    const visibleHigh = visiblePrices.length ? Math.max(...visiblePrices) : null;
    const range =
      visibleLow != null && visibleHigh != null && Number.isFinite(visibleHigh - visibleLow)
        ? Math.max(visibleHigh - visibleLow, Math.max(Math.abs(selection.fullRange), 0.01))
        : Math.max(Math.abs(selection.fullRange), 0.01);
    const clampMin = visibleLow != null ? visibleLow - range * 2 : Number.NEGATIVE_INFINITY;
    const clampMax = visibleHigh != null ? visibleHigh + range * 2 : Number.POSITIVE_INFINITY;

    const nextLevels = selection.levels
      .map((level) => ({
        ...level,
        price: Math.min(clampMax, Math.max(clampMin, level.price)),
      }))
      .filter((level) => Number.isFinite(level.price));

    const createdPriceLines: any[] = [];
    const createdSavedPriceLines: SavedProjectionPriceLine[] = [];
    for (const level of nextLevels) {
      const savedTitle = "SAVED " + level.title;
      const displayTitle = saveProjectionLinesRef.current ? savedTitle : level.title;
      const priceLine = candleSeries.createPriceLine({
        price: level.price,
        color: level.color,
        lineStyle: level.lineStyle,
        lineWidth: (level.lineWidth ?? 1) as 1 | 2 | 3 | 4,
        axisLabelVisible: true,
        title: displayTitle,
      });
      createdPriceLines.push(priceLine);
      if (saveProjectionLinesRef.current) {
        createdSavedPriceLines.push({
          id: "saved-projection-" + selection.candleTime + "-" + level.id + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          line: priceLine,
          price: level.price,
          title: savedTitle,
          color: level.color,
          lineStyle: level.lineStyle,
          lineWidth: level.lineWidth ?? 1,
          createdAt: Date.now(),
        });
      }
    }

    const nextSelection: ProjectionSelection = {
      ...selection,
      levels: nextLevels,
    };

    if (saveProjectionLinesRef.current) {
      savedProjectionPriceLinesRef.current.push(...createdSavedPriceLines);
      persistSavedProjectionLines();
      refreshProjectionScaleAnchor();
      projectionSelectionRef.current = null;
      setSelectedSavedProjectionId(createdSavedPriceLines[createdSavedPriceLines.length - 1]?.id ?? null);
    } else {
      projectionPriceLinesRef.current = createdPriceLines;
      projectionSelectionRef.current = nextSelection;
    }

    const anchorBars = barsRef.current;
    const finiteProjectionPrices = nextLevels
      .map((level) => level.price)
      .filter((price) => Number.isFinite(price) && price > 0);

    if (anchorBars.length && finiteProjectionPrices.length) {
      const firstTime = toChartTime(anchorBars[0].time);
      const lastTime = toChartTime(anchorBars[anchorBars.length - 1].time);
      const minProjectionPrice = Math.min(...finiteProjectionPrices);
      const maxProjectionPrice = Math.max(...finiteProjectionPrices);
      const anchorData: { time: UTCTimestamp; value: number }[] =
        lastTime === firstTime
          ? [{ time: firstTime, value: minProjectionPrice }]
          : [
              { time: firstTime, value: minProjectionPrice },
              { time: lastTime, value: maxProjectionPrice },
            ];

      projectionScaleAnchorSeriesRef.current?.setData(anchorData);
    } else {
      projectionScaleAnchorSeriesRef.current?.setData([]);
    }

    setProjectionSelection(nextSelection);

    const currentBars = barsRef.current;
    if (currentBars.length) {
      const atrValues = computeRollingAtrValues(currentBars, 14);
      const atrBreakoutSignals = computeAtrExpansionAndResistanceBreakoutSignals(
        currentBars,
        atrValues,
        saveProjectionLinesRef.current ? null : nextSelection
      );
      latestAtrExpansionMarkersRef.current = atrBreakoutSignals.expansionDots;
      latestResistanceBreakoutMarkersRef.current = atrBreakoutSignals.breakoutConfirmations;
    }
  }, [persistSavedProjectionLines, refreshProjectionScaleAnchor]);

  const clearSavedProjectionLines = useCallback(() => {
    const candleSeries = candleSeriesRef.current;
    if (candleSeries) {
      for (const item of savedProjectionPriceLinesRef.current) {
          candleSeries.removePriceLine(item.line);
        }
    }
    savedProjectionPriceLinesRef.current = [];
    selectedSavedProjectionIdRef.current = null;
    setSelectedSavedProjectionId(null);
    persistSavedProjectionLines();
    refreshProjectionScaleAnchor();
  }, [persistSavedProjectionLines, refreshProjectionScaleAnchor]);

  const refreshProjectionFromLatestBar = useCallback((bars: Candle[]) => {
    const selection = projectionSelectionRef.current;
    if (!selection || !latestLineVisibilityRef.current.projections) return;
    if (selection.anchorClose == null) return;
    const latestBar = bars[bars.length - 1];
    if (!latestBar) return;

    const latestTime = toChartTime(latestBar.time);
    if (latestTime === selection.candleTime) return;

    if (latestBar.close < selection.anchorClose) {
      drawProjectionSelection(buildAnchorRangeProjectionSelection(latestBar));
    }
  }, [drawProjectionSelection]);

  const submitWatchlistAdd = useCallback(() => {
    const next = symbolInput.trim().toUpperCase();
    if (!next) {
      setAddWatchlistFeedback("Enter symbol");
      return;
    }

    if (!/^[A-Z.\-]{1,10}$/.test(next)) {
      setAddWatchlistFeedback("Invalid symbol");
      return;
    }

    if (!onRequestAddSymbolToWatchlist) {
      setAddWatchlistFeedback("Hook up callback");
      return;
    }

    onRequestAddSymbolToWatchlist(next);
    setAddWatchlistFeedback(`Added ${next}`);
  }, [symbolInput, onRequestAddSymbolToWatchlist]);

  const getEditableTrendlineId = useCallback(() => {
    const selectedId = selectedTrendlineIdRef.current;
    if (selectedId) {
      const selected = trendlinesRef.current.find(
        (line) => line.id === selectedId
      );
      if (selected) return selected.id;
    }

    const manualLines = trendlinesRef.current;
    return manualLines.length ? manualLines[manualLines.length - 1].id : null;
  }, []);

  const applySelectedTrendlinePatch = useCallback(
    (patch: Partial<Trendline>) => {
      const targetId = getEditableTrendlineId();
      if (!targetId) return false;

      setSelectedTrendlineId(targetId);
      setTrendlines((prev) =>
        prev.map((line) => {
          if (line.id !== targetId) return line;
          return normalizeStoredTrendline({ ...line, ...patch });
        })
      );
      return true;
    },
    [getEditableTrendlineId]
  );

  const deleteSelectedOrLastTrendline = useCallback(() => {
    const targetId = getEditableTrendlineId();
    if (!targetId) return;

    setTrendlines((prev) => prev.filter((line) => line.id !== targetId));
    if (selectedTrendlineIdRef.current === targetId) {
      setSelectedTrendlineId(null);
    }
    setPendingTrendPoint(null);
    setDrawMode(false);
  }, [getEditableTrendlineId]);

  const clearManualTrendlines = useCallback(() => {
    setTrendlines([]);
    setSelectedTrendlineId(null);
    setPendingTrendPoint(null);
    setDrawMode(false);
  }, []);

  const handleManualScopeChange = useCallback(
    (scope: TrendlineScope) => {
      setManualTrendlineScope(scope);
      applySelectedTrendlinePatch({ scope });
    },
    [applySelectedTrendlinePatch]
  );

  const handleManualColorChange = useCallback(
    (color: string) => {
      setManualTrendlineColor(color);
      applySelectedTrendlinePatch({ color });
    },
    [applySelectedTrendlinePatch]
  );

  const handleManualWidthChange = useCallback(
    (width: number) => {
      const safeWidth = Math.max(1, Math.min(5, Math.round(width)));
      setManualTrendlineWidth(safeWidth);
      applySelectedTrendlinePatch({ width: safeWidth });
    },
    [applySelectedTrendlinePatch]
  );

  const handleManualExtendLeftChange = useCallback(
    (extendLeft: boolean) => {
      setManualExtendLeft(extendLeft);
      applySelectedTrendlinePatch({ extendLeft });
    },
    [applySelectedTrendlinePatch]
  );

  const handleManualExtendRightChange = useCallback(
    (extendRight: boolean) => {
      setManualExtendRight(extendRight);
      applySelectedTrendlinePatch({ extendRight });
    },
    [applySelectedTrendlinePatch]
  );

  useEffect(() => {
    if (trendlineAction.type === "none") return;

    if (trendlineAction.type === "toggle_draw") {
      setDrawMode((prev) => !prev);
      setPendingTrendPoint(null);
    } else if (trendlineAction.type === "cancel_draw") {
      setDrawMode(false);
      setPendingTrendPoint(null);
    } else if (trendlineAction.type === "delete_last") {
      deleteSelectedOrLastTrendline();
    } else if (trendlineAction.type === "clear_all") {
      clearManualTrendlines();
    }

    onTrendlineActionHandled?.();
  }, [trendlineAction, onTrendlineActionHandled, deleteSelectedOrLastTrendline, clearManualTrendlines]);

  const getNearestSavedProjectionInteraction = useCallback((clickedPrice: number) => {
    const saved = savedProjectionPriceLinesRef.current;
    if (!saved.length || !Number.isFinite(clickedPrice)) return null;

    const bars = barsRef.current;
    const prices = bars.flatMap((bar) => [bar.high, bar.low]).filter(Number.isFinite);
    const visibleHigh = prices.length ? Math.max(...prices) : clickedPrice;
    const visibleLow = prices.length ? Math.min(...prices) : clickedPrice;
    const chartRange = Math.max(Math.abs(visibleHigh - visibleLow), 0.01);
    const tolerance = Math.max(chartRange * 0.015, clickedPrice * 0.003, 0.002);

    let best: SavedProjectionPriceLine | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of saved) {
      const distance = Math.abs(item.price - clickedPrice);
      if (distance <= tolerance && distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }

    return best;
  }, []);

  const deleteSelectedSavedProjection = useCallback(() => {
    const selectedId = selectedSavedProjectionIdRef.current;
    if (!selectedId) return false;
    const candleSeries = candleSeriesRef.current;
    const selected = savedProjectionPriceLinesRef.current.find((item) => item.id === selectedId);
    if (!selected) {
      selectedSavedProjectionIdRef.current = null;
      setSelectedSavedProjectionId(null);
      return false;
    }

    if (candleSeries) {
      candleSeries.removePriceLine(selected.line);
    }
    savedProjectionPriceLinesRef.current = savedProjectionPriceLinesRef.current.filter((item) => item.id !== selectedId);
    selectedSavedProjectionIdRef.current = null;
    setSelectedSavedProjectionId(null);
    persistSavedProjectionLines();
    refreshProjectionScaleAnchor();
    return true;
  }, [persistSavedProjectionLines, refreshProjectionScaleAnchor]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dragStateRef.current = null;
        setPendingTrendPoint(null);
        setDrawMode(false);
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (deleteSelectedSavedProjection()) return;
        deleteSelectedOrLastTrendline();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelectedOrLastTrendline, deleteSelectedSavedProjection]);


  const syncTrendlineSeries = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const bars = barsRef.current;
    const existing = trendlineSeriesMapRef.current;
    const visibleTrendlines = latestLineVisibilityRef.current.trendlines ? trendlinesRef.current : [];
    const activeIds = new Set(visibleTrendlines.map((line) => line.id));

    for (const [id, series] of existing.entries()) {
      if (!activeIds.has(id)) {
        chart.removeSeries(series);
        existing.delete(id);
      }
    }

    for (const line of visibleTrendlines) {
      let series = existing.get(line.id);

      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: line.color ?? "#00e5ff",
          lineWidth: (line.width ?? 2) as 1 | 2 | 3 | 4,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          autoscaleInfoProvider: () => null,
        });

        series.applyOptions({ autoscaleInfoProvider: () => null });
        existing.set(line.id, series);
      }

      const isSelected = selectedTrendlineIdRef.current === line.id;
      series.applyOptions({
        color: isSelected ? "#ffffff" : line.color ?? "#00e5ff",
        lineWidth: (isSelected ? 4 : (line.width ?? 2)) as 1 | 2 | 3 | 4,
        autoscaleInfoProvider: () => null,
      });

      const visibleBars =
        bars.length > 0
          ? bars
          : [
              {
                time: line.t1 * 1000,
                open: line.p1,
                high: line.p1,
                low: line.p1,
                close: line.p1,
                volume: 0,
              },
              {
                time: line.t2 * 1000,
                open: line.p2,
                high: line.p2,
                low: line.p2,
                close: line.p2,
                volume: 0,
              },
            ];

      const i1 = findClosestBarIndexByChartTime(visibleBars, line.t1);
      const i2 = findClosestBarIndexByChartTime(visibleBars, line.t2);
      const leftIndex = Math.min(i1, i2);
      const rightIndex = Math.max(i1, i2);
      const anchorSpan = Math.max(rightIndex - leftIndex, 1);
      const leftPadding = line.extendLeft ? Math.max(anchorSpan * 3, 40) : 0;
      const rightPadding = line.extendRight ? Math.max(anchorSpan * 3, 40) : 0;
      const startIndex = Math.max(0, leftIndex - leftPadding);
      const endIndex = Math.min(visibleBars.length - 1, rightIndex + rightPadding);

      const data: { time: UTCTimestamp; value: number }[] = [];

      for (let idx = startIndex; idx <= endIndex; idx++) {
        if (!line.extendLeft && idx < leftIndex) continue;
        if (!line.extendRight && idx > rightIndex) continue;

        data.push({
          time: toChartTime(visibleBars[idx].time),
          value: getTrendlinePriceAtBarIndex(line, visibleBars, idx),
        });
      }

      if (!data.length) {
        data.push(
          {
            time: line.t1,
            value: line.p1,
          },
          {
            time: line.t2,
            value: line.p2,
          }
        );
      }

      const dedupedData = data
        .sort((a, b) => a.time - b.time)
        .filter((point, index, arr) => index === 0 || point.time !== arr[index - 1].time);

      series.setData(dedupedData);
      // Keep trendlines from changing candle price scale after draw/edit/color changes.
      series.applyOptions({ autoscaleInfoProvider: () => null });
    }
  }, []);

  const evaluateTrendlineAlerts = useCallback(
    (bars: Candle[]) => {
      const lines = latestLineVisibilityRef.current.trendlines ? trendlinesRef.current : [];
      const vwapValues = calcVWAP(bars);
      setControlState(computeControlState(bars, liveTapeRef.current, vwapValues));

      if (!lines.length || bars.length < 2) {
        latestTrendlineCloseMarkersRef.current = [];
        setTrendlineCloseMarkers([]);
        return;
      }

      const latestBar = bars[bars.length - 1];
      const latestBarTime = toChartTime(latestBar.time);
      const signalMarkerMap = new Map<string, SignalMarkerPoint>(
        latestSignalMarkersRef.current.map((marker, index) => [`${marker.label}-${marker.time}-${index}`, marker])
      );
      const trendlineCloseMarkerMap = new Map<string, SignalMarkerPoint>();

      for (const line of lines) {
        // Use bar-index math so alert checks match the drawn trendline exactly.
        const currentExpected = getTrendlinePriceAtBarIndex(line, bars, bars.length - 1);

        if (Number.isFinite(currentExpected) && currentExpected > 0) {
          const nearTolerance = getDynamicNearTolerance(currentExpected, bars);
          const nearestDistance = Math.min(
            Math.abs(latestBar.close - currentExpected),
            Math.abs(latestBar.high - currentExpected),
            Math.abs(latestBar.low - currentExpected)
          );
          const distancePct = (nearestDistance / currentExpected) * 100;
          const nearKey = `${line.id}|near|${latestBarTime}`;

          if (nearestDistance <= nearTolerance && !seenAlertKeysRef.current.has(nearKey)) {
            seenAlertKeysRef.current.add(nearKey);
            pushTrendlineAlert(
              line.id,
              "near",
              `${symbol.toUpperCase()} near resistance (${distancePct.toFixed(2)}%)`
            );
          }
        }

        const preBreak = computePreBreakSignal(bars, line, vwapValues);
        if (preBreak) {
          const preKey = `${line.id}|pre|${preBreak.side}|${latestBarTime}`;

          if (!seenAlertKeysRef.current.has(preKey)) {
            seenAlertKeysRef.current.add(preKey);

            if (preBreak.side === "bull") {
              pushTrendlineAlert(
                line.id,
                "prebreak_bull",
                `${symbol.toUpperCase()} pre-break ↑ score ${preBreak.score} · vol ${preBreak.volumeRatio.toFixed(2)}x · touches ${preBreak.touchCount}`
              );
            } else {
              pushTrendlineAlert(
                line.id,
                "prebreak_bear",
                `${symbol.toUpperCase()} pre-break ↓ score ${preBreak.score} · vol ${preBreak.volumeRatio.toFixed(2)}x · touches ${preBreak.touchCount}`
              );
            }
          }
        }

        const absorption = detectBullishAbsorption(
          bars,
          line,
          liveTapeRef.current,
          vwapValues
        );
        if (absorption) {
          const key = `${line.id}|absorption_bull|${latestBarTime}`;
          signalMarkerMap.set(key, {
            time: absorption.markerTime,
            price: absorption.markerPrice,
            label: absorption.markerLabel,
            color: absorption.markerColor,
            direction: absorption.markerDirection,
          });

          if (!seenAlertKeysRef.current.has(key)) {
            seenAlertKeysRef.current.add(key);
            pushTrendlineAlert(
              line.id,
              "absorption_bull",
              `${symbol.toUpperCase()} ${absorption.message}`
            );
          }
        }

        const aggressiveBuyers = detectAggressiveBuyers(
          bars,
          line,
          liveTapeRef.current,
          vwapValues
        );
        if (aggressiveBuyers) {
          const key = `${line.id}|aggressive_buyers|${latestBarTime}`;
          signalMarkerMap.set(key, {
            time: aggressiveBuyers.markerTime,
            price: aggressiveBuyers.markerPrice,
            label: aggressiveBuyers.markerLabel,
            color: aggressiveBuyers.markerColor,
            direction: aggressiveBuyers.markerDirection,
          });

          if (!seenAlertKeysRef.current.has(key)) {
            seenAlertKeysRef.current.add(key);
            pushTrendlineAlert(
              line.id,
              "aggressive_buyers",
              `${symbol.toUpperCase()} ${aggressiveBuyers.message}`
            );
          }
        }

        const failedBreakdown = detectFailedBreakdown(
          bars,
          line,
          liveTapeRef.current,
          vwapValues
        );
        if (failedBreakdown) {
          const key = `${line.id}|failed_breakdown|${latestBarTime}`;
          signalMarkerMap.set(key, {
            time: failedBreakdown.markerTime,
            price: failedBreakdown.markerPrice,
            label: failedBreakdown.markerLabel,
            color: failedBreakdown.markerColor,
            direction: failedBreakdown.markerDirection,
          });

          if (!seenAlertKeysRef.current.has(key)) {
            seenAlertKeysRef.current.add(key);
            pushTrendlineAlert(
              line.id,
              "failed_breakdown",
              `${symbol.toUpperCase()} ${failedBreakdown.message}`
            );
          }
        }

        // Study labels for every candle close crossing the trendline.
        // These are chart labels, not just popup alerts.
        if (latestLineVisibilityRef.current.trendlineCloseAlerts) {
          for (let i = 1; i < bars.length; i += 1) {
            const prevBar = bars[i - 1];
            const currBar = bars[i];
            const prevCrossTime = toChartTime(prevBar.time);
            const currCrossTime = toChartTime(currBar.time);
            // Use the same bar-index trendline math that draws the line.
            // This keeps TL Close markers snapped to the actual candle that crossed,
            // including premarket/after-hours bars where time gaps can distort timestamp math.
            const prevLinePrice = getTrendlinePriceAtBarIndex(line, bars, i - 1);
            const currLinePrice = getTrendlinePriceAtBarIndex(line, bars, i);

            if (
              !Number.isFinite(prevLinePrice) ||
              !Number.isFinite(currLinePrice) ||
              prevLinePrice <= 0 ||
              currLinePrice <= 0
            ) {
              continue;
            }

            const prevCloseDiff = prevBar.close - prevLinePrice;
            const currCloseDiff = currBar.close - currLinePrice;

            if (prevCloseDiff <= 0 && currCloseDiff > 0) {
              trendlineCloseMarkerMap.set(`${line.id}|tl-close-up|${currCrossTime}`, {
                time: currCrossTime,
                price: currBar.low,
                label: "TL Close ↑",
                color: "#22d3ee",
                direction: "up",
              });
            }

            if (prevCloseDiff >= 0 && currCloseDiff < 0) {
              trendlineCloseMarkerMap.set(`${line.id}|tl-close-down|${currCrossTime}`, {
                time: currCrossTime,
                price: currBar.high,
                label: "TL Close ↓",
                color: "#fb7185",
                direction: "down",
              });
            }
          }
        }

        let prevSignalIndex: number;
        let currSignalIndex: number;

        if (timeframe === "1m" && liveStartedRef.current && bars.length >= 3) {
          prevSignalIndex = bars.length - 3;
          currSignalIndex = bars.length - 2;
        } else {
          prevSignalIndex = bars.length - 2;
          currSignalIndex = bars.length - 1;
        }

        const prevSignalBar = bars[prevSignalIndex];
        const currSignalBar = bars[currSignalIndex];
        const prevTime = toChartTime(prevSignalBar.time);
        const currTime = toChartTime(currSignalBar.time);
        // Use the same bar-index math that draws the trendline so popup alerts
        // and candle labels trigger on the same candle.
        const prevExpected = getTrendlinePriceAtBarIndex(line, bars, prevSignalIndex);
        const currExpected = getTrendlinePriceAtBarIndex(line, bars, currSignalIndex);

        if (
          !Number.isFinite(prevExpected) ||
          !Number.isFinite(currExpected) ||
          prevExpected <= 0 ||
          currExpected <= 0
        ) {
          continue;
        }

        const prevDiff = prevSignalBar.close - prevExpected;
        const currDiff = currSignalBar.close - currExpected;

        const crossUpKey = `${line.id}|cross_up|${currTime}`;
        const crossDownKey = `${line.id}|cross_down|${currTime}`;

        if (
          prevDiff <= 0 &&
          currDiff > 0 &&
          !seenAlertKeysRef.current.has(crossUpKey)
        ) {
          seenAlertKeysRef.current.add(crossUpKey);
          pushTrendlineAlert(
            line.id,
            "cross_up",
            `${symbol.toUpperCase()} closed above resistance`
          );
        }

        if (
          prevDiff >= 0 &&
          currDiff < 0 &&
          !seenAlertKeysRef.current.has(crossDownKey)
        ) {
          seenAlertKeysRef.current.add(crossDownKey);
          pushTrendlineAlert(
            line.id,
            "cross_down",
            `${symbol.toUpperCase()} failed back below resistance`
          );
        }
      }

      latestSignalMarkersRef.current = Array.from(signalMarkerMap.values()).slice(-24);
      latestTrendlineCloseMarkersRef.current = Array.from(trendlineCloseMarkerMap.values()).slice(-80);
    },
    [pushTrendlineAlert, symbol, timeframe]
  );

  const updateOverlayPositions = useCallback(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const compression = latestCompressionRef.current;

    if (!chart || !candleSeries) {
      setCompressionRect(null);
      setBreakoutMarker(null);
      setVwapMarkers([]);
      setSignalMarkers([]);
      setChochMarkers([]);
      setLiquiditySweepMarkers([]);
      setTrendlineHandleOverlays([]);
      setTrendlineFocusOverlay(null);
      setOrderLineOverlays([]);
      setSessionBands([]);
      return;
    }

    const timeScale = chart.timeScale();

    const nextSessionBands: SessionBandOverlay[] = [];
    for (const band of computeSessionBandRanges(barsRef.current, tradingDateRef.current)) {
      const leftX = timeScale.timeToCoordinate(band.startTime as Time);
      const rightX = timeScale.timeToCoordinate(band.endTime as Time);

      if (
        leftX == null ||
        rightX == null ||
        !Number.isFinite(leftX) ||
        !Number.isFinite(rightX)
      ) {
        continue;
      }

      nextSessionBands.push({
        ...band,
        left: Math.min(leftX, rightX),
        width: Math.max(Math.abs(rightX - leftX), 2),
      });
    }
    setSessionBands(nextSessionBands);

    if (latestLineVisibilityRef.current.compression && compression) {
      const leftX = timeScale.timeToCoordinate(compression.startTime as Time);
      const rightX = timeScale.timeToCoordinate(compression.endTime as Time);
      const topY = candleSeries.priceToCoordinate(compression.top);
      const bottomY = candleSeries.priceToCoordinate(compression.bottom);

      if (
        leftX != null &&
        rightX != null &&
        topY != null &&
        bottomY != null &&
        Number.isFinite(leftX) &&
        Number.isFinite(rightX) &&
        Number.isFinite(topY) &&
        Number.isFinite(bottomY)
      ) {
        const left = Math.min(leftX, rightX);
        const width = Math.max(Math.abs(rightX - leftX), 2);
        const top = Math.min(topY, bottomY);
        const height = Math.max(Math.abs(bottomY - topY), 2);

        setCompressionRect({
          left,
          width,
          top,
          height,
          label: compression.label,
          direction: compression.direction,
        });
      } else {
        setCompressionRect(null);
      }

      if (
        compression.breakoutTime != null &&
        compression.breakoutPrice != null &&
        compression.breakoutLabel
      ) {
        const breakoutX = timeScale.timeToCoordinate(compression.breakoutTime as Time);
        const breakoutY = candleSeries.priceToCoordinate(compression.breakoutPrice);

        if (
          breakoutX != null &&
          breakoutY != null &&
          Number.isFinite(breakoutX) &&
          Number.isFinite(breakoutY)
        ) {
          setBreakoutMarker({
            left: breakoutX,
            top: breakoutY,
            label: compression.breakoutLabel,
            color: compression.direction === "bull" ? "#22c55e" : "#ef4444",
            direction: compression.direction === "bull" ? "up" : "down",
          });
        } else {
          setBreakoutMarker(null);
        }
      } else {
        setBreakoutMarker(null);
      }
    } else {
      setCompressionRect(null);
      setBreakoutMarker(null);
    }

    if (latestLineVisibilityRef.current.vwap) {
      const markers: MarkerOverlay[] = [];

      for (const signal of latestVwapSignalsRef.current) {
        const x = timeScale.timeToCoordinate(signal.time as Time);
        const y = candleSeries.priceToCoordinate(signal.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        markers.push({
          left: x,
          top: y,
          label: signal.label,
          color: "#38bdf8",
          direction: "up",
        });
      }

      setVwapMarkers(markers);
    } else {
      setVwapMarkers([]);
    }

    if (latestLineVisibilityRef.current.choch) {
      const nextChochMarkers: MarkerOverlay[] = [];
      for (const marker of latestChochMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextChochMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
        });
      }
      setChochMarkers(nextChochMarkers);
    } else {
      setChochMarkers([]);
    }
    if (latestLineVisibilityRef.current.fakeEngulfing) {
      const nextFakeEngulfingMarkers: MarkerOverlay[] = [];
      for (const marker of latestFakeEngulfingMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextFakeEngulfingMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
        });
      }
      setFakeEngulfingMarkers(nextFakeEngulfingMarkers);
    } else {
      setFakeEngulfingMarkers([]);
    }

    if (latestLineVisibilityRef.current.significantCandles) {
      const nextSignificantMarkers: MarkerOverlay[] = [];
      for (const marker of latestSignificantCandleMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextSignificantMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
          dotSize: marker.dotSize,
        });
      }
      setSignificantCandleMarkers(nextSignificantMarkers);
    } else {
      setSignificantCandleMarkers([]);
    }

    if (latestLineVisibilityRef.current.liquiditySweeps) {
      const nextLiquiditySweepMarkers: MarkerOverlay[] = [];
      for (const marker of latestLiquiditySweepMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextLiquiditySweepMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
        });
      }
      setLiquiditySweepMarkers(nextLiquiditySweepMarkers);
    } else {
      setLiquiditySweepMarkers([]);
    }


    if (latestLineVisibilityRef.current.volumeSignals) {
      const nextVolumeSignalMarkers: MarkerOverlay[] = [];
      for (const marker of latestVolumeSignalMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextVolumeSignalMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
          dotSize: marker.dotSize,
        });
      }
      setVolumeSignalMarkers(nextVolumeSignalMarkers);
    } else {
      setVolumeSignalMarkers([]);
    }

    if (latestLineVisibilityRef.current.bodyBreakDots) {
      const nextBodyBreakDotMarkers: MarkerOverlay[] = [];
      for (const marker of latestBodyBreakDotMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextBodyBreakDotMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
          dotSize: marker.dotSize,
        });
      }
      setBodyBreakDotMarkers(nextBodyBreakDotMarkers);
    } else {
      setBodyBreakDotMarkers([]);
    }

    if (latestLineVisibilityRef.current.closeAbovePrevCloseDots) {
      const nextCloseAbovePrevCloseDotMarkers: MarkerOverlay[] = [];
      for (const marker of latestCloseAbovePrevCloseDotMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextCloseAbovePrevCloseDotMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
          dotSize: marker.dotSize,
        });
      }
      setCloseAbovePrevCloseDotMarkers(nextCloseAbovePrevCloseDotMarkers);
    } else {
      setCloseAbovePrevCloseDotMarkers([]);
    }

    if (latestLineVisibilityRef.current.atrExpansionCandles) {
      const nextAtrExpansionMarkers: MarkerOverlay[] = [];
      for (const marker of latestAtrExpansionMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextAtrExpansionMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
          dotSize: marker.dotSize,
        });
      }
      setAtrExpansionMarkers(nextAtrExpansionMarkers);
    } else {
      setAtrExpansionMarkers([]);
    }

    if (latestLineVisibilityRef.current.resistanceBreakoutConfirm) {
      const nextResistanceBreakoutMarkers: MarkerOverlay[] = [];
      for (const marker of latestResistanceBreakoutMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextResistanceBreakoutMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
          dotSize: marker.dotSize,
        });
      }
      setResistanceBreakoutMarkers(nextResistanceBreakoutMarkers);
    } else {
      setResistanceBreakoutMarkers([]);
    }

    if (latestLineVisibilityRef.current.trendlineCloseAlerts) {
      const nextTrendlineCloseMarkers: MarkerOverlay[] = [];
      for (const marker of latestTrendlineCloseMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextTrendlineCloseMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
        });
      }
      setTrendlineCloseMarkers(nextTrendlineCloseMarkers);
    } else {
      setTrendlineCloseMarkers([]);
    }

    const nextSignalMarkers: MarkerOverlay[] = [];
    for (const marker of latestSignalMarkersRef.current) {
      const x = timeScale.timeToCoordinate(marker.time as Time);
      const y = candleSeries.priceToCoordinate(marker.price);

      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }

      nextSignalMarkers.push({
        left: x,
        top: y,
        label: marker.label,
        color: marker.color,
        direction: marker.direction,
      });
    }
    setSignalMarkers(nextSignalMarkers);

    if (latestLineVisibilityRef.current.trendlineCloseAlerts) {
      const nextTrendlineCloseMarkers: MarkerOverlay[] = [];
      for (const marker of latestTrendlineCloseMarkersRef.current) {
        const x = timeScale.timeToCoordinate(marker.time as Time);
        const y = candleSeries.priceToCoordinate(marker.price);

        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        nextTrendlineCloseMarkers.push({
          left: x,
          top: y,
          label: marker.label,
          color: marker.color,
          direction: marker.direction,
        });
      }
      setTrendlineCloseMarkers(nextTrendlineCloseMarkers);
    } else {
      setTrendlineCloseMarkers([]);
    }

    const nextTrendlineHandles: TrendlineHandleOverlay[] = [];
    let nextTrendlineFocus: TrendlineFocusOverlay | null = null;

    if (latestLineVisibilityRef.current.trendlines) {
      const selectedId = selectedTrendlineIdRef.current;
      const editableLines = selectedId
        ? trendlinesRef.current.filter((line) => line.id === selectedId)
        : [];

      for (const line of editableLines) {
        const anchors = [
          { anchor: "p1" as const, time: line.t1, price: line.p1 },
          { anchor: "p2" as const, time: line.t2, price: line.p2 },
        ];

        const anchorCoordinates: { left: number; top: number }[] = [];

        for (const item of anchors) {
          const x = timeScale.timeToCoordinate(item.time as Time);
          const y = candleSeries.priceToCoordinate(item.price);

          if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
            continue;
          }

          anchorCoordinates.push({ left: x, top: y });

          nextTrendlineHandles.push({
            id: `${line.id}-${item.anchor}`,
            trendlineId: line.id,
            anchor: item.anchor,
            left: x,
            top: y,
            selected: selectedId === line.id,
          });
        }

        if (selectedId === line.id && anchorCoordinates.length === 2) {
          nextTrendlineFocus = {
            trendlineId: line.id,
            left: (anchorCoordinates[0].left + anchorCoordinates[1].left) / 2,
            top: Math.min(anchorCoordinates[0].top, anchorCoordinates[1].top) - 22,
            label: `Selected TL · P1 ${formatPrice(line.p1)} · P2 ${formatPrice(line.p2)}`,
          };
        }
      }
    }

    const normalizedOrderLines = normalizeOrderLines(openOrdersRef.current, symbol).map((line) => ({
      ...line,
      price: orderPriceOverrides[line.lineId] ?? line.price,
    }));

    const nextOrderLineOverlays: OrderLineOverlay[] = [];
    for (const line of normalizedOrderLines) {
      const y = candleSeries.priceToCoordinate(line.price);
      if (y == null || !Number.isFinite(y)) continue;

      nextOrderLineOverlays.push({
        lineId: line.lineId,
        orderId: line.orderId,
        top: y,
        price: line.price,
        label: line.label,
        detail: formatOrderLineDetail(line),
        color: line.color,
        order: line.order,
        line,
      });
    }

    setOrderLineOverlays(nextOrderLineOverlays);

    setTrendlineHandleOverlays(nextTrendlineHandles);
    setTrendlineFocusOverlay(nextTrendlineFocus);
  }, [symbol, orderPriceOverrides]);

  useEffect(() => {
    const bars = barsRef.current;
    if (!bars.length) {
      latestAtrExpansionMarkersRef.current = [];
      latestResistanceBreakoutMarkersRef.current = [];
      setAtrExpansionMarkers([]);
      setResistanceBreakoutMarkers([]);
      return;
    }

    const atrValues = computeRollingAtrValues(bars, 14);
    const atrBreakoutSignals = computeAtrExpansionAndResistanceBreakoutSignals(
      bars,
      atrValues,
      projectionSelection
    );
    latestAtrExpansionMarkersRef.current = atrBreakoutSignals.expansionDots;
    latestResistanceBreakoutMarkersRef.current = atrBreakoutSignals.breakoutConfirmations;
    window.requestAnimationFrame(updateOverlayPositions);
  }, [projectionSelection, updateOverlayPositions]);

  useEffect(() => {
    openOrdersRef.current = openOrders;
    window.requestAnimationFrame(updateOverlayPositions);
  }, [openOrders, orderPriceOverrides, updateOverlayPositions]);

  useEffect(() => {
    onCancelOrderRef.current = onCancelOrder;
  }, [onCancelOrder]);

  useEffect(() => {
    onReplaceOrderPriceRef.current = onReplaceOrderPrice;
  }, [onReplaceOrderPrice]);

  useEffect(() => {
    setOrderPriceOverrides((prev) => {
      const validLineIds = new Set(normalizeOrderLines(openOrders, symbol).map((line) => line.lineId));
      const next: Record<string, number> = {};
      for (const [lineId, price] of Object.entries(prev)) {
        if (validLineIds.has(lineId)) next[lineId] = price;
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [openOrders, symbol]);

  useEffect(() => {
    const bars = barsRef.current;
    const tradingDate = tradingDateRef.current;

    const vwapValues = calcVWAP(bars);
    const vwapData: LinePoint[] = bars.map((bar, i) => ({
      time: toChartTime(bar.time),
      value: vwapValues[i],
    }));

    const sessionStats = computeSessionStats(bars, tradingDate);
    const pmh = sessionStats.premarketHigh;
    const pmhData: LinePoint[] =
      pmh == null
        ? []
        : bars.map((bar) => ({
            time: toChartTime(bar.time),
            value: pmh,
          }));

    const compression = computeCompressionZone(bars);
    latestCompressionRef.current = compression;

    const compressionTopData: LinePoint[] =
      compression && effectiveLineVisibility.compression
        ? [
            { time: compression.startTime, value: compression.top },
            { time: compression.endTime, value: compression.top },
          ]
        : [];

    const compressionBottomData: LinePoint[] =
      compression && effectiveLineVisibility.compression
        ? [
            { time: compression.startTime, value: compression.bottom },
            { time: compression.endTime, value: compression.bottom },
          ]
        : [];

    vwapSeriesRef.current?.setData(effectiveLineVisibility.vwap ? vwapData : []);
    pmhSeriesRef.current?.setData(effectiveLineVisibility.pmh ? pmhData : []);
    compressionTopSeriesRef.current?.setData(compressionTopData);
    compressionBottomSeriesRef.current?.setData(compressionBottomData);

    if (!effectiveLineVisibility.projections) {
      clearProjectionSelection();
    }

    syncTrendlineSeries();
    window.requestAnimationFrame(updateOverlayPositions);
  }, [
    effectiveLineVisibility,
    clearProjectionSelection,
    syncTrendlineSeries,
    updateOverlayPositions,
  ]);

  const renderBars = useCallback(
    async (bars: Candle[], tradingDate: string | null, lastOverride?: number | null) => {
      barsRef.current = bars;
      tradingDateRef.current = tradingDate;

      const atrValues = computeRollingAtrValues(bars, 14);
      const fakeEngulfingSignals = computeFakeEngulfingSignals(bars);
      const liquiditySweepSignals = computeLiquiditySweepSignals(bars);
      const volumeSignalMarkers = computeVolumeSignalMarkers(bars);
      const bodyBreakDotSignals = computeBodyBreakDotSignals(bars);
      const atrBreakoutSignals = computeAtrExpansionAndResistanceBreakoutSignals(
        bars,
        atrValues,
        projectionSelectionRef.current
      );
      const fakeEngulfingTimes = new Set(fakeEngulfingSignals.map((marker) => marker.time));

      const significantCandleSignals: SignalMarkerPoint[] = [];

      const candleData: CandlePoint[] = bars.map((bar, index) => {
        const atr = atrValues[index];
        const isExpansionCandle = isSignificantExpansionCandle(bar, atr, 1.5);

        if (isExpansionCandle) {
          const candleTime = toChartTime(bar.time);
          const isFakeoutConfirmation = fakeEngulfingTimes.has(candleTime);
          const isSqueezeSetup = isSqueezeExpansionSetup(bars, index, atrValues);

          significantCandleSignals.push({
            time: candleTime,
            price: (bar.open + bar.close) / 2,
            label: isFakeoutConfirmation ? "Fakeout" : isSqueezeSetup ? "Squeeze Expansion" : "Expansion",
            color: isFakeoutConfirmation ? "#38bdf8" : isSqueezeSetup ? "#c084fc" : "#fbbf24",
            direction: bar.close >= bar.open ? "up" : "down",
            dotSize: getExpansionDotSize(bar, atr),
          });
        }

        return {
          time: toChartTime(bar.time),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        };
      });

      latestSignificantCandleMarkersRef.current = significantCandleSignals.slice(-40);
      latestFakeEngulfingMarkersRef.current = fakeEngulfingSignals;
      latestLiquiditySweepMarkersRef.current = liquiditySweepSignals;
      latestVolumeSignalMarkersRef.current = volumeSignalMarkers;
      latestBodyBreakDotMarkersRef.current = bodyBreakDotSignals.blackDots;
      latestCloseAbovePrevCloseDotMarkersRef.current = bodyBreakDotSignals.whiteDots;
      latestAtrExpansionMarkersRef.current = atrBreakoutSignals.expansionDots;
      latestResistanceBreakoutMarkersRef.current = atrBreakoutSignals.breakoutConfirmations;

      const volumeData: VolumePoint[] = bars.map((bar) => ({
        time: toChartTime(bar.time),
        value: bar.volume,
        color:
          bar.close >= bar.open
            ? "rgba(34,197,94,0.5)"
            : "rgba(239,68,68,0.5)",
      }));

      const vwapValues = calcVWAP(bars);
      const vwapData: LinePoint[] = bars.map((bar, i) => ({
        time: toChartTime(bar.time),
        value: vwapValues[i],
      }));

      const sessionStats = computeSessionStats(bars, tradingDate);
      const pmh = sessionStats.premarketHigh;

      const pmhData: LinePoint[] =
        pmh === null
          ? []
          : bars.map((bar) => ({
              time: toChartTime(bar.time),
              value: pmh,
            }));

      const compression = computeCompressionZone(bars);
      latestCompressionRef.current = compression;
      latestVwapSignalsRef.current = computeVWAPReclaimSignals(bars, vwapValues);
      latestChochMarkersRef.current = computeChochSignals(bars);

      const compressionTopData: LinePoint[] =
        compression && latestLineVisibilityRef.current.compression
          ? [
              { time: compression.startTime, value: compression.top },
              { time: compression.endTime, value: compression.top },
            ]
          : [];

      const compressionBottomData: LinePoint[] =
        compression && latestLineVisibilityRef.current.compression
          ? [
              { time: compression.startTime, value: compression.bottom },
              { time: compression.endTime, value: compression.bottom },
            ]
          : [];

      candleSeriesRef.current?.setData(candleData);
      volumeSeriesRef.current?.setData(volumeData);
      vwapSeriesRef.current?.setData(latestLineVisibilityRef.current.vwap ? vwapData : []);
      pmhSeriesRef.current?.setData(latestLineVisibilityRef.current.pmh ? pmhData : []);
      compressionTopSeriesRef.current?.setData(compressionTopData);
      compressionBottomSeriesRef.current?.setData(compressionBottomData);

      syncTrendlineSeries();
      refreshProjectionFromLatestBar(bars);
      evaluateTrendlineAlerts(bars);

      if (autoFitPendingRef.current) {
        applyNormalVisibleRange(bars);
        autoFitPendingRef.current = false;
      }

      window.requestAnimationFrame(updateOverlayPositions);

      let last: number | null =
        lastOverride ??
        (bars.length > 0 ? bars[bars.length - 1].close : null);

      if (lastOverride == null && bars.length > 0) {
        try {
          const lastTradeResp = await fetchLastTrade(symbol);
          if (lastTradeResp.price !== null) {
            last = lastTradeResp.price;
          }
        } catch {
          // keep last close
        }
      }

      const latestVwap =
        vwapValues.length > 0 ? vwapValues[vwapValues.length - 1] : null;

      const nextLegend: LegendState = {
        last,
        pmh,
        vwap: latestVwap,
        tradingDate,
        compressionLabel: compression?.label ?? null,
        session: sessionStats,
      };

      setLegend(nextLegend);
      legendRef.current = nextLegend;
      setHoveredCandle((prev) => {
        if (!prev) {
          return toHoveredCandleState(bars.length > 0 ? bars[bars.length - 1] : null);
        }

        const nearest = findNearestBarByTime(bars, prev.time);
        return toHoveredCandleState(nearest ?? (bars.length > 0 ? bars[bars.length - 1] : null));
      });

      onStatsUpdateRef.current({
        last,
        pmh,
        vwap: latestVwap,
        barsCount: bars.length,
      });

    },
    [symbol, timeframe, updateOverlayPositions, syncTrendlineSeries, refreshProjectionFromLatestBar, evaluateTrendlineAlerts, applyNormalVisibleRange]
  );

  const setChartInteractionEnabledForOrders = useCallback((enabled: boolean) => {
    chartRef.current?.applyOptions({
      handleScroll: enabled,
      handleScale: enabled,
    });
  }, []);

  const beginOrderLineDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, line: NormalizedOrderLine) => {
    if (!line.canMove) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    orderDragStateRef.current = {
      lineId: line.lineId,
      pointerId: event.pointerId,
      startingPrice: line.price,
      currentPrice: line.price,
      startY: event.clientY,
      latestY: event.clientY,
      hasMoved: false,
    };
    setSelectedTrendlineId(null);
    setChartInteractionEnabledForOrders(false);
    if (containerRef.current) containerRef.current.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }, [setChartInteractionEnabledForOrders]);

  const cancelOrderFromLine = useCallback((event: ReactMouseEvent<HTMLButtonElement>, overlay: OrderLineOverlay) => {
    event.preventDefault();
    event.stopPropagation();
    onCancelOrderRef.current?.(overlay.order, overlay.line);
  }, []);

  const moveOrderLineDuringDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = orderDragStateRef.current;
    const candleSeries = candleSeriesRef.current;
    const containerEl = containerRef.current;
    if (!drag || !candleSeries || !containerEl) return;
    if (event.pointerId !== drag.pointerId) return;

    const rect = containerEl.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const movedPixels = Math.abs(event.clientY - drag.startY);

    event.preventDefault();
    event.stopPropagation();

    drag.latestY = event.clientY;

    const rawPrice = candleSeries.coordinateToPrice(y);
    if (rawPrice == null || !Number.isFinite(rawPrice) || rawPrice <= 0) return;

    const price = roundOrderDragPrice(rawPrice);
    drag.currentPrice = price;

    if (movedPixels >= 2) {
      drag.hasMoved = true;
    }

    setOrderPriceOverrides((prev) => {
      if (prev[drag.lineId] === price) return prev;
      return { ...prev, [drag.lineId]: price };
    });
    window.requestAnimationFrame(updateOverlayPositions);
  }, [updateOverlayPositions]);

  const finishOrderLineDrag = useCallback(async (event: ReactPointerEvent<HTMLDivElement>) => {
    const orderDrag = orderDragStateRef.current;
    if (!orderDrag) return;
    if (event.pointerId !== orderDrag.pointerId) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // pointer may already be released
    }

    orderDragStateRef.current = null;
    setChartInteractionEnabledForOrders(true);
    if (containerRef.current) containerRef.current.style.cursor = "default";
    document.body.style.userSelect = "";

    const currentLines = normalizeOrderLines(openOrdersRef.current, symbol);
    const line = currentLines.find((item) => item.lineId === orderDrag.lineId);
    const nextPrice = roundOrderDragPrice(orderDrag.currentPrice);
    const minMove = Math.max(0.0001, orderDrag.startingPrice * 0.00005);
    const priceMoved = Math.abs(nextPrice - orderDrag.startingPrice) >= minMove;

    if (line && orderDrag.hasMoved && priceMoved && Number.isFinite(nextPrice) && nextPrice > 0) {
      const patchedLine = { ...line, price: nextPrice };
      try {
        await onReplaceOrderPriceRef.current?.(patchedLine.order, patchedLine, nextPrice);
      } finally {
        // Clear drag-only price after the broker action finishes so chart and
        // Open Orders both come from the same refreshed order data.
        setOrderPriceOverrides((prev) => {
          const next = { ...prev };
          delete next[orderDrag.lineId];
          return next;
        });
      }
    } else {
      setOrderPriceOverrides((prev) => {
        const next = { ...prev };
        delete next[orderDrag.lineId];
        return next;
      });
    }

    window.requestAnimationFrame(updateOverlayPositions);
  }, [setChartInteractionEnabledForOrders, symbol, updateOverlayPositions]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    const chart = createChart(container, {
      width: Math.max(container.clientWidth, 300),
      height: Math.max(container.clientHeight, 320),
      layout: {
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#d6e4ff",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.05)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.12)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.12)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 10,
        barSpacing: 7,
        minBarSpacing: 1.5,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: false,
        tickMarkFormatter: (time: number, tickMarkType: TickMarkType) => {
          const includeDate =
            tickMarkType === TickMarkType.DayOfMonth ||
            tickMarkType === TickMarkType.Month ||
            tickMarkType === TickMarkType.Year;

          return formatPacificTime(time, includeDate);
        },
      },
      localization: {
        timeFormatter: (time: number) => formatPacificTime(time, true),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.15)" },
        horzLine: { color: "rgba(255,255,255,0.15)" },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceLineVisible: true,
      lastValueVisible: true,
    });

    // Keep the candle price area above the volume pane so candles/wicks
    // do not overlap the volume bars. Do not change any studies.
    candleSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.2,
        bottom: 0.26,
      },
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    const vwapSeries = chart.addSeries(LineSeries, {
      color: "#38bdf8",
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });

    // Hidden autoscale helper for projection price lines.
    // Lightweight Charts price lines do not expand the price scale by themselves,
    // so this invisible series keeps off-screen support/resistance projections visible.
    const projectionScaleAnchorSeries = chart.addSeries(LineSeries, {
      color: "rgba(0,0,0,0)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const pmhSeries = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });

    const compressionTopSeries = chart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const compressionBottomSeries = chart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    vwapSeries.applyOptions({ autoscaleInfoProvider: () => null });
    pmhSeries.applyOptions({ autoscaleInfoProvider: () => null });
    compressionTopSeries.applyOptions({ autoscaleInfoProvider: () => null });
    compressionBottomSeries.applyOptions({ autoscaleInfoProvider: () => null });

    const getPointFromCoordinates = (x: number, y: number): PendingTrendPoint | null => {
      const chart = chartRef.current;
      const candleSeries = candleSeriesRef.current;
      if (!chart || !candleSeries) return null;

      const rawTime = chart.timeScale().coordinateToTime(x);
      const clickedTime = normalizeClickedTime(rawTime);
      if (clickedTime == null) return null;

      const rawClickedPrice = candleSeries.coordinateToPrice(y);
      if (rawClickedPrice == null || !Number.isFinite(rawClickedPrice)) return null;

      return buildSnappedTrendPointFromClick(
        barsRef.current,
        clickedTime,
        rawClickedPrice,
        trendlineSnapMode
      );
    };

    const handleChartClick = (param: unknown) => {
      if (!candleSeriesRef.current) return;

      const point = (param as { point?: { x: number; y: number } }).point;
      const rawTime = (param as { time?: unknown }).time;

      if (!point) return;

      const clickedTime = normalizeClickedTime(rawTime);
      const rawClickedPrice = candleSeriesRef.current.coordinateToPrice(point.y);
      if (clickedTime == null || rawClickedPrice == null || !Number.isFinite(rawClickedPrice)) return;

      if (projectionModeRef.current) {
        if (!latestLineVisibilityRef.current.projections) return;
        const nearestBar = findNearestBarByTime(barsRef.current, clickedTime);
        if (!nearestBar) return;
        const functionId =
          activeChartFunctionIdRef.current === "none"
            ? "support_prediction_wick_range"
            : activeChartFunctionIdRef.current;
        drawProjectionSelection(getChartFunctionDefinition(functionId).buildSelection(nearestBar));
        projectionModeRef.current = false;
        setProjectionMode(false);
        return;
      }

      if (!drawModeRef.current) {
        if (dragStateRef.current) return;

        const savedProjectionInteraction = getNearestSavedProjectionInteraction(rawClickedPrice);
        if (savedProjectionInteraction) {
          setSelectedSavedProjectionId(savedProjectionInteraction.id);
          setSelectedTrendlineId(null);
          return;
        }
        setSelectedSavedProjectionId(null);

        const interaction = getNearestTrendlineInteraction(
          trendlinesRef.current,
          clickedTime,
          rawClickedPrice,
          barsRef.current
        );

        setSelectedTrendlineId(interaction?.lineId ?? null);
        if (interaction?.lineId) {
          window.requestAnimationFrame(updateOverlayPositions);
        }
        return;
      }

      const snappedPoint = buildSnappedTrendPointFromClick(
        barsRef.current,
        clickedTime,
        rawClickedPrice,
        trendlineSnapMode
      );

      if (!snappedPoint) return;

      if (!pendingTrendPointRef.current) {
        setPendingTrendPoint(snappedPoint);
        return;
      }

      const line = createTrendline(
        symbol,
        timeframe,
        pendingTrendPointRef.current,
        snappedPoint,
        {
          scope: manualTrendlineScope,
          extendLeft: manualExtendLeft,
          extendRight: manualExtendRight,
          color: manualTrendlineColor,
          width: manualTrendlineWidth,
        }
      );

      setPendingTrendPoint(null);
      setDrawMode(false);

      if (!line) return;

      setTrendlines((prev) => [...prev, line]);
      setSelectedTrendlineId(line.id);
    };

    const handleDoubleClick = (event: MouseEvent) => {
      const containerEl = containerRef.current;
      const chart = chartRef.current;
      const candleSeries = candleSeriesRef.current;
      if (!containerEl || !chart || !candleSeries) return;

      const rect = containerEl.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const rawTime = chart.timeScale().coordinateToTime(x);
      const clickedTime = normalizeClickedTime(rawTime);
      if (clickedTime == null) return;

      const clickedPrice = candleSeries.coordinateToPrice(y);

      if (!drawModeRef.current && !projectionModeRef.current && clickedPrice != null && Number.isFinite(clickedPrice)) {
        const interaction = getNearestTrendlineInteraction(
          trendlinesRef.current,
          clickedTime,
          clickedPrice,
          barsRef.current
        );

        if (interaction) {
          event.preventDefault();
          event.stopPropagation();

          const line = trendlinesRef.current.find((item) => item.id === interaction.lineId);
          if (!line) return;

          setSelectedTrendlineId(line.id);

          const input = window.prompt(
            `Edit selected trendline prices. Enter P1 price and P2 price separated by comma.\n\nP1 time: ${formatPacificTime(line.t1, true)}\nP2 time: ${formatPacificTime(line.t2, true)}`,
            `${formatPrice(line.p1)}, ${formatPrice(line.p2)}`
          );

          if (input == null) return;

          const parts = input
            .split(/[ ,]+/)
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isFinite(value));

          if (parts.length < 2) {
            window.alert("Enter two valid prices like: 1.2400, 1.3800");
            return;
          }

          const p1 = parts[0];
          const p2 = parts[1];

          setTrendlines((prev) =>
            prev.map((item) => {
              if (item.id !== line.id) return item;
              return updateTrendlineManualPrices(item, p1, p2) ?? item;
            })
          );

          window.requestAnimationFrame(() => {
            syncTrendlineSeries();
            updateOverlayPositions();
          });
          return;
        }
      }

      if (!projectionModeRef.current || !latestLineVisibilityRef.current.projections) return;
      event.preventDefault();
      event.stopPropagation();

      const nearestBar = findNearestBarByTime(barsRef.current, clickedTime);
      if (!nearestBar) return;

      drawProjectionSelection(getChartFunctionDefinition(activeChartFunctionIdRef.current).buildSelection(nearestBar));
      setProjectionMode(false);
    };

    const setChartInteractionEnabled = (enabled: boolean) => {
      chart.applyOptions({
        handleScroll: enabled,
        handleScale: enabled,
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (orderDragStateRef.current) return;
      if (drawModeRef.current || projectionModeRef.current) return;
      const containerEl = containerRef.current;
      if (!containerEl) return;

      const rect = containerEl.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const point = getPointFromCoordinates(x, y);
      if (!point) return;

      const interaction = getNearestTrendlineInteraction(
        trendlinesRef.current,
        point.time,
        point.price,
        barsRef.current
      );

      if (!interaction) return;

      setSelectedTrendlineId(interaction.lineId);

      if (interaction.kind === "anchor" && interaction.anchor) {
        event.preventDefault();
        event.stopPropagation();
        containerEl.setPointerCapture?.(event.pointerId);
        setChartInteractionEnabled(false);
        dragStateRef.current = {
          trendlineId: interaction.lineId,
          anchor: interaction.anchor,
        };
        containerEl.style.cursor = "grabbing";
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const containerEl = containerRef.current;
      if (!containerEl) return;

      const rect = containerEl.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (orderDragStateRef.current) {
        const drag = orderDragStateRef.current;
        const movedPixels = Math.abs(event.clientY - drag.startY);
        const rawPrice = candleSeriesRef.current?.coordinateToPrice(y);

        event.preventDefault();
        event.stopPropagation();

        if (rawPrice != null && Number.isFinite(rawPrice) && rawPrice > 0) {
          const price = roundOrderDragPrice(rawPrice);
          drag.latestY = event.clientY;
          drag.currentPrice = price;
          if (movedPixels >= 2) drag.hasMoved = true;
          setOrderPriceOverrides((prev) => {
            if (prev[drag.lineId] === price) return prev;
            return { ...prev, [drag.lineId]: price };
          });
          window.requestAnimationFrame(updateOverlayPositions);
        }
        return;
      }

      const point = getPointFromCoordinates(x, y);

      if (dragStateRef.current && point) {
        event.preventDefault();
        event.stopPropagation();
        const drag = dragStateRef.current;
        setTrendlines((prev) =>
          prev.map((line) => {
            if (line.id !== drag.trendlineId) return line;
            return updateTrendlineAnchor(line, drag.anchor, point) ?? line;
          })
        );
        window.requestAnimationFrame(() => {
          syncTrendlineSeries();
          updateOverlayPositions();
        });
        return;
      }

      if (drawModeRef.current || projectionModeRef.current || !point) {
        containerEl.style.cursor = drawModeRef.current || projectionModeRef.current ? "crosshair" : "default";
        return;
      }

      const interaction = getNearestTrendlineInteraction(
        trendlinesRef.current,
        point.time,
        point.price,
        barsRef.current
      );

      containerEl.style.cursor = interaction?.kind === "anchor" ? "grab" : interaction ? "pointer" : "default";
    };

    const handlePointerUp = async (event?: PointerEvent) => {
      const orderDrag = orderDragStateRef.current;
      if (orderDrag) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }

        orderDragStateRef.current = null;
        setChartInteractionEnabled(true);
        if (containerRef.current) containerRef.current.style.cursor = "default";
        document.body.style.userSelect = "";

        const currentLines = normalizeOrderLines(openOrdersRef.current, symbol);
        const line = currentLines.find((item) => item.lineId === orderDrag.lineId);
        const nextPrice = roundOrderDragPrice(orderDrag.currentPrice);
        const minMove = Math.max(0.0001, orderDrag.startingPrice * 0.00005);
        const priceMoved = Math.abs(nextPrice - orderDrag.startingPrice) >= minMove;

        if (line && orderDrag.hasMoved && priceMoved && Number.isFinite(nextPrice) && nextPrice > 0) {
          const patchedLine = { ...line, price: nextPrice };
          try {
            await onReplaceOrderPriceRef.current?.(patchedLine.order, patchedLine, nextPrice);
          } finally {
            // Clear drag-only price after the broker action finishes so chart and
            // Open Orders both come from the same refreshed order data.
            setOrderPriceOverrides((prev) => {
              const next = { ...prev };
              delete next[orderDrag.lineId];
              return next;
            });
          }
        } else {
          setOrderPriceOverrides((prev) => {
            const next = { ...prev };
            delete next[orderDrag.lineId];
            return next;
          });
        }

        window.requestAnimationFrame(updateOverlayPositions);
        return;
      }

      const wasDragging = dragStateRef.current !== null;
      dragStateRef.current = null;
      const containerEl = containerRef.current;
      if (containerEl) {
        if (event) {
          try {
            containerEl.releasePointerCapture?.(event.pointerId);
          } catch {
            // pointer may already be released
          }
        }
        containerEl.style.cursor = drawModeRef.current ? "crosshair" : "default";
      }
      if (wasDragging) {
        setChartInteractionEnabled(true);
        window.requestAnimationFrame(() => {
          syncTrendlineSeries();
          updateOverlayPositions();
        });
      }
    };

    const resizeChartToContainer = () => {
      if (!containerRef.current || !chartRef.current) return;

      const nextWidth = Math.max(containerRef.current.clientWidth, 300);
      const nextHeight = Math.max(containerRef.current.clientHeight, 320);

      chartRef.current.applyOptions({
        width: nextWidth,
        height: nextHeight,
      });

      setTimeout(() => {
        window.requestAnimationFrame(() => {
          syncTrendlineSeries();
          updateOverlayPositions();
        });
      }, 0);
    };

    const resizeObserver = new ResizeObserver(() => {
      resizeChartToContainer();
    });

    resizeObserver.observe(container);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    vwapSeriesRef.current = vwapSeries;
    projectionScaleAnchorSeriesRef.current = projectionScaleAnchorSeries;
    pmhSeriesRef.current = pmhSeries;
    compressionTopSeriesRef.current = compressionTopSeries;
    compressionBottomSeriesRef.current = compressionBottomSeries;

    void loadSavedProjectionLinesFromPersistence();

    const handleCrosshairMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
      const point = param.point;
      if (!point) return;

      const containerEl = containerRef.current;
      if (containerEl) {
        const withinBounds =
          point.x >= 0 &&
          point.y >= 0 &&
          point.x <= containerEl.clientWidth &&
          point.y <= containerEl.clientHeight;

        if (!withinBounds) return;
      }

      const hoveredTime = normalizeClickedTime(param.time);
      const hoveredBar = hoveredTime != null
        ? findNearestBarByTime(barsRef.current, hoveredTime)
        : barsRef.current.length > 0
          ? barsRef.current[barsRef.current.length - 1]
          : null;

      setHoveredCandle(toHoveredCandleState(hoveredBar));
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.subscribeClick(handleChartClick);
    container.addEventListener("dblclick", handleDoubleClick);
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    const handleVisibleRangeChange = () => {
      window.requestAnimationFrame(() => {
        updateOverlayPositions();
      });
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    return () => {
      resizeObserver.disconnect();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.unsubscribeClick(handleChartClick);
      container.removeEventListener("dblclick", handleDoubleClick);
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      for (const timeoutId of alertTimeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
      alertTimeoutsRef.current = [];

      for (const series of trendlineSeriesMapRef.current.values()) {
        chart.removeSeries(series);
      }
      trendlineSeriesMapRef.current.clear();

      for (const line of projectionPriceLinesRef.current) {
        candleSeries.removePriceLine(line);
      }
      projectionPriceLinesRef.current = [];
      savedProjectionPriceLinesRef.current = [];
      selectedSavedProjectionIdRef.current = null;

      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      vwapSeriesRef.current = null;
      projectionScaleAnchorSeriesRef.current = null;
      pmhSeriesRef.current = null;
      compressionTopSeriesRef.current = null;
      compressionBottomSeriesRef.current = null;
    };
  }, [symbol, timeframe, renderBars, syncTrendlineSeries, trendlineSnapMode, updateOverlayPositions, getNearestSavedProjectionInteraction, loadSavedProjectionLinesFromPersistence]);

  useEffect(() => {
    // Keep drawn/edited/deleted trendlines rendered without allowing them to affect candle scaling.
    syncTrendlineSeries();

    // Rebuild Trendline Close Alert labels every time a trendline is created, edited,
    // selected, deleted, or visibility changes. This is what makes TL Close ↑ / ↓
    // appear immediately instead of only after a fresh candle update.
    evaluateTrendlineAlerts(barsRef.current);
    window.requestAnimationFrame(updateOverlayPositions);
  }, [
    trendlines,
    selectedTrendlineId,
    effectiveLineVisibility.trendlineCloseAlerts,
    syncTrendlineSeries,
    evaluateTrendlineAlerts,
    updateOverlayPositions,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError("");

      try {
        const barsResp = await fetchBars(symbol, timeframe, {
          lookback: chartLookbackForTimeframe(timeframe),
          forceRefresh: true,
        });
        if (cancelled) return;

        const normalizedBars = normalizeBarsForChart(barsResp.bars ?? []);
        await renderBars(normalizedBars, barsResp.trading_date ?? null);

        if (normalizedBars.length === 0) {
          setError(`No bars returned for ${symbol.toUpperCase()} ${timeframe}. Backend responded, but the bars array was empty.`);
        }
      } catch (err) {
        if (cancelled) return;

        latestCompressionRef.current = null;
        latestVwapSignalsRef.current = [];
        barsRef.current = [];
        tradingDateRef.current = null;

        setCompressionRect(null);
        setBreakoutMarker(null);
        setVwapMarkers([]);
        setSignalMarkers([]);
        setChochMarkers([]);
        setSessionBands([]);
        latestSignalMarkersRef.current = [];
        latestChochMarkersRef.current = [];
        resetTapeSnapshot(liveTapeRef.current);

        candleSeriesRef.current?.setData([]);
        volumeSeriesRef.current?.setData([]);
        vwapSeriesRef.current?.setData([]);
        pmhSeriesRef.current?.setData([]);
        compressionTopSeriesRef.current?.setData([]);
        compressionBottomSeriesRef.current?.setData([]);

        const chart = chartRef.current;
        if (chart) {
          for (const series of trendlineSeriesMapRef.current.values()) {
            chart.removeSeries(series);
          }
        }
        trendlineSeriesMapRef.current.clear();

        const emptyLegend: LegendState = {
          last: null,
          pmh: null,
          vwap: null,
          tradingDate: null,
          compressionLabel: null,
          session: {
            currentSession: getCurrentEtSessionKind(),
            currentSessionLabel: getSessionLabel(getCurrentEtSessionKind()),
            premarketHigh: null,
            regularHigh: null,
            afterHoursHigh: null,
            extendedHigh: null,
          },
        };

        setLegend(emptyLegend);
        legendRef.current = emptyLegend;
        setHoveredCandle(null);

        onStatsUpdateRef.current({
          last: null,
          pmh: null,
          vwap: null,
          barsCount: 0,
        });

        setError(err instanceof Error ? err.message : "Failed to load chart");
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, renderBars]);

  useEffect(() => {
    let disposed = false;

    const handlePayload = async (payload: unknown) => {
      if (disposed) return;

      try {
        const messages: PolygonMessage[] = Array.isArray(payload) ? (payload as PolygonMessage[]) : [];
        if (!messages.length) return;

        let nextBars = [...barsRef.current];
        let changed = false;
        let lastPriceOverride: number | null = null;

        const fallbackClose = (): number => {
          const lastClose = nextBars.length ? nextBars[nextBars.length - 1]?.close : null;
          return lastPriceOverride ?? lastClose ?? 0;
        };

        for (const rawMsg of messages) {
          const eventType = typeof (rawMsg as { ev?: unknown }).ev === "string"
            ? ((rawMsg as { ev?: string }).ev ?? "")
            : "";
          const msgSymbol = typeof (rawMsg as { sym?: unknown }).sym === "string"
            ? ((rawMsg as { sym?: string }).sym ?? "").toUpperCase()
            : "";

          if (msgSymbol !== symbol.toUpperCase()) continue;

          if (eventType === "A") {
            const secondMsg = rawMsg as SecondAggregateMessage;
            const secondBar: Candle = {
              time: (typeof secondMsg.s === "number" ? secondMsg.s : Date.now()) as UTCTimestamp,
              open: typeof secondMsg.o === "number" ? secondMsg.o : fallbackClose(),
              high: typeof secondMsg.h === "number" ? secondMsg.h : fallbackClose(),
              low: typeof secondMsg.l === "number" ? secondMsg.l : fallbackClose(),
              close: typeof secondMsg.c === "number" ? secondMsg.c : fallbackClose(),
              volume: typeof secondMsg.v === "number" ? secondMsg.v : 0,
            };

            const result: { bars: Candle[]; lastPrice: number | null; changed: boolean } =
              timeframe === "1m"
                ? applySecondAggregateToBars(nextBars, secondMsg)
                : mergeIncomingBarIntoTimeframe(nextBars, secondBar, timeframe);

            nextBars = result.bars;
            if (result.changed) changed = true;
            if (result.lastPrice != null) lastPriceOverride = result.lastPrice;
            liveStartedRef.current = true;
            continue;
          }

          if (eventType === "T") {
            const tradeMsg = rawMsg as TradeMessage;
            updateTapeSnapshot(liveTapeRef.current, tradeMsg);

            const tradeBar: Candle = {
              time: (typeof tradeMsg.t === "number" ? tradeMsg.t : Date.now()) as UTCTimestamp,
              open: typeof tradeMsg.p === "number" ? tradeMsg.p : fallbackClose(),
              high: typeof tradeMsg.p === "number" ? tradeMsg.p : fallbackClose(),
              low: typeof tradeMsg.p === "number" ? tradeMsg.p : fallbackClose(),
              close: typeof tradeMsg.p === "number" ? tradeMsg.p : fallbackClose(),
              volume: typeof tradeMsg.s === "number" ? tradeMsg.s : 0,
            };

            const result: { bars: Candle[]; lastPrice: number | null; changed: boolean } =
              timeframe === "1m"
                ? applyTradeToBars(nextBars, tradeMsg)
                : mergeIncomingBarIntoTimeframe(nextBars, tradeBar, timeframe);

            nextBars = result.bars;
            if (result.changed) changed = true;
            if (result.lastPrice != null) lastPriceOverride = result.lastPrice;
            liveStartedRef.current = true;
            continue;
          }

          if (eventType === "AM") {
            const minuteMsg = rawMsg as MinuteAggregateMessage;
            resetTapeSnapshot(liveTapeRef.current);

            const minuteBar: Candle = {
              time: (typeof minuteMsg.s === "number" ? minuteMsg.s : Date.now()) as UTCTimestamp,
              open: typeof minuteMsg.o === "number" ? minuteMsg.o : fallbackClose(),
              high: typeof minuteMsg.h === "number" ? minuteMsg.h : fallbackClose(),
              low: typeof minuteMsg.l === "number" ? minuteMsg.l : fallbackClose(),
              close: typeof minuteMsg.c === "number" ? minuteMsg.c : fallbackClose(),
              volume: typeof minuteMsg.v === "number" ? minuteMsg.v : 0,
            };

            const result: { bars: Candle[]; lastPrice: number | null; changed: boolean } =
              timeframe === "1m"
                ? {
                    bars: applyMinuteAggregateToBars(nextBars, minuteMsg),
                    lastPrice: minuteBar.close,
                    changed: true,
                  }
                : mergeIncomingBarIntoTimeframe(nextBars, minuteBar, timeframe);

            nextBars = result.bars;
            if (result.changed) changed = true;
            if (result.lastPrice != null) lastPriceOverride = result.lastPrice;
            liveStartedRef.current = true;
          }
        }

        if (changed) {
          setError("");
          await renderBars(
            nextBars,
            tradingDateRef.current,
            lastPriceOverride ?? nextBars[nextBars.length - 1]?.close ?? null
          );
        } else if (lastPriceOverride != null) {
          setLegend((prev) => {
            const next = { ...prev, last: lastPriceOverride };
            legendRef.current = next;
            return next;
          });

          onStatsUpdateRef.current({
            last: lastPriceOverride,
            pmh: legendRef.current.pmh,
            vwap: legendRef.current.vwap,
            barsCount: barsRef.current.length,
          });
        }
      } catch (err) {
        console.error("WS message error:", err);
      }
    };

    marketSocket.subscribe(symbol, handlePayload);

    return () => {
      disposed = true;
      marketSocket.unsubscribe(symbol, handlePayload);
    };
  }, [symbol, timeframe, renderBars]);

  const canAddWatchlist = useMemo(
    () => Boolean(onRequestAddSymbolToWatchlist),
    [onRequestAddSymbolToWatchlist]
  );

  const getMarkerLabelStack = useCallback((markers: MarkerOverlay[], marker: MarkerOverlay, idx: number) => {
    return markers
      .slice(0, idx)
      .filter((item) => Math.abs(item.left - marker.left) <= 8)
      .length;
  }, []);

  const getMarkerClusterCount = useCallback((markers: MarkerOverlay[], marker: MarkerOverlay) => {
    return markers.filter((item) => Math.abs(item.left - marker.left) <= 8).length;
  }, []);

  const getSignalLabelKey = useCallback((group: string, marker: MarkerOverlay, idx: number) => {
    return `${group}-${idx}-${Math.round(marker.left)}-${Math.round(marker.top)}-${marker.label}`;
  }, []);

  const isSignalLabelExpanded = useCallback((group: string, marker: MarkerOverlay, idx: number) => {
    return expandedSignalLabelKey === getSignalLabelKey(group, marker, idx);
  }, [expandedSignalLabelKey, getSignalLabelKey]);

  const toggleSignalLabel = useCallback((group: string, marker: MarkerOverlay, idx: number) => {
    const key = getSignalLabelKey(group, marker, idx);
    setExpandedSignalLabelKey((current) => (current === key ? null : key));
  }, [getSignalLabelKey]);

  const getCompactSignalText = useCallback((markers: MarkerOverlay[], marker: MarkerOverlay) => {
    const count = getMarkerClusterCount(markers, marker);
    if (count > 1) return String(count);
    return marker.direction === "up" ? "▲" : "▼";
  }, [getMarkerClusterCount]);

  const getSignalLabelText = useCallback((
    group: string,
    markers: MarkerOverlay[],
    marker: MarkerOverlay,
    idx: number
  ) => {
    return isSignalLabelExpanded(group, marker, idx) ? marker.label : getCompactSignalText(markers, marker);
  }, [getCompactSignalText, isSignalLabelExpanded]);

  const getSignalLabelTitle = useCallback((
    group: string,
    marker: MarkerOverlay,
    idx: number
  ) => {
    return isSignalLabelExpanded(group, marker, idx)
      ? `${marker.label} — click to collapse`
      : `${marker.label} — click to expand`;
  }, [isSignalLabelExpanded]);

  const getVerticalMarkerLabelStyle = useCallback((
    marker: MarkerOverlay,
    lane: number,
    background: string,
    border: string,
    color: string,
    yOffset = 0,
    expanded = false
  ): CSSProperties => {
    const laneGap = expanded ? 18 : 14;

    if (!expanded) {
      return {
        position: "absolute",
        left: marker.left + lane * laneGap,
        top: marker.direction === "up" ? marker.top - 34 - yOffset : marker.top + 18 + yOffset,
        transform: "translateX(-50%)",
        minWidth: 16,
        height: 18,
        padding: "0 4px",
        borderRadius: 999,
        background,
        border,
        color,
        fontSize: 10,
        fontWeight: 900,
        letterSpacing: 0.1,
        lineHeight: "17px",
        textAlign: "center",
        whiteSpace: "nowrap",
        boxShadow: "0 5px 14px rgba(0,0,0,0.30)",
        pointerEvents: "auto",
        cursor: "pointer",
        userSelect: "none",
        zIndex: 8 + lane,
      };
    }

    return {
      position: "absolute",
      left: marker.left + lane * laneGap,
      top: marker.direction === "up" ? marker.top - 54 - yOffset : marker.top + 24 + yOffset,
      transform: marker.direction === "up" ? "translate(-50%, -100%)" : "translateX(-50%)",
      padding: "5px 8px",
      borderRadius: 8,
      background,
      border,
      color,
      fontSize: 11,
      fontWeight: 850,
      letterSpacing: 0.2,
      lineHeight: 1.15,
      whiteSpace: "nowrap",
      boxShadow: "0 6px 18px rgba(0,0,0,0.32)",
      pointerEvents: "auto",
      cursor: "pointer",
      userSelect: "none",
      zIndex: 20 + lane,
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 320 }}>
      <style>
        {`
          @keyframes selectedTrendlinePulse {
            0% { transform: scale(1); opacity: 0.95; }
            50% { transform: scale(1.24); opacity: 1; }
            100% { transform: scale(1); opacity: 0.95; }
          }
          @keyframes selectedTrendlineBadgePulse {
            0% { box-shadow: 0 0 0 0 rgba(250,204,21,0.55); }
            70% { box-shadow: 0 0 0 9px rgba(250,204,21,0.00); }
            100% { box-shadow: 0 0 0 0 rgba(250,204,21,0.00); }
          }
        `}
      </style>
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 72,
          zIndex: 10,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={legendBoxStyle}>
          <strong>{symbol}</strong> · {timeframe} · {legend.tradingDate ?? "--"} · PT
          <span style={{ display: "inline-flex", gap: 4, marginLeft: 10, verticalAlign: "middle" }}>
            {(["1m", "5m", "15m"] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => {
                  if (tf === timeframe) return;
                  setChartTimeframe(tf);
                }}
                style={{
                  height: 24,
                  minWidth: 42,
                  padding: "0 8px",
                  borderRadius: 8,
                  border: tf === timeframe ? "1px solid rgba(96,165,250,0.75)" : "1px solid rgba(148,163,184,0.22)",
                  background: tf === timeframe ? "rgba(37,99,235,0.88)" : "rgba(15,23,42,0.88)",
                  color: tf === timeframe ? "#eff6ff" : "#bfdbfe",
                  fontSize: 11,
                  fontWeight: 900,
                  cursor: "pointer",
                }}
                title={`Switch chart to ${tf}`}
              >
                {tf}
              </button>
            ))}
          </span>
        </div>
        <div style={legendBoxStyle}>VWAP: {formatPrice(legend.vwap)}</div>
        <div style={legendBoxStyle}>PMH: {formatPrice(legend.pmh)}</div>
        <div
          style={{
            ...legendBoxStyle,
            color:
              legend.session.currentSession === "regular"
                ? "#86efac"
                : legend.session.currentSession === "premarket"
                  ? "#7dd3fc"
                  : "#fcd34d",
          }}
        >
          SESSION: {legend.session.currentSessionLabel}
        </div>
        <div style={legendBoxStyle}>RTH H: {formatPrice(legend.session.regularHigh)}</div>
        <div style={legendBoxStyle}>AH H: {formatPrice(legend.session.afterHoursHigh)}</div>
        <div style={legendBoxStyle}>EXT H: {formatPrice(legend.session.extendedHigh)}</div>
        <div style={{ ...legendBoxStyle, color: "#86efac" }}>
          LAST: {formatPrice(legend.last)}
        </div>
        {hoveredCandle ? (
          <>
            <div style={{ ...legendBoxStyle, color: "#e2e8f0" }}>
              T: {formatPacificTime(hoveredCandle.time, false)}
            </div>
            <div style={{ ...legendBoxStyle, color: "#93c5fd" }}>
              O: {formatPrice(hoveredCandle.open)}
            </div>
            <div style={{ ...legendBoxStyle, color: "#86efac" }}>
              H: {formatPrice(hoveredCandle.high)}
            </div>
            <div style={{ ...legendBoxStyle, color: "#fca5a5" }}>
              L: {formatPrice(hoveredCandle.low)}
            </div>
            <div style={{ ...legendBoxStyle, color: hoveredCandle.close >= hoveredCandle.open ? "#22c55e" : "#ef4444" }}>
              C: {formatPrice(hoveredCandle.close)}
            </div>
            <div style={{ ...legendBoxStyle, color: "#fbbf24" }}>
              R: {formatPrice(hoveredCandle.high - hoveredCandle.low)}
            </div>
            <div style={{ ...legendBoxStyle, color: "#c4b5fd" }}>
              V: {formatVolume(hoveredCandle.volume)}
            </div>
          </>
        ) : null}
        <div style={{ ...legendBoxStyle, color: controlState.color }}>
          CTRL: {controlState.label}
        </div>
        <div style={{ ...legendBoxStyle, color: controlState.color }}>
          {controlState.detail}
        </div>
        {legend.compressionLabel ? (
          <div style={{ ...legendBoxStyle, color: "#c4b5fd" }}>
            {legend.compressionLabel}
          </div>
        ) : null}
        {pendingTrendPoint ? (
          <div style={{ ...legendBoxStyle, color: "#7dd3fc" }}>
            TL P1: {formatPacificTime(pendingTrendPoint.time, false)} @ {formatPrice(pendingTrendPoint.price)}
          </div>
        ) : null}
        {trendlines.length > 0 ? (
          <div style={{ ...legendBoxStyle, color: "#67e8f9" }}>
            TL: {trendlines.length}
          </div>
        ) : null}
        {selectedTrendlineId ? (
          <div style={{ ...legendBoxStyle, color: "#fde68a" }}>
            Selected TL · Drag anchor or press Delete
          </div>
        ) : null}
        {drawMode ? (
          <div style={{ ...legendBoxStyle, color: "#93c5fd" }}>
            Draw Mode · Click 2 points
          </div>
        ) : null}
      </div>

      {showInChartWatchlistAdder ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 12,
            zIndex: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "8px 10px",
            borderRadius: 10,
            background: "rgba(5, 18, 45, 0.92)",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
            maxWidth: "min(420px, calc(100% - 24px))",
          }}
        >
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitWatchlistAdd();
            }}
            placeholder="Symbol"
            style={{
              width: 96,
              height: 30,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(2, 18, 43, 0.95)",
              color: "#dbeafe",
              padding: "0 10px",
              outline: "none",
              fontSize: 12,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          />
          <button
            onClick={submitWatchlistAdd}
            style={{
              height: 30,
              padding: "0 12px",
              borderRadius: 8,
              border: "1px solid rgba(34,197,94,0.35)",
              background: canAddWatchlist ? "rgba(21,128,61,0.92)" : "rgba(55,65,81,0.9)",
              color: "#ecfdf5",
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
            }}
            title={
              canAddWatchlist
                ? "Add symbol to watchlist"
                : "Pass onRequestAddSymbolToWatchlist from parent to enable"
            }
          >
            Add WL
          </button>

          {addWatchlistFeedback ? (
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color:
                  addWatchlistFeedback.startsWith("Added")
                    ? "#86efac"
                    : addWatchlistFeedback === "Hook up callback"
                      ? "#fcd34d"
                      : "#fca5a5",
                whiteSpace: "nowrap",
              }}
            >
              {addWatchlistFeedback}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          top: 96,
          left: 12,
          zIndex: 13,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          width: 48,
          padding: 6,
          borderRadius: 12,
          background: "rgba(5, 18, 45, 0.96)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
          backdropFilter: "blur(6px)",
        }}
      >
        <button
          onClick={() => setToolbarCollapsed((prev) => !prev)}
          style={{
            ...toolbarIconButtonStyle,
            border: !toolbarCollapsed ? "1px solid rgba(96,165,250,0.45)" : toolbarIconButtonStyle.border,
            color: !toolbarCollapsed ? "#dbeafe" : toolbarIconButtonStyle.color,
          }}
          title={toolbarCollapsed ? "Show trendline settings" : "Hide trendline settings"}
        >
          ☰
        </button>

        <button
          onClick={() => {
            setPendingTrendPoint(null);
            setProjectionMode(false);
            setDrawMode((prev) => !prev);
          }}
          style={{
            ...toolbarIconButtonStyle,
            border: drawMode
              ? "1px solid rgba(96,165,250,0.6)"
              : toolbarIconButtonStyle.border,
            background: drawMode ? "rgba(30,64,175,0.95)" : toolbarIconButtonStyle.background,
            color: drawMode ? "#dbeafe" : toolbarIconButtonStyle.color,
          }}
          title={drawMode ? "Drawing On" : "Draw Trendline"}
        >
          ╱
        </button>

        <button
          onClick={() => {
            setDrawMode(false);
            setPendingTrendPoint(null);
            if (activeChartFunctionIdRef.current === "none") {
              activeChartFunctionIdRef.current = "support_prediction_wick_range";
              setActiveChartFunctionId("support_prediction_wick_range");
            }
            setProjectionMode((prev) => !prev);
          }}
          style={{
            ...toolbarIconButtonStyle,
            border: projectionMode
              ? "1px solid rgba(96,165,250,0.6)"
              : toolbarIconButtonStyle.border,
            background: projectionMode ? "rgba(30,64,175,0.95)" : toolbarIconButtonStyle.background,
            color: projectionMode ? "#dbeafe" : toolbarIconButtonStyle.color,
          }}
          title={projectionMode ? "Function Pick On" : "Chart Function"}
        >
          ƒx
        </button>

        <button
          onClick={() => setProjectionSettingsOpen((prev) => !prev)}
          style={{
            ...toolbarIconButtonStyle,
            border: projectionSettingsOpen
              ? "1px solid rgba(96,165,250,0.6)"
              : toolbarIconButtonStyle.border,
            background: projectionSettingsOpen ? "rgba(30,64,175,0.95)" : toolbarIconButtonStyle.background,
            color: projectionSettingsOpen ? "#dbeafe" : toolbarIconButtonStyle.color,
          }}
          title={projectionSettingsOpen ? "Hide projection settings" : "Show projection settings"}
        >
          ⊞
        </button>

        <button
          onClick={() => setLineSettingsOpen((prev) => !prev)}
          style={{
            ...toolbarIconButtonStyle,
            border: lineSettingsOpen
              ? "1px solid rgba(96,165,250,0.6)"
              : toolbarIconButtonStyle.border,
            background: lineSettingsOpen ? "rgba(30,64,175,0.95)" : toolbarIconButtonStyle.background,
            color: lineSettingsOpen ? "#dbeafe" : toolbarIconButtonStyle.color,
          }}
          title={lineSettingsOpen ? "Hide line visibility" : "Show line visibility"}
        >
          ☷
        </button>

        <button
          onClick={() => {
            setPendingTrendPoint(null);
            setDrawMode(false);
            setProjectionMode(false);
          }}
          style={toolbarIconButtonStyle}
          title="Cancel draw mode"
        >
          ✕
        </button>

        <button
          onClick={clearProjectionSelection}
          style={toolbarIconButtonStyle}
          title="Clear temporary projection"
        >
          ⌁
        </button>

        <button
          onClick={clearSavedProjectionLines}
          style={toolbarIconButtonStyle}
          title="Clear saved projections"
        >
          S
        </button>

        <button
          onClick={deleteSelectedOrLastTrendline}
          style={toolbarIconButtonStyle}
          title={selectedTrendlineId ? "Delete selected trendline" : "Delete last trendline"}
        >
          🗑
        </button>

        <button
          onClick={clearManualTrendlines}
          style={toolbarIconButtonStyle}
          title="Clear trendlines"
        >
          ⌫
        </button>
      </div>

      {projectionSettingsOpen ? (
        <div
          style={{
            position: "absolute",
            top: 96,
            left: toolbarCollapsed ? 68 : 264,
            zIndex: 13,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: 220,
            padding: 10,
            borderRadius: 12,
            background: "rgba(5, 18, 45, 0.94)",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
            backdropFilter: "blur(6px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#dbeafe", letterSpacing: 0.25 }}>
              Function Settings
            </div>
            <button
              onClick={() => setProjectionSettingsOpen(false)}
              style={{ ...toolbarIconButtonStyle, width: 28, height: 28, fontSize: 12 }}
              title="Hide projection settings"
            >
              ←
            </button>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "#93c5fd", letterSpacing: 0.4 }}>
              Function Selection
            </span>
            <select
              value={activeChartFunctionId}
              onChange={(event) => setActiveChartFunctionId(event.target.value as ChartFunctionId)}
              style={{ ...toolbarSelectStyle, width: "100%" }}
              title="Choose which chart function to draw"
            >
              {CHART_FUNCTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => setSaveProjectionLines((prev) => !prev)}
            style={{
              ...toolbarButtonStyle,
              width: "100%",
              height: 32,
              padding: "0 10px",
              justifyContent: "flex-start",
              border: saveProjectionLines ? "1px solid rgba(34,197,94,0.65)" : toolbarButtonStyle.border,
              color: saveProjectionLines ? "#bbf7d0" : toolbarButtonStyle.color,
              background: saveProjectionLines ? "rgba(22,101,52,0.88)" : toolbarButtonStyle.background,
            }}
            title="ON saves the next projection you click. OFF makes projections temporary and replaces only the temporary projection."
          >
            {saveProjectionLines ? "Save Projection ON" : "Save Projection OFF"}
          </button>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 6,
              padding: 8,
              borderRadius: 10,
              background: "rgba(15, 23, 42, 0.75)",
              border: "1px solid rgba(148,163,184,0.18)",
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 800, color: "#93c5fd", letterSpacing: 0.4 }}>
              Function Description
            </div>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#e2e8f0" }}>
              {getChartFunctionDefinition(activeChartFunctionId).label}
            </div>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7dd3fc", letterSpacing: 0.35 }}>
              {getChartFunctionDefinition(activeChartFunctionId).category.toUpperCase()}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.35, color: "#94a3b8" }}>
              {getChartFunctionDefinition(activeChartFunctionId).description}
            </div>
          </div>

          <button
            onClick={() => {
              if (!effectiveLineVisibility.projections) {
                setProjectionMode(false);
                return;
              }
              setDrawMode(false);
              setPendingTrendPoint(null);
              if (activeChartFunctionIdRef.current === "none") {
                activeChartFunctionIdRef.current = "support_prediction_wick_range";
                setActiveChartFunctionId("support_prediction_wick_range");
              }
              setProjectionMode((prev) => !prev);
            }}
            style={{
              ...toolbarButtonStyle,
              width: "100%",
              height: 34,
              padding: "0 10px",
              justifyContent: "flex-start",
              border: projectionMode ? "1px solid rgba(96,165,250,0.55)" : toolbarButtonStyle.border,
              color: projectionMode ? "#dbeafe" : toolbarButtonStyle.color,
              background: projectionMode ? "rgba(30,64,175,0.95)" : toolbarButtonStyle.background,
            }}
            title={!effectiveLineVisibility.projections ? "Function projections are hidden in Line Visibility" : activeChartFunctionId === "none" ? "Choose a chart function first" : "Enable projection pick mode"}
          >
            {!effectiveLineVisibility.projections ? "Projections Hidden" : activeChartFunctionId === "none" ? "Function Off" : projectionMode ? "Projection Pick On" : "Enable Projection Pick"}
          </button>

          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              color: projectionMode ? "#93c5fd" : projectionSelection ? "#fde68a" : "#94a3b8",
              lineHeight: 1.35,
              padding: "4px 2px 0",
            }}
          >
            {activeChartFunctionId === "none"
              ? "No function selected · PMH, VWAP, and compression remain as reference overlays."
              : projectionMode
                ? `Click candle · ${getChartFunctionDefinition(activeChartFunctionId).label}`
                : projectionSelection
                  ? `${getChartFunctionDefinition(activeChartFunctionId).label} · Body ${formatPrice(projectionSelection.bodyRange)} · Range ${formatPrice(projectionSelection.fullRange)}`
                  : "Choose a chart function, enable projection pick, then click a candle."}
          </div>
        </div>
      ) : null}

      {lineSettingsOpen ? (
        <div
          style={{
            position: "absolute",
            top: 96,
            left: toolbarCollapsed ? 68 : projectionSettingsOpen ? 492 : 264,
            zIndex: 13,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: 220,
            padding: 10,
            borderRadius: 12,
            background: "rgba(5, 18, 45, 0.94)",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
            backdropFilter: "blur(6px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#dbeafe", letterSpacing: 0.25 }}>
              Line Visibility
            </div>
            <button
              onClick={() => setLineSettingsOpen(false)}
              style={{ ...toolbarIconButtonStyle, width: 28, height: 28, fontSize: 12 }}
              title="Hide line visibility"
            >
              ←
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            {([
              ["pmh", "Premarket High"],
              ["vwap", "VWAP"],
              ["compression", "Compression Zones"],
              ["choch", "Change of Character"],
              ["sessionBands", "Session Bands"],
              ["projections", "Function Projections"],
              ["trendlines", "Trendlines"],
              ["fakeEngulfing", "Fake Engulfing / Fakeouts"],
              ["significantCandles", "Significant Candle Dots"],
              ["liquiditySweeps", "Liquidity Sweeps"],
              ["volumeSignals", "Volume Signals"],
              ["bodyBreakDots", "Black Dots: Open/Close Below Prev Body"],
              ["closeAbovePrevCloseDots", "White Dots: Close Above Prev Close"],
              ["atrExpansionCandles", "ATR Expansion Candles"],
              ["resistanceBreakoutConfirm", "Resistance Breakout Confirm"],
              ["trendlineCloseAlerts", "Trendline Close Alerts"],
            ] as const).map(([key, label]) => {
              const isOn = lineVisibility[key];
              const disabled =
                key === "pmh"
                  ? !visibility.pmh
                  : key === "vwap"
                    ? !visibility.vwap
                    : key === "compression"
                      ? !visibility.compression
                      : key === "choch"
                        ? !visibility.choch
                        : key === "sessionBands"
                          ? !visibility.sessionBands
                          : key === "projections"
                            ? !visibility.projections
                            : key === "trendlines"
                              ? !visibility.trendlines
                              : false;

              return (
                <button
                  key={key}
                  onClick={() => {
                    if (disabled) return;
                    setLineVisibility((prev) => ({ ...prev, [key]: !prev[key] }));
                  }}
                  style={{
                    ...toolbarButtonStyle,
                    width: "100%",
                    height: 32,
                    padding: "0 10px",
                    justifyContent: "space-between",
                    border: isOn ? "1px solid rgba(96,165,250,0.55)" : toolbarButtonStyle.border,
                    color: disabled ? "#64748b" : isOn ? "#dbeafe" : toolbarButtonStyle.color,
                    opacity: disabled ? 0.65 : 1,
                  }}
                  title={disabled ? `${label} is disabled from the top toolbar` : `Toggle ${label}`}
                >
                  <span>{label}</span>
                  <span>{isOn ? "On" : "Off"}</span>
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button
              onClick={() => setLineVisibility({
                pmh: false,
                vwap: false,
                compression: false,
                choch: false,
                sessionBands: false,
                projections: false,
                trendlines: false,
                fakeEngulfing: false,
                significantCandles: false,
                liquiditySweeps: false,
                volumeSignals: false,
                bodyBreakDots: false,
                closeAbovePrevCloseDots: false,
                atrExpansionCandles: false,
                resistanceBreakoutConfirm: false,
                trendlineCloseAlerts: false,
              })}
              style={{
                ...toolbarButtonStyle,
                width: "100%",
                height: 32,
                padding: "0 10px",
                justifyContent: "center",
              }}
              title="Hide all chart lines"
            >
              Hide All
            </button>
            <button
              onClick={() => setLineVisibility({
                pmh: true,
                vwap: true,
                compression: true,
                choch: true,
                sessionBands: true,
                projections: true,
                trendlines: true,
                fakeEngulfing: true,
                significantCandles: true,
                liquiditySweeps: true,
                volumeSignals: true,
                bodyBreakDots: true,
                closeAbovePrevCloseDots: true,
                atrExpansionCandles: true,
                resistanceBreakoutConfirm: true,
                trendlineCloseAlerts: true,
              })}
              style={{
                ...toolbarButtonStyle,
                width: "100%",
                height: 32,
                padding: "0 10px",
                justifyContent: "center",
              }}
              title="Show all chart lines"
            >
              Show All
            </button>
          </div>

          <div
            style={{
              fontSize: 11,
              lineHeight: 1.35,
              color: "#94a3b8",
              padding: "4px 2px 0",
            }}
          >
            Top toolbar PMH, VWAP, and Compression still act as master switches. This panel lets you hide lines locally inside the chart.
          </div>
        </div>
      ) : null}

      {!toolbarCollapsed ? (
        <div
          style={{
            position: "absolute",
            top: 96,
            left: 68,
            zIndex: 13,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: 188,
            padding: 10,
            borderRadius: 12,
            background: "rgba(5, 18, 45, 0.94)",
            border: "1px solid rgba(255,255,255,0.10)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
            backdropFilter: "blur(6px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#dbeafe", letterSpacing: 0.25 }}>
              Trendline Settings
            </div>
            <button
              onClick={() => setToolbarCollapsed(true)}
              style={{ ...toolbarIconButtonStyle, width: 28, height: 28, fontSize: 12 }}
              title="Hide trendline settings"
            >
              ←
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#93c5fd", letterSpacing: 0.4 }}>
                Scope
              </span>
              <select
                value={manualTrendlineScope}
                onChange={(event) => handleManualScopeChange(event.target.value as TrendlineScope)}
                style={{ ...toolbarSelectStyle, width: "100%" }}
                title="Shared shows on all timeframes for this symbol. Timeframe Only stays on this timeframe."
              >
                <option value="shared">Shared</option>
                <option value="timeframe">Timeframe Only</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#93c5fd", letterSpacing: 0.4 }}>
                Color
              </span>
              <select
                value={manualTrendlineColor}
                onChange={(event) => handleManualColorChange(event.target.value)}
                style={{ ...toolbarSelectStyle, width: "100%" }}
                title="Trendline color"
              >
                <option value="#00e5ff">Cyan</option>
                <option value="#ef4444">Red</option>
                <option value="#3b82f6">Blue</option>
                <option value="#22c55e">Green</option>
                <option value="#f59e0b">Orange</option>
                <option value="#a855f7">Purple</option>
                <option value="#f8fafc">White</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#93c5fd", letterSpacing: 0.4 }}>
                Thickness
              </span>
              <select
                value={String(manualTrendlineWidth)}
                onChange={(event) => handleManualWidthChange(Number(event.target.value))}
                style={{ ...toolbarSelectStyle, width: "100%" }}
                title="Trendline thickness"
              >
                <option value="1">Thin</option>
                <option value="2">Normal</option>
                <option value="3">Medium</option>
                <option value="4">Bold</option>
              </select>
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
            <button
              onClick={() => {
                setDrawMode((prev) => {
                  const next = !prev;
                  if (!next) setPendingTrendPoint(null);
                  return next;
                });
                setSelectedTrendlineId(null);
              }}
              style={{
                ...toolbarButtonStyle,
                width: "100%",
                height: 32,
                padding: "0 10px",
                justifyContent: "center",
                border: drawMode ? "1px solid rgba(34,197,94,0.70)" : toolbarButtonStyle.border,
                color: drawMode ? "#bbf7d0" : toolbarButtonStyle.color,
                background: drawMode ? "rgba(22,101,52,0.40)" : toolbarButtonStyle.background,
              }}
              title="Manual trendline mode: click first point, then click second point"
            >
              {drawMode ? "Manual Trendline On" : "Manual Trendline"}
            </button>

            <button
              onClick={() => handleManualExtendLeftChange(!manualExtendLeft)}
              style={{
                ...toolbarButtonStyle,
                width: "100%",
                height: 32,
                padding: "0 10px",
                justifyContent: "flex-start",
                border: manualExtendLeft ? "1px solid rgba(96,165,250,0.55)" : toolbarButtonStyle.border,
                color: manualExtendLeft ? "#dbeafe" : toolbarButtonStyle.color,
              }}
              title="Extend line to the left"
            >
              Extend Left {manualExtendLeft ? "On" : "Off"}
            </button>

            <button
              onClick={() => handleManualExtendRightChange(!manualExtendRight)}
              style={{
                ...toolbarButtonStyle,
                width: "100%",
                height: 32,
                padding: "0 10px",
                justifyContent: "flex-start",
                border: manualExtendRight ? "1px solid rgba(96,165,250,0.55)" : toolbarButtonStyle.border,
                color: manualExtendRight ? "#dbeafe" : toolbarButtonStyle.color,
              }}
              title="Extend line to the right"
            >
              Extend Right {manualExtendRight ? "On" : "Off"}
            </button>
          </div>

          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              color: drawMode ? "#93c5fd" : selectedTrendlineId ? "#fde68a" : "#94a3b8",
              lineHeight: 1.35,
              padding: "4px 2px 0",
            }}
          >
            {drawMode
              ? pendingTrendPoint
                ? "Click second point"
                : "Click first point"
              : selectedTrendlineId
                ? "Trendline selected"
                : "Click Draw Trendline"}
          </div>
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          top: 96,
          right: 12,
          zIndex: 12,
          width: 320,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "none",
        }}
      >
        {effectiveLineVisibility.trendlines ? trendlineAlerts.map((item) => (
          <div
            key={item.id}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border:
                item.kind === "cross_up" || item.kind === "absorption_bull"
                  ? "1px solid rgba(34,197,94,0.45)"
                  : item.kind === "cross_down"
                    ? "1px solid rgba(239,68,68,0.45)"
                    : item.kind === "prebreak_bull" || item.kind === "aggressive_buyers"
                      ? "1px solid rgba(59,130,246,0.45)"
                      : item.kind === "prebreak_bear"
                        ? "1px solid rgba(252,165,165,0.4)"
                        : item.kind === "failed_breakdown"
                          ? "1px solid rgba(245,158,11,0.45)"
                          : "1px solid rgba(56,189,248,0.45)",
              background:
                item.kind === "cross_up" || item.kind === "absorption_bull"
                  ? "rgba(20,83,45,0.9)"
                  : item.kind === "cross_down"
                    ? "rgba(127,29,29,0.9)"
                    : item.kind === "prebreak_bull" || item.kind === "aggressive_buyers"
                      ? "rgba(30,64,175,0.9)"
                      : item.kind === "prebreak_bear"
                        ? "rgba(69,10,10,0.92)"
                        : item.kind === "failed_breakdown"
                          ? "rgba(120,53,15,0.92)"
                          : "rgba(8,47,73,0.92)",
              color:
                item.kind === "cross_up" || item.kind === "absorption_bull"
                  ? "#bbf7d0"
                  : item.kind === "cross_down"
                    ? "#fecaca"
                    : item.kind === "prebreak_bull" || item.kind === "aggressive_buyers"
                      ? "#bfdbfe"
                      : item.kind === "prebreak_bear"
                        ? "#fecdd3"
                        : item.kind === "failed_breakdown"
                          ? "#fde68a"
                          : "#bae6fd",
              fontSize: 12,
              fontWeight: 700,
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            }}
          >
            {item.message}
          </div>
        )) : null}
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 6,
          pointerEvents: "none",
        }}
      >
        {orderLineOverlays.map((overlay) => (
          <div
            key={overlay.lineId}
            onPointerDown={(event) => beginOrderLineDrag(event, overlay.line)}
            onPointerMove={moveOrderLineDuringDrag}
            onPointerUp={finishOrderLineDrag}
            onPointerCancel={finishOrderLineDrag}
            title="Drag order line to replace order price"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: overlay.top - 9,
              height: 18,
              borderTop: `2px dashed ${overlay.color}`,
              transform: "translateY(8px)",
              boxShadow: `0 0 0 1px rgba(0,0,0,0.35), 0 0 12px ${overlay.color}66`,
              pointerEvents: "auto",
              cursor: "ns-resize",
              zIndex: 42,
              touchAction: "none",
              userSelect: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                right: 68,
                top: -8,
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 6px 4px 9px",
                borderRadius: 999,
                background: "rgba(2, 6, 23, 0.96)",
                border: `1px solid ${overlay.color}`,
                color: "#e5e7eb",
                fontSize: 11,
                fontWeight: 900,
                whiteSpace: "nowrap",
                boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
              }}
            >
              <span style={{ color: overlay.color }}>{overlay.label}</span>
              <span>{formatPrice(overlay.price)}</span>
              <span style={{ color: "#94a3b8", fontWeight: 800 }}>{overlay.detail}</span>
              <button
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => cancelOrderFromLine(event, overlay)}
                title="Cancel this order"
                style={{
                  height: 20,
                  minWidth: 24,
                  padding: "0 7px",
                  borderRadius: 999,
                  border: "1px solid rgba(248,113,113,0.75)",
                  background: "rgba(127,29,29,0.95)",
                  color: "#fee2e2",
                  fontSize: 10,
                  fontWeight: 900,
                  cursor: "pointer",
                  pointerEvents: "auto",
                }}
              >
                X
              </button>
            </div>
          </div>
        ))}

        {trendlineFocusOverlay ? (
          <div
            title="Double-click selected trendline to manually edit P1 and P2 prices"
            style={{
              position: "absolute",
              left: trendlineFocusOverlay.left,
              top: Math.max(6, trendlineFocusOverlay.top),
              transform: "translate(-50%, -100%)",
              padding: "5px 8px",
              borderRadius: 999,
              background: "rgba(250,204,21,0.95)",
              border: "1px solid rgba(255,255,255,0.8)",
              color: "#111827",
              fontSize: 11,
              fontWeight: 900,
              letterSpacing: 0.2,
              whiteSpace: "nowrap",
              animation: "selectedTrendlineBadgePulse 1.15s ease-out infinite",
              zIndex: 34,
            }}
          >
            {trendlineFocusOverlay.label}
          </div>
        ) : null}

        {trendlineHandleOverlays.map((handle) => (
          <div
            key={handle.id}
            title={handle.anchor === "p1" ? "Drag trendline start point" : "Drag trendline end point"}
            style={{
              position: "absolute",
              left: handle.left - (handle.selected ? 8 : 6),
              top: handle.top - (handle.selected ? 8 : 6),
              width: handle.selected ? 16 : 12,
              height: handle.selected ? 16 : 12,
              borderRadius: 999,
              background: handle.selected ? "rgba(250,204,21,0.95)" : "rgba(34,211,238,0.95)",
              border: "2px solid rgba(15,23,42,0.95)",
              boxShadow: handle.selected
                ? "0 0 0 2px rgba(250,204,21,0.35), 0 4px 12px rgba(0,0,0,0.40)"
                : "0 0 0 2px rgba(34,211,238,0.25), 0 4px 12px rgba(0,0,0,0.35)",
              animation: handle.selected ? "selectedTrendlinePulse 1s ease-in-out infinite" : undefined,
              zIndex: 30,
            }}
          />
        ))}

        {effectiveLineVisibility.sessionBands ? sessionBands.map((band, idx) => (
          <div
            key={`${band.kind}-${idx}-${band.startTime}`}
            style={{
              position: "absolute",
              left: band.left,
              top: 0,
              width: band.width,
              height: "100%",
              background:
                band.kind === "premarket" || band.kind === "afterhours" || band.kind === "overnight"
                  ? "rgba(209,213,219,0.16)"
                  : "rgba(0,0,0,0.00)",
              borderLeft:
                band.kind === "regular"
                  ? "1px solid rgba(34,197,94,0.12)"
                  : "1px solid rgba(255,255,255,0.06)",
              borderRight:
                band.kind === "regular"
                  ? "1px solid rgba(34,197,94,0.12)"
                  : "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 6,
                left: 6,
                padding: "2px 6px",
                borderRadius: 6,
                background:
                  band.kind === "premarket" || band.kind === "afterhours" || band.kind === "overnight"
                    ? "rgba(209,213,219,0.24)"
                    : "rgba(34,197,94,0.14)",
                border:
                  band.kind === "premarket" || band.kind === "afterhours" || band.kind === "overnight"
                    ? "1px solid rgba(209,213,219,0.40)"
                    : "1px solid rgba(34,197,94,0.22)",
                color:
                  band.kind === "premarket" || band.kind === "afterhours" || band.kind === "overnight"
                    ? "#e5e7eb"
                    : "#86efac",
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: 0.25,
              }}
            >
              {band.label}
            </div>
          </div>
        )) : null}

        {effectiveLineVisibility.compression && compressionRect ? (
          <>
            <div
              style={{
                position: "absolute",
                left: compressionRect.left,
                top: compressionRect.top,
                width: compressionRect.width,
                height: compressionRect.height,
                background:
                  compressionRect.direction === "bull"
                    ? "rgba(34,197,94,0.12)"
                    : "rgba(239,68,68,0.12)",
                border:
                  compressionRect.direction === "bull"
                    ? "1px solid rgba(34,197,94,0.42)"
                    : "1px solid rgba(239,68,68,0.42)",
                borderRadius: 4,
                boxShadow:
                  compressionRect.direction === "bull"
                    ? "0 0 0 1px rgba(34,197,94,0.08) inset"
                    : "0 0 0 1px rgba(239,68,68,0.08) inset",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: compressionRect.left + 6,
                top: Math.max(compressionRect.top - 22, 4),
                padding: "2px 6px",
                borderRadius: 6,
                background:
                  compressionRect.direction === "bull"
                    ? "rgba(34,197,94,0.14)"
                    : "rgba(239,68,68,0.14)",
                border:
                  compressionRect.direction === "bull"
                    ? "1px solid rgba(34,197,94,0.28)"
                    : "1px solid rgba(239,68,68,0.28)",
                color:
                  compressionRect.direction === "bull" ? "#86efac" : "#fca5a5",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.2,
              }}
            >
              {compressionRect.label}
            </div>
          </>
        ) : null}

        {effectiveLineVisibility.compression && breakoutMarker ? (
          <>
            <div
              style={
                breakoutMarker.direction === "up"
                  ? {
                      position: "absolute",
                      left: breakoutMarker.left - 7,
                      top: breakoutMarker.top - 26,
                      width: 0,
                      height: 0,
                      borderLeft: "7px solid transparent",
                      borderRight: "7px solid transparent",
                      borderBottom: `12px solid ${breakoutMarker.color}`,
                      filter: `drop-shadow(0 0 4px ${breakoutMarker.color}66)`,
                    }
                  : {
                      position: "absolute",
                      left: breakoutMarker.left - 7,
                      top: breakoutMarker.top + 12,
                      width: 0,
                      height: 0,
                      borderLeft: "7px solid transparent",
                      borderRight: "7px solid transparent",
                      borderTop: `12px solid ${breakoutMarker.color}`,
                      filter: `drop-shadow(0 0 4px ${breakoutMarker.color}66)`,
                    }
              }
            />
            <div
              style={{
                position: "absolute",
                left: breakoutMarker.left - 28,
                top:
                  breakoutMarker.direction === "up"
                    ? breakoutMarker.top - 46
                    : breakoutMarker.top + 28,
                padding: "2px 6px",
                borderRadius: 6,
                background:
                  breakoutMarker.direction === "up"
                    ? "rgba(34,197,94,0.15)"
                    : "rgba(239,68,68,0.15)",
                border:
                  breakoutMarker.direction === "up"
                    ? "1px solid rgba(34,197,94,0.35)"
                    : "1px solid rgba(239,68,68,0.35)",
                color:
                  breakoutMarker.direction === "up" ? "#86efac" : "#fca5a5",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.2,
              }}
            >
              {breakoutMarker.label}
            </div>
          </>
        ) : null}

        {effectiveLineVisibility.vwap
          ? vwapMarkers.map((marker, idx) => {
              const labelLane = getMarkerLabelStack(vwapMarkers, marker, idx);
              const labelGroup = "vwap";
              const labelExpanded = isSignalLabelExpanded(labelGroup, marker, idx);

              return (
              <div key={`${marker.label}-${idx}`}>
                <div
                  style={{
                    position: "absolute",
                    left: marker.left - 6,
                    top: marker.top - 22,
                    width: 0,
                    height: 0,
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                    borderBottom: `10px solid ${marker.color}`,
                    filter: `drop-shadow(0 0 4px ${marker.color}66)`,
                  }}
                />
                <div
                  style={getVerticalMarkerLabelStyle(
                    marker,
                    labelLane,
                    "rgba(56,189,248,0.14)",
                    "1px solid rgba(56,189,248,0.28)",
                    "#7dd3fc",
                    0,
                    labelExpanded
                  )}
                  title={getSignalLabelTitle(labelGroup, marker, idx)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSignalLabel(labelGroup, marker, idx);
                  }}
                >
                  {getSignalLabelText(labelGroup, vwapMarkers, marker, idx)}
                </div>
              </div>
            );
            })
          : null}

        {chochMarkers.map((marker, idx) => {
          const labelLane = 1 + getMarkerLabelStack(chochMarkers, marker, idx);
              const labelGroup = "choch";
              const labelExpanded = isSignalLabelExpanded(labelGroup, marker, idx);

          return (
          <div key={`${marker.label}-${idx}-${marker.left}-choch`}>
            <div
              style={
                marker.direction === "up"
                  ? {
                      position: "absolute",
                      left: marker.left - 6,
                      top: marker.top - 22,
                      width: 0,
                      height: 0,
                      borderLeft: "6px solid transparent",
                      borderRight: "6px solid transparent",
                      borderBottom: `10px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 4px ${marker.color}66)`,
                    }
                  : {
                      position: "absolute",
                      left: marker.left - 6,
                      top: marker.top + 10,
                      width: 0,
                      height: 0,
                      borderLeft: "6px solid transparent",
                      borderRight: "6px solid transparent",
                      borderTop: `10px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 4px ${marker.color}66)`,
                    }
              }
            />
            <div
              style={getVerticalMarkerLabelStyle(
                marker,
                labelLane,
                `${marker.color}22`,
                `1px solid ${marker.color}55`,
                marker.color,
                0,
                labelExpanded
              )}
              title={getSignalLabelTitle(labelGroup, marker, idx)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSignalLabel(labelGroup, marker, idx);
                  }}
                >
                  {getSignalLabelText(labelGroup, chochMarkers, marker, idx)}
                </div>
          </div>
          );
        })}


        {effectiveLineVisibility.significantCandles ? significantCandleMarkers.map((marker, idx) => {
          const dotSize = marker.dotSize ?? 9;

          return (
            <div
              key={`${marker.label}-${idx}-${marker.left}-significant-dot`}
              style={{
                position: "absolute",
                left: marker.left - dotSize / 2,
                top: marker.top - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: "999px",
                background: marker.color,
                border: "1px solid rgba(255,255,255,0.9)",
                boxShadow: `0 0 ${Math.max(7, dotSize)}px ${marker.color}`,
                pointerEvents: "auto",
              }}
              title={`${marker.label} candle`}
            />
          );
        }) : null}

        {effectiveLineVisibility.bodyBreakDots ? bodyBreakDotMarkers.map((marker, idx) => {
          const dotSize = marker.dotSize ?? 7;

          return (
            <div
              key={`${marker.label}-${idx}-${marker.left}-body-break-dot`}
              style={{
                position: "absolute",
                left: marker.left - dotSize / 2,
                top: marker.top - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: "999px",
                background: "#020617",
                border: "none",
                boxShadow: "0 0 4px rgba(0,0,0,0.65)",
                pointerEvents: "auto",
              }}
              title="Open or close below previous candle body"
            />
          );
        }) : null}

        {effectiveLineVisibility.closeAbovePrevCloseDots ? closeAbovePrevCloseDotMarkers.map((marker, idx) => {
          const dotSize = marker.dotSize ?? 7;

          return (
            <div
              key={`${marker.label}-${idx}-${marker.left}-close-above-prev-close-dot`}
              style={{
                position: "absolute",
                left: marker.left - dotSize / 2,
                top: marker.top - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: "999px",
                background: "#ffffff",
                border: "1px solid rgba(2,6,23,0.95)",
                boxShadow: "0 0 6px rgba(255,255,255,0.65)",
                pointerEvents: "auto",
              }}
              title="Close above previous candle close"
            />
          );
        }) : null}

        {effectiveLineVisibility.atrExpansionCandles ? atrExpansionMarkers.map((marker, idx) => {
          const dotSize = marker.dotSize ?? 9;

          return (
            <div
              key={`${marker.label}-${idx}-${marker.left}-atr-expansion-dot`}
              style={{
                position: "absolute",
                left: marker.left - dotSize / 2,
                top: marker.top - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: "999px",
                background: marker.color,
                border: "1px solid rgba(15,23,42,0.95)",
                boxShadow: `0 0 ${Math.max(8, dotSize)}px ${marker.color}` ,
                pointerEvents: "auto",
              }}
              title={marker.label}
            />
          );
        }) : null}

        {effectiveLineVisibility.resistanceBreakoutConfirm ? resistanceBreakoutMarkers.map((marker, idx) => {
          const dotSize = marker.dotSize ?? 11;

          return (
            <div
              key={`${marker.label}-${idx}-${marker.left}-resistance-breakout-confirm`}
              style={{
                position: "absolute",
                left: marker.left - dotSize / 2,
                top: marker.top - dotSize - 8,
                minWidth: dotSize,
                height: dotSize + 4,
                padding: "0 4px",
                borderRadius: "999px",
                background: "rgba(34,197,94,0.95)",
                border: "1px solid rgba(220,252,231,0.95)",
                color: "#052e16",
                fontSize: 10,
                fontWeight: 900,
                lineHeight: `${dotSize + 4}px`,
                textAlign: "center",
                boxShadow: "0 0 12px rgba(34,197,94,0.8)",
                pointerEvents: "auto",
              }}
              title={marker.label}
            >
              BO
            </div>
          );
        }) : null}

        {effectiveLineVisibility.liquiditySweeps ? liquiditySweepMarkers.map((marker, idx) => {
          const labelLane = 2 + getMarkerLabelStack(liquiditySweepMarkers, marker, idx);
              const labelGroup = "liquidity";
              const labelExpanded = isSignalLabelExpanded(labelGroup, marker, idx);

          return (
          <div key={`${marker.label}-${idx}-${marker.left}-liquidity-sweep`}>
            <div
              style={
                marker.direction === "up"
                  ? {
                      position: "absolute",
                      left: marker.left - 6,
                      top: marker.top - 22,
                      width: 0,
                      height: 0,
                      borderLeft: "6px solid transparent",
                      borderRight: "6px solid transparent",
                      borderBottom: `10px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 5px ${marker.color}88)`,
                    }
                  : {
                      position: "absolute",
                      left: marker.left - 6,
                      top: marker.top + 10,
                      width: 0,
                      height: 0,
                      borderLeft: "6px solid transparent",
                      borderRight: "6px solid transparent",
                      borderTop: `10px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 5px ${marker.color}88)`,
                    }
              }
            />
            <div
              style={getVerticalMarkerLabelStyle(
                marker,
                labelLane,
                `${marker.color}22`,
                `1px solid ${marker.color}55`,
                marker.color,
                0,
                labelExpanded
              )}
              title={getSignalLabelTitle(labelGroup, marker, idx)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSignalLabel(labelGroup, marker, idx);
                  }}
                >
                  {getSignalLabelText(labelGroup, liquiditySweepMarkers, marker, idx)}
                </div>
          </div>
          );
        }) : null}


        {effectiveLineVisibility.volumeSignals ? volumeSignalMarkers.map((marker, idx) => {
          const dotSize = marker.dotSize ?? 11;

          return (
            <div
              key={`${marker.label}-${idx}-${marker.left}-volume-signal`}
              style={{
                position: "absolute",
                left: marker.left - dotSize / 2,
                top: marker.top - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: "999px",
                background: marker.color,
                border: "2px solid rgba(255,255,255,0.95)",
                boxShadow: `0 0 ${Math.max(9, dotSize + 3)}px ${marker.color}`,
                pointerEvents: "auto",
              }}
              title={marker.label}
            />
          );
        }) : null}

        {effectiveLineVisibility.trendlineCloseAlerts ? trendlineCloseMarkers.map((marker, idx) => {
          // Keep the TL close compact badge snapped to the exact candle x-position.
          // Do NOT add a lane offset here; the previous +4 lane offset pushed the popup
          // several candles to the right of the actual TL Close arrow.
          const labelLane = getMarkerLabelStack(trendlineCloseMarkers, marker, idx);
          const labelGroup = "tlclose";
          const labelExpanded = isSignalLabelExpanded(labelGroup, marker, idx);
          const labelBaseStyle = getVerticalMarkerLabelStyle(
            marker,
            0,
            `${marker.color}22`,
            `1px solid ${marker.color}66`,
            marker.color,
            0,
            labelExpanded
          );
          const labelStackOffset = labelLane * (labelExpanded ? 24 : 18);

          return (
          <div key={`${marker.label}-${idx}-${marker.left}-tl-close`}>
            <div
              style={
                marker.direction === "up"
                  ? {
                      position: "absolute",
                      left: marker.left - 8,
                      // Put the up arrow just below the candle low so it is visible on green candles.
                      top: marker.top + 6 + labelLane * 2,
                      width: 0,
                      height: 0,
                      borderLeft: "8px solid transparent",
                      borderRight: "8px solid transparent",
                      borderBottom: `14px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 6px rgba(255,255,255,0.95)) drop-shadow(0 0 6px ${marker.color})`,
                      zIndex: 18,
                    }
                  : {
                      position: "absolute",
                      left: marker.left - 8,
                      // Put the down arrow just above the candle high so it is visible on red candles.
                      top: marker.top - 22 - labelLane * 2,
                      width: 0,
                      height: 0,
                      borderLeft: "8px solid transparent",
                      borderRight: "8px solid transparent",
                      borderTop: `14px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 6px rgba(255,255,255,0.95)) drop-shadow(0 0 6px ${marker.color})`,
                      zIndex: 18,
                    }
              }
            />
            <div
              style={{
                ...labelBaseStyle,
                left: marker.left,
                top: marker.direction === "up"
                  ? marker.top + 24 + labelStackOffset
                  : marker.top - 30 - labelStackOffset,
                transform: labelExpanded
                  ? marker.direction === "up"
                    ? "translateX(-50%)"
                    : "translate(-50%, -100%)"
                  : "translateX(-50%)",
                zIndex: 24 + labelLane,
              }}
              title={getSignalLabelTitle(labelGroup, marker, idx)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSignalLabel(labelGroup, marker, idx);
                  }}
                >
                  {getSignalLabelText(labelGroup, trendlineCloseMarkers, marker, idx)}
                </div>
          </div>
          );
        }) : null}

        {effectiveLineVisibility.fakeEngulfing ? fakeEngulfingMarkers.map((marker, idx) => {
          const labelLane = 3 + getMarkerLabelStack(fakeEngulfingMarkers, marker, idx);
              const labelGroup = "fakeengulf";
              const labelExpanded = isSignalLabelExpanded(labelGroup, marker, idx);

          return (
          <div key={`${marker.label}-${idx}-${marker.left}-fake-engulf`}>
            <div
              style={
                marker.direction === "up"
                  ? {
                      position: "absolute",
                      left: marker.left - 7,
                      top: marker.top - 24,
                      width: 0,
                      height: 0,
                      borderLeft: "7px solid transparent",
                      borderRight: "7px solid transparent",
                      borderBottom: `12px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 5px ${marker.color}88)`,
                    }
                  : {
                      position: "absolute",
                      left: marker.left - 7,
                      top: marker.top + 12,
                      width: 0,
                      height: 0,
                      borderLeft: "7px solid transparent",
                      borderRight: "7px solid transparent",
                      borderTop: `12px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 5px ${marker.color}88)`,
                    }
              }
            />
            <div
              style={getVerticalMarkerLabelStyle(
                marker,
                labelLane,
                `${marker.color}22`,
                `1px solid ${marker.color}66`,
                marker.color,
                0,
                labelExpanded
              )}
              title={getSignalLabelTitle(labelGroup, marker, idx)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSignalLabel(labelGroup, marker, idx);
                  }}
                >
                  {getSignalLabelText(labelGroup, fakeEngulfingMarkers, marker, idx)}
                </div>
          </div>
          );
        }) : null}

        {effectiveLineVisibility.trendlines ? signalMarkers.map((marker, idx) => {
          const labelLane = 4 + getMarkerLabelStack(signalMarkers, marker, idx);
              const labelGroup = "signal";
              const labelExpanded = isSignalLabelExpanded(labelGroup, marker, idx);

          return (
          <div key={`${marker.label}-${idx}-${marker.left}`}>
            <div
              style={
                marker.direction === "up"
                  ? {
                      position: "absolute",
                      left: marker.left - 6,
                      top: marker.top - 22,
                      width: 0,
                      height: 0,
                      borderLeft: "6px solid transparent",
                      borderRight: "6px solid transparent",
                      borderBottom: `10px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 4px ${marker.color}66)`,
                    }
                  : {
                      position: "absolute",
                      left: marker.left - 6,
                      top: marker.top + 10,
                      width: 0,
                      height: 0,
                      borderLeft: "6px solid transparent",
                      borderRight: "6px solid transparent",
                      borderTop: `10px solid ${marker.color}`,
                      filter: `drop-shadow(0 0 4px ${marker.color}66)`,
                    }
              }
            />
            <div
              style={getVerticalMarkerLabelStyle(
                marker,
                labelLane,
                `${marker.color}22`,
                `1px solid ${marker.color}55`,
                marker.color,
                0,
                labelExpanded
              )}
              title={getSignalLabelTitle(labelGroup, marker, idx)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSignalLabel(labelGroup, marker, idx);
                  }}
                >
                  {getSignalLabelText(labelGroup, signalMarkers, marker, idx)}
                </div>
          </div>
          );
        }) : null}
      </div>

      {error ? (
        <div
          style={{
            position: "absolute",
            top: 50,
            right: 12,
            zIndex: 12,
            padding: "8px 10px",
            borderRadius: 8,
            background: "rgba(127,29,29,0.88)",
            border: "1px solid rgba(248,113,113,0.5)",
            color: "#fecaca",
            fontSize: 12,
            maxWidth: 340,
          }}
        >
          {error}
        </div>
      ) : null}

      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          minHeight: 320,
          cursor: drawMode ? "crosshair" : "default",
        }}
      />
    </div>
  );
}



const toolbarButtonStyle: CSSProperties = {
  height: 30,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(15,23,42,0.92)",
  color: "#e2e8f0",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};


const toolbarIconButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  padding: 0,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(15,23,42,0.92)",
  color: "#e2e8f0",
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const toolbarSelectStyle: CSSProperties = {
  height: 30,
  padding: "0 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(15,23,42,0.92)",
  color: "#e2e8f0",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const legendBoxStyle: CSSProperties = {
  background: "rgba(5, 18, 45, 0.88)",
  border: "1px solid rgba(255,255,255,0.09)",
  color: "#dbeafe",
  padding: "8px 12px",
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 700,
  backdropFilter: "blur(4px)",
};

const sameVisibility = (a: OverlayVisibility, b: OverlayVisibility) =>
  a.pmh === b.pmh &&
  a.vwap === b.vwap &&
  a.compression === b.compression &&
  a.choch === b.choch &&
  a.sessionBands === b.sessionBands &&
  a.projections === b.projections &&
  a.trendlines === b.trendlines &&
  (a.trendlineCloseAlerts ?? true) === (b.trendlineCloseAlerts ?? true);

const sameTrendlineAction = (a: TrendlineControlAction | undefined, b: TrendlineControlAction | undefined) =>
  (a?.type ?? "none") === (b?.type ?? "none");

export default memo(ChartPanelComponent, (prev, next) =>
  prev.symbol === next.symbol &&
  prev.timeframe === next.timeframe &&
  sameVisibility(prev.visibility, next.visibility) &&
  sameTrendlineAction(prev.trendlineAction, next.trendlineAction) &&
  prev.trendlineSnapMode === next.trendlineSnapMode &&
  prev.showInChartWatchlistAdder === next.showInChartWatchlistAdder &&
  prev.openOrders === next.openOrders &&
  prev.onCancelOrder === next.onCancelOrder &&
  prev.onReplaceOrderPrice === next.onReplaceOrderPrice
);
