export type PracticeDifficulty =
  | "beginner"
  | "intermediate"
  | "advanced";

export type PracticeSetupType =
  | "trend"
  | "opening_range_break"
  | "ifvg"
  | "fair_value_gap"
  | "liquidity_sweep"
  | "vwap_reclaim"
  | "compression_breakout"
  | "support_resistance"
  | "reversal"
  | "momentum"
  | "failed_breakout"
  | "range"
  | "chop";

export type PracticeRecommendationCategory =
  | "best_overall"
  | "best_trend"
  | "best_opening_range_break"
  | "best_ifvg"
  | "best_liquidity_sweep"
  | "best_vwap_reclaim"
  | "best_reversal"
  | "best_momentum"
  | "best_failed_breakout"
  | "biggest_runner"
  | "best_beginner"
  | "best_intermediate"
  | "best_advanced"
  | "avoid_chop";

export type PracticeTrendDirection =
  | "bullish"
  | "bearish"
  | "neutral";

export type PracticeMarketCondition =
  | "trending"
  | "reversal"
  | "range"
  | "compression"
  | "choppy"
  | "mixed";

export type PracticeScoreGrade =
  | "A+"
  | "A"
  | "A-"
  | "B+"
  | "B"
  | "B-"
  | "C+"
  | "C"
  | "C-"
  | "D"
  | "F";

export interface PracticeScoreComponent {
  score: number;
  confidence: number;
  reasons: string[];
}

export interface PracticeTrendAnalysis
  extends PracticeScoreComponent {
  direction: PracticeTrendDirection;
  marketCondition: PracticeMarketCondition;

  higherHighCount: number;
  higherLowCount: number;
  lowerHighCount: number;
  lowerLowCount: number;

  impulseCount: number;
  pullbackCount: number;

  trendStrength: number;
  trendEfficiency: number;
  directionalConsistency: number;
}

export interface PracticeStructureAnalysis
  extends PracticeScoreComponent {
  bullishBreakCount: number;
  bearishBreakCount: number;

  bullishShiftCount: number;
  bearishShiftCount: number;

  confirmedSwingHighCount: number;
  confirmedSwingLowCount: number;

  cleanStructure: boolean;
}

export interface PracticeLiquiditySweepEvent {
  direction: "bullish" | "bearish";
  time: number;
  price: number;
  sweptPrice: number;
  reclaimed: boolean;
  confirmationTime?: number;
  qualityScore: number;
}

export interface PracticeLiquidityAnalysis
  extends PracticeScoreComponent {
  sweepCount: number;
  bullishSweepCount: number;
  bearishSweepCount: number;
  reclaimedSweepCount: number;
  events: PracticeLiquiditySweepEvent[];
}

export interface PracticeGapEvent {
  direction: "bullish" | "bearish";
  type: "fvg" | "ifvg";
  startTime: number;
  validationTime?: number;
  invalidationTime?: number;
  low: number;
  high: number;
  midpoint: number;
  active: boolean;
  qualityScore: number;
}

export interface PracticeGapAnalysis
  extends PracticeScoreComponent {
  fvgCount: number;
  ifvgCount: number;
  activeFvgCount: number;
  activeIfvgCount: number;
  events: PracticeGapEvent[];
}

export interface PracticeVwapInteraction {
  type:
    | "reclaim"
    | "rejection"
    | "hold"
    | "loss"
    | "cross";
  direction: "bullish" | "bearish";
  time: number;
  price: number;
  qualityScore: number;
}

export interface PracticeVwapAnalysis
  extends PracticeScoreComponent {
  reclaimCount: number;
  rejectionCount: number;
  holdCount: number;
  lossCount: number;
  interactionCount: number;
  interactions: PracticeVwapInteraction[];
}

export interface PracticeOpeningRangeAnalysis
  extends PracticeScoreComponent {
  rangeHigh?: number;
  rangeLow?: number;
  rangeSize?: number;

  bullishBreakTime?: number;
  bearishBreakTime?: number;

  bullishRetestConfirmed: boolean;
  bearishRetestConfirmed: boolean;

  failedBullishBreak: boolean;
  failedBearishBreak: boolean;
}

export interface PracticeCompressionAnalysis
  extends PracticeScoreComponent {
  compressionDetected: boolean;
  compressionStartTime?: number;
  compressionEndTime?: number;
  breakoutTime?: number;
  breakoutDirection?: "bullish" | "bearish";
  breakoutExpansionRatio?: number;
}

export interface PracticeVolatilityAnalysis
  extends PracticeScoreComponent {
  averageTrueRange: number;
  sessionRange: number;
  sessionRangeAtrMultiple: number;
  expansionCount: number;
  contractionCount: number;
}

export interface PracticeVolumeAnalysis
  extends PracticeScoreComponent {
  averageVolume: number;
  peakVolume: number;
  relativeVolume: number;
  expansionCount: number;
  climaxCount: number;
}

export interface PracticeSetupDetection {
  type: PracticeSetupType;
  direction: PracticeTrendDirection;
  score: number;
  confidence: number;

