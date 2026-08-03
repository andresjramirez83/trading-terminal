import type { StatusTone } from "./components/StatusDot";

export type DecisionCenterStatus = "Ready" | "Caution" | "Avoid";

export interface DecisionCenterItem {
  label: string;
  tone: StatusTone;
}

export interface DecisionCenterTradeReadiness {
  score: number;
  status: DecisionCenterStatus;
  items: DecisionCenterItem[];
}

export interface DecisionCenterPerformanceItem {
  label: string;
  value: string;
  tone: StatusTone;
}

export interface DecisionCenterScoreBlock {
  score: number;
  subtitle: string;
  badge: string;
  tone: StatusTone;
}

export interface DecisionCenterMomentum {
  score: number;
  status: string;
  direction: "bullish" | "bearish" | "neutral";
  ema: number;
  vwap: number;
  candle: number;
  volume: number;
  atr: number;
  increasing: boolean;
  fading: boolean;
}

export interface DecisionCenterVWAP {
  priceVsVwap: string;
  priceVsVwapTone: StatusTone;
  slope: string;
  slopeTone: StatusTone;
  reclaim: string;
  reclaimTone: StatusTone;
}

export interface DecisionCenterStats {
  range: string;
  volume: string;
  atr: string;
  rr: string;
}

export interface DecisionCenterKeyStats {
  price?: number;
  range?: number;
  volume?: number;
  atr?: number;
  vwapDistance?: number;
  rr?: string;
}

export interface DecisionCenterTrendStrength {
  score: number;
  badge: string;
  subtitle: string;
  tone: StatusTone;
  emaAlignment: number;
  vwapAlignment: number;
  structureAlignment: number;
  momentumAlignment: number;
  continuationProbability: number;
}

export interface DecisionCenterBalance {
  score: number;
  vwapZScore?: number;
  badge: string;
  subtitle: string;
  tone: StatusTone;
  buyers: number;
  sellers: number;
  equilibrium: number;
}

export interface DecisionCenterEntryQuality {
  score: number;
  badge: string;
  subtitle: string;
  tone: StatusTone;
  location: number;
  confirmation: number;
  timing: number;
  riskReward: number;
}

export interface DecisionCenterRisk {
  score: number;
  badge: string;
  subtitle: string;
  tone: StatusTone;
  stopDistance: string;
  targetDistance: string;
  expectedRR: string;
}

export type DecisionCenterAction =
  | "BUY"
  | "WATCH LONG"
  | "WAIT"
  | "WATCH SHORT"
  | "SELL"
  | "AVOID";

export interface DecisionCenterAI {
  /**
   * Direction and execution readiness are intentionally separate.
   *
   * WATCH LONG / WATCH SHORT means market structure has established a
   * directional bias, but the current entry or risk conditions are not ready.
   */
  action: DecisionCenterAction;
  confidence: number;
  reason: string;
  tone: StatusTone;
}

export interface DecisionCenterState {
  tradeReadiness: DecisionCenterTradeReadiness;
  performance: DecisionCenterPerformanceItem[];
  compression: DecisionCenterScoreBlock;
  structure: DecisionCenterScoreBlock;
  momentum: DecisionCenterMomentum;
  vwap: DecisionCenterVWAP;
  stats: DecisionCenterStats;
  keyStats: DecisionCenterKeyStats;

  trendStrength: DecisionCenterTrendStrength;
  balance: DecisionCenterBalance;
  entryQuality: DecisionCenterEntryQuality;
  risk: DecisionCenterRisk;
  ai: DecisionCenterAI;
}
