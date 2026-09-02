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

  /**
   * Optional exchange trading day in YYYY-MM-DD format.
   * When present, the backend returns bars for that specific session.
   */
  date?: string;

  lookback?: string;
  limit?: number;
}): Promise<CleanBar[]> {
  const cleanSymbol = String(params.symbol || "SPY").trim().toUpperCase();
  const cleanTimeframe = String(params.timeframe || "5m").trim().toLowerCase();

  const cleanDate = String(params.date ?? "").trim();

  const response = await fetchBars(cleanSymbol, cleanTimeframe, {
    date: cleanDate || undefined,
    lookback: cleanDate ? undefined : params.lookback ?? "5d",
    session: "extended",
    limit: params.limit ?? 500,
    forceRefresh: false,
  });


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

  const BASE_RECONNECT_DELAY_MS = 750;
  const MAX_RECONNECT_DELAY_MS = 10_000;
  const HEARTBEAT_INTERVAL_MS = 20_000;

  let disposed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let reconnectAttempt = 0;

  const clearReconnectTimer = () => {
    if (reconnectTimer != null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer != null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send("ping");
      } catch {
        // onclose handles reconnection if the socket has actually failed.
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer != null) return;

    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.min(reconnectAttempt, 4)),
    );
    reconnectAttempt += 1;

    params.onStatus("connecting");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (disposed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    params.onStatus("connecting");

    let nextWs: WebSocket;
    nextWs = connectChartV2BarsSocket({
      symbol: cleanSymbol,
      timeframe: cleanTimeframe,
      onOpen: () => {
        if (disposed || ws !== nextWs) {
          try {
            nextWs.close();
          } catch {
            // Safe to ignore during cleanup races.
          }
          return;
        }

        clearReconnectTimer();
        reconnectAttempt = 0;
        params.onStatus("live");
        startHeartbeat();
      },
      onClose: () => {
        if (ws !== nextWs) return;

        stopHeartbeat();
        ws = null;

        if (disposed) return;

        params.onStatus("disconnected");
        scheduleReconnect();
      },
      onError: () => {
        if (disposed || ws !== nextWs) return;

        params.onStatus("disconnected");
        // The browser fires onclose after an unrecoverable socket error.
        // Reconnect from onclose so duplicate sockets are never created.
      },
      onBar: (bar) => {
        if (disposed || ws !== nextWs) return;

        const cleanBar = normalizeLiveBar(bar);
        if (!cleanBar) return;

        params.onBar(cleanBar);
      },
    });

    ws = nextWs;
  };

  const reconnectNow = () => {
    if (disposed) return;

    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }

    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    clearReconnectTimer();
    reconnectAttempt = 0;
    connect();
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      reconnectNow();
    }
  };

  const handleOnline = () => {
    reconnectNow();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
  }

  connect();

  return () => {
    disposed = true;

    clearReconnectTimer();
    stopHeartbeat();

    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("online", handleOnline);
    }

    const currentWs = ws;
    ws = null;

    if (currentWs) {
      try {
        currentWs.close(1000, "chart-live-cleanup");
      } catch {
        // Safe to ignore if the socket is already closed.
      }
    }
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