// src/trading/intelligence/core/IntelligenceTypes.ts

/**
 * Shared contracts for the Trading OS intelligence layer.
 *
 * This file contains types only. It intentionally has no runtime logic so the
 * same report can safely be consumed by Live Trading, Practice Center, Replay,
 * Scanner, Decision Center, AI Coach, Journal, Trading DNA, and Auto Trader.
 */

import type {
  MarketContextBuildRequest,
  MarketContextDelta,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextReason,
  MarketContextSnapshot,
  MarketContextSource,
  MarketContextStrength,
  MarketRegime,
  MarketSession,
} from "../types/MarketContextTypes";
import type {
  TradingDecisionAction,
  TradingDecisionGrade,
  TradingDecisionResult,
  TradingDecisionRiskLevel,
} from "../evaluators/TradingDecisionEngine";

export const INTELLIGENCE_REPORT_VERSION = 1 as const;

export type IntelligenceMode = "live" | "replay" | "historical";

export type IntelligenceStatus =
  | "idle"
  | "building"
  | "ready"
  | "degraded"
  | "failed";

export type IntelligenceConsumer =
  | MarketContextSource
  | "live-trading"
  | "practice-center"
  | "replay-coach"
  | "decision-center"
  | "journal-analysis"
  | "trading-dna"
  | "auto-trader"
  | "alert-engine"
  | "scanner-engine"
  | "master-intelligence";

export type IntelligenceQuality =
  | "A+"
  | "A"
  | "B"
  | "C"
  | "D"
  | "F";

export type MarketPhase =
  | "accumulation"
  | "expansion"
  | "pullback"
  | "trend"
  | "balance"
  | "distribution"
  | "reversal"
  | "transition"
  | "unknown";

export type MarketCharacter =
  | "clean-trend"
  | "volatile-trend"
  | "orderly-pullback"
  | "impulsive-expansion"
  | "balanced-auction"
  | "tight-compression"
  | "failed-breakout"
  | "failed-breakdown"
  | "choppy"
  | "thin-liquidity"
  | "mixed"
  | "unknown";

export type MarketObjectiveType =
  | "liquidity"
  | "session-level"
  | "structure-level"
  | "fair-value-gap"
  | "vwap"
  | "range-boundary"
  | "target"
  | "invalidation"
  | "unknown";

export type CoachMessageLevel =
  | "info"
  | "positive"
  | "warning"
  | "critical";

export type CoachMessageCategory =
  | "market-reading"
  | "patience"
  | "entry"
  | "risk"
  | "execution"
  | "management"
  | "exit"
  | "discipline"
  | "education"
  | "review";

export type IntelligenceRecommendationAction =
  | TradingDecisionAction
  | "observe"
  | "prepare"
  | "enter-long"
  | "enter-short"
  | "hold"
  | "reduce"
  | "exit"
  | "cancel"
  | "review";

export type IntelligenceTriggerStatus =
  | "inactive"
  | "forming"
  | "armed"
  | "confirmed"
  | "invalidated"
  | "expired";

export interface IntelligenceIdentity {
  reportId: string;
  version: number;
  correlationId?: string;
  parentReportId?: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  generatedAt: number;
  tradingDate?: string;
  barIndex?: number;
  source: MarketContextSource;
  consumer?: IntelligenceConsumer;
  mode: IntelligenceMode;
  session: MarketSession;
}

export interface IntelligenceProbabilitySet {
  bullishContinuation: number;
  bearishContinuation: number;
  reversal: number;
  balance: number;
  expansion: number;
  trendDay: number;
  confidence: number;
}

export interface IntelligenceObjective {
  id: string;
  label: string;
  type: MarketObjectiveType;
  direction: MarketContextDirection;
  price?: number;
  distance?: number;
  distanceAtr?: number;
  probability: number;
  confidence: number;
  priority: number;
  reason: string;
  evidenceIds: string[];
  reached: boolean;
  invalidated: boolean;
  metadata?: Record<string, unknown>;
}

export interface IntelligenceTrigger {
  id: string;
  label: string;
  description: string;
  direction: MarketContextDirection;
  status: IntelligenceTriggerStatus;
  price?: number;
  score: number;
  confidence: number;
  expiresAt?: number;
  evidenceIds: string[];
  metadata?: Record<string, unknown>;
}

