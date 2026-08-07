// src/components/chart/studies/StudyRenderer.ts

import type { IChartApi, Time } from "lightweight-charts";

import type { CleanBar } from "../ChartTypes";
import type {
  StudyMarkerPoint,
  StudyRendererSeries,
  StudyRenderContext,
  StudyRenderResult,
} from "./StudyTypes";
import {
  buildStructureStudyLines,
  type StructureStudyLine,
} from "./StructureStudy";
import { analyzeLiquidity, type LiquidityEvent } from "../analysis/LiquiditySweepEngine";
import { buildMarketStructure } from "../analysis/MarketStructureEngine";
import { buildAutomaticSupplyZones } from "../SupplyZoneEngine";
import {
  buildAutomaticDemandZones,
  type AutomaticDemandZone,
} from "../DemandZoneEngine";

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
    const slice = trueRanges
      .slice(start, index + 1)
      .filter((value) => value > 0);

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
      label: `ATR Expansion ${(
        (bar.high - bar.low) /
        Math.max(atr, 0.000001)
      ).toFixed(2)}x`,
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
  element.style.boxShadow =
    "0 0 0 1px rgba(255,255,255,0.18), 0 0 8px rgba(250,204,21,0.45)";
  element.style.pointerEvents = "none";
  element.style.transform = "translate(-50%, -50%)";

  return element;
}

function createStructureLineElement(
  line: StructureStudyLine,
  left: number,
  right: number,
  y: number,
): HTMLDivElement {
  const element = document.createElement("div");
  const width = Math.max(12, right - left);

  element.title = `${line.label} ${line.price}`;
  element.style.position = "absolute";
  element.style.left = `${left}px`;
  element.style.top = `${y}px`;
  element.style.width = `${width}px`;
  element.style.height = "0";
  element.style.borderTop = `${line.lineWidth}px ${
    line.lineStyle === "dashed" ? "dashed" : "solid"
  } ${line.color}`;
  element.style.pointerEvents = "none";
  element.style.transform = "translateY(-50%)";

  return element;
}

function createStructureLabelElement(
  line: StructureStudyLine,
  x: number,
  y: number,
): HTMLDivElement {
  const element = document.createElement("div");
  const isHigh = line.side === "high";

  element.title = `${line.label} ${line.price}`;
  element.textContent = line.label;
  element.style.position = "absolute";
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  element.style.padding = "1px 4px";
  element.style.borderRadius = "4px";
  element.style.background = line.pending
    ? "rgba(113, 63, 18, 0.92)"
    : "rgba(2, 6, 23, 0.92)";
  element.style.border = `1px solid ${line.color}`;
  element.style.color = line.color;
  element.style.fontSize = "9px";
  element.style.fontWeight = "900";
  element.style.opacity = line.pending ? "0.9" : "1";
  element.style.lineHeight = "14px";
  element.style.whiteSpace = "nowrap";
  element.style.pointerEvents = "none";
  element.style.transform = isHigh
    ? "translate(-50%, calc(-100% - 5px))"
    : "translate(-50%, 5px)";

  return element;
}

function createLiquiditySweepLabelElement(
  event: LiquidityEvent,
  x: number,
  y: number,
): HTMLDivElement {
  const element = document.createElement("div");
  const isBuySide = event.side === "buy-side";
  const color = isBuySide ? "#f97316" : "#22c55e";

  element.title = `${isBuySide ? "Buy-side" : "Sell-side"} liquidity sweep at ${event.price.toFixed(2)}`;
  element.textContent = "LS";
  element.style.position = "absolute";
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  element.style.padding = "1px 4px";
  element.style.borderRadius = "4px";
  element.style.background = "rgba(2, 6, 23, 0.94)";
  element.style.border = `1px solid ${color}`;
  element.style.color = color;
  element.style.fontSize = "9px";
  element.style.fontWeight = "900";
  element.style.lineHeight = "14px";
  element.style.whiteSpace = "nowrap";
  element.style.pointerEvents = "none";
  element.style.transform = isBuySide
    ? "translate(-50%, calc(-100% - 7px))"
    : "translate(-50%, 7px)";

  return element;
}

