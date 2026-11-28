import { detectStructuralPatterns, patternBoundaryAt, type StructuralPattern } from "./ConsolidationStudy";
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
  buildSmartSwingFailures,
  type SwingFailurePattern,
} from "../analysis/SwingFailureEngine";
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
  const emphasized = line.layer !== "internal" && !line.pending && !line.label.endsWith(" Break");
  const choch = line.label.endsWith("CHoCH");
  const paired = line.label === "HL" || line.label === "LH";
  const weight = emphasized ? Math.max(choch ? 4 : 3,line.lineWidth) : line.lineWidth;
  const width = Math.max(paired || choch || line.label.endsWith("BOS") ? 1 : 12,right-left);

  element.title = `${line.label} ${line.price}`;
  element.style.position = "absolute";
  element.style.left = `${left}px`;
  element.style.top = `${y}px`;
  element.style.width = `${width}px`;
  element.style.height = "0";
  element.style.borderTop = `${weight}px ${
    line.lineStyle === "dashed" ? "dashed" : "solid"
  } ${line.color}`;
  element.style.pointerEvents = "none";
  element.style.transform = "translateY(-50%)";

  if (line.label.endsWith("CHoCH")) {
    const shortChoch = right-left < 20;
    element.style.opacity = "1";
    element.style.zIndex = "4";
    if (shortChoch) {
      const extendedWidth = Math.max(32,right-left+16);
      const extendedLeft = left-(extendedWidth-(right-left))/2;
      element.style.left = extendedLeft+"px";
      element.style.width = extendedWidth+"px";
      element.style.height = "0px";
      element.style.borderTop = "4px solid " + line.color;
      element.style.filter = "drop-shadow(0 0 3px " + line.color + ")";
      const marker = document.createElement("div");
      Object.assign(marker.style,{
        position:"absolute",
        right:"-3px",
        top:"-5px",
        width:"6px",
        height:"6px",
        borderRadius:"50%",
        background:line.color,
        pointerEvents:"none"
      });
      element.appendChild(marker);
    }
  }

  if (line.label.endsWith("CHoCH")) {
    element.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.95)";
    element.style.filter = "none";
  }

  if (emphasized) {
    element.style.filter = "drop-shadow(0 0 1px rgba(255,255,255,0.85)) drop-shadow(0 0 3px " + line.color + ")";
    element.style.opacity = "1";
  }
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
  element.style.fontSize = line.layer === "internal" ? "8px" : "9px";
  element.style.fontWeight = line.layer === "internal" ? "600" : "900";
  element.style.opacity = line.layer === "internal" ? "0.75" : line.pending ? "0.9" : "1";
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

function formatSfpPrice(price: number): string {
  if (Math.abs(price) < 1) return price.toFixed(4);
  if (Math.abs(price) < 10) return price.toFixed(3);
  return price.toFixed(2);
}

