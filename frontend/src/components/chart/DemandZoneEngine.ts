// src/components/chart/DemandZoneEngine.ts

import type { Time, UTCTimestamp } from "lightweight-charts";
import type { CleanBar, DemandZone } from "./ChartTypes";
import {
  buildMarketStructure,
  type MarketStructurePoint,
  type MarketStructureResult,
} from "./analysis/MarketStructureEngine";

export type AutomaticDemandZoneSetup = "continuation" | "reversal";
export type AutomaticDemandZoneStatus =
  | "fresh"
  | "touched"
  | "partially-mitigated"
  | "invalidated";

/**
 * A demand zone confirmed by structure and imbalance, not a manually drawn
 * rectangle. The full origin-candle range (including both wicks) is used.
 */
export interface AutomaticDemandZone {
  id: string;
  originIndex: number;
  originTime: Time;
  confirmationIndex: number;
  confirmationTime: Time;
  fvgIndex: number;
  fvgTime: Time;
  bottom: number;
  top: number;
  previousHigh: number;
  previousHigherLow?: number;
  setup: AutomaticDemandZoneSetup;
  status: AutomaticDemandZoneStatus;
  active: boolean;
  touchCount: number;
  mitigationPercent: number;
  invalidationIndex?: number;
  invalidationTime?: Time;
}

export interface AutomaticDemandZoneOptions {
  /** Last bearish/indecision candle search distance before the impulse. */
  maxOriginLookback?: number;
  /** Allows the FVG to complete shortly after the structure-break candle. */
  maxFvgBarsAfterBreak?: number;
  /** Maximum body/range ratio that qualifies a candle as indecision. */
  indecisionBodyPercent?: number;
  /** Keep reversal demand zones whose origin formed below the prior HL. */
  includeReversalZones?: boolean;
  maxZones?: number;
  structure?: MarketStructureResult;
}

export interface DemandZoneOptions {
  extendBars?: number;
  bodyOnly?: boolean;
  symbol?: string;
  timeframe?: string;
}

const STORAGE_PREFIX = "chart.demandZones.v1";

function bodyHigh(bar: CleanBar): number {
  return Math.max(bar.open, bar.close);
}

function isFiniteBar(bar: CleanBar | undefined): bar is CleanBar {
  return Boolean(
    bar &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close),
  );
}

function isBullishFvg(bars: CleanBar[], index: number): boolean {
  if (index < 2 || index >= bars.length) return false;

  const first = bars[index - 2];
  const impulse = bars[index - 1];
  const third = bars[index];

  return (
    isFiniteBar(first) &&
    isFiniteBar(impulse) &&
    isFiniteBar(third) &&
    impulse.close > impulse.open &&
    third.low > first.high
  );
}

function isOriginCandle(
  bar: CleanBar,
  indecisionBodyPercent: number,
): boolean {
  const range = Math.max(bar.high - bar.low, 0);
  const body = Math.abs(bar.close - bar.open);
  const bearish = bar.close < bar.open;
  const indecision = range > 0 && body / range <= indecisionBodyPercent;

  return bearish || indecision;
}

function findOriginIndex(
  bars: CleanBar[],
  fvgIndex: number,
  minimumIndex: number,
  maxLookback: number,
  indecisionBodyPercent: number,
): number | null {
  // The middle candle of a three-candle FVG is the displacement candle. Start
  // immediately before it and walk back to the last bearish/indecision candle.
  const latestOrigin = fvgIndex - 2;
  const earliestOrigin = Math.max(
    minimumIndex,
    latestOrigin - Math.max(1, maxLookback) + 1,
  );

  for (let index = latestOrigin; index >= earliestOrigin; index -= 1) {
    const bar = bars[index];
    if (isFiniteBar(bar) && isOriginCandle(bar, indecisionBodyPercent)) {
      return index;
    }
  }

  return null;
}

function latestPointBefore(
  points: MarketStructurePoint[],
  confirmationIndex: number,
  types: MarketStructurePoint["type"][],
): MarketStructurePoint | undefined {
  return points
    .filter(
      (point) =>
        point.confirmationIndex < confirmationIndex &&
        point.index < confirmationIndex &&
        types.includes(point.type),
    )
    .sort((a, b) => {
      if (a.confirmationIndex !== b.confirmationIndex) {
        return b.confirmationIndex - a.confirmationIndex;
      }

      return b.index - a.index;
    })[0];
}

