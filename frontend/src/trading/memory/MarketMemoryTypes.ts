/**
 * MarketMemoryTypes.ts
 * Foundation types for the Trading OS Market Memory subsystem.
 */

export type MarketEventCategory =
  | "structure"
  | "liquidity"
  | "vwap"
  | "fvg"
  | "session"
  | "momentum"
  | "regime"
  | "volatility"
  | "participation"
  | "custom";

export interface MarketMemoryEvent {
  id: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  category: MarketEventCategory;
  type: string;
  title: string;
  description?: string;
  importance: number;      // 0-100
  confidence: number;      // 0-1
  implications: string[];
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
}

export interface MarketSequence {
  id: string;
  name: string;
  active: boolean;
  completed: boolean;
  eventIds: string[];
  confidence: number;
}

export interface SessionMemory {
  session: "overnight" | "premarket" | "rth" | "afterhours";
  bias: "bullish" | "bearish" | "neutral";
  objectives: string[];
}

export interface MarketMemorySnapshot {
  symbol: string;
  timeframe: string;
  generatedAt: number;
  events: MarketMemoryEvent[];
  activeSequences: MarketSequence[];
  session: SessionMemory;
}

export interface MarketMemoryStoreContract {
  addEvent(event: MarketMemoryEvent): void;
  getSnapshot(): MarketMemorySnapshot;
  clear(): void;
}
