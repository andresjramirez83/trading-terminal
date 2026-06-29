// src/components/chart/ChartEngine.ts

import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
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

function volumeColor(bar: CleanBar): string {
  return bar.close >= bar.open
    ? "rgba(34, 197, 94, 0.35)"
    : "rgba(239, 68, 68, 0.35)";
}

const NEW_YORK_TIME_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

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

export class ChartEngine {
  readonly chart: IChartApi;
  readonly series: ChartSeriesBundle;

  private bars: CleanBar[] = [];
  private container: HTMLDivElement;
  private crosshairListeners = new Set<(info: CrosshairInfo | null) => void>();
  private clickListeners = new Set<(point: ChartPointerPoint) => void>();
  private pointerDownListeners = new Set<(point: ChartPointerPoint) => void>();
  private pointerMoveListeners = new Set<(point: ChartPointerPoint) => void>();
  private pointerUpListeners = new Set<(point: ChartPointerPoint) => void>();
  private contextMenuListeners = new Set<(point: ChartPointerPoint) => void>();
  private handleCrosshairMove: (param: MouseEventParams<Time>) => void;
  private handleClick: (param: MouseEventParams<Time>) => void;
  private handlePointerDown: (event: PointerEvent) => void;
  private handlePointerMove: (event: PointerEvent) => void;
  private handlePointerUp: (event: PointerEvent) => void;
  private handleContextMenu: (event: MouseEvent) => void;
  private lastPointerPoint: ChartPointerPoint | null = null;
  private lastCrosshairInfo: (CrosshairInfo & { range: number }) | null = null;
  private analysisRenderer: AnalysisRenderer;
  private studyRenderer: StudyRenderer;
  private analysisStore = new AnalysisStore();
  private fxAnalysisSettings: FxAnalysisSettings = DEFAULT_FX_ANALYSIS_SETTINGS;
  private chartSettings: ChartSettings = DEFAULT_CHART_SETTINGS;
  private symbol?: string;
  private timeframe?: string;
  private sessionOverlay: HTMLDivElement;
  private sessionRenderFrame: number | null = null;
  private handleVisibleRangeChange: () => void;

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
      timeScale: {
        borderVisible: false,
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

    this.series = {
      candles,
      volume,
      vwap,
      ema9,
      ema20,
    };

    this.analysisRenderer = new AnalysisRenderer(this.chart);
    this.studyRenderer = new StudyRenderer(this.chart, this.container, this.series.candles);

    // Keep the chart fast: this autoscale provider only scans the current
    // in-memory 500 bars and the small FX analysis store. No DOM work, no
    // recalculation of algorithms, and no series creation happens here.
    (this.series.candles as unknown as {
      applyOptions?: (options: Record<string, unknown>) => void;
    }).applyOptions?.({
      autoscaleInfoProvider: (baseImplementation: () => {
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
      },
    });

    this.handleVisibleRangeChange = () => {
      this.scheduleSessionBandsRender();
      this.studyRenderer.scheduleOverlayRender();
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

    this.handleClick = (param) => {
      const point = this.buildPointFromChartClick(param);
      if (!point) return;

      for (const listener of this.clickListeners) {
        listener(point);
      }
    };

    this.handlePointerDown = (event) => {
      const point = this.buildPointFromPointerEvent(event);
      if (!point) return;

      this.lastPointerPoint = point;

      for (const listener of this.pointerDownListeners) {
        listener(point);
      }
    };

    this.handlePointerMove = (event) => {
      const point = this.buildPointFromPointerEvent(event);
      if (!point) return;

      this.lastPointerPoint = point;

      for (const listener of this.pointerMoveListeners) {
        listener(point);
      }
    };

    this.handlePointerUp = (event) => {
      // Always emit pointer-up. If the mouse is released outside the chart area
      // or outside the time scale, coordinateToTime can return null. When that
      // happened, DrawingEngine never ended the drag and chart navigation stayed
      // disabled, which made the page feel frozen until reload.
      const point =
        this.buildPointFromPointerEvent(event) ??
        this.lastPointerPoint ??
        this.buildFallbackPointFromMouseEvent(event);

      if (!point) return;

      this.lastPointerPoint = null;

      for (const listener of this.pointerUpListeners) {
        listener(point);
      }
    };

    this.handleContextMenu = (event) => {
      const point = this.buildPointFromMouseEvent(event);
      if (!point) return;

      for (const listener of this.contextMenuListeners) {
        listener(point);
      }
    };

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);
    this.chart.subscribeCrosshairMove(this.handleCrosshairMove);
    this.chart.subscribeClick(this.handleClick);
    this.container.addEventListener("pointerdown", this.handlePointerDown);
    this.container.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    this.container.addEventListener("contextmenu", this.handleContextMenu);
  }

  subscribeCrosshairInfo(
    listener: (info: CrosshairInfo | null) => void,
  ): () => void {
    this.crosshairListeners.add(listener);

    return () => {
      this.crosshairListeners.delete(listener);
    };
  }

  subscribeClick(listener: (point: ChartPointerPoint) => void): () => void {
    this.clickListeners.add(listener);

    return () => {
      this.clickListeners.delete(listener);
    };
  }

  subscribePointerDown(
    listener: (point: ChartPointerPoint) => void,
  ): () => void {
    this.pointerDownListeners.add(listener);

    return () => {
      this.pointerDownListeners.delete(listener);
    };
  }

  subscribePointerMove(
    listener: (point: ChartPointerPoint) => void,
  ): () => void {
    this.pointerMoveListeners.add(listener);

    return () => {
      this.pointerMoveListeners.delete(listener);
    };
  }

  subscribePointerUp(listener: (point: ChartPointerPoint) => void): () => void {
    this.pointerUpListeners.add(listener);

    return () => {
      this.pointerUpListeners.delete(listener);
    };
  }

  subscribeContextMenu(
    listener: (point: ChartPointerPoint) => void,
  ): () => void {
    this.contextMenuListeners.add(listener);

    return () => {
      this.contextMenuListeners.delete(listener);
    };
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
    // Keep chart navigation enabled.
    // Disabling handleScroll/handleScale made the chart feel locked after
    // selecting a drawing tool. Drawing zoom-outs were caused by drawing
    // series affecting autoscale, which is fixed in DrawingEngine.
    this.chart.applyOptions({
      handleScroll: true,
      handleScale: true,
    });
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
  }

  setBars(bars: CleanBar[]): void {
    this.bars = bars.slice(-500);
    this.lastCrosshairInfo = this.getLastBarInfo();

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
    this.renderStudies();
    this.renderFxAnalysis();
    this.scheduleSessionBandsRender();
  }

  updateBar(bar: CleanBar): void {
    const lastBar = this.bars[this.bars.length - 1];

    if (lastBar && Number(lastBar.time) === Number(bar.time)) {
      this.bars[this.bars.length - 1] = bar;
    } else {
      this.bars.push(bar);
    }

    this.bars = this.bars.slice(-500);
    this.lastCrosshairInfo = buildCrosshairInfoFromBar(bar);

    this.series.candles.update({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });

    this.renderStudies();

    this.series.volume.update({
      time: bar.time,
      value: bar.volume,
      color: volumeColor(bar),
    });

    const vwapBars = buildVwapBars(this.bars);
    const newestVwap = vwapBars[vwapBars.length - 1];

    if (newestVwap) {
      this.series.vwap.update(newestVwap);
    }

    const ema9Bars = buildEmaBars(this.bars, 9);
    const newestEma9 = ema9Bars[ema9Bars.length - 1];

    if (newestEma9) {
      this.series.ema9.update(newestEma9);
    }

    const ema20Bars = buildEmaBars(this.bars, 20);
    const newestEma20 = ema20Bars[ema20Bars.length - 1];

    if (newestEma20) {
      this.series.ema20.update(newestEma20);
    }

    this.scheduleSessionBandsRender();
  }

  setStudyVisibility(visibility: StudyVisibility): void {
    this.series.vwap.applyOptions({ visible: visibility.vwap });
    this.series.ema9.applyOptions({ visible: visibility.ema9 });
    this.series.ema20.applyOptions({ visible: visibility.ema20 });
    this.series.volume.applyOptions({ visible: visibility.volume });
  }

  fitContent(): void {
    this.chart.timeScale().fitContent();
  }

  getLastBarInfo(): CrosshairInfo | null {
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
    this.symbol = symbol;
    this.timeframe = timeframe;
  }

  private buildAutoScalePriceRange(
    baseRange: { minValue: number; maxValue: number } | null,
  ): { minValue: number; maxValue: number } | null {
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;

    if (baseRange) {
      minValue = Math.min(minValue, baseRange.minValue);
      maxValue = Math.max(maxValue, baseRange.maxValue);
    }

    const fxRange = this.analysisStore.getAutoScalePriceRange(this.fxAnalysisSettings);

    if (fxRange) {
      minValue = Math.min(minValue, fxRange.minValue);
      maxValue = Math.max(maxValue, fxRange.maxValue);
    }

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      return baseRange;
    }

    if (minValue === maxValue) {
      const padding = Math.max(Math.abs(minValue) * 0.02, 0.01);
      return {
        minValue: minValue - padding,
        maxValue: maxValue + padding,
      };
    }

    // Small padding keeps far-away FX support/resistance labels from sitting
    // directly on the top/bottom edge while avoiding heavy visual compression.
    const range = maxValue - minValue;
    const padding = Math.max(range * 0.08, Math.abs(maxValue) * 0.002, 0.01);

    return {
      minValue: minValue - padding,
      maxValue: maxValue + padding,
    };
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

    const ema9 = getCurrentEMA(this.bars, 9);
    const ema20 = getCurrentEMA(this.bars, 20);
    const ema50 = getCurrentEMA(this.bars, 50);
    const ema200 = getCurrentEMA(this.bars, 200);
    const vwap = getCurrentVWAP(this.bars);
    const atr = getCurrentATR(this.bars);
    const structure = buildMarketStructure(this.bars);
    const compression = buildCompression(this.bars);
    const momentum = buildMomentum(this.bars);

    console.log("ChartEngine.getState()", {
      price: lastBar?.close,
      vwap,
      bars: this.bars.length,
      structure,
    });

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
    this.analysisRenderer.renderAll(results, this.fxAnalysisSettings);
  }

