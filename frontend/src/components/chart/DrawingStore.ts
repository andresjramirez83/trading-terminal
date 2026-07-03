// src/components/chart/DrawingStore.ts

import type { ChartDrawing } from "./DrawingTypes";

const STORAGE_PREFIX = "chart.drawings.v1";

function safeKeyPart(value: string): string {
  return String(value || "default").trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_");
}

function makeStorageKey(symbol: string, timeframe: string): string {
  return `${STORAGE_PREFIX}.${safeKeyPart(symbol)}.${safeKeyPart(timeframe)}`;
}

function cloneDrawing<T extends ChartDrawing>(drawing: T): T {
  return JSON.parse(JSON.stringify(drawing)) as T;
}

function cloneDrawings(drawings: ChartDrawing[]): ChartDrawing[] {
  return drawings.map((drawing) => cloneDrawing(drawing));
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

export class DrawingStore {
  private drawings: ChartDrawing[] = [];
  private symbol = "SPY";
  private timeframe = "5m";
  private storageKey = makeStorageKey(this.symbol, this.timeframe);

  constructor(symbol = "SPY", timeframe = "5m") {
    this.setWorkspace(symbol, timeframe);
  }

  setWorkspace(symbol: string, timeframe: string): void {
    this.symbol = String(symbol || "SPY").trim().toUpperCase();
    this.timeframe = String(timeframe || "5m").trim().toLowerCase();
    this.storageKey = makeStorageKey(this.symbol, this.timeframe);
    this.load();
  }

  getWorkspace(): { symbol: string; timeframe: string; storageKey: string } {
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      storageKey: this.storageKey,
    };
  }

  getAll(): ChartDrawing[] {
    return this.drawings;
  }

  get(id: string): ChartDrawing | undefined {
    return this.drawings.find((drawing) => drawing.id === id);
  }

  add(drawing: ChartDrawing): void {
    this.drawings.push(cloneDrawing(drawing));
    this.save();
  }

  update(updated: ChartDrawing): void {
    const index = this.drawings.findIndex((drawing) => drawing.id === updated.id);

    if (index >= 0) {
      this.drawings[index] = cloneDrawing(updated);
      this.save();
    }
  }

  remove(id: string): void {
    const next = this.drawings.filter((drawing) => drawing.id !== id);
    if (next.length === this.drawings.length) return;

    this.drawings = next;
    this.save();
  }

  clear(): void {
    this.drawings = [];
    this.save();
  }

  setAll(drawings: ChartDrawing[]): void {
    this.drawings = cloneDrawings(drawings);
    this.save();
  }

  reload(): void {
    this.load();
  }

  private load(): void {
    if (!canUseLocalStorage()) {
      this.drawings = [];
      return;
    }

    const saved = window.localStorage.getItem(this.storageKey);
    if (!saved) {
      this.drawings = [];
      return;
    }

    try {
      const parsed = JSON.parse(saved) as unknown;
      this.drawings = Array.isArray(parsed) ? cloneDrawings(parsed as ChartDrawing[]) : [];
    } catch (error) {
      console.warn("[DrawingStore] failed to load drawings", {
        storageKey: this.storageKey,
        error,
      });
      this.drawings = [];
    }
  }

  private save(): void {
    if (!canUseLocalStorage()) return;

    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.drawings));
    } catch (error) {
      console.warn("[DrawingStore] failed to save drawings", {
        storageKey: this.storageKey,
        error,
      });
    }
  }
}