  detectedAt: number;
  confirmationAt?: number;

  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;

  reasons: string[];
  tags: string[];
}

export interface PracticeReplayRecommendation {
  category: PracticeRecommendationCategory;
  label: string;
  score: number;
  confidence: number;

  symbol: string;
  tradingDate: string;
  timeframe: string;

  jumpToTime?: number;
  setupType?: PracticeSetupType;
  direction?: PracticeTrendDirection;

  reason: string;
}

export interface PracticeSymbolAnalysis {
  id: string;

  symbol: string;
  tradingDate: string;
  timeframe: string;

  analyzedAt: number;
  firstBarTime?: number;
  lastBarTime?: number;
  barCount: number;

  overallScore: number;
  replayScore: number;
  setupQualityScore: number;
  learningValueScore: number;
  executionClarityScore: number;

  grade: PracticeScoreGrade;
  difficulty: PracticeDifficulty;
  primaryCondition: PracticeMarketCondition;
  primaryDirection: PracticeTrendDirection;

  trend: PracticeTrendAnalysis;
  structure: PracticeStructureAnalysis;
  liquidity: PracticeLiquidityAnalysis;
  gaps: PracticeGapAnalysis;
  vwap: PracticeVwapAnalysis;
  openingRange: PracticeOpeningRangeAnalysis;
  compression: PracticeCompressionAnalysis;
  volatility: PracticeVolatilityAnalysis;
  volume: PracticeVolumeAnalysis;

  setups: PracticeSetupDetection[];
  recommendations: PracticeReplayRecommendation[];

  strengths: string[];
  risks: string[];
  tags: string[];
}

export interface PracticeDayAnalysis {
  tradingDate: string;
  analyzedAt: number;

  symbolCount: number;
  analyzedSymbolCount: number;

  symbols: PracticeSymbolAnalysis[];
  recommendations: PracticeReplayRecommendation[];

  topOverallSymbol?: string;
  topTrendSymbol?: string;
  topOpeningRangeBreakSymbol?: string;
  topIfvgSymbol?: string;
  topLiquiditySweepSymbol?: string;
  topReversalSymbol?: string;
  topMomentumSymbol?: string;
}

export interface PracticeAnalysisRequest {
  symbol: string;
  tradingDate: string;
  timeframe: string;

  bars: PracticeAnalysisBar[];

  scannerNames?: string[];
  scannerHitTimes?: number[];

  forceRefresh?: boolean;
}

export interface PracticeAnalysisBar {
  time: number;

  open: number;
  high: number;
  low: number;
  close: number;

  volume?: number;
  vwap?: number;
}

export interface PracticeAnalyzerContext {
  symbol: string;
  tradingDate: string;
  timeframe: string;
  bars: PracticeAnalysisBar[];

  scannerNames: string[];
  scannerHitTimes: number[];
}

export interface PracticeAnalyzer<T> {
  readonly id: string;
  analyze(context: PracticeAnalyzerContext): T;
}

export interface PracticeAnalysisStorage {
  version: number;
  updatedAt: number;
  days: Record<string, PracticeDayAnalysis>;
}

export const PRACTICE_ANALYSIS_STORAGE_VERSION = 1;

export function clampPracticeScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function getPracticeScoreGrade(
  score: number,
): PracticeScoreGrade {
  const normalized = clampPracticeScore(score);

  if (normalized >= 97) return "A+";
  if (normalized >= 93) return "A";
  if (normalized >= 90) return "A-";
  if (normalized >= 87) return "B+";
  if (normalized >= 83) return "B";
  if (normalized >= 80) return "B-";
  if (normalized >= 77) return "C+";
  if (normalized >= 73) return "C";
  if (normalized >= 70) return "C-";
  if (normalized >= 60) return "D";

  return "F";
}

export function getPracticeStarRating(score: number): number {
  const normalized = clampPracticeScore(score);

  if (normalized >= 90) return 5;
  if (normalized >= 80) return 4;
  if (normalized >= 70) return 3;
  if (normalized >= 60) return 2;
  return 1;
}

export function getPracticeDifficulty(
  score: number,
  volatilityScore: number,
  structureScore: number,
): PracticeDifficulty {
  const normalizedScore = clampPracticeScore(score);
  const normalizedVolatility = clampPracticeScore(volatilityScore);
  const normalizedStructure = clampPracticeScore(structureScore);

  if (
    normalizedScore >= 80 &&
    normalizedVolatility <= 65 &&
    normalizedStructure >= 75
  ) {
    return "beginner";
  }

  if (
    normalizedVolatility >= 85 ||
    normalizedStructure <= 45
  ) {
    return "advanced";
  }

  return "intermediate";
}

export function createPracticeAnalysisId(params: {
  tradingDate: string;
  symbol: string;
  timeframe: string;
}): string {
  return [
    params.tradingDate,
    params.symbol.trim().toUpperCase(),
    params.timeframe.trim().toLowerCase(),
  ].join(":");
}