function isPivotHigh(bars: CleanBar[], index: number): boolean {
  if (index < 2 || index > bars.length - 3) return false;
  const high = bars[index].high;

  return (
    high > bars[index - 1].high &&
    high > bars[index - 2].high &&
    high >= bars[index + 1].high &&
    high >= bars[index + 2].high
  );
}

function findFallbackBreakLevel(
  bars: CleanBar[],
  confirmationIndex: number,
): { index: number; price: number } | null {
  const close = bars[confirmationIndex]?.close;
  if (!Number.isFinite(close)) return null;

  for (let index = confirmationIndex - 1; index >= 2; index -= 1) {
    if (!isPivotHigh(bars, index)) continue;

    const level = bodyHigh(bars[index]);
    if (close > level) return { index, price: level };
  }

  return null;
}

function getBullishBreakConfirmations(
  structure: MarketStructureResult,
): number[] {
  const groups = new Map<number, MarketStructurePoint[]>();

  for (const point of structure.points) {
    const group = groups.get(point.confirmationIndex) ?? [];
    group.push(point);
    groups.set(point.confirmationIndex, group);
  }

  return [...groups.entries()]
    .filter(([, points]) =>
      points.some(
        (point) =>
          point.type === "HL" ||
          (point.type === "HH" && point.breakType === "choch"),
      ),
    )
    .map(([confirmationIndex]) => confirmationIndex)
    .sort((a, b) => a - b);
}

function evaluateLifecycle(
  bars: CleanBar[],
  zone: AutomaticDemandZone,
): AutomaticDemandZone {
  let status: AutomaticDemandZoneStatus = "fresh";
  let touchCount = 0;
  let mitigationPercent = 0;
  let wasInside = false;
  const height = Math.max(zone.top - zone.bottom, 0.0000001);
  const startIndex = Math.max(zone.confirmationIndex, zone.fvgIndex) + 1;

  for (let index = startIndex; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!isFiniteBar(bar)) continue;

    if (bar.close < zone.bottom) {
      return {
        ...zone,
        status: "invalidated",
        active: false,
        touchCount,
        mitigationPercent: 100,
        invalidationIndex: index,
        invalidationTime: bar.time,
      };
    }

    const inside = bar.low <= zone.top && bar.high >= zone.bottom;
    if (inside && !wasInside) touchCount += 1;

    if (inside) {
      const depth = Math.max(0, Math.min(1, (zone.top - bar.low) / height));
      mitigationPercent = Math.max(mitigationPercent, depth * 100);
      status = mitigationPercent > 5 ? "partially-mitigated" : "touched";
    }

    wasInside = inside;
  }

  return {
    ...zone,
    status,
    active: true,
    touchCount,
    mitigationPercent: Math.round(mitigationPercent),
  };
}

/**
 * Detects automatic bullish demand zones using the user's approved rules:
 * 1. The origin is the last bearish/indecision candle before displacement.
 * 2. The displacement must leave a three-candle bullish FVG.
 * 3. That same leg must CLOSE above a prior confirmed structure high.
 * 4. An origin fully above the prior HL is continuation; otherwise reversal.
 * 5. The zone uses the origin candle's full wick range and is invalid only by
 *    a candle close below its low. ATR is deliberately not used.
 */