export interface IntelligenceRiskAssessment {
  level: TradingDecisionRiskLevel;
  score: number;
  confidence: number;
  approved: boolean;
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  rewardRiskRatio?: number;
  invalidationPrice?: number;
  invalidationReason?: string;
  extensionRisk: number;
  volatilityRisk: number;
  liquidityRisk: number;
  reversalRisk: number;
  eventRisk: number;
  blockers: string[];
  warnings: string[];
  strengths: string[];
}

export interface IntelligenceEntryAssessment {
  grade: TradingDecisionGrade;
  score: number;
  confidence: number;
  approved: boolean;
  direction: MarketContextDirection;
  locationScore: number;
  timingScore: number;
  confirmationScore: number;
  confluenceScore: number;
  rewardRiskScore: number;
  chaseRisk: number;
  extensionRisk: number;
  isEarly: boolean;
  isLate: boolean;
  isChasing: boolean;
  idealEntryPrice?: number;
  currentEntryPrice?: number;
  reasons: string[];
  warnings: string[];
}

export interface IntelligenceNarrative {
  headline: string;
  story: string;
  shortSummary: string;
  phase: MarketPhase;
  regime: MarketRegime;
  dominantSide: MarketContextDirection;
  marketCharacter: MarketCharacter;
  currentObjective: IntelligenceObjective | null;
  alternativeObjectives: IntelligenceObjective[];
  nextBullTrigger: IntelligenceTrigger | null;
  nextBearTrigger: IntelligenceTrigger | null;
  currentRisk: string;
  invalidation: string;
  quality: IntelligenceQuality;
  confidence: number;
  probabilities: IntelligenceProbabilitySet;
  supportingEvidenceIds: string[];
  conflictingEvidenceIds: string[];
  generatedAt: number;
}

export interface CoachMessage {
  id: string;
  level: CoachMessageLevel;
  category: CoachMessageCategory;
  title: string;
  message: string;
  action?: string;
  priority: number;
  confidence: number;
  dismissible: boolean;
  expiresAt?: number;
  evidenceIds: string[];
  metadata?: Record<string, unknown>;
}

export interface IntelligenceCoachAssessment {
  headline: string;
  summary: string;
  recommendation: string;
  immediateAction: IntelligenceRecommendationAction;
  processScore: number;
  patienceScore: number;
  disciplineScore: number;
  confidence: number;
  messages: CoachMessage[];
  strengths: string[];
  improvements: string[];
  questions: string[];
  shouldInterrupt: boolean;
  shouldWarn: boolean;
  generatedAt: number;
}

export interface IntelligenceExecutionAssessment {
  marketReadingScore: number;
  patienceScore: number;
  entryTimingScore: number;
  riskManagementScore: number;
  executionScore: number;
  tradeManagementScore: number;
  exitScore: number;
  processScore: number;
  overallScore: number;
  grade: IntelligenceQuality;
  followedPlan: boolean | null;
  followedNarrative: boolean | null;
  followedCoach: boolean | null;
  mistakes: string[];
  strengths: string[];
  lessons: string[];
}

export interface IntelligenceRecommendation {
  action: IntelligenceRecommendationAction;
  direction: MarketContextDirection;
  label: string;
  summary: string;
  rationale: string;
  grade: IntelligenceQuality;
  score: number;
  confidence: number;
  canTrade: boolean;
  shouldWait: boolean;
  requiresConfirmation: boolean;
  nextTriggerId?: string;
  invalidation?: string;
  blockers: string[];
  warnings: string[];
}

export interface IntelligenceDiagnostics {
  status: IntelligenceStatus;
  processingTimeMs: number;
  evaluatorCount: number;
  successfulEvaluatorCount: number;
  failedEvaluatorIds: string[];
  warnings: string[];
  errors: string[];
  cacheHit: boolean;
  stale: boolean;
  staleAfterMs?: number;
  generatedFromSnapshotId?: string;
  metadata?: Record<string, unknown>;
}

export interface MarketIntelligenceReport extends IntelligenceIdentity {
  status: IntelligenceStatus;
  direction: MarketContextDirection;
  strength: MarketContextStrength;
  grade: IntelligenceQuality;
  marketConfidence: number;
  convictionScore: number;
  tradeScore: number;
  summary: string;
  thesis: string;

