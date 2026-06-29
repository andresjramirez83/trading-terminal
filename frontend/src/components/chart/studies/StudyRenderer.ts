// src/chart/StudyRenderer.ts

import type { IChartApi, Time } from "lightweight-charts";
import type { CleanBar } from "./ChartTypes";
import type {
  StudyMarkerPoint,
  StudyRendererSeries,
  StudyRenderContext,
  StudyRenderResult,
} from "./StudyTypes";

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeRollingAtrValues(bars: CleanBar[], period = 14): number[] {
  const atrValues = new Array<number>(bars.length).fill(0);
  if (bars.length < 2) return atrValues;

  const trueRanges = new Array<number>(bars.length).fill(0);

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1]?.close ?? bar.close;

    trueRanges[index] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  }

  for (let index = 1; index < bars.length; index += 1) {
    const start = Math.max(1, index - period + 1);
    const slice = trueRanges.slice(start, index + 1).filter((value) => value > 0);
    atrValues[index] = average(slice);
  }

  return atrValues;
}

function isSignificantExpansionCandle(
  bar: CleanBar,
  atr: number,
  multiplier = 1.5,
): boolean {
  if (!Number.isFinite(atr) || atr <= 0) return false;

  const fullWickRange = bar.high - bar.low;
  return fullWickRange >= atr * multiplier;
}

function getExpansionDotSize(bar: CleanBar, atr: number): number {
  if (!Number.isFinite(atr) || atr <= 0) return 9;

  const range = Math.max(bar.high - bar.low, 0);
  const rangeToAtr = range / atr;

  return Math.round(clampNumber(7 + rangeToAtr * 2.4, 9, 16));
}

function buildAtrExpansionMarkers(
  bars: CleanBar[],
  length: number,
  multiplier: number,
  color: string,
): StudyMarkerPoint[] {
  const atrValues = computeRollingAtrValues(bars, length);
  const markers: StudyMarkerPoint[] = [];

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const atr = atrValues[index];

    if (!isSignificantExpansionCandle(bar, atr, multiplier)) continue;

    const midBodyPrice = (bar.open + bar.close) / 2;

    markers.push({
      time: bar.time,
      price: Number.isFinite(midBodyPrice) ? midBodyPrice : bar.close,
      label: `ATR Expansion ${((bar.high - bar.low) / Math.max(atr, 0.000001)).toFixed(2)}x`,
      color,
      direction: bar.close >= bar.open ? "up" : "down",
      dotSize: getExpansionDotSize(bar, atr),
    });
  }

  return markers.slice(-120);
}

function createMarkerElement(marker: StudyMarkerPoint): HTMLDivElement {
  const dotSize = marker.dotSize ?? 9;
  const element = document.createElement("div");

  element.title = marker.label;
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  element.style.width = `${dotSize}px`;
  element.style.height = `${dotSize}px`;
  element.style.borderRadius = "9999px";
  element.style.background = marker.color;
  element.style.border = "1px solid rgba(15, 23, 42, 0.85)";
  element.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.18), 0 0 8px rgba(250,204,21,0.45)";
  element.style.pointerEvents = "none";
  element.style.transform = "translate(-50%, -50%)";

  return element;
}

export class StudyRenderer {
  private readonly chart: IChartApi;
  private readonly series: StudyRendererSeries;
  private readonly overlay: HTMLDivElement;
  private renderFrame: number | null = null;
  private latestContext: StudyRenderContext | null = null;
  private lastResult: StudyRenderResult = {
    atrExpansionMarkers: [],
  };

  constructor(chart: IChartApi, container: HTMLDivElement, series: StudyRendererSeries) {
    this.chart = chart;
    this.series = series;

    this.overlay = document.createElement("div");
    this.overlay.style.position = "absolute";
    this.overlay.style.inset = "0";
    this.overlay.style.pointerEvents = "none";
    this.overlay.style.overflow = "hidden";
    this.overlay.style.zIndex = "6";

    container.appendChild(this.overlay);
  }

  render(context: StudyRenderContext): StudyRenderResult {
    this.latestContext = context;

    const atrSettings = context.settings.atrExpansion;

    this.lastResult = {
      atrExpansionMarkers: atrSettings.enabled
        ? buildAtrExpansionMarkers(
            context.bars,
            atrSettings.length,
            atrSettings.multiplier,
            atrSettings.color || "#facc15",
          )
        : [],
    };

    this.scheduleOverlayRender();

    return this.lastResult;
  }

  scheduleOverlayRender(): void {
    if (this.renderFrame != null) return;

    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderOverlay();
    });
  }

  clear(): void {
    this.overlay.replaceChildren();
  }

  destroy(): void {
    if (this.renderFrame != null) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }

    this.clear();
    this.overlay.remove();
    this.latestContext = null;
  }

  private renderOverlay(): void {
    this.clear();

    if (!this.latestContext?.bars.length) return;

    const fragment = document.createDocumentFragment();

    for (const marker of this.lastResult.atrExpansionMarkers) {
      const x = this.chart.timeScale().timeToCoordinate(marker.time as Time);
      const y = this.series.priceToCoordinate(marker.price);

      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }

      const element = createMarkerElement(marker);
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      fragment.appendChild(element);
    }

    this.overlay.appendChild(fragment);
  }
}
