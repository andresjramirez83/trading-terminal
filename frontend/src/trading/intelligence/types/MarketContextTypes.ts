// src/trading/intelligence/types/MarketContextTypes.ts

/**
 * Shared market-intelligence contracts.
 *
 * This file intentionally has no runtime dependencies so the same context
 * model can be consumed by live trading, replay, scanners, Decision Center,
 * AI Coach, Trading DNA, journal analytics, and automated strategies.
 */

export type MarketContextSource =
  | "live"
  | "replay"
  | "scanner"
  | "decision-center"
  | "ai-coach"
  | "trading-dna"
  | "journal"
  | "auto-trading"
  | "backtest"
  | "manual"
  | "system";

export type MarketContextDirection = "bullish" | "bearish" | "neutral";

export type MarketContextBias =
  | "strong-bullish"
  | "bullish"
  | "neutral"
  | "bearish"
  | "strong-bearish";

export type MarketContextStrength =
  | "very-weak"
  | "weak"
  | "moderate"
  | "strong"
  | "very-strong";

export type MarketContextQuality =
  | "invalid"
  | "poor"
  | "fair"
  | "good"
  | "excellent";

export type MarketContextStatus =
  | "inactive"
  | "pending"
  | "forming"
  | "confirmed"
  | "weakening"
  | "invalidated"
  | "expired";

export type MarketSession =
  | "overnight"
  | "premarket"
  | "regular"
  | "after-hours"
  | "closed"
  | "unknown";

export type MarketRegime =
  | "strong-uptrend"
  | "uptrend"
  | "bullish-expansion"
  | "bullish-pullback"
  | "range"
  | "compression"
  | "breakout"
  | "breakdown"
  | "volatile"
  | "low-volatility"
  | "bearish-pullback"
  | "bearish-expansion"
  | "downtrend"
  | "strong-downtrend"
  | "transition"
  | "unknown";

export type MarketRegimeFamily =
  | "trend"
  | "range"
  | "compression"
  | "expansion"
  | "transition"
  | "unknown";

export type MarketContextCategory =
  | "structure"
  | "balance"
  | "regime"
  | "trend"
  | "momentum"
  | "volatility"
  | "volume"
  | "participation"
  | "liquidity"
  | "location"
  | "timing"
  | "session"
  | "risk"
  | "entry-quality"
  | "trade-readiness"
  | "execution"
  | "performance"
  | "behavior"
  | "custom";

export type EvidenceSeverity = "info" | "supporting" | "warning" | "critical";

export type EvidencePolarity = "positive" | "negative" | "neutral";

export type EvidenceValue = string | number | boolean | null;

/** Normalized score range is 0-100 unless a producer documents otherwise. */
export interface ScoredContext {
  score: number;
  maxScore: number;
  normalizedScore: number;
  confidence: number;
  direction: MarketContextDirection;
  strength: MarketContextStrength;
  quality: MarketContextQuality;
}