  context: MarketContextSnapshot;
  contextDelta: MarketContextDelta | null;
  decision: TradingDecisionResult;
  narrative: IntelligenceNarrative;
  coach: IntelligenceCoachAssessment;
  risk: IntelligenceRiskAssessment;
  entry: IntelligenceEntryAssessment;
  execution: IntelligenceExecutionAssessment | null;
  recommendation: IntelligenceRecommendation;
  probabilities: IntelligenceProbabilitySet;

  objectives: IntelligenceObjective[];
  triggers: IntelligenceTrigger[];
  evidence: MarketContextEvidence[];
  reasons: MarketContextReason[];
  metrics: MarketContextMetric[];
  tags: string[];
  diagnostics: IntelligenceDiagnostics;
  metadata?: Record<string, unknown>;
}

export interface IntelligenceTradePlanInput {
  direction?: Exclude<MarketContextDirection, "neutral">;
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  quantity?: number;
  riskAmount?: number;
  setupName?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface IntelligencePositionInput {
  id?: string;
  symbol: string;
  direction: Exclude<MarketContextDirection, "neutral">;
  quantity: number;
  averageEntryPrice: number;
  currentPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
  openedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface IntelligenceOrderInput {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop-limit" | string;
  status: string;
  quantity?: number;
  filledQuantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  submittedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface IntelligenceAccountInput {
  buyingPower?: number;
  cash?: number;
  equity?: number;
  portfolioValue?: number;
  dayTradeCount?: number;
  dailyPnL?: number;
  dailyLossLimit?: number;
  riskPerTrade?: number;
  maxOpenPositions?: number;
  metadata?: Record<string, unknown>;
}

export interface IntelligenceBehaviorInput {
  recentTradeCount?: number;
  consecutiveWins?: number;
  consecutiveLosses?: number;
  tradesToday?: number;
  processScoreToday?: number;
  overtradingRisk?: number;
  revengeTradingRisk?: number;
  hesitationRisk?: number;
  chasingRisk?: number;
  fatigueRisk?: number;
  metadata?: Record<string, unknown>;
}

export interface MarketIntelligenceRequest {
  contextRequest: MarketContextBuildRequest;
  consumer?: IntelligenceConsumer;
  preferredDirection?: MarketContextDirection;
  tradePlan?: IntelligenceTradePlanInput;
  position?: IntelligencePositionInput | null;
  orders?: IntelligenceOrderInput[];
  account?: IntelligenceAccountInput;
  behavior?: IntelligenceBehaviorInput;
  previousReport?: MarketIntelligenceReport | null;
  includeCoach?: boolean;
  includeNarrative?: boolean;
  includeExecutionAssessment?: boolean;
  minimumConfidence?: number;
  minimumTradeScore?: number;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface MarketIntelligenceBuildResult {
  report: MarketIntelligenceReport;
  previousReport: MarketIntelligenceReport | null;
  changed: boolean;
  warnings: string[];
  processingTimeMs: number;
}

export interface IntelligenceReportQuery {
  symbol?: string;
  timeframe?: string;
  source?: MarketContextSource | MarketContextSource[];
  consumer?: IntelligenceConsumer | IntelligenceConsumer[];
  mode?: IntelligenceMode | IntelligenceMode[];
  direction?: MarketContextDirection | MarketContextDirection[];
  action?: IntelligenceRecommendationAction | IntelligenceRecommendationAction[];
  grade?: IntelligenceQuality | IntelligenceQuality[];
  minimumConfidence?: number;
  minimumTradeScore?: number;
  canTrade?: boolean;
  fromTimestamp?: number;
  toTimestamp?: number;
  tags?: string[];
  limit?: number;
}

export interface IntelligenceReportProvider {
  getLatest(
    symbol: string,
    timeframe: string,
  ): MarketIntelligenceReport | null;
  getHistory(query: IntelligenceReportQuery): MarketIntelligenceReport[];
}

export type IntelligenceReportListener = (
  report: MarketIntelligenceReport,
  previousReport: MarketIntelligenceReport | null,
) => void;

export interface IntelligenceEngine {
  evaluate(
    request: MarketIntelligenceRequest,
  ): MarketIntelligenceBuildResult;
}
