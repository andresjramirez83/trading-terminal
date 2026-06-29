// src/components/chart/LiveDataEngine.ts

import type { Time } from "lightweight-charts";

import {
  connectChartV2BarsSocket,
  fetchBars,
  type LiveBarMessage,
} from "../../services/api";

import type { Candle } from "../../types/market";
import type { CleanBar, LiveStatus } from "./ChartTypes";

export function normalizeBarTime(value: number | string): Time {
  const rawTime = Number(value);
  return (rawTime > 10_000_000_000 ? Math.floor(rawTime / 1000) : rawTime) as Time;
}

export function normalizeLiveBar(bar: LiveBarMessage | any): CleanBar | null {
  const cleanBar: CleanBar = {
    time: normalizeBarTime(bar.time),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume ?? bar.v ?? 0),
  };

  if (
    !Number.isFinite(cleanBar.open) ||
    !Number.isFinite(cleanBar.high) ||
    !Number.isFinite(cleanBar.low) ||
    !Number.isFinite(cleanBar.close) ||
    !Number.isFinite(cleanBar.volume)
  ) {
    return null;
  }

  return cleanBar;
}

export async function loadHistoricalBars(params: {
  symbol: string;
  timeframe: string;
  lookback?: string;
  limit?: number;
}): Promise<CleanBar[]> {
  const cleanSymbol = String(params.symbol || "SPY").trim().toUpperCase();
  const cleanTimeframe = String(params.timeframe || "5m").trim().toLowerCase();

  const response = await fetchBars(cleanSymbol, cleanTimeframe, {
    lookback: params.lookback ?? "5d",
    session: "extended",
    limit: params.limit ?? 500,
    forceRefresh: true,
  });

  console.log("V2 bars response", response);

  const rawBars = Array.isArray(response) ? response : response?.bars ?? [];

  return rawBars
    .map((bar: any) => normalizeLiveBar(bar))
    .filter(Boolean) as CleanBar[];
}

export function connectLiveBars(params: {
  symbol: string;
  timeframe: string;
  onStatus: (status: LiveStatus) => void;
  onBar: (bar: CleanBar) => void;
}): () => void {
  const cleanSymbol = String(params.symbol || "SPY").trim().toUpperCase();
  const cleanTimeframe = String(params.timeframe || "5m").trim().toLowerCase();

  params.onStatus("connecting");

  const ws = connectChartV2BarsSocket({
    symbol: cleanSymbol,
    timeframe: cleanTimeframe,
    onOpen: () => params.onStatus("live"),
    onClose: () => params.onStatus("disconnected"),
    onError: () => params.onStatus("disconnected"),
    onBar: (bar) => {
      const cleanBar = normalizeLiveBar(bar);
      if (!cleanBar) return;
      params.onBar(cleanBar);
    },
  });

  return () => {
    ws.close();
  };
}

/* Legacy lightweight in-memory live update bus.
   Keep this for existing chart engines that may still import liveDataEngine. */
export interface LiveUpdate {
  symbol: string;
  candle: Candle;
}

type Listener = (candle: Candle) => void;

export class LiveDataEngine {
  private pending = new Map<string, Candle>();
  private listeners = new Set<Listener>();
  private raf = 0;

  subscribe(listener: Listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  push(update: LiveUpdate) {
    this.pending.set(update.symbol, update.candle);

    if (this.raf) return;

    this.raf = requestAnimationFrame(this.flush);
  }

  private flush = () => {
    this.raf = 0;

    if (!this.pending.size) return;

    const updates = [...this.pending.values()];

    this.pending.clear();

    for (const candle of updates) {
      for (const listener of this.listeners) {
        listener(candle);
      }
    }
  };

  clear() {
    this.pending.clear();
  }

  destroy() {
    cancelAnimationFrame(this.raf);

    this.pending.clear();
    this.listeners.clear();
  }
}

export const liveDataEngine = new LiveDataEngine();
