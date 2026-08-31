// src/components/chart/ChartEngine.ts

import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  TickMarkType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type LineData,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";

import type { ChartState } from "./ChartState";

import { buildEmaBars, getCurrentEMA } from "./studies/EmaStudy";
import {
  DEFAULT_CHART_SETTINGS,
  type ChartSessionBandKey,
  type ChartSettings,
} from "./ChartSettingsTypes";
import { getSmartSnapPrice } from "./SnapManager";
import { StudyRenderer } from "./studies/StudyRenderer";
import { ChartInteractionManager } from "./interaction/ChartInteractionManager";
import type { ChartTool, ChartToolId } from "./interaction/ChartTool";
import type { FocusSelection } from "./interaction/ToolContext";
import { ChartAutoScaleManager } from "./ChartAutoScaleManager";
import { getCurrentVWAP } from "./studies/VWAPStudy";
import { getCurrentATR } from "./studies/ATRStudy";
import { buildMarketStructure } from "./analysis/MarketStructureEngine";
import { buildCompression } from "./analysis/CompressionEngine";
import { buildMomentum } from "./analysis/MomentumEngine";
import {
  AnalysisRenderer,
  AnalysisStore,
  DEFAULT_FX_ANALYSIS_SETTINGS,
  buildFxAnalysisResult,
  type FxAnalysisSettings,
  type FxAnalysisToolId,
} from "./analysis";
import type {
  ChartSeriesBundle,
  CleanBar,
  CrosshairInfo,
  StudyVisibility,
} from "./ChartTypes";
import { PositionOverlayEngine } from "../../trading/overlay/PositionOverlayEngine";
import { PositionOverlayRenderer } from "../../trading/overlay/PositionOverlayRenderer";
import { marketObjectRegistry } from "./analysis/market-objects/MarketObjectRegistry";
import type { MarketObject } from "./analysis/market-objects/MarketObjectTypes";


export type Vwap3ChartSetupOverlay = {
  symbol: string;
  setupKey?: string;
  grade?: string;
  status?: string;
  outcome?: string;
  displacementTime?: string;
  displacementHigh?: number;
  displacementLow?: number;
  freezeUpper3Std?: number;
  freezeLower3Std?: number;
  targetPrice?: number;
  currentScore?: number;
  scoreAtFreeze?: number;
};

function volumeColor(bar: CleanBar): string {
  return bar.close >= bar.open
    ? "rgba(34, 197, 94, 0.35)"
    : "rgba(239, 68, 68, 0.35)";
}


const PACIFIC_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const PACIFIC_AXIS_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
});

const PACIFIC_AXIS_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
});

function chartTimeToTimestampMs(time: Time): number | null {
  if (typeof time === "number") return time * 1000;

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (time && typeof time === "object" && "year" in time) {
    return Date.UTC(time.year, time.month - 1, time.day);
  }

  return null;
}

function formatPacificChartTime(time: Time): string {
  const timestamp = chartTimeToTimestampMs(time);
  if (timestamp == null) return "";

  return PACIFIC_TIME_FORMATTER.format(new Date(timestamp));
}

function formatPacificTimeScaleTick(time: Time, tickMarkType: TickMarkType): string {
  const timestamp = chartTimeToTimestampMs(time);
  if (timestamp == null) return "";

  const date = new Date(timestamp);

  if (tickMarkType === TickMarkType.Year) {
    return PACIFIC_AXIS_YEAR_FORMATTER.format(date);
  }

  if (
    tickMarkType === TickMarkType.Month ||
    tickMarkType === TickMarkType.DayOfMonth
  ) {
    return PACIFIC_AXIS_DATE_FORMATTER.format(date);
  }

  return PACIFIC_TIME_FORMATTER.format(date);
}

const NEW_YORK_TIME_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const NEW_YORK_MARKET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function getMarketDateKey(time: Time): string | null {
  const timestamp = chartTimeToTimestampMs(time);
  if (timestamp == null) return null;

  return NEW_YORK_MARKET_DATE_FORMATTER.format(new Date(timestamp));
}

function getTradingDayLimit(timeframe?: string): number | null {
  const normalized = String(timeframe ?? "").trim().toLowerCase();

  if (normalized === "1m" || normalized === "1min") return 3;
  if (normalized === "5m" || normalized === "5min") return 5;

  return null;
}

function trimBarsForTimeframe(
  bars: CleanBar[],
  timeframe?: string,
): CleanBar[] {
  const tradingDayLimit = getTradingDayLimit(timeframe);

  if (tradingDayLimit == null) {
    return bars.slice(-500);
  }

  const keptDates = new Set<string>();
  let startIndex = bars.length;

  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const dateKey = getMarketDateKey(bars[index].time);
    if (!dateKey) continue;

    if (!keptDates.has(dateKey)) {
      if (keptDates.size >= tradingDayLimit) {
        break;
      }

      keptDates.add(dateKey);
    }

    startIndex = index;
  }

  return bars.slice(startIndex);
}

function getEasternMinutes(time: Time): number | null {
  const timestamp =
    typeof time === "number"
      ? time * 1000
      : typeof time === "string"
        ? Date.parse(time)
        : time && typeof time === "object" && "year" in time
          ? Date.UTC(time.year, time.month - 1, time.day)
          : NaN;

  if (!Number.isFinite(timestamp)) return null;

  const parts = NEW_YORK_TIME_PARTS_FORMATTER.formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? NaN);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? NaN);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const normalizedHour = hour === 24 ? 0 : hour;
  return normalizedHour * 60 + minute;
}

function getSessionBandKey(time: Time): ChartSessionBandKey | null {
  const minutes = getEasternMinutes(time);
  if (minutes == null) return null;

  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "afterHours";

  return null;
}

function getSessionBandColor(
  key: ChartSessionBandKey,
  opacity: number,
): string {
  if (key === "premarket") return `rgba(59, 130, 246, ${opacity})`;
  if (key === "regular") return `rgba(255, 255, 255, ${opacity * 0.45})`;
  return `rgba(168, 85, 247, ${opacity})`;
}

export type ChartPointerPoint = {
  time: number;
  price: number;
  rawPrice: number;
  x: number;
  y: number;
  snappedTo: "high" | "low" | "open" | "close" | null;
  bar: CleanBar | null;
  nativeEvent?: PointerEvent | MouseEvent;
};

function chartTimeToNumber(time: Time): number | null {
  if (typeof time === "number") return time;

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }

  if (time && typeof time === "object" && "year" in time) {
    const date = Date.UTC(time.year, time.month - 1, time.day);
    return Math.floor(date / 1000);
  }

  return null;
}


function buildCrosshairInfoFromBar(bar: CleanBar): CrosshairInfo & { range: number } {
  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    range: bar.high - bar.low,
  } as CrosshairInfo & { range: number };
}

function buildVwapBars(bars: CleanBar[]): LineData<Time>[] {
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  return bars
    .map((bar) => {
      const typicalPrice = (bar.high + bar.low + bar.close) / 3;

      cumulativePV += typicalPrice * bar.volume;
      cumulativeVolume += bar.volume;

      if (cumulativeVolume <= 0) return null;

      return {
        time: bar.time,
        value: cumulativePV / cumulativeVolume,
      };
    })
    .filter(Boolean) as LineData<Time>[];
}

const LIVE_STUDY_THROTTLE_MS = 750;

