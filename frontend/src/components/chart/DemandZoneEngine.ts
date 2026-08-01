// src/components/chart/DemandZoneEngine.ts

import type { UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../../types/market";
import type { DemandZone } from "./ChartTypes";

export interface DemandZoneOptions {
  extendBars?: number;
  bodyOnly?: boolean;
  symbol?: string;
  timeframe?: string;
}

const STORAGE_PREFIX = "chart.demandZones.v1";

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

  createFromCandle(candle: Candle): DemandZone {
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
      if (price >= zone.bottom && price <= zone.top) {
        return cloneZone(zone);
      }
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