export function buildAutomaticDemandZones(
  bars: CleanBar[],
  options: AutomaticDemandZoneOptions = {},
): AutomaticDemandZone[] {
  if (bars.length < 8 || bars.some((bar) => !isFiniteBar(bar))) return [];

  const maxOriginLookback = Math.max(1, options.maxOriginLookback ?? 8);
  const maxFvgBarsAfterBreak = Math.max(
    0,
    options.maxFvgBarsAfterBreak ?? 3,
  );
  const indecisionBodyPercent = Math.max(
    0,
    Math.min(1, options.indecisionBodyPercent ?? 0.25),
  );
  const includeReversalZones = options.includeReversalZones ?? true;
  const maxZones = Math.max(1, options.maxZones ?? 24);
  const structure = options.structure ?? buildMarketStructure(bars);
  const confirmations = getBullishBreakConfirmations(structure);
  const zones: AutomaticDemandZone[] = [];
  const usedOriginIndexes = new Set<number>();

  for (let eventIndex = 0; eventIndex < confirmations.length; eventIndex += 1) {
    const confirmationIndex = confirmations[eventIndex];
    const confirmationBar = bars[confirmationIndex];
    if (!isFiniteBar(confirmationBar)) continue;

    const previousHighPoint = latestPointBefore(
      structure.points,
      confirmationIndex,
      ["HH", "LH"],
    );
    const fallbackHigh = previousHighPoint
      ? null
      : findFallbackBreakLevel(bars, confirmationIndex);
    const previousHighIndex = previousHighPoint?.index ?? fallbackHigh?.index;
    const previousHigh = previousHighPoint
      ? bodyHigh(bars[previousHighPoint.index])
      : fallbackHigh?.price;

    if (
      previousHighIndex == null ||
      previousHigh == null ||
      confirmationBar.close <= previousHigh
    ) {
      continue;
    }

    const previousEventConfirmation = confirmations[eventIndex - 1] ?? 0;
    const legStart = Math.max(
      0,
      Math.min(previousHighIndex + 1, confirmationIndex - 1),
      previousEventConfirmation + 1,
    );
    const fvgSearchEnd = Math.min(
      bars.length - 1,
      confirmationIndex + maxFvgBarsAfterBreak,
    );

    let selectedFvgIndex: number | null = null;
    let selectedOriginIndex: number | null = null;

    for (
      let fvgIndex = Math.max(2, legStart + 2);
      fvgIndex <= fvgSearchEnd;
      fvgIndex += 1
    ) {
      if (!isBullishFvg(bars, fvgIndex)) continue;

      const originIndex = findOriginIndex(
        bars,
        fvgIndex,
        legStart,
        maxOriginLookback,
        indecisionBodyPercent,
      );

      if (originIndex == null || usedOriginIndexes.has(originIndex)) continue;

      selectedFvgIndex = fvgIndex;
      selectedOriginIndex = originIndex;
      break;
    }

    if (selectedFvgIndex == null || selectedOriginIndex == null) continue;

    const origin = bars[selectedOriginIndex];
    const previousHigherLow = latestPointBefore(
      structure.points,
      confirmationIndex,
      ["HL"],
    );
    const setup: AutomaticDemandZoneSetup =
      previousHigherLow && origin.low > previousHigherLow.price
        ? "continuation"
        : "reversal";

    if (setup === "reversal" && !includeReversalZones) continue;

    usedOriginIndexes.add(selectedOriginIndex);

    const baseZone: AutomaticDemandZone = {
      id: [
        "auto-demand",
        String(origin.time),
        String(confirmationBar.time),
      ].join("-"),
      originIndex: selectedOriginIndex,
      originTime: origin.time,
      confirmationIndex,
      confirmationTime: confirmationBar.time,
      fvgIndex: selectedFvgIndex,
      fvgTime: bars[selectedFvgIndex].time,
      bottom: origin.low,
      top: origin.high,
      previousHigh,
      previousHigherLow: previousHigherLow?.price,
      setup,
      status: "fresh",
      active: true,
      touchCount: 0,
      mitigationPercent: 0,
    };

    zones.push(evaluateLifecycle(bars, baseZone));
  }

  return zones.slice(-maxZones);
}

function normalizeSymbol(symbol?: string): string {
  return String(symbol || "SPY").trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_");
}

function normalizeTimeframe(timeframe?: string): string {
  return String(timeframe || "5m").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
}