  runFxAnalysisTool(tool: FxAnalysisToolId, bar: CleanBar | null): void {
    if (!bar || tool === "none") return;

    const result = buildFxAnalysisResult(tool, bar, this.bars, this.fxAnalysisSettings);
    if (!result) return;

    const saved = this.fxAnalysisSettings[tool]?.saveWithSymbol === true;

    this.analysisStore.addResult(result, saved);
    this.renderFxAnalysis();
  }

  setFxAnalysisSettings(settings: FxAnalysisSettings): void {
    this.fxAnalysisSettings = settings;
    this.renderFxAnalysis();
  }

  clearFxAnalysis(): void {
    this.analysisStore.clear();
    this.analysisRenderer.clear();
  }

  destroy(): void {
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.handleVisibleRangeChange);
    this.chart.unsubscribeCrosshairMove(this.handleCrosshairMove);
    this.chart.unsubscribeClick(this.handleClick);
    this.container.removeEventListener("pointerdown", this.handlePointerDown);
    this.container.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    this.container.removeEventListener("contextmenu", this.handleContextMenu);
    this.crosshairListeners.clear();
    this.clickListeners.clear();
    this.pointerDownListeners.clear();
    this.pointerMoveListeners.clear();
    this.pointerUpListeners.clear();
    this.contextMenuListeners.clear();
    this.analysisRenderer.clear();
    this.studyRenderer.destroy();
    this.clearSessionBands();

    if (this.sessionRenderFrame != null) {
      window.cancelAnimationFrame(this.sessionRenderFrame);
      this.sessionRenderFrame = null;
    }

    this.sessionOverlay.remove();
    this.bars = [];
    this.chart.remove();
  }
}