export class ChartEngine {
  readonly chart: IChartApi;
  readonly series: ChartSeriesBundle;

  private bars: CleanBar[] = [];
  private container: HTMLDivElement;
  private crosshairListeners = new Set<(info: CrosshairInfo | null) => void>();
  private interactionManager: ChartInteractionManager;
  private handleCrosshairMove: (param: MouseEventParams<Time>) => void;
  private lastCrosshairInfo: (CrosshairInfo & { range: number }) | null = null;
  private analysisRenderer: AnalysisRenderer;
  private studyRenderer: StudyRenderer;
  private analysisStore = new AnalysisStore();
  private autoScaleManager = new ChartAutoScaleManager();
  private fxAnalysisSettings: FxAnalysisSettings = DEFAULT_FX_ANALYSIS_SETTINGS;
  private chartSettings: ChartSettings = DEFAULT_CHART_SETTINGS;
  private symbol?: string;
  private timeframe?: string;
  private sessionOverlay: HTMLDivElement;
  private sessionRenderFrame: number | null = null;
  private handleVisibleRangeChange: () => void;
  private positionOverlayEngine: PositionOverlayEngine;
  private positionOverlayRenderer: PositionOverlayRenderer;
  private unsubscribePositionOverlay: (() => void) | null = null;
  private unsubscribeAnalysisStore: (() => void) | null = null;
  private fxAutoScaleRangeKey = "none";
  private forceNextFxAutoScale = false;
  private vwap3SetupOverlay: Vwap3ChartSetupOverlay | null = null;
  private vwap3UpperPriceLine: IPriceLine | null = null;
  private vwap3LowerPriceLine: IPriceLine | null = null;
  private vwap3TargetPriceLine: IPriceLine | null = null;
  private vwap3ExpansionOverlay: HTMLDivElement;
  private vwap3OverlayRenderFrame: number | null = null;

  // Live candle updates can arrive many times per second. Keep the expensive
  // study algorithms off the hot path and update EMA/VWAP from cached prefix
  // state instead of rebuilding every historical value on each tick.
  private vwapPrefixPriceVolume = 0;
  private vwapPrefixVolume = 0;
  private ema9PreviousValue: number | null = null;
  private ema20PreviousValue: number | null = null;
  private ema50PreviousValue: number | null = null;
  private currentVwapValue: number | null = null;
  private currentEma9Value: number | null = null;
  private currentEma20Value: number | null = null;
  private currentEma50Value: number | null = null;
  private vwap3ExpansionVisible = true;
  private lastLiveStudyRenderAt = 0;
  private liveStudyRenderTimer: number | null = null;

  // Decision Center / intelligence can request ChartState on every live tick.
  // Structure, compression and momentum only need a full recalculation when a
  // new bar arrives (or historical data/context is replaced).
  private derivedStateCacheKey = "";
  private cachedStructure: ReturnType<typeof buildMarketStructure> | null = null;
  private cachedCompression: ReturnType<typeof buildCompression> | null = null;
  private cachedMomentum: ReturnType<typeof buildMomentum> | null = null;

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.container.style.position = this.container.style.position || "relative";

    this.sessionOverlay = document.createElement("div");
    this.sessionOverlay.style.position = "absolute";
    this.sessionOverlay.style.inset = "0";
    this.sessionOverlay.style.pointerEvents = "none";
    this.sessionOverlay.style.overflow = "hidden";
    this.sessionOverlay.style.zIndex = "2";
    this.container.appendChild(this.sessionOverlay);

    this.vwap3ExpansionOverlay = document.createElement("div");
    this.vwap3ExpansionOverlay.style.position = "absolute";
    this.vwap3ExpansionOverlay.style.inset = "0";
    this.vwap3ExpansionOverlay.style.pointerEvents = "none";
    this.vwap3ExpansionOverlay.style.overflow = "hidden";
    this.vwap3ExpansionOverlay.style.zIndex = "5";
    this.container.appendChild(this.vwap3ExpansionOverlay);