function makeStorageKey(symbol?: string, timeframe?: string): string {
  return `${STORAGE_PREFIX}.${normalizeSymbol(symbol)}.${normalizeTimeframe(timeframe)}`;
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function cloneZone(zone: DemandZone): DemandZone {
  return JSON.parse(JSON.stringify(zone)) as DemandZone;
}

/**
 * Existing manual-zone storage API. Automatic detection is exposed through
 * detect() and buildAutomaticDemandZones() so manual drawings remain separate.
 */
export class DemandZoneEngine {
  private zones = new Map<string, DemandZone>();
  private extendBars: number;
  private bodyOnly: boolean;
  private symbol: string;
  private timeframe: string;
  private storageKey: string;

  constructor(options?: DemandZoneOptions) {
    this.extendBars = options?.extendBars ?? 500;
    this.bodyOnly = options?.bodyOnly ?? false;
    this.symbol = normalizeSymbol(options?.symbol);
    this.timeframe = normalizeTimeframe(options?.timeframe);
    this.storageKey = makeStorageKey(this.symbol, this.timeframe);
    this.load();
  }

  detect(
    bars: CleanBar[],
    options: AutomaticDemandZoneOptions = {},
  ): AutomaticDemandZone[] {
    return buildAutomaticDemandZones(bars, options);
  }

  setWorkspace(symbol: string, timeframe: string): void {
    this.symbol = normalizeSymbol(symbol);
    this.timeframe = normalizeTimeframe(timeframe);
    this.storageKey = makeStorageKey(this.symbol, this.timeframe);
    this.load();
  }

  getAll(): DemandZone[] {
    return [...this.zones.values()].map(cloneZone);
  }

  clear(): void {
    this.zones.clear();
    this.save();
  }

  remove(id: string): void {
    this.zones.delete(id);
    this.save();
  }

  createFromCandle(candle: CleanBar): DemandZone {
    const top = this.bodyOnly ? Math.max(candle.open, candle.close) : candle.high;
    const bottom = this.bodyOnly ? Math.min(candle.open, candle.close) : candle.low;

    const zone: DemandZone = {
      id: crypto.randomUUID(),
      candleTime: candle.time as UTCTimestamp,
      startTime: candle.time as UTCTimestamp,
      endTime: (Number(candle.time) + this.extendBars) as UTCTimestamp,
      top,
      bottom,
      color: "#00ff00",
      fill: "rgba(0,255,0,.18)",
      visible: true,
    };

    this.zones.set(zone.id, zone);
    this.save();
    return cloneZone(zone);
  }

  update(id: string, top: number, bottom: number): void {
    const zone = this.zones.get(id);
    if (!zone) return;
    zone.top = top;
    zone.bottom = bottom;
    this.save();
  }

  setVisible(id: string, visible: boolean): void {
    const zone = this.zones.get(id);
    if (!zone) return;
    zone.visible = visible;
    this.save();
  }

  setColor(id: string, border: string, fill: string): void {
    const zone = this.zones.get(id);
    if (!zone) return;
    zone.color = border;
    zone.fill = fill;
    this.save();
  }

  extend(id: string, bars: number): void {
    const zone = this.zones.get(id);
    if (!zone) return;
    zone.endTime = (Number(zone.startTime) + bars) as UTCTimestamp;
    this.save();
  }

  findAtPrice(price: number): DemandZone | null {
    for (const zone of this.zones.values()) {
      if (price >= zone.bottom && price <= zone.top) return cloneZone(zone);
    }
    return null;
  }

  invalidateBrokenZones(currentPrice: number): void {
    let changed = false;
    for (const zone of this.zones.values()) {
      if (currentPrice < zone.bottom && zone.visible) {
        zone.visible = false;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  serialize(): string {
    return JSON.stringify([...this.zones.values()]);
  }

  deserialize(json: string): void {
    this.zones.clear();
    try {
      const zones = JSON.parse(json) as DemandZone[];
      for (const zone of zones) {
        if (zone?.id) this.zones.set(zone.id, cloneZone(zone));
      }
      this.save();
    } catch {
      this.zones.clear();
      this.save();
    }
  }

  private load(): void {
    this.zones.clear();
    if (!canUseLocalStorage()) return;
    const saved = window.localStorage.getItem(this.storageKey);
    if (!saved) return;

    try {
      const zones = JSON.parse(saved) as DemandZone[];
      if (!Array.isArray(zones)) return;
      for (const zone of zones) {
        if (zone?.id) this.zones.set(zone.id, cloneZone(zone));
      }
    } catch (error) {
      console.warn("[DemandZoneEngine] failed to load zones", error);
    }
  }

  private save(): void {
    if (!canUseLocalStorage()) return;
    try {
      window.localStorage.setItem(this.storageKey, this.serialize());
    } catch (error) {
      console.warn("[DemandZoneEngine] failed to save zones", error);
    }
  }
}
