// src/components/chart/SupplyZoneEngine.ts

import type { UTCTimestamp, Time } from "lightweight-charts";
import type { Candle } from "../../types/market";
import type { CleanBar, RectangleModel } from "./ChartTypes";
import {
  buildMarketStructure,
  type MarketStructureResult,
} from "./analysis/MarketStructureEngine";

export interface SupplyZone extends RectangleModel {
  candleTime: UTCTimestamp;
}

export interface AutomaticSupplyZone {
  id: string;
  originIndex: number;
  originTime: Time;
  confirmationIndex: number;
  confirmationTime: Time;
  bottom: number;
  top: number;
  reason: "support-break" | "bearish-fvg" | "support-break+bearish-fvg";
  active: boolean;
  invalidationIndex?: number;
  invalidationTime?: Time;
}

export interface AutomaticSupplyZoneOptions {
  maxZones?: number;
  structure?: MarketStructureResult;
}

export interface SupplyZoneOptions {
  extendBars?: number;
  bodyOnly?: boolean;
  autoInvalidate?: boolean;
  symbol?: string;
  timeframe?: string;
}

const STORAGE_PREFIX = "chart.supplyZones.v1";

function finiteBar(bar: CleanBar | undefined): bar is CleanBar {
  return Boolean(
    bar &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close),
  );
}

function bodyLow(bar: CleanBar): number {
  return Math.min(bar.open, bar.close);
}

