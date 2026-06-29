import type {
  DecisionAnalysisResult,
  DecisionSignal,
} from "./DecisionAnalysisTypes";

import { analyzeEMA } from "./EMAAnalysis";
import { analyzeVWAP } from "./VWAPAnalysis";

import type { StudySnapshot } from "./snapshot/StudySnapshotTypes";

export interface TradeReadinessInput {
  snapshot: StudySnapshot;
}

export interface TradeReadinessResult {
  score: number;
  maxScore: number;
  percent: number;
  status: "Ready" | "Caution" | "Avoid";
  confidence: number;
  signals: DecisionSignal[];

  analyses: {
    ema: DecisionAnalysisResult;
    vwap: DecisionAnalysisResult;
  };
}

export function calculateTradeReadiness(
  input: TradeReadinessInput
): TradeReadinessResult {
  const ema = analyzeEMA(input.snapshot);
  const vwap = analyzeVWAP(input.snapshot);

  const analyses = [
    ema,
    vwap,
  ];

  const score = analyses.reduce(
    (sum, analysis) => sum + analysis.score,
    0
  );

  const maxScore = analyses.reduce(
    (sum, analysis) => sum + analysis.maxScore,
    0
  );

  const percent =
    maxScore > 0
      ? Math.round((score / maxScore) * 100)
      : 0;

  const confidence =
    analyses.reduce(
      (sum, analysis) => sum + analysis.confidence,
      0
    ) / analyses.length;

  const signals = analyses.flatMap(
    (analysis) => analysis.signals
  );

  return {
    score,
    maxScore,
    percent,

    status:
      percent >= 80
        ? "Ready"
        : percent >= 60
        ? "Caution"
        : "Avoid",

    confidence,

    signals,

    analyses: {
      ema,
      vwap,
    },
  };
}