import type { DecisionAnalysisResult } from "./DecisionAnalysisTypes";
import type { StudySnapshot } from "./snapshot/StudySnapshotTypes";

export function analyzeEMA(snapshot: StudySnapshot): DecisionAnalysisResult {
  const price = snapshot.price;
  const ema9 = snapshot.ema.ema9;
  const ema20 = snapshot.ema.ema20;

  const signals = [
    {
      label: "EMA 9 > EMA 20",
      passed:
        typeof ema9 === "number" &&
        typeof ema20 === "number" &&
        ema9 > ema20,
      tone: "neutral" as const,
      points: 0,
      maxPoints: 10,
    },
    {
      label: "Price Above EMA 20",
      passed:
        typeof price === "number" &&
        typeof ema20 === "number" &&
        price > ema20,
      tone: "neutral" as const,
      points: 0,
      maxPoints: 10,
    },
  ].map((signal) => ({
    ...signal,
    tone: signal.passed ? ("good" as const) : ("bad" as const),
    points: signal.passed ? signal.maxPoints : 0,
  }));

  const score = signals.reduce((sum, signal) => sum + signal.points, 0);
  const maxScore = signals.reduce((sum, signal) => sum + signal.maxPoints, 0);

  return {
    direction: score >= 15 ? "bullish" : score <= 5 ? "bearish" : "neutral",
    score,
    maxScore,
    confidence: maxScore > 0 ? score / maxScore : 0,
    signals,
  };
}