function createDemandZoneElement(
  zone: AutomaticDemandZone,
  left: number,
  right: number,
  topY: number,
  bottomY: number,
): HTMLDivElement {
  const element = document.createElement("div");
  const continuation = zone.setup === "continuation";
  const invalidated =
    !zone.active || zone.status === "invalidated";
  /**
   * Keep historical zones visibly shaded after invalidation. The dashed
   * border and DZ× label show that the zone failed, while the original demand
   * color preserves where the setup existed.
   */
  const border = continuation ? "#22c55e" : "#38bdf8";
  const fill = continuation
    ? invalidated
      ? "rgba(34, 197, 94, 0.12)"
      : "rgba(34, 197, 94, 0.18)"
    : invalidated
      ? "rgba(56, 189, 248, 0.10)"
      : "rgba(56, 189, 248, 0.15)";
  const width = Math.max(8, right - left);
  const height = Math.max(2, bottomY - topY);
  const label = invalidated
    ? continuation
      ? "DZ×"
      : "R-DZ×"
    : continuation
      ? "DZ"
      : "R-DZ";

  element.title = [
    continuation ? "Continuation demand zone" : "Reversal demand zone",
    `${zone.bottom.toFixed(2)} - ${zone.top.toFixed(2)}`,
    `FVG + close above ${zone.previousHigh.toFixed(2)}`,
    zone.status.replace(/-/g, " "),
  ].join(" | ");
  element.style.position = "absolute";
  element.style.left = `${left}px`;
  element.style.top = `${topY}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.boxSizing = "border-box";
  element.style.background = fill;
  const borderStyle = invalidated ? "dashed" : "solid";
  element.style.borderTop = `1px ${borderStyle} ${border}`;
  element.style.borderBottom = `1px ${borderStyle} ${border}`;
  element.style.opacity = "1";
  element.style.pointerEvents = "none";

  const badge = document.createElement("span");
  badge.textContent = label;
  badge.style.position = "absolute";
  badge.style.left = "3px";
  badge.style.top = "2px";
  badge.style.padding = "0 3px";
  badge.style.borderRadius = "3px";
  badge.style.background = "rgba(2, 6, 23, 0.88)";
  badge.style.color = border;
  badge.style.fontSize = "9px";
  badge.style.fontWeight = "900";
  badge.style.lineHeight = "13px";
  badge.style.whiteSpace = "nowrap";
  element.appendChild(badge);

  return element;
}

export class StudyRenderer {
  private readonly chart: IChartApi;
  private readonly series: StudyRendererSeries;
  private readonly overlay: HTMLDivElement;

  private renderFrame: number | null = null;
  private latestContext: StudyRenderContext | null = null;
  private structureLines: StructureStudyLine[] = [];
  private liquiditySweepEvents: LiquidityEvent[] = [];
  private demandZones: AutomaticDemandZone[] = [];
  private structureVisible = true;
  private demandZonesVisible = true;

  private lastResult: StudyRenderResult = {
    atrExpansionMarkers: [],
    demandZones: [],
  };

  constructor(
    chart: IChartApi,
    container: HTMLDivElement,
    series: StudyRendererSeries,
  ) {
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

    const structure = buildMarketStructure(context.bars);
    const detectedDemandZones = this.demandZonesVisible
      ? buildAutomaticDemandZones(context.bars, {
          structure,
          includeReversalZones: true,
          maxZones: 24,
        })
      : [];
    const detectedSupplyZones = buildAutomaticSupplyZones(context.bars, {
      structure,
      maxZones: 24,
    });

    /**
     * Keep invalidated zones for historical chart rendering. Downstream study
     * consumers still receive active zones only.
     */
    this.demandZones = detectedDemandZones;

    this.lastResult = {
      atrExpansionMarkers: atrSettings.enabled
        ? buildAtrExpansionMarkers(
            context.bars,
            atrSettings.length,
            atrSettings.multiplier,
            atrSettings.color || "#facc15",
          )
        : [],
      demandZones: detectedDemandZones.filter((zone) => zone.active),
    };

    this.structureLines = this.structureVisible
      ? buildStructureStudyLines(context.bars)
      : [];

    this.liquiditySweepEvents = analyzeLiquidity(context.bars, {
      swingHigh: structure.swingHigh,
      swingLow: structure.swingLow,
      points: structure.points,
      demandZones: detectedDemandZones,
      supplyZones: detectedSupplyZones,
    }).sweepEvents.slice(-80);

    this.scheduleOverlayRender();

    return this.lastResult;
  }

  setStructureVisible(visible: boolean): void {
    if (this.structureVisible === visible) return;

    this.structureVisible = visible;

    this.structureLines =
      visible && this.latestContext?.bars.length
        ? buildStructureStudyLines(this.latestContext.bars)
        : [];

    this.scheduleOverlayRender();
  }

  setDemandZonesVisible(visible: boolean): void {
    if (this.demandZonesVisible === visible) return;

    this.demandZonesVisible = visible;
    this.demandZones =
      visible && this.latestContext?.bars.length
        ? buildAutomaticDemandZones(this.latestContext.bars, {
            maxZones: 24,
            includeReversalZones: true,
          })
        : [];
    this.lastResult = {
      ...this.lastResult,
      demandZones: this.demandZones.filter((zone) => zone.active),
    };
    this.scheduleOverlayRender();
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
    this.structureLines = [];
    this.liquiditySweepEvents = [];
    this.demandZones = [];
  }

  private renderOverlay(): void {
    this.clear();

    if (!this.latestContext?.bars.length) return;

    const fragment = document.createDocumentFragment();
    const timeScale = this.chart.timeScale();

    const lastBar = this.latestContext.bars[this.latestContext.bars.length - 1];
    const lastBarX = lastBar
      ? timeScale.timeToCoordinate(lastBar.time as Time)
      : null;
    const timeScaleWidth = (
      timeScale as unknown as { width?: () => number }
    ).width?.();
    const zoneEndX =
      timeScaleWidth != null && Number.isFinite(timeScaleWidth)
        ? timeScaleWidth
        : lastBarX;

    if (zoneEndX != null && Number.isFinite(zoneEndX)) {
      for (const zone of this.demandZones) {
        const startX = timeScale.timeToCoordinate(zone.originTime as Time);
        const invalidationX =
          !zone.active && zone.invalidationTime != null
            ? timeScale.timeToCoordinate(zone.invalidationTime as Time)
            : null;
        const endX =
          invalidationX != null && Number.isFinite(invalidationX)
            ? invalidationX
            : zoneEndX;
        const topY = this.series.priceToCoordinate(zone.top);
        const bottomY = this.series.priceToCoordinate(zone.bottom);

        if (
          startX == null ||
          topY == null ||
          bottomY == null ||
          !Number.isFinite(startX) ||
          !Number.isFinite(endX) ||
          !Number.isFinite(topY) ||
          !Number.isFinite(bottomY)
        ) {
          continue;
        }

        fragment.appendChild(
          createDemandZoneElement(
            zone,
            Math.min(startX, endX),
            Math.max(startX, endX),
            Math.min(topY, bottomY),
            Math.max(topY, bottomY),
          ),
        );
      }
    }

    for (const line of this.structureLines) {
      const startX = timeScale.timeToCoordinate(line.startTime as Time);
      const endX = timeScale.timeToCoordinate(line.endTime as Time);
      const y = this.series.priceToCoordinate(line.price);

      if (
        startX == null ||
        endX == null ||
        y == null ||
        !Number.isFinite(startX) ||
        !Number.isFinite(endX) ||
        !Number.isFinite(y)
      ) {
        continue;
      }

      const left = Math.min(startX, endX);
      const right = Math.max(startX, endX);

      fragment.appendChild(
        createStructureLineElement(line, left, right, y),
      );

      const pointX = timeScale.timeToCoordinate(line.pointTime as Time);

      if (pointX != null && Number.isFinite(pointX)) {
        fragment.appendChild(
          createStructureLabelElement(line, pointX, y),
        );
      }
    }

    for (const event of this.liquiditySweepEvents) {
      const bar = this.latestContext.bars[event.barIndex];
      if (!bar) continue;

      const x = timeScale.timeToCoordinate(bar.time as Time);
      const markerPrice = event.side === "buy-side" ? bar.high : bar.low;
      const y = this.series.priceToCoordinate(markerPrice);

      if (
        x == null ||
        y == null ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        continue;
      }

      fragment.appendChild(createLiquiditySweepLabelElement(event, x, y));
    }

    for (const marker of this.lastResult.atrExpansionMarkers) {
      const x = timeScale.timeToCoordinate(marker.time as Time);
      const y = this.series.priceToCoordinate(marker.price);

      if (
        x == null ||
        y == null ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
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
