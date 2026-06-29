import type { DecisionAnalysisResult } from "./DecisionAnalysisTypes";
import type { StudySnapshot } from "./snapshot/StudySnapshotTypes";

export function analyzeVWAP(snapshot: StudySnapshot): DecisionAnalysisResult {
  const price = snapshot.price;
  const vwap = snapshot.vwap.value;
  const slope = snapshot.vwap.slope;

  const signals = [
    {
      label: "Price Above VWAP",
      passed:
        typeof price === "number" &&
        typeof vwap === "number" &&
        price > vwap,
      tone: "neutral" as const,
      points: 0,
      maxPoints: 10,
    },
    {
      label: "VWAP Rising",
      passed: typeof slope === "number" && slope > 0,
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