// src/trading/replay/HistoricalTradeOverlayTypes.ts

export type HistoricalTradeEntrySnapshot = {
  score?: number;
  grade?: string;
  entryQuality?: number;
  risk?: number;
  summary?: string;
  thesis?: string;
  triggers?: string[];
  capturedAt?: string;
};

export type HistoricalTradeReplayOverlay = {
  tradeId: string;
  symbol: string;
  side: "buy" | "sell";
  shares: number;
  entryPrice: number;
  exitPrice?: number;
  targetPrice?: number;
  stopPrice?: number;
  entryTimestamp: string;
  exitTimestamp?: string;
  recordedTrigger?: string;
  coachContext?: string[];
  entrySnapshot?: HistoricalTradeEntrySnapshot;
};
