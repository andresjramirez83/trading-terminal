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
import {
  buildAutomaticDemandZones,
  type AutomaticDemandZone,
} from "../DemandZoneEngine";


type FairValueGapDirection = "bullish" | "bearish";

type FairValueGap = {
  direction: FairValueGapDirection;
  startTime: Time;
  top: number;
  bottom: number;
};

function buildFairValueGaps(
  bars: CleanBar[],
  direction: FairValueGapDirection,
  maxGaps = 32,
): FairValueGap[] {
  if (bars.length < 3) return [];

  const gaps: FairValueGap[] = [];

  for (let index = 2; index < bars.length; index += 1) {
    const first = bars[index - 2];
    const displacement = bars[index - 1];
    const third = bars[index];

    const bullish = third.low > first.high;
    const bearish = third.high < first.low;
    if (direction === "bullish" ? !bullish : !bearish) continue;

    const bottom = direction === "bullish" ? first.high : third.high;
    const top = direction === "bullish" ? third.low : first.low;
    if (!Number.isFinite(bottom) || !Number.isFinite(top) || top <= bottom) {
      continue;
    }

    // An FVG is valid only while price has never returned to its price range.
    // Any wick/body overlap with the zone after the confirming third candle is
    // a retest, so the gap is removed completely from the chart. Boundary
    // touches count as retests as well.
    let retested = false;
    for (let futureIndex = index + 1; futureIndex < bars.length; futureIndex += 1) {
      const future = bars[futureIndex];
      const touchesGap =
        direction === "bullish"
          ? future.low <= top
          : future.high >= bottom;
      if (touchesGap) {
        retested = true;
        break;
      }
    }
    if (retested) continue;

    gaps.push({
      direction,
      // Start at the imbalance/displacement candle so the box visually begins
      // where the FVG was created, while the third candle confirms it.
      startTime: displacement.time,
      top,
      bottom,
    });
  }

  return gaps.slice(-maxGaps);
}