function trueRange(current: CleanBar, previous?: CleanBar): number {
  if (!previous) return Math.max(0, current.high - current.low);
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

function rollingAtr(bars: CleanBar[], endIndex: number, length = 14): number {
  const start = Math.max(0, endIndex - length + 1);
  let total = 0;
  let count = 0;
  for (let index = start; index <= endIndex; index += 1) {
    if (!finiteBar(bars[index])) continue;
    total += trueRange(bars[index], index > 0 ? bars[index - 1] : undefined);
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function bearishFvgAt(bars: CleanBar[], index: number): boolean {
  if (index < 2 || index >= bars.length) return false;
  const first = bars[index - 2];
  const displacement = bars[index - 1];
  const confirming = bars[index];
  return (
    finiteBar(first) &&
    finiteBar(displacement) &&
    finiteBar(confirming) &&
    confirming.high < first.low
  );
}

function significantBearishDisplacement(
  bars: CleanBar[],
  index: number,
): boolean {
  const bar = bars[index];
  if (!finiteBar(bar) || bar.close >= bar.open) return false;
  const range = Math.max(0, bar.high - bar.low);
  if (range <= 0) return false;
  const body = bar.open - bar.close;
  const atr = rollingAtr(bars, index);
  return body / range >= 0.55 || (atr > 0 && range >= atr * 1.15);
}

function priorStructuralSupport(
  structure: MarketStructureResult,
  beforeIndex: number,
): { index: number; price: number } | undefined {
  return structure.points
    .filter(
      (point) =>
        (point.type === "HL" || point.type === "LL") &&
        point.index < beforeIndex &&
        point.confirmationIndex < beforeIndex,
    )
    .sort((left, right) => right.index - left.index)[0];
}

/**
 * Automatic bearish supply zone rule:
 * - The zone is the FULL candle immediately before bearish displacement.
 * - A bearish displacement qualifies when it either:
 *   1) closes through a previously confirmed support/HL/LL, OR
 *   2) creates a bearish fair value gap / imbalance.
 * - If the FVG is the reason, the pre-FVG candle is the anchor.
 * - A zone is invalidated only after a candle CLOSES above its high.
 */
export function buildAutomaticSupplyZones(
  bars: CleanBar[],
  options: AutomaticSupplyZoneOptions = {},
): AutomaticSupplyZone[] {
  if (bars.length < 4 || bars.some((bar) => !finiteBar(bar))) return [];

  const structure = options.structure ?? buildMarketStructure(bars);
  const maxZones = Math.max(1, options.maxZones ?? 24);
  const candidates = new Map<number, AutomaticSupplyZone>();

  for (let confirmationIndex = 2; confirmationIndex < bars.length; confirmationIndex += 1) {
    const fvg = bearishFvgAt(bars, confirmationIndex);
    const displacementIndex = confirmationIndex - 1;
    const displacement = bars[displacementIndex];
    if (!finiteBar(displacement)) continue;

    const support = priorStructuralSupport(structure, displacementIndex);
    const supportBroken = Boolean(
      support &&
        displacement.low < support.price &&
        displacement.close < support.price,
    );

    if (!fvg && !supportBroken) continue;
    if (!significantBearishDisplacement(bars, displacementIndex) && !supportBroken) {
      continue;
    }

    const originIndex = fvg ? confirmationIndex - 2 : displacementIndex - 1;
    if (originIndex < 0 || !finiteBar(bars[originIndex])) continue;

    const origin = bars[originIndex];
    const reason: AutomaticSupplyZone["reason"] =
      fvg && supportBroken
        ? "support-break+bearish-fvg"
        : fvg
          ? "bearish-fvg"
          : "support-break";

    candidates.set(originIndex, {
      id: `auto-supply-${Number(origin.time)}-${reason}`,
      originIndex,
      originTime: origin.time,
      confirmationIndex,
      confirmationTime: bars[confirmationIndex].time,
      bottom: origin.low,
      top: origin.high,
      reason,
      active: true,
    });
  }

  const zones = [...candidates.values()].sort(
    (left, right) => left.originIndex - right.originIndex,
  );

  for (const zone of zones) {
    for (let index = zone.confirmationIndex + 1; index < bars.length; index += 1) {
      if (bars[index].close > zone.top) {
        zone.active = false;
        zone.invalidationIndex = index;
        zone.invalidationTime = bars[index].time;
        break;
      }
    }
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

function cloneZone(zone: SupplyZone): SupplyZone {
  return JSON.parse(JSON.stringify(zone)) as SupplyZone;
}

export class SupplyZoneEngine {
  private zones = new Map<string, SupplyZone>();
  private extendBars: number;
  private bodyOnly: boolean;
  private autoInvalidate: boolean;
  private symbol: string;
  private timeframe: string;
  private storageKey: string;

  constructor(options?: SupplyZoneOptions) {
    this.extendBars = options?.extendBars ?? 500;
    this.bodyOnly = options?.bodyOnly ?? false;
    this.autoInvalidate = options?.autoInvalidate ?? true;
    this.symbol = normalizeSymbol(options?.symbol);
    this.timeframe = normalizeTimeframe(options?.timeframe);
    this.storageKey = makeStorageKey(this.symbol, this.timeframe);
    this.load();
  }

  setWorkspace(symbol: string, timeframe: string): void {
    this.symbol = normalizeSymbol(symbol);
    this.timeframe = normalizeTimeframe(timeframe);
    this.storageKey = makeStorageKey(this.symbol, this.timeframe);
    this.load();
  }

  getAll(): SupplyZone[] {
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

  createFromCandle(candle: Candle): SupplyZone {
    const top = this.bodyOnly ? Math.max(candle.open, candle.close) : candle.high;
    const bottom = this.bodyOnly ? Math.min(candle.open, candle.close) : candle.low;

    const zone: SupplyZone = {
      id: crypto.randomUUID(),
      candleTime: candle.time as UTCTimestamp,
      startTime: candle.time as UTCTimestamp,
      endTime: (Number(candle.time) + this.extendBars) as UTCTimestamp,
      top,
      bottom,
      color: "#ff4040",
      fill: "rgba(255,0,0,.18)",
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

  invalidate(currentPrice: number): void {
    if (!this.autoInvalidate) return;
    let changed = false;
    for (const zone of this.zones.values()) {
      if (currentPrice > zone.top && zone.visible) {
        zone.visible = false;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  find(price: number): SupplyZone | null {
    for (const zone of this.zones.values()) {
      if (price <= zone.top && price >= zone.bottom) return cloneZone(zone);
    }
    return null;
  }

  serialize(): string {
    return JSON.stringify([...this.zones.values()]);
  }

  deserialize(json: string): void {
    this.zones.clear();
    try {
      const zones = JSON.parse(json) as SupplyZone[];
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
      const zones = JSON.parse(saved) as SupplyZone[];
      if (!Array.isArray(zones)) return;
      for (const zone of zones) {
        if (zone?.id) this.zones.set(zone.id, cloneZone(zone));
      }
    } catch (error) {
      console.warn("[SupplyZoneEngine] failed to load zones", error);
    }
  }

  private save(): void {
    if (!canUseLocalStorage()) return;
    try {
      window.localStorage.setItem(this.storageKey, this.serialize());
    } catch (error) {
      console.warn("[SupplyZoneEngine] failed to save zones", error);
    }
  }
}