    this.chart = createChart(container, {
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      layout: {
        background: {
          type: ColorType.Solid,
          color: "#111315",
        },
        textColor: "#d0d0d0",
      },
      grid: {
        vertLines: {
          color: "rgba(255,255,255,.04)",
        },
        horzLines: {
          color: "rgba(255,255,255,.04)",
        },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          visible: true,
          labelVisible: true,
          style: LineStyle.Dashed,
          color: "rgba(255,255,255,.55)",
        },
        horzLine: {
          visible: true,
          labelVisible: true,
          style: LineStyle.Dashed,
          color: "rgba(255,255,255,.35)",
        },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: {
          top: 0.08,
          bottom: 0.25,
        },
      },
      localization: {
        locale: "en-US",
        timeFormatter: (time: Time) => formatPacificChartTime(time),
      },
      timeScale: {
        visible: true,
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 8,
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) =>
          formatPacificTimeScaleTick(time, tickMarkType),
      },
    });

    const candles = this.chart.addSeries(CandlestickSeries);

    const volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: {
        type: "volume",
      },
      lastValueVisible: false,
      priceLineVisible: false,
    });

    this.chart.priceScale("volume").applyOptions({
      scaleMargins: {
        top: 0.78,
        bottom: 0,
      },
    });

    const vwap = this.chart.addSeries(LineSeries, {
      color: "#38bdf8",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "VWAP",
    });

    const ema9 = this.chart.addSeries(LineSeries, {
      color: "#facc15",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "EMA 9",
    });

    const ema20 = this.chart.addSeries(LineSeries, {
      color: "#a855f7",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "EMA 20",
    });

    const ema50 = this.chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "EMA 50",
    });

    this.series = {
      candles,
      volume,
      vwap,
      ema9,
      ema20,
      ema50,
    };

    this.analysisRenderer = new AnalysisRenderer(this.chart);
    this.studyRenderer = new StudyRenderer(this.chart, this.container, this.series.candles);
    this.unsubscribeAnalysisStore = this.analysisStore.subscribe(() => {
      this.renderFxAnalysis();
      this.synchronizeFxAnalysisMarketObjects();
      this.refreshFxAutoScaleIfNeeded(this.forceNextFxAutoScale);
      this.forceNextFxAutoScale = false;
    });
    this.positionOverlayEngine = new PositionOverlayEngine();
    this.positionOverlayRenderer = new PositionOverlayRenderer(
      this.container,
    );
    this.unsubscribePositionOverlay = this.positionOverlayEngine.subscribe((state) => {
      this.positionOverlayRenderer.update(state);
    });

    // Keep the chart fast: this autoscale provider only scans the current
    // in-memory 500 bars and the small FX analysis store. No DOM work, no
    // recalculation of algorithms, and no series creation happens here.
    const autoScaleInfoProvider = (baseImplementation: () => {
        priceRange?: { minValue: number; maxValue: number } | null;
        margins?: unknown;
      } | null) => {
        const base = baseImplementation?.() ?? null;
        const priceRange = this.buildAutoScalePriceRange(base?.priceRange ?? null);

        if (!priceRange) {
          return base;
        }

        return {
          ...(base ?? {}),
          priceRange,
        };
      };

    // Every visible price series must use the same shifted range. Otherwise
    // VWAP or an EMA could keep the scale anchored while the candles move.
    for (const priceSeries of [
      this.series.candles,
      this.series.vwap,
      this.series.ema9,
      this.series.ema20,
      this.series.ema50,
    ]) {
      (priceSeries as unknown as {
        applyOptions?: (options: Record<string, unknown>) => void;
      }).applyOptions?.({
        autoscaleInfoProvider: autoScaleInfoProvider,
      });
    }

    this.handleVisibleRangeChange = () => {
      this.scheduleSessionBandsRender();
      this.studyRenderer.scheduleOverlayRender();
      this.scheduleVwap3OverlayRender();
    };

    this.handleCrosshairMove = (param) => {
      // When the cursor is between candles or outside the plot area,
      // Lightweight Charts can send no time or no matching candle.
      // Keep showing the last valid candle so O/H/L/C/R/V do not fall
      // back to zero/blank while the user is moving around the chart.
      if (!param.time) {
        this.emitCrosshairInfo(this.lastCrosshairInfo ?? this.getLastBarInfo());
        return;
      }

      const bar = this.bars.find(
        (item) => Number(item.time) === Number(param.time),
      );

      if (!bar) {
        this.emitCrosshairInfo(this.lastCrosshairInfo ?? this.getLastBarInfo());
        return;
      }

      const nextInfo = buildCrosshairInfoFromBar(bar);
      this.lastCrosshairInfo = nextInfo;

      this.emitCrosshairInfo(nextInfo);
    };


    this.interactionManager = new ChartInteractionManager({
      container: this.container,
      chart: this.chart,
      buildPointFromClick: (param) => this.buildPointFromChartClick(param),
      buildPointFromPointerEvent: (event) => this.buildPointFromPointerEvent(event),
      buildFallbackPointFromMouseEvent: (event) =>
        this.buildFallbackPointFromMouseEvent(event),
      focusSelection: (selection) => this.focusSelection(selection),
      resetFocus: () => this.resetFocus(),
      panPriceScale: (deltaY) => this.panPriceScale(deltaY),
      panTimeScale: (deltaX) => this.panTimeScale(deltaX),
      setChartNavigationEnabled: (enabled) =>
        this.setChartNavigationEnabled(enabled),
    });

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);
    this.chart.subscribeCrosshairMove(this.handleCrosshairMove);
  }

  subscribeCrosshairInfo(
    listener: (info: CrosshairInfo | null) => void,
  ): () => void {
    this.crosshairListeners.add(listener);

    return () => {
      this.crosshairListeners.delete(listener);
    };
  }


  registerInteractionTool(tool: ChartTool): void {
    this.interactionManager.registerTool(tool);
  }

  activateInteractionTool(toolId: ChartToolId): boolean {
    return this.interactionManager.activateTool(toolId);
  }

  subscribeClick(listener: (point: ChartPointerPoint) => void): () => void {
    return this.interactionManager.subscribeClick(listener);
  }

  subscribePointerDown(
    listener: (point: ChartPointerPoint) => void,
  ): () => void {
    return this.interactionManager.subscribePointerDown(listener);
  }

  subscribePointerMove(
    listener: (point: ChartPointerPoint) => void,
  ): () => void {
    return this.interactionManager.subscribePointerMove(listener);
  }

  subscribePointerUp(listener: (point: ChartPointerPoint) => void): () => void {
    return this.interactionManager.subscribePointerUp(listener);
  }

  subscribeContextMenu(
    listener: (point: ChartPointerPoint) => void,
  ): () => void {
    return this.interactionManager.subscribeContextMenu(listener);
  }

  getContainer(): HTMLDivElement {
    return this.container;
  }

  private emitCrosshairInfo(info: CrosshairInfo | null): void {
    for (const listener of this.crosshairListeners) {
      listener(info);
    }
  }

  private findNearestBar(time: number): CleanBar | null {
    if (!this.bars.length) return null;

    let best = this.bars[0];
    let bestDistance = Math.abs(Number(best.time) - time);

    for (const bar of this.bars) {
      const distance = Math.abs(Number(bar.time) - time);
      if (distance < bestDistance) {
        best = bar;
        bestDistance = distance;
      }
    }

    return best;
  }

  private findBarByXCoordinate(x: number): CleanBar | null {
    if (!this.bars.length) return null;

    // For drawing tools, we want the actual candle under the mouse, not an
    // interpolated timestamp. Lightweight Charts maps x pixels to logical
    // bar indexes, so snapping should start from the rounded logical index.
    const timeScale = this.chart.timeScale() as unknown as {
      coordinateToLogical?: (coordinate: number) => number | null;
    };

    const logical = timeScale.coordinateToLogical?.(x);

    if (logical == null || !Number.isFinite(Number(logical))) {
      return null;
    }

    const index = Math.max(
      0,
      Math.min(this.bars.length - 1, Math.round(Number(logical))),
    );

    return this.bars[index] ?? null;
  }

  private buildPointFromChartClick(
    param: MouseEventParams<Time>,
  ): ChartPointerPoint | null {
    if (!param.time || !param.point) return null;

    const time = chartTimeToNumber(param.time);
    if (time == null) return null;

    const seriesBar = param.seriesData.get(this.series.candles) as
      | CandlestickData<Time>
      | undefined;

    const forcedBar = seriesBar
      ? ({
          time: time as Time,
          open: Number(seriesBar.open),
          high: Number(seriesBar.high),
          low: Number(seriesBar.low),
          close: Number(seriesBar.close),
          volume: 0,
        } as CleanBar)
      : null;

    return this.buildPointFromCoordinates(
      param.point.x,
      param.point.y,
      time,
      forcedBar,
    );
  }

  private buildPointFromPointerEvent(
    event: PointerEvent,
  ): ChartPointerPoint | null {
    return this.buildPointFromMouseEvent(event);
  }

  private buildPointFromMouseEvent(
    event: PointerEvent | MouseEvent,
  ): ChartPointerPoint | null {
    const rect = this.container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return null;
    }

    const rawTime = this.chart.timeScale().coordinateToTime(x);
    if (rawTime == null) return null;

    const time = chartTimeToNumber(rawTime);
    if (time == null) return null;

    const point = this.buildPointFromCoordinates(x, y, time);
    if (!point) return null;

    return {
      ...point,
      nativeEvent: event,
    };
  }

  private buildPointFromCoordinates(
    x: number,
    y: number,
    fallbackTime?: number,
    forcedBar?: CleanBar | null,
  ): ChartPointerPoint | null {
    const rawPrice = this.series.candles.coordinateToPrice(y);
    if (rawPrice == null || !Number.isFinite(rawPrice)) return null;

    const bar =
      forcedBar ??
      this.findBarByXCoordinate(x) ??
      (fallbackTime != null ? this.findNearestBar(fallbackTime) : null);

    if (!bar) return null;

    const snap = getSmartSnapPrice({
      bar,
      mousePrice: rawPrice,
      mouseY: y,
      tolerancePx: 18,
      priceToCoordinate: (targetPrice) =>
        this.series.candles.priceToCoordinate(targetPrice),
    });

    return {
      // Store the exact candle timestamp from the rounded logical bar. This
      // keeps the x-position and the snapped OHLC price from the same candle.
      time: Number(bar.time),
      price: snap.price,
      rawPrice,
      x,
      y,
      snappedTo: snap.snapped ? (snap.target ?? null) : null,
      bar,
    };
  }

  private buildFallbackPointFromMouseEvent(
    event: PointerEvent | MouseEvent,
  ): ChartPointerPoint | null {
    const lastBar = this.bars[this.bars.length - 1];
    if (!lastBar) return null;

    const rect = this.container.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const rawPrice = this.series.candles.coordinateToPrice(y) ?? lastBar.close;

    return {
      time: Number(lastBar.time),
      price: Number(rawPrice),
      rawPrice: Number(rawPrice),
      x,
      y,
      snappedTo: null,
      bar: lastBar,
      nativeEvent: event,
    };
  }

  setDrawingMode(_active: boolean): void {
    // Keep chart navigation enabled for normal drawing tools.
    // Temporary tools such as Focus Box can disable navigation through
    // setChartNavigationEnabled while their gesture is active.
    this.setChartNavigationEnabled(true);
  }

  setChartNavigationEnabled(enabled: boolean): void {
    this.chart.applyOptions({
      handleScroll: enabled
        ? {
            mouseWheel: true,
            pressedMouseMove: false,
            horzTouchDrag: true,
            vertTouchDrag: true,
          }
        : false,
      handleScale: enabled
        ? {
            axisPressedMouseMove: false,
            mouseWheel: true,
            pinch: true,
          }
        : false,
    });
  }


  private rebuildLiveIndicatorState(): void {
    this.vwapPrefixPriceVolume = 0;
    this.vwapPrefixVolume = 0;
    this.ema9PreviousValue = null;
    this.ema20PreviousValue = null;
    this.ema50PreviousValue = null;
    this.currentVwapValue = null;
    this.currentEma9Value = null;
    this.currentEma20Value = null;
    this.currentEma50Value = null;

    if (!this.bars.length) return;

    const ema9Multiplier = 2 / 10;
    const ema20Multiplier = 2 / 21;
    const ema50Multiplier = 2 / 51;
    let ema9: number | null = null;
    let ema20: number | null = null;
    let ema50: number | null = null;

    for (let index = 0; index < this.bars.length - 1; index += 1) {
      const bar = this.bars[index];
      const typicalPrice = (bar.high + bar.low + bar.close) / 3;

      this.vwapPrefixPriceVolume += typicalPrice * bar.volume;
      this.vwapPrefixVolume += bar.volume;

      ema9 =
        ema9 == null
          ? bar.close
          : bar.close * ema9Multiplier + ema9 * (1 - ema9Multiplier);
      ema20 =
        ema20 == null
          ? bar.close
          : bar.close * ema20Multiplier + ema20 * (1 - ema20Multiplier);
      ema50 =
        ema50 == null
          ? bar.close
          : bar.close * ema50Multiplier + ema50 * (1 - ema50Multiplier);
    }

    this.ema9PreviousValue = ema9;
    this.ema20PreviousValue = ema20;
    this.ema50PreviousValue = ema50;
    this.updateLiveIndicatorValues(this.bars[this.bars.length - 1]);
  }

  private updateLiveIndicatorValues(bar: CleanBar): void {
    const ema9Multiplier = 2 / 10;
    const ema20Multiplier = 2 / 21;
    const ema50Multiplier = 2 / 51;

    this.currentEma9Value =
      this.ema9PreviousValue == null
        ? bar.close
        : bar.close * ema9Multiplier +
          this.ema9PreviousValue * (1 - ema9Multiplier);

    this.currentEma20Value =
      this.ema20PreviousValue == null
        ? bar.close
        : bar.close * ema20Multiplier +
          this.ema20PreviousValue * (1 - ema20Multiplier);

    this.currentEma50Value =
      this.ema50PreviousValue == null
        ? bar.close
        : bar.close * ema50Multiplier +
          this.ema50PreviousValue * (1 - ema50Multiplier);

    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    const cumulativePriceVolume =
      this.vwapPrefixPriceVolume + typicalPrice * bar.volume;
    const cumulativeVolume = this.vwapPrefixVolume + bar.volume;

    this.currentVwapValue =
      cumulativeVolume > 0
        ? cumulativePriceVolume / cumulativeVolume
        : null;
  }

  private scheduleLiveStudiesRender(force = false): void {
    const now = performance.now();

    if (force || now - this.lastLiveStudyRenderAt >= LIVE_STUDY_THROTTLE_MS) {
      if (this.liveStudyRenderTimer != null) {
        window.clearTimeout(this.liveStudyRenderTimer);
        this.liveStudyRenderTimer = null;
      }

      this.lastLiveStudyRenderAt = now;
      this.renderStudies();
      return;
    }

    if (this.liveStudyRenderTimer != null) return;

    const delay = Math.max(0, LIVE_STUDY_THROTTLE_MS - (now - this.lastLiveStudyRenderAt));

    this.liveStudyRenderTimer = window.setTimeout(() => {
      this.liveStudyRenderTimer = null;
      this.lastLiveStudyRenderAt = performance.now();
      this.renderStudies();
    }, delay);
  }

  private invalidateDerivedStateCache(): void {
    this.derivedStateCacheKey = "";
    this.cachedStructure = null;
    this.cachedCompression = null;
    this.cachedMomentum = null;
  }

  private getDerivedStateAnalysis(): {
    structure: ReturnType<typeof buildMarketStructure>;
    compression: ReturnType<typeof buildCompression>;
    momentum: ReturnType<typeof buildMomentum>;
  } {
    const lastBar = this.bars[this.bars.length - 1];
    const cacheKey = [
      this.symbol ?? "",
      this.timeframe ?? "",
      this.bars.length,
      lastBar ? String(lastBar.time) : "none",
    ].join("|");

    if (
      cacheKey !== this.derivedStateCacheKey ||
      !this.cachedStructure ||
      !this.cachedCompression ||
      !this.cachedMomentum
    ) {
      this.derivedStateCacheKey = cacheKey;
      this.cachedStructure = buildMarketStructure(this.bars);
      this.cachedCompression = buildCompression(this.bars);
      this.cachedMomentum = buildMomentum(this.bars);
    }

    return {
      structure: this.cachedStructure!,
      compression: this.cachedCompression!,
      momentum: this.cachedMomentum!,
    };
  }

  private buildCandleSeriesData(): CandlestickData<Time>[] {
    return this.bars.map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));
  }

  private renderStudies(): void {
    this.lastLiveStudyRenderAt = performance.now();
    this.studyRenderer.render({
      bars: this.bars,
      settings: this.chartSettings,
    });
  }

  private scheduleSessionBandsRender(): void {
    if (this.sessionRenderFrame != null) return;

    this.sessionRenderFrame = window.requestAnimationFrame(() => {
      this.sessionRenderFrame = null;
      this.renderSessionBands();
    });
  }

  private clearSessionBands(): void {
    this.sessionOverlay.replaceChildren();
  }

  private isSessionBandEnabled(key: ChartSessionBandKey): boolean {
    const settings = this.chartSettings.sessionBands;

    if (!settings.enabled) return false;
    if (key === "premarket") return settings.premarket;
    if (key === "regular") return settings.regular;
    return settings.afterHours;
  }

  private renderSessionBands(): void {
    const settings = this.chartSettings.sessionBands;

    this.clearSessionBands();

    if (!settings.enabled || !this.bars.length) return;

    const timeScale = this.chart.timeScale();
    const points = this.bars
      .map((bar) => {
        const x = timeScale.timeToCoordinate(bar.time);
        const key = getSessionBandKey(bar.time);

        if (x == null || key == null || !this.isSessionBandEnabled(key)) {
          return null;
        }

        return { x, key };
      })
      .filter(Boolean) as Array<{ x: number; key: ChartSessionBandKey }>;

    if (!points.length) return;

    const segments: Array<{
      left: number;
      right: number;
      key: ChartSessionBandKey;
    }> = [];

    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const previous = points[index - 1];
      const next = points[index + 1];

      const left =
        previous != null
          ? (previous.x + current.x) / 2
          : current.x - Math.max(2, next ? Math.abs(next.x - current.x) / 2 : 4);
      const right =
        next != null
          ? (current.x + next.x) / 2
          : current.x + Math.max(2, previous ? Math.abs(current.x - previous.x) / 2 : 4);

      const last = segments[segments.length - 1];

      if (last && last.key === current.key && Math.abs(left - last.right) <= 2) {
        last.right = right;
      } else {
        segments.push({
          left,
          right,
          key: current.key,
        });
      }
    }

    const opacity = Math.max(0, Math.min(0.25, settings.opacity));

    for (const segment of segments) {
      const width = segment.right - segment.left;
      if (width <= 0) continue;

      const band = document.createElement("div");
      band.style.position = "absolute";
      band.style.top = "0";
      band.style.bottom = "0";
      band.style.left = `${segment.left}px`;
      band.style.width = `${width}px`;
      band.style.background = getSessionBandColor(segment.key, opacity);

      this.sessionOverlay.appendChild(band);
    }
  }

  setChartSettings(settings: ChartSettings): void {
    this.chartSettings = settings;

    this.chart.applyOptions({
      grid: {
        vertLines: {
          color: settings.gridVisible ? "rgba(255,255,255,.04)" : "transparent",
        },
        horzLines: {
          color: settings.gridVisible ? "rgba(255,255,255,.04)" : "transparent",
        },
      },
      crosshair: {
        vertLine: {
          visible: settings.crosshairVisible,
          labelVisible: settings.crosshairVisible,
          style: LineStyle.Dashed,
          color: "rgba(255,255,255,.55)",
        },
        horzLine: {
          visible: settings.crosshairVisible,
          labelVisible: settings.crosshairVisible,
          style: LineStyle.Dashed,
          color: "rgba(255,255,255,.35)",
        },
      },
    });

    this.series.candles.setData(this.buildCandleSeriesData());
    this.renderStudies();
    this.scheduleSessionBandsRender();
  }

  resize(): void {
    this.chart.applyOptions({
      width: Math.max(1, this.container.clientWidth),
      height: Math.max(1, this.container.clientHeight),
    });

    this.studyRenderer.scheduleOverlayRender();
    this.scheduleSessionBandsRender();
    this.scheduleVwap3OverlayRender();
  }

  setBars(bars: CleanBar[]): void {
    this.bars = trimBarsForTimeframe(bars, this.timeframe);
    this.invalidateDerivedStateCache();
    this.rebuildLiveIndicatorState();
    this.lastCrosshairInfo = this.getLastBarInfo();

    const newestBar = this.bars[this.bars.length - 1];
    if (newestBar) {
      this.positionOverlayEngine.updateMarketPrice(newestBar.close);
    }

    const candleBars = this.buildCandleSeriesData();

    const volumeBars: HistogramData<Time>[] = this.bars.map((bar) => ({
      time: bar.time,
      value: bar.volume,
      color: volumeColor(bar),
    }));

    this.series.candles.setData(candleBars);
    this.series.volume.setData(volumeBars);
    this.series.vwap.setData(buildVwapBars(this.bars));
    this.series.ema9.setData(buildEmaBars(this.bars, 9));
    this.series.ema20.setData(buildEmaBars(this.bars, 20));
    this.series.ema50.setData(buildEmaBars(this.bars, 50));
    this.renderStudies();
    this.renderFxAnalysis();
    this.scheduleSessionBandsRender();
    this.scheduleVwap3OverlayRender();
  }

  updateBar(bar: CleanBar): void {
    const lastBar = this.bars[this.bars.length - 1];
    const lastTime = lastBar ? Number(lastBar.time) : null;
    const incomingTime = Number(bar.time);

    // Never append an older websocket candle after a newer chart candle. Late
    // SIP prints/corrections are reconciled by historical bars instead of
    // corrupting the time order of the live series.
    if (lastTime != null && incomingTime < lastTime) {
      return;
    }

    const isSameBar = lastTime != null && lastTime === incomingTime;

    // A websocket subscription can begin in the middle of a candle. The live
    // aggregator therefore only knows trades observed after subscription,
    // while the historical bar already contains the true beginning of the
    // interval. Merge same-time updates instead of replacing that OHLC history.
    const nextBar: CleanBar = isSameBar && lastBar
      ? {
          time: bar.time,
          open: lastBar.open,
          high: Math.max(lastBar.high, bar.high, bar.open, bar.close),
          low: Math.min(lastBar.low, bar.low, bar.open, bar.close),
          close: bar.close,
          volume: Math.max(lastBar.volume, bar.volume),
        }
      : bar;

    if (isSameBar) {
      this.bars[this.bars.length - 1] = nextBar;
    } else {
      this.bars.push(nextBar);
    }

    this.bars = trimBarsForTimeframe(this.bars, this.timeframe);

    if (isSameBar) {
      this.updateLiveIndicatorValues(nextBar);
    } else {
      // Rebuild once per completed candle so any timeframe trimming remains
      // exactly consistent with the historical calculation.
      this.invalidateDerivedStateCache();
      this.rebuildLiveIndicatorState();
    }

    this.lastCrosshairInfo = buildCrosshairInfoFromBar(nextBar);
    this.positionOverlayEngine.updateMarketPrice(nextBar.close);

    this.series.candles.update({
      time: nextBar.time,
      open: nextBar.open,
      high: nextBar.high,
      low: nextBar.low,
      close: nextBar.close,
    });

    this.series.volume.update({
      time: nextBar.time,
      value: nextBar.volume,
      color: volumeColor(nextBar),
    });

    if (this.currentVwapValue != null) {
      this.series.vwap.update({
        time: nextBar.time,
        value: this.currentVwapValue,
      });
    }

    if (this.currentEma9Value != null) {
      this.series.ema9.update({
        time: nextBar.time,
        value: this.currentEma9Value,
      });
    }

    if (this.currentEma20Value != null) {
      this.series.ema20.update({
        time: nextBar.time,
        value: this.currentEma20Value,
      });
    }

    if (this.currentEma50Value != null) {
      this.series.ema50.update({
        time: nextBar.time,
        value: this.currentEma50Value,
      });
    }

    // Structure, demand-zone and liquidity calculations are expensive. Run
    // immediately on a new candle, but throttle repeated updates to the same
    // live candle.
    this.scheduleLiveStudiesRender(!isSameBar);

    if (!isSameBar) {
      this.scheduleSessionBandsRender();
    }
    this.scheduleVwap3OverlayRender();
  }

  setStudyVisibility(visibility: StudyVisibility): void {
    this.studyRenderer.setStructureVisible(visibility.marketStructure);
    this.studyRenderer.setDemandZonesVisible(visibility.demandZones);
    this.studyRenderer.setFvgVisibility(visibility.bullishFvg, visibility.bearishFvg);
    this.series.vwap.applyOptions({ visible: visibility.vwap });
    this.series.ema9.applyOptions({ visible: visibility.ema9 });
    this.series.ema20.applyOptions({ visible: visibility.ema20 });
    this.series.ema50.applyOptions({ visible: visibility.ema50 });
    this.series.volume.applyOptions({ visible: visibility.volume });
    this.vwap3ExpansionVisible = visibility.vwap3Expansion;
    this.scheduleVwap3OverlayRender();
  }

  fitContent(): void {
    this.chart.timeScale().fitContent();
  }

  focusSelection(selection: FocusSelection): void {
    const leftX = Number(selection.leftX);
    const rightX = Number(selection.rightX);

    if (
      !Number.isFinite(leftX) ||
      !Number.isFinite(rightX) ||
      rightX <= leftX ||
      !this.bars.length
    ) {
      return;
    }

    const timeScale = this.chart.timeScale() as unknown as {
      coordinateToLogical?: (coordinate: number) => number | null;
      setVisibleLogicalRange?: (range: { from: number; to: number }) => void;
    };

    const leftLogical = timeScale.coordinateToLogical?.(leftX);
    const rightLogical = timeScale.coordinateToLogical?.(rightX);

    if (
      leftLogical == null ||
      rightLogical == null ||
      !Number.isFinite(Number(leftLogical)) ||
      !Number.isFinite(Number(rightLogical))
    ) {
      return;
    }

    const from = Math.min(Number(leftLogical), Number(rightLogical));
    const to = Math.max(Number(leftLogical), Number(rightLogical));

    if (to - from < 0.5) {
      return;
    }

    // Logical indexes map directly to the candle order supplied through
    // setData(). Include partially selected candles at both edges.
    const firstIndex = Math.max(
      0,
      Math.min(this.bars.length - 1, Math.floor(from)),
    );
    const lastIndex = Math.max(
      firstIndex,
      Math.min(this.bars.length - 1, Math.ceil(to)),
    );
    const selectedBars = this.bars.slice(firstIndex, lastIndex + 1);

    if (!selectedBars.length) {
      return;
    }

    // The vertical height of the Shift-drag rectangle is visual only.
    // Focus the price scale on the actual highest high and lowest low of
    // the candles contained in the selected time range.
    if (!this.autoScaleManager.setFocusedBars(selectedBars)) {
      return;
    }

    timeScale.setVisibleLogicalRange?.({ from, to });
    this.refreshCandleAutoscale();
    this.scheduleSessionBandsRender();
    this.studyRenderer.scheduleOverlayRender();
  }

  resetFocus(): void {
    this.autoScaleManager.clearFocusedPriceRange();
    this.autoScaleManager.clearVerticalPan();
    this.chart.priceScale("right").applyOptions({ autoScale: true });
    this.refreshCandleAutoscale();
    this.chart.timeScale().fitContent();
  }

  private panPriceScale(deltaY: number): void {
    if (
      !this.autoScaleManager.panVertically(
        deltaY,
        this.container.clientHeight,
      )
    ) {
      return;
    }

    this.chart.priceScale("right").applyOptions({ autoScale: true });
    this.series.candles.setData(this.buildCandleSeriesData());
    this.studyRenderer.scheduleOverlayRender();
  }

  private panTimeScale(deltaX: number): void {
    if (!Number.isFinite(deltaX) || deltaX === 0) return;

    const timeScale = this.chart.timeScale();
    const barSpacing = Math.max(1, timeScale.options().barSpacing);
    timeScale.scrollToPosition(
      timeScale.scrollPosition() - deltaX / barSpacing,
      false,
    );
    this.scheduleSessionBandsRender();
    this.studyRenderer.scheduleOverlayRender();
  }

  private refreshCandleAutoscale(): void {
    this.series.candles.setData(this.buildCandleSeriesData());
    this.renderFxAnalysis();
  }

  getLastBarInfo(): (CrosshairInfo & { range: number }) | null {
    const lastBar = this.bars[this.bars.length - 1];

    if (!lastBar) {
      return null;
    }

    return buildCrosshairInfoFromBar(lastBar);
  }

  getBars(): CleanBar[] {
    return this.bars;
  }