function createSwingFailureLabelElement(
  pattern: SwingFailurePattern,
  x: number,
  y: number,
): HTMLDivElement {
  const element = document.createElement("div");
  const bullish = pattern.direction === "bullish";
  const color = bullish ? "#22c55e" : "#fb7185";

  element.title = [
    `${bullish ? "Bullish" : "Bearish"} Swing Failure Pattern`,
    `${pattern.levelType} ${formatSfpPrice(pattern.levelPrice)} | ${pattern.anchorSource === "structure" ? "confirmed structure" : "internal liquidity"}`,
    `${pattern.grade} / ${pattern.confidence}% confidence`,
    `structure ${pattern.structureConfidence}%`,
    `wick ${(pattern.wickFraction * 100).toFixed(0)}%`,
    `penetration ${pattern.penetrationAtr.toFixed(2)} ATR`,
    `reclaim ${pattern.reclaimAtr.toFixed(2)} ATR`,
    `volume ${pattern.volumeRatio.toFixed(2)}x`,
    "three-candle swing raided + same-candle close back inside",
  ].join(" | ");
  element.textContent = `SFP ${pattern.grade}`;
  element.style.position = "absolute";
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  element.style.padding = "1px 4px";
  element.style.borderRadius = "4px";
  element.style.background = "rgba(2, 6, 23, 0.96)";
  element.style.border = `1px solid ${color}`;
  element.style.boxShadow = `0 0 0 1px rgba(2, 6, 23, 0.55)`;
  element.style.color = color;
  element.style.fontSize = "9px";
  element.style.fontWeight = "900";
  element.style.lineHeight = "14px";
  element.style.whiteSpace = "nowrap";
  element.style.pointerEvents = "none";
  element.style.transform = bullish
    ? "translate(-50%, 7px)"
    : "translate(-50%, calc(-100% - 7px))";

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
  private swingFailurePatterns: SwingFailurePattern[] = [];
  private demandZones: AutomaticDemandZone[] = [];
  private bullishFvgs: FairValueGap[] = [];
  private bearishFvgs: FairValueGap[] = [];
  private structureVisible = true;
  private swingFailureVisible = true;
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

    const liquidityEvents = analyzeLiquidity(context.bars, {
      swingHigh: structure.swingHigh,
      swingLow: structure.swingLow,
      points: structure.points,
    }).sweepEvents;

    // SFP labels come ONLY from a raided three-candle SFP swing. Confirmed
    // Market Structure HH/HL/LH/LL remains separate and does not create SFPs.
    this.swingFailurePatterns = this.swingFailureVisible
      ? buildSmartSwingFailures(context.bars, structure, liquidityEvents)
      : [];
    this.liquiditySweepEvents = liquidityEvents
      .filter((event) => event.source !== "structure")
      .slice(-80);

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

  setSwingFailureVisible(visible: boolean): void {
    if (this.swingFailureVisible === visible) return;

    this.swingFailureVisible = visible;
    const bars = this.latestContext?.bars ?? [];

    if (!visible || !bars.length) {
      this.swingFailurePatterns = [];
      this.scheduleOverlayRender();
      return;
    }

    const structure = buildMarketStructure(bars);
    const liquidityEvents = analyzeLiquidity(bars, {
      swingHigh: structure.swingHigh,
      swingLow: structure.swingLow,
      points: structure.points,
    }).sweepEvents;
    this.swingFailurePatterns = buildSmartSwingFailures(
      bars,
      structure,
      liquidityEvents,
    );
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
    this.swingFailurePatterns = [];
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

    const consolidationBars = this.latestContext?.bars ?? [];
    const consolidationRanges: StructuralPattern[] = this.structureVisible
      ? detectStructuralPatterns(consolidationBars, "hybrid")
      : [];
    const consolidationIndices = new Map(consolidationBars.map((bar,index) => [bar.time,index] as const));
    const hidePatternStructure = (line: StructureStudyLine): boolean => {
      // Always preserve major trend structure.
      if (line.layer === "major") return false;

      const point = consolidationIndices.get(
        line.pointTime as typeof consolidationBars[number]["time"]
      );

      const confirmation = consolidationIndices.get(
        line.confirmationTime as typeof consolidationBars[number]["time"]
      );

      if (point === undefined || confirmation === undefined) return false;

      const isBreak =
        line.label.endsWith("BOS") ||
        line.label.endsWith("CHoCH") ||
        line.label.endsWith(" Break");

      return consolidationRanges.some(pattern => {
        const last = pattern.breakout
          ? pattern.endIndex - 1
          : pattern.endIndex;

        // Preserve structure originating outside the formation.
        if (point < pattern.startIndex || point > last) return false;
        if (confirmation < pattern.startIndex || confirmation > last) return false;

        const boundary = patternBoundaryAt(pattern, point);
        const tolerance = pattern.tolerance;

        // Preserve levels significantly outside the formation.
        if (line.price > boundary.high + tolerance) return false;
        if (line.price < boundary.low - tolerance) return false;

        if (isBreak) {
          // Preserve potential meaningful boundary breaks.
          for (const index of [point, confirmation]) {
            const edge = patternBoundaryAt(pattern, index);
            const close = consolidationBars[index].close;

            if (close > edge.high + tolerance / 2) return false;
            if (close < edge.low - tolerance / 2) return false;
          }
        }

        // Minor structure contained within a confirmed formation.
        return true;
      });
    };

    const structurePriority = (line: StructureStudyLine) => line.label.endsWith(" Break") ? 0 : (line.label.endsWith("CHoCH") ? 100 : 0) + (line.layer === "major" ? 30 : line.layer === "external" ? 20 : 10) + (line.pending ? 0 : 5);
    const structureBarSpacing = timeScale.options().barSpacing;
    const visibleStructureLabels: {line: StructureStudyLine; x: number; y: number}[] = [];
    const placedStructureLabels: {left:number; right:number; top:number; bottom:number; line:StructureStudyLine; y:number}[] = [];
    for (const line of this.structureLines) {
      const hiddenByPattern = hidePatternStructure(line);

      const confirmedSwing =
        line.layer === "external" &&
        !line.pending &&
        ["HH","HL","LH","LL"].includes(line.label);

      if (hiddenByPattern && !confirmedSwing) continue;

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

      if (!hiddenByPattern) fragment.appendChild(
        createStructureLineElement(line.label.endsWith("CHoCH") ? {...line,lineWidth:line.layer === "internal" ? 2 : 3,lineStyle:"solid",color:line.side === "high" ? "#22c55e" : "#ef4444"} : line, left, right, y),
      );

      if (!hiddenByPattern && line.layer === "external" && !line.pending && (line.label === "HL" || line.label === "LH") && right-left >= Math.max(54,structureBarSpacing*1.8) && isVisibleX(right)) {
        const levelLabel=document.createElement("div");
        levelLabel.textContent=line.label;
        Object.assign(levelLabel.style,{
          position:"absolute",
          left:(right-5)+"px",
          top:(y+(line.label==="HL" ? 4 : -4))+"px",
          transform:line.label==="HL" ? "translate(-100%,0)" : "translate(-100%,-100%)",
          color:line.color,
          fontSize:"12px",
          fontWeight:"800",
          textShadow:"0 0 3px #000000, 0 0 5px #000000",
          pointerEvents:"none",
          zIndex:"6"
        });
        fragment.appendChild(levelLabel);
      }
      let labelY = y;

      if (confirmedSwing) {
        const index = consolidationIndices.get(
          line.pointTime as typeof consolidationBars[number]["time"]
        );

        const bar = index === undefined
          ? undefined
          : consolidationBars[index];

        if (bar) {
          const wickY = this.series.priceToCoordinate(
            line.side === "high" ? bar.high : bar.low
          );

          if (wickY !== null && Number.isFinite(wickY)) {
            labelY = wickY;
          }
        }
      }

      const pointX = timeScale.timeToCoordinate(line.pointTime as Time);

      if (
        pointX != null &&
        Number.isFinite(pointX) &&
        isVisibleX(pointX)
      ) {
        if ((line.layer !== "internal" || structureBarSpacing >= (line.label.endsWith("CHoCH") ? 5 : 8))) visibleStructureLabels.push({line,x:pointX,y:labelY});
      }
    }
    visibleStructureLabels.sort((a,b) => structurePriority(b.line)-structurePriority(a.line) || a.x-b.x);
    for (const {line,x,y} of visibleStructureLabels) {
      const choch = line.label.endsWith("CHoCH");
      const name = line.label.replace(/^[mi]/,"");
      if (placedStructureLabels.some(p => p.line.pointTime === line.pointTime && p.line.side === line.side && p.line.label.replace(/^[mi]/,"") === name && Math.abs(p.y-y) <= 3)) continue;
      const element = createStructureLabelElement(line,x,y);
      if (choch) {
        const bullish = line.side === "high";
        element.textContent = (bullish ? String.fromCharCode(8593) : String.fromCharCode(8595)) + " " + line.label;
        Object.assign(element.style,{fontSize:"12px",fontWeight:"900",opacity:"1",color:"#ffffff",background:bullish ? "#166534" : "#991b1b",border:bullish ? "2px solid #4ade80" : "2px solid #f87171",padding:"2px 6px",lineHeight:"16px",zIndex:"5"});
      }
      const displayStructureLabel = (value: StructureStudyLine): string => {
        if (value.layer === "external") return value.label;
        if (value.layer === "major" && value.label.endsWith("CHoCH")) return "TCHoCH";
        if (value.layer === "major" && value.label.endsWith("BOS")) return "TBOS";
        if (value.label.endsWith("CHoCH") || value.label.endsWith("BOS") || value.label.endsWith("EQH") || value.label.endsWith("EQL")) return value.label;
        const prefix = value.label.replace(/^[mi]/,"");
        const state = prefix.startsWith("p") ? "p" : prefix.startsWith("d") ? "d" : "";
        const high = value.side === "high";
        return state + (value.layer === "major" ? (high ? "TH" : "TL") : value.layer === "internal" ? (high ? "IH" : "IL") : (high ? "HH" : "LL"));
      };
      element.textContent = displayStructureLabel(line);
      Object.assign(element.style,{fontSize:choch || line.layer !== "internal" ? "11px" : "10px",fontWeight:choch ? "700" : "600",opacity:"1",textShadow:"0 1px 2px #000000",color:line.color,background:"transparent",border:"none",padding:"0px 2px",lineHeight:"14px",zIndex:"1"});
      const width = (element.textContent?.length ?? 0)*7+10;
      const height = 16;
      const above = line.side === "high";
      const clearance = choch ? 18 : 12;
      const appendFloatingStructureLabel = (top: number) => {
        element.style.top = top+"px";
        element.style.transform = "translate(-50%,0)";
        fragment.appendChild(element);
      };
      let placed = false;
      for (let lane=0;lane<(structureBarSpacing < 8 ? 2 : 3);lane++) {
        const top = above ? y-clearance-height-lane*20 : y+clearance+lane*20;
        if (top < 0) continue;
        const rect = {left:x-width/2,right:x+width/2,top,bottom:top+height,line,y};
        if (placedStructureLabels.some(p => rect.left < p.right+3 && rect.right > p.left-3 && rect.top < p.bottom+3 && rect.bottom > p.top-3)) continue;
        appendFloatingStructureLabel(top);
        placedStructureLabels.push(rect);
        placed = true;
        break;
      }
      void placed;
    }

    if (this.structureVisible && this.latestContext) {
      const bars = this.latestContext.bars;
      const ns = "http://www.w3.org/2000/svg";

      const svg = document.createElementNS(ns, "svg");

      Object.assign(svg.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "hidden"
      });

      for (const pattern of consolidationRanges) {
        const first = bars[pattern.startIndex];
        const last = bars[pattern.endIndex];

        if (!first || !last) continue;

        const x1 = timeScale.timeToCoordinate(first.time as Time);
        const x2 = timeScale.timeToCoordinate(last.time as Time);

        if (x1 == null || x2 == null) continue;
        if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;
        if (!intersectsVisibleX(x1,x2)) continue;

        const start = patternBoundaryAt(pattern,pattern.startIndex);
        const end = patternBoundaryAt(pattern,pattern.endIndex);

        const u1 = this.series.priceToCoordinate(start.high);
        const u2 = this.series.priceToCoordinate(end.high);
        const l1 = this.series.priceToCoordinate(start.low);
        const l2 = this.series.priceToCoordinate(end.low);

        if (u1 == null || u2 == null || l1 == null || l2 == null) continue;
        if (![u1,u2,l1,l2].every(Number.isFinite)) continue;

        const area = document.createElementNS(ns,"polygon");

        area.setAttribute("points",
          x1+","+u1+" "+x2+","+u2+" "+x2+","+l2+" "+x1+","+l1
        );

        area.setAttribute("fill","#eab308");
        area.setAttribute("fill-opacity","0.065");
        area.setAttribute("stroke","none");

        svg.appendChild(area);

        const drawBoundary = (y1:number,y2:number) => {
          const line = document.createElementNS(ns,"line");
          line.setAttribute("x1",String(x1));
          line.setAttribute("y1",String(y1));
          line.setAttribute("x2",String(x2));
          line.setAttribute("y2",String(y2));
          line.setAttribute("stroke","#facc15");
          line.setAttribute("stroke-width","1.5");
          line.setAttribute("stroke-opacity","0.9");
          svg.appendChild(line);
        };

        drawBoundary(u1,u2);
        drawBoundary(l1,l2);

        const label = document.createElementNS(ns,"text");

        const labelX = Math.max(8,x1+5);
        const fraction = Math.max(0,Math.min(1,
          (labelX-x1)/Math.max(1,x2-x1)
        ));

        const labelY = Math.max(12,u1+(u2-u1)*fraction-5);

        label.setAttribute("x",String(labelX));
        label.setAttribute("y",String(labelY));
        label.setAttribute("fill","#facc15");
        label.setAttribute("font-size","10");
        label.setAttribute("font-weight","700");
        label.setAttribute("stroke","#111827");
        label.setAttribute("stroke-width","2");
        label.setAttribute("paint-order","stroke");

        label.textContent = pattern.kind;

        svg.appendChild(label);
      }

      fragment.insertBefore(svg,fragment.firstChild);
    }

    for (const pattern of this.swingFailurePatterns) {
      const bar = this.latestContext.bars[pattern.barIndex];
      if (!bar) continue;

      const x = timeScale.timeToCoordinate(bar.time as Time);
      const markerPrice = pattern.direction === "bearish" ? bar.high : bar.low;
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

      fragment.appendChild(createSwingFailureLabelElement(pattern, x, y));
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