function createFvgElement(
  gap: FairValueGap,
  left: number,
  right: number,
  topY: number,
  bottomY: number,
): HTMLDivElement {
  const bullish = gap.direction === "bullish";
  const element = document.createElement("div");
  const width = Math.max(4, right - left);
  const height = Math.max(2, bottomY - topY);
  const border = bullish ? "#22c55e" : "#ef4444";
  const fill = bullish
    ? "rgba(34, 197, 94, 0.11)"
    : "rgba(239, 68, 68, 0.10)";

  element.title = `${bullish ? "Bullish" : "Bearish"} FVG ${gap.bottom.toFixed(4)} - ${gap.top.toFixed(4)} | untested`;
  element.style.position = "absolute";
  element.style.left = `${left}px`;
  element.style.top = `${topY}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.boxSizing = "border-box";
  element.style.background = fill;
  element.style.borderTop = `1px solid ${border}`;
  element.style.borderBottom = `1px solid ${border}`;
  element.style.pointerEvents = "none";

  const badge = document.createElement("span");
  badge.textContent = bullish ? "B FVG" : "S FVG";
  badge.style.position = "absolute";
  badge.style.left = "3px";
  badge.style.top = "1px";
  badge.style.padding = "0 3px";
  badge.style.borderRadius = "3px";
  badge.style.background = "rgba(2, 6, 23, 0.82)";
  badge.style.color = border;
  badge.style.fontSize = "8px";
  badge.style.fontWeight = "900";
  badge.style.lineHeight = "12px";
  badge.style.whiteSpace = "nowrap";
  element.appendChild(badge);

  return element;
}

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
  // Keep automatic demand zones visually distinct from bullish FVGs.
  // Bullish FVGs use green; demand zones use light-blue/cyan shades.
  const border = continuation ? "#38bdf8" : "#7dd3fc";
  const fill = continuation
    ? invalidated
      ? "rgba(56, 189, 248, 0.10)"
      : "rgba(56, 189, 248, 0.17)"
    : invalidated
      ? "rgba(125, 211, 252, 0.09)"
      : "rgba(125, 211, 252, 0.14)";
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
  private bullishFvgs: FairValueGap[] = [];
  private bearishFvgs: FairValueGap[] = [];
  private structureVisible = true;
  private demandZonesVisible = true;
  private bullishFvgVisible = false;
  private bearishFvgVisible = false;

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
    /**
     * Keep invalidated zones for historical chart rendering. Downstream study
     * consumers still receive active zones only.
     */
    this.demandZones = detectedDemandZones;
    this.bullishFvgs = this.bullishFvgVisible
      ? buildFairValueGaps(context.bars, "bullish")
      : [];
    this.bearishFvgs = this.bearishFvgVisible
      ? buildFairValueGaps(context.bars, "bearish")
      : [];

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

  setFvgVisibility(bullishVisible: boolean, bearishVisible: boolean): void {
    const bullishChanged = this.bullishFvgVisible !== bullishVisible;
    const bearishChanged = this.bearishFvgVisible !== bearishVisible;
    if (!bullishChanged && !bearishChanged) return;

    this.bullishFvgVisible = bullishVisible;
    this.bearishFvgVisible = bearishVisible;

    const bars = this.latestContext?.bars ?? [];
    this.bullishFvgs = bullishVisible
      ? buildFairValueGaps(bars, "bullish")
      : [];
    this.bearishFvgs = bearishVisible
      ? buildFairValueGaps(bars, "bearish")
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
    this.bullishFvgs = [];
    this.bearishFvgs = [];
  }

  private renderOverlay(): void {
    if (!this.latestContext?.bars.length) {
      this.clear();
      return;
    }

    const fragment = document.createDocumentFragment();
    const timeScale = this.chart.timeScale();
    const measuredWidth = (
      timeScale as unknown as { width?: () => number }
    ).width?.();
    const viewportWidth =
      measuredWidth != null && Number.isFinite(measuredWidth)
        ? measuredWidth
        : this.overlay.clientWidth;
    const minVisibleX = -48;
    const maxVisibleX = Math.max(0, viewportWidth) + 48;
    const isVisibleX = (x: number): boolean =>
      x >= minVisibleX && x <= maxVisibleX;
    const intersectsVisibleX = (left: number, right: number): boolean =>
      Math.max(left, right) >= minVisibleX &&
      Math.min(left, right) <= maxVisibleX;

    const lastBar = this.latestContext.bars[this.latestContext.bars.length - 1];
    const lastBarX = lastBar
      ? timeScale.timeToCoordinate(lastBar.time as Time)
      : null;
    const zoneEndX =
      viewportWidth > 0
        ? viewportWidth
        : lastBarX;

    if (zoneEndX != null && Number.isFinite(zoneEndX)) {
      for (const gap of [...this.bullishFvgs, ...this.bearishFvgs]) {
        const startX = timeScale.timeToCoordinate(gap.startTime as Time);
        // Retested gaps are filtered out during detection, so every rendered
        // gap is still valid and extends through the current chart edge.
        const endX = zoneEndX;
        const topY = this.series.priceToCoordinate(gap.top);
        const bottomY = this.series.priceToCoordinate(gap.bottom);

        if (
          startX == null ||
          endX == null ||
          topY == null ||
          bottomY == null ||
          !Number.isFinite(startX) ||
          !Number.isFinite(endX) ||
          !Number.isFinite(topY) ||
          !Number.isFinite(bottomY)
        ) {
          continue;
        }

        const gapLeft = Math.min(startX, endX);
        const gapRight = Math.max(startX, endX);
        if (!intersectsVisibleX(gapLeft, gapRight)) continue;

        fragment.appendChild(
          createFvgElement(
            gap,
            gapLeft,
            gapRight,
            Math.min(topY, bottomY),
            Math.max(topY, bottomY),
          ),
        );
      }

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

        const zoneLeft = Math.min(startX, endX);
        const zoneRight = Math.max(startX, endX);

        if (!intersectsVisibleX(zoneLeft, zoneRight)) {
          continue;
        }

        fragment.appendChild(
          createDemandZoneElement(
            zone,
            zoneLeft,
            zoneRight,
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

      if (!intersectsVisibleX(left, right)) {
        continue;
      }

      fragment.appendChild(
        createStructureLineElement(line, left, right, y),
      );

      const pointX = timeScale.timeToCoordinate(line.pointTime as Time);

      if (
        pointX != null &&
        Number.isFinite(pointX) &&
        isVisibleX(pointX)
      ) {
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
        !Number.isFinite(y) ||
        !isVisibleX(x)
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
        !Number.isFinite(y) ||
        !isVisibleX(x)
      ) {
        continue;
      }

      const element = createMarkerElement(marker);
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;

      fragment.appendChild(element);
    }

    // Swap the overlay in one DOM mutation. Combined with viewport culling,
    // this avoids rebuilding hundreds of off-screen labels while panning.
    this.overlay.replaceChildren(fragment);
  }
}
