// src/trading/replay/ReplayTypes.ts

import type { CleanBar, LiveStatus } from "../../components/chart/ChartTypes";

export type MarketDataMode = "live" | "replay";

export type ReplayPlaybackState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "completed"
  | "error";

export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 5 | 10 | 25 | 50 | 100;

export interface MarketDataRequest {
  symbol: string;
  timeframe: string;
  lookback?: string;
  limit?: number;
}

export interface MarketDataConnectionHandlers {
  onStatus: (status: LiveStatus) => void;
  onBar: (bar: CleanBar) => void;
  onError?: (error: Error) => void;
}

export interface ReplaySessionConfig extends MarketDataRequest {
  startIndex?: number;
  speed?: ReplaySpeed;
  autoplay?: boolean;
}

export interface ReplaySnapshot {
  mode: "replay";
  state: ReplayPlaybackState;

  symbol: string;
  timeframe: string;

  speed: ReplaySpeed;

  bars: CleanBar[];
  visibleBars: CleanBar[];

  currentIndex: number;
  currentBar: CleanBar | null;
  currentTime: number | null;

  progress: number;
  error: string | null;
}

export type ReplayListener = (snapshot: ReplaySnapshot) => void;