export interface MarketContextEvidence {
  id: string;
  category: MarketContextCategory;
  label: string;
  reason: string;
  polarity: EvidencePolarity;
  severity: EvidenceSeverity;
  weight: number;
  scoreImpact: number;
  confidence: number;
  value?: EvidenceValue;
  expectedValue?: EvidenceValue;
  source?: string;
  timeframe?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface MarketContextReason {
  id: string;
  text: string;
  category: MarketContextCategory;
  polarity: EvidencePolarity;
  importance: number;
  confidence: number;
  evidenceIds?: string[];
}

export interface MarketRegimeAssessment extends ScoredContext {
  regime: MarketRegime;
  family: MarketRegimeFamily;
  status: MarketContextStatus;
  durationBars?: number;
  startedAt?: number;
  transitionFrom?: MarketRegime;
  transitionProbability?: number;
  supportingEvidenceIds: string[];
  conflictingEvidenceIds: string[];
}

export interface MarketContextMetric {
  key: string;
  label: string;
  category: MarketContextCategory;
  value: EvidenceValue;
  previousValue?: EvidenceValue;
  unit?: string;
  score?: number;
  confidence?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface MarketContextComponent extends ScoredContext {
  id: string;
  category: MarketContextCategory;
  label: string;
  summary: string;
  status: MarketContextStatus;
  reasons: MarketContextReason[];
  evidence: MarketContextEvidence[];
  metrics: MarketContextMetric[];
  tags: string[];
  updatedAt: number;
}

export interface MarketContextPriceSnapshot {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  last?: number;
  bid?: number;
  ask?: number;
  midpoint?: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
}

export interface MarketContextVolumeSnapshot {
  current?: number;
  average?: number;
  relative?: number;
  cumulative?: number;
  buyVolume?: number;
  sellVolume?: number;
  delta?: number;
}

export interface MarketContextVolatilitySnapshot {
  atr?: number;
  atrPercent?: number;
  realizedVolatility?: number;
  range?: number;
  rangePercent?: number;
  expansionScore?: number;
  compressionScore?: number;
}

export interface MarketContextStructureSnapshot {
  direction?: MarketContextDirection;
  trend?: MarketContextDirection;
  score?: number;
  confidence?: number;
  breakOfStructure?: boolean;
  changeOfCharacter?: boolean;
  higherHighs?: boolean;
  higherLows?: boolean;
  lowerHighs?: boolean;
  lowerLows?: boolean;
  swingHigh?: number;
  swingLow?: number;
  lastSwingHigh?: number;
  lastSwingLow?: number;
  support?: number[];
  resistance?: number[];
}

export interface MarketContextIndicatorSnapshot {
  ema9?: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  vwap?: number;
  vwapSlope?: number;
  momentumScore?: number;
  compressionScore?: number;
  trendStrengthScore?: number;
  participationScore?: number;
  rsi?: number;
  macdHistogram?: number;
  roc?: number;
  relativeVolume?: number;
  adx?: number;
  custom?: Record<string, EvidenceValue>;
}

export interface MarketContextBarSnapshot {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  barIndex?: number;
}

export interface MarketContextInputSnapshot {
  symbol: string;
  timeframe: string;
  timestamp: number;
  session: MarketSession;
  bar: MarketContextBarSnapshot;
  price: MarketContextPriceSnapshot;
  volume: MarketContextVolumeSnapshot;
  volatility: MarketContextVolatilitySnapshot;
  structure: MarketContextStructureSnapshot;
  indicators: MarketContextIndicatorSnapshot;
  barIndex?: number;
  tradingDate?: string;
  metadata?: Record<string, unknown>;
}

export interface MarketContextSnapshot extends ScoredContext {
  id: string;
  version: number;
  symbol: string;
  timeframe: string;
  timestamp: number;
  createdAt: number;
  source: MarketContextSource;
  mode: "live" | "replay" | "historical";
  session: MarketSession;
  tradingDate?: string;
  barIndex?: number;
  bias: MarketContextBias;
  status: MarketContextStatus;
  summary: string;
  regime: MarketRegimeAssessment;
  components: MarketContextComponent[];
  reasons: MarketContextReason[];
  evidence: MarketContextEvidence[];
  metrics: MarketContextMetric[];
  tags: string[];
  input?: MarketContextInputSnapshot;
  parentSnapshotId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Canonical completed market-context result consumed by decision, narrative,
 * coaching, journal, replay, scanner, and automation layers.
 *
 * This alias intentionally points to MarketContextSnapshot rather than
 * MarketContextBuildResult. The build result contains processing metadata,
 * while downstream intelligence engines consume the finalized snapshot.
 */
export type MarketContextResult = MarketContextSnapshot;

export interface MarketContextHistory {
  symbol: string;
  timeframe: string;
  snapshots: MarketContextSnapshot[];
  latest: MarketContextSnapshot | null;
  previous: MarketContextSnapshot | null;
  regimeChanges: MarketRegimeChange[];
}

export interface MarketRegimeChange {
  id: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  from: MarketRegime;
  to: MarketRegime;
  confidence: number;
  reasonIds: string[];
  snapshotId: string;
}

export interface MarketContextDelta {
  fromSnapshotId: string;
  toSnapshotId: string;
  scoreChange: number;
  confidenceChange: number;
  directionChanged: boolean;
  biasChanged: boolean;
  regimeChanged: boolean;
  addedEvidenceIds: string[];
  removedEvidenceIds: string[];
  strengthenedReasonIds: string[];
  weakenedReasonIds: string[];
}

export interface MarketContextQuery {
  symbol?: string;
  timeframe?: string;
  source?: MarketContextSource | MarketContextSource[];
  regime?: MarketRegime | MarketRegime[];
  direction?: MarketContextDirection | MarketContextDirection[];
  minimumScore?: number;
  minimumConfidence?: number;
  fromTimestamp?: number;
  toTimestamp?: number;
  tags?: string[];
  limit?: number;
}

export interface MarketContextBuildRequest {
  input: MarketContextInputSnapshot;
  source: MarketContextSource;
  mode: "live" | "replay" | "historical";
  previousSnapshot?: MarketContextSnapshot | null;
  enabledCategories?: MarketContextCategory[];
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface MarketContextBuildResult {
  snapshot: MarketContextSnapshot;
  delta: MarketContextDelta | null;
  warnings: string[];
  processingTimeMs?: number;
}

export interface MarketContextConsumerDecision {
  consumer: MarketContextSource;
  accepted: boolean;
  action:
    | "observe"
    | "alert"
    | "prepare"
    | "enter"
    | "manage"
    | "reduce"
    | "exit"
    | "block"
    | "review";
  score: number;
  confidence: number;
  reasonIds: string[];
  snapshotId: string;
  metadata?: Record<string, unknown>;
}

export interface MarketContextProvider {
  getLatest(symbol: string, timeframe: string): MarketContextSnapshot | null;
  getHistory(query: MarketContextQuery): MarketContextSnapshot[];
}

export type MarketContextListener = (
  snapshot: MarketContextSnapshot,
  delta: MarketContextDelta | null,
) => void;