setMarketContext(symbol?: string, timeframe?: string): void {
  const nextSymbol = symbol;
  const nextTimeframe = timeframe;

  if (this.symbol === nextSymbol && this.timeframe === nextTimeframe) {
    return;
  }

  const symbolChanged = this.symbol !== nextSymbol;
  this.symbol = nextSymbol;
  this.timeframe = nextTimeframe;
  this.invalidateDerivedStateCache();

  if (symbolChanged && this.vwap3SetupOverlay?.symbol !== nextSymbol) {
    this.setVwap3SetupOverlay(null);
  }

  this.autoScaleManager.clearFocusedPriceRange();
  this.autoScaleManager.clearVerticalPan();
  this.chart.priceScale("right").applyOptions({ autoScale: true });

  this.positionOverlayEngine.setSymbol(symbol);
  this.analysisStore.setWorkspace(symbol, timeframe);
}
  setVwap3SetupOverlay(setup: Vwap3ChartSetupOverlay | null): void {
    this.vwap3SetupOverlay = setup;

    if (this.vwap3UpperPriceLine) {
      this.series.candles.removePriceLine(this.vwap3UpperPriceLine);
      this.vwap3UpperPriceLine = null;
    }
    if (this.vwap3LowerPriceLine) {
      this.series.candles.removePriceLine(this.vwap3LowerPriceLine);
      this.vwap3LowerPriceLine = null;
    }
    if (this.vwap3TargetPriceLine) {
      this.series.candles.removePriceLine(this.vwap3TargetPriceLine);
      this.vwap3TargetPriceLine = null;
    }

    const upper = Number(setup?.freezeUpper3Std ?? 0);
    const lower = Number(setup?.freezeLower3Std ?? 0);
    const target = Number(setup?.targetPrice ?? 0);
    const targetMatchesUpper =
      Number.isFinite(target) &&
      target > 0 &&
      Number.isFinite(upper) &&
      upper > 0 &&
      Math.abs(target - upper) <= Math.max(0.000001, Math.abs(upper) * 0.000001);

    if (setup && Number.isFinite(upper) && upper > 0) {
      const isExtremeRunner = String(setup.grade ?? "")
        .toUpperCase()
        .includes("EXTREME");
      this.vwap3UpperPriceLine = this.series.candles.createPriceLine({
        price: upper,
        color: "#38bdf8",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: targetMatchesUpper
          ? "+3 TARGET"
          : isExtremeRunner
            ? "+3 T2"
            : "+3 VWAP",
      });
    }
    if (setup && Number.isFinite(lower) && lower > 0) {
      this.vwap3LowerPriceLine = this.series.candles.createPriceLine({
        price: lower,
        color: "#fb7185",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "-3 VWAP",
      });
    }
    if (
      setup &&
      Number.isFinite(target) &&
      target > 0 &&
      !targetMatchesUpper
    ) {
      const isExtremeRunner = String(setup.grade ?? "")
        .toUpperCase()
        .includes("EXTREME");
      this.vwap3TargetPriceLine = this.series.candles.createPriceLine({
        price: target,
        color: "#22c55e",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: isExtremeRunner ? "T1 TARGET" : "TARGET",
      });
    }

    this.scheduleVwap3OverlayRender();
  }

  private scheduleVwap3OverlayRender(): void {
    if (this.vwap3OverlayRenderFrame != null) return;
    this.vwap3OverlayRenderFrame = window.requestAnimationFrame(() => {
      this.vwap3OverlayRenderFrame = null;
      this.renderVwap3ExpansionMarker();
    });
  }

  private renderVwap3ExpansionMarker(): void {
    this.vwap3ExpansionOverlay.replaceChildren();
    if (!this.vwap3ExpansionVisible) return;
    const setup = this.vwap3SetupOverlay;
    if (!setup || !setup.displacementTime || !this.bars.length) return;

    // The scanner displacement is always a native 5-minute candle. On 5m the
    // marker lands on the exact candle. On other chart timeframes, mark the bar
    // that contains the 5m displacement time and label it "5m EXP" so we do not
    // imply the larger/smaller chart candle itself qualified as the setup.
    const normalizedTimeframe = String(this.timeframe ?? "").trim().toLowerCase();
    const targetMs = Date.parse(setup.displacementTime);
    if (!Number.isFinite(targetMs)) return;
    const targetSeconds = Math.floor(targetMs / 1000);

    let markerBar = this.bars[0];
    let markerIndex = 0;
    for (let index = 0; index < this.bars.length; index += 1) {
      const barTime = Number(this.bars[index].time);
      if (!Number.isFinite(barTime)) continue;
      if (barTime <= targetSeconds) {
        markerBar = this.bars[index];
        markerIndex = index;
        continue;
      }
      break;
    }

    const markerSeconds = Number(markerBar.time);
    const nextSeconds =
      markerIndex + 1 < this.bars.length
        ? Number(this.bars[markerIndex + 1].time)
        : Number.NaN;
    const inferredBarSeconds =
      Number.isFinite(nextSeconds) && nextSeconds > markerSeconds
        ? nextSeconds - markerSeconds
        : this.bars.length > 1
          ? Math.max(60, Number(this.bars[1].time) - Number(this.bars[0].time))
          : 5 * 60;

    // Reject markers whose displacement time is outside the loaded chart data.
    if (
      targetSeconds < Number(this.bars[0].time) - inferredBarSeconds ||
      targetSeconds > Number(this.bars[this.bars.length - 1].time) + inferredBarSeconds
    ) {
      return;
    }

    const x = this.chart.timeScale().timeToCoordinate(markerBar.time);
    const markerPrice = Number(setup.displacementHigh ?? markerBar.high);
    const y = this.series.candles.priceToCoordinate(markerPrice);
    if (x == null || y == null) return;

    const badge = document.createElement("div");
    const invalid =
      String(setup.outcome ?? "") === "invalidated" ||
      String(setup.status ?? "") === "INVALIDATED" ||
      String(setup.outcome ?? "") === "target_hit_after_invalidation";
    const expPrefix = normalizedTimeframe === "5m" ? "EXP" : "5m EXP";
    badge.textContent = invalid
      ? `${expPrefix} ${setup.grade ?? ""} · INVALID`
      : `${expPrefix} ${setup.grade ?? ""}`;
    badge.style.position = "absolute";
    badge.style.left = `${Math.round(x)}px`;
    badge.style.top = `${Math.max(4, Math.round(y) - 30)}px`;
    badge.style.transform = "translateX(-50%)";
    badge.style.padding = "3px 6px";
    badge.style.borderRadius = "5px";
    badge.style.border = invalid
      ? "1px solid rgba(248,113,113,0.95)"
      : "1px solid rgba(56,189,248,0.95)";
    badge.style.background = "rgba(8,15,28,0.92)";
    badge.style.color = invalid ? "#fca5a5" : "#bae6fd";
    badge.style.fontSize = "10px";
    badge.style.fontWeight = "800";
    badge.style.whiteSpace = "nowrap";
    badge.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";

    const stem = document.createElement("div");
    stem.style.position = "absolute";
    stem.style.left = `${Math.round(x)}px`;
    stem.style.top = `${Math.max(18, Math.round(y) - 10)}px`;
    stem.style.height = "10px";
    stem.style.borderLeft = invalid
      ? "1px dotted rgba(248,113,113,0.9)"
      : "1px dotted rgba(56,189,248,0.9)";

    this.vwap3ExpansionOverlay.appendChild(badge);
    this.vwap3ExpansionOverlay.appendChild(stem);
  }

  private buildAutoScalePriceRange(
    baseRange: { minValue: number; maxValue: number } | null,
  ): { minValue: number; maxValue: number } | null {
    return this.autoScaleManager.buildPriceScaleRange({
      baseRange,
      bars: this.bars,
      analysisRange: this.analysisStore.getAutoScalePriceRange(
        this.fxAnalysisSettings,
      ),
    });
  }

  private refreshFxAutoScaleIfNeeded(force = false): void {
    const range = this.analysisStore.getAutoScalePriceRange(
      this.fxAnalysisSettings,
    );
    const nextKey = range
      ? `${range.minValue}:${range.maxValue}`
      : "none";

    if (!force && nextKey === this.fxAutoScaleRangeKey) return;

    this.fxAutoScaleRangeKey = nextKey;
    this.chart.priceScale("right").applyOptions({ autoScale: true });
  }

  fitFxAnalysisLevels(): void {
    // Re-applying the candle data forces Lightweight Charts to ask the
    // autoscale provider for the latest candle + FX analysis range.
    const candleBars = this.buildCandleSeriesData();

    this.series.candles.setData(candleBars);
    this.chart.timeScale().fitContent();
    this.renderFxAnalysis();
  }

  public getState(): ChartState {
    const lastBar =
      this.bars.length > 0
        ? this.bars[this.bars.length - 1]
        : undefined;

    const recentVolumeBars = this.bars.slice(-20);
    const avgVolume =
      recentVolumeBars.length > 0
        ? recentVolumeBars.reduce((sum, bar) => sum + bar.volume, 0) /
          recentVolumeBars.length
        : undefined;

    const ema9 = this.currentEma9Value ?? getCurrentEMA(this.bars, 9);
    const ema20 = this.currentEma20Value ?? getCurrentEMA(this.bars, 20);
    const ema50 = getCurrentEMA(this.bars, 50);
    const ema200 = getCurrentEMA(this.bars, 200);
    const vwap = this.currentVwapValue ?? getCurrentVWAP(this.bars);
    const atr = getCurrentATR(this.bars);
    const { structure, compression, momentum } =
      this.getDerivedStateAnalysis();


    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      bars: this.bars,
      lastBar,
      price: lastBar?.close,
      studies: { ema: {}, vwap: {}, atr: {} },
      ema: {
        ema9,
        ema20,
        ema50,
        ema200,
        bullish: ema9 != null && ema20 != null ? ema9 > ema20 : undefined,
      },
      vwap: {
        value: vwap,
        above: lastBar && vwap != null ? lastBar.close > vwap : undefined,
        slope: "flat",
        distance: lastBar && vwap != null ? lastBar.close - vwap : undefined,
        reclaimed: undefined,
      },
      atr: {
        value: atr,
        expanding: undefined,
      },
      volume: {
        current: lastBar?.volume,
        average: avgVolume,
        relative: lastBar && avgVolume ? lastBar.volume / avgVolume : undefined,
      },
      structure: {
        trend: structure.trend,
        bos: structure.bos,
        choch: structure.choch,
        higherHighs: structure.higherHighs,
        higherLows: structure.higherLows,
        lowerHighs: structure.lowerHighs,
        lowerLows: structure.lowerLows,
        swingHigh: structure.swingHigh,
        swingLow: structure.swingLow,
        lastSwingHigh: structure.lastSwingHigh,
        lastSwingLow: structure.lastSwingLow,
        bullishCount: structure.bullishCount,
        bearishCount: structure.bearishCount,
        strength: structure.strength,
      },
      compression: {
  	score: compression.score,
  	breaking: compression.breaking,
	},
	momentum: {
    score: momentum.score,
    direction: momentum.direction,
    status: momentum.status,

    emaMomentum: momentum.emaMomentum,
    vwapMomentum: momentum.vwapMomentum,
    candleMomentum: momentum.candleMomentum,
    volumeMomentum: momentum.volumeMomentum,
    atrMomentum: momentum.atrMomentum,

    increasing: momentum.increasing,
    fading: momentum.fading,
},
    };
  }

  private renderFxAnalysis(): void {
    const results = this.analysisStore.getAll();

    if (!results.length) {
      this.analysisRenderer.clear();
      return;
    }

    const firstBar = this.bars[0];
    const lastBar = this.bars[this.bars.length - 1];
    const fallback = results[results.length - 1]?.anchorTime ?? null;

    this.analysisRenderer.setVisibleRange(
      firstBar ? firstBar.time : fallback,
      lastBar ? lastBar.time : fallback,
    );
    this.analysisRenderer.renderAll(
      results,
      this.fxAnalysisSettings,
      this.analysisStore.getSelectedId(),
    );
  }

  private synchronizeFxAnalysisMarketObjects(): void {
    const symbol = String(this.symbol ?? "SPY").trim().toUpperCase();
    const timeframe = String(this.timeframe ?? "5m").trim();
    const demandResults = this.analysisStore
      .getSaved()
      .filter((result) => result.tool === "demandZone" && result.zone);
    const activeIds = new Set(
      demandResults.map((result) => `market_object_analysis_${result.id}`),
    );

    const existingObjects = marketObjectRegistry.find({
      symbol,
      timeframe,
      source: "engine",
      type: "demandZone",
    });

    for (const object of existingObjects) {
      if (
        object.metadata?.synchronizedFromFxAnalysis === true &&
        !activeIds.has(object.id)
      ) {
        marketObjectRegistry.remove(object.id);
      }
    }

    for (const result of demandResults) {
      const zone = result.zone;
      if (!zone) continue;

      const id = `market_object_analysis_${result.id}`;
      const existing = marketObjectRegistry.get(id);
      const timestamp = Date.now();
      const object: MarketObject = {
        id,
        type: "demandZone",
        source: "engine",
        bias: "bullish",
        symbol,
        timeframe,
        status: existing?.status ?? "registered",
        lifecycleStage: existing?.lifecycleStage ?? "fresh",
        active: true,
        geometry: {
          kind: "zone",
          zone: {
            low: Math.min(zone.low, zone.high),
            high: Math.max(zone.low, zone.high),
            startTime: result.anchorTime,
            extendRight: zone.extendRight ?? true,
          },
        },
        scoring: existing?.scoring ?? {
          quality: 50,
          health: 100,
          confidence: 50,
          confidenceBand: "moderate",
          priority: "normal",
        },
        awareness: existing?.awareness ?? {
          enabled: true,
          mode: "percent",
          threshold: 0.25,
        },
        memory: existing?.memory ?? {
          touchCount: 0,
          rejectionCount: 0,
          successfulRetestCount: 0,
          failedRetestCount: 0,
          interactions: [],
        },
        relationshipIds: existing?.relationshipIds ?? [],
        evidence: existing?.evidence ?? [],
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        createdTime: existing?.createdTime ?? result.anchorTime,
        updatedTime: result.anchorTime,
        presentation: {
          label: zone.title || "Demand Zone",
          color: zone.borderColor,
          fillColor: zone.fillColor,
          lineWidth: 2,
          visible: true,
          showLabel: true,
        },
        metadata: {
          ...(existing?.metadata ?? {}),
          analysisResultId: result.id,
          analysisZoneId: zone.id,
          synchronizedFromFxAnalysis: true,
        },
      };

      marketObjectRegistry.upsert(object);
    }
  }



  selectFxAnalysisAtPoint(point: ChartPointerPoint): boolean {
    const hit = this.analysisStore.hitTestAt({
      time: point.time,
      price: point.rawPrice ?? point.price,
    });

    this.analysisStore.select(hit?.resultId ?? null);
    this.renderFxAnalysis();

    return hit != null;
  }

  clearFxAnalysisSelection(): void {
    if (!this.analysisStore.getSelectedId()) return;

    this.analysisStore.select(null);
    this.renderFxAnalysis();
  }

  removeSelectedFxAnalysis(): boolean {
    const removed = this.analysisStore.removeSelected();
    if (!removed) return false;

    this.renderFxAnalysis();
    return true;
  }

  runFxAnalysisTool(tool: FxAnalysisToolId, bar: CleanBar | null): void {
    if (!bar || tool === "none") return;

    const result = buildFxAnalysisResult(tool, bar, this.bars, this.fxAnalysisSettings);
    if (!result) return;

    // Demand zones are chart objects, not temporary previews. Always persist
    // them so the AnalysisStore can send them to the shared backend even when
    // an older browser has saveWithSymbol disabled in local preferences.
    const saved =
      tool === "demandZone" ||
      this.fxAnalysisSettings[tool]?.saveWithSymbol === true;

    // The new FX level may be outside the candle-only price range. Force one
    // lightweight price-scale calculation so the selected level is visible
    // immediately without changing the horizontal time range.
    this.forceNextFxAutoScale = true;
    this.analysisStore.addResult(result, saved);
    this.renderFxAnalysis();
  }

  setFxAnalysisSettings(settings: FxAnalysisSettings): void {
    this.fxAnalysisSettings = settings;
    this.renderFxAnalysis();
    this.refreshFxAutoScaleIfNeeded();
  }

  clearFxAnalysis(): void {
    this.analysisStore.clear();
    this.analysisRenderer.clear();
  }

  destroy(): void {
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);
    this.chart.unsubscribeCrosshairMove(this.handleCrosshairMove);
    this.interactionManager.destroy();
    this.crosshairListeners.clear();
    this.analysisRenderer.clear();
    this.unsubscribeAnalysisStore?.();
    this.unsubscribeAnalysisStore = null;
    this.analysisStore.destroy();
    this.unsubscribePositionOverlay?.();
    this.unsubscribePositionOverlay = null;
    this.positionOverlayRenderer.destroy();
    this.positionOverlayEngine.destroy();

    if (this.liveStudyRenderTimer != null) {
      window.clearTimeout(this.liveStudyRenderTimer);
      this.liveStudyRenderTimer = null;
    }

    this.studyRenderer.destroy();
    this.clearSessionBands();
    this.setVwap3SetupOverlay(null);
    this.vwap3ExpansionOverlay.replaceChildren();

    if (this.vwap3OverlayRenderFrame != null) {
      window.cancelAnimationFrame(this.vwap3OverlayRenderFrame);
      this.vwap3OverlayRenderFrame = null;
    }

    if (this.sessionRenderFrame != null) {
      window.cancelAnimationFrame(this.sessionRenderFrame);
      this.sessionRenderFrame = null;
    }

    this.sessionOverlay.remove();
    this.vwap3ExpansionOverlay.remove();
    this.bars = [];
    this.chart.remove();
  }
}
