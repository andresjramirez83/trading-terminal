// src/components/chart/SupplyZoneEngine.ts

import type { UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../../types/market";
import type { RectangleModel } from "./ChartTypes";

export interface SupplyZone extends RectangleModel {
  candleTime: UTCTimestamp;
}

export interface SupplyZoneOptions {
  extendBars?: number;
  bodyOnly?: boolean;
  autoInvalidate?: boolean;
  symbol?: string;
  timeframe?: string;
}

const STORAGE_PREFIX = "chart.supplyZones.v1";

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
      if (price <= zone.top && price >= zone.bottom) {
        return cloneZone(zone);
      }
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
