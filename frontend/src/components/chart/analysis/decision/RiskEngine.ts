import type { StudySnapshot } from "./snapshot/StudySnapshotBuilder";
import type {
  DecisionCenterEntryQuality,
  DecisionCenterRisk,
  DecisionCenterTrendStrength,
} from "./DecisionAnalysisTypes";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toneFromScore(score: number): "good" | "warn" | "bad" {
  if (score >= 70) return "good";
  if (score >= 45) return "warn";
  return "bad";
}

function formatPrice(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return value.toFixed(2);
}

export function buildRisk(
  snapshot: StudySnapshot,
  trendStrength: DecisionCenterTrendStrength,
  entryQuality: DecisionCenterEntryQuality
): DecisionCenterRisk {
  const close = snapshot.price?.close ?? 0;
  const high = snapshot.price?.high ?? close;
  const low = snapshot.price?.low ?? close;
  const atr = snapshot.atr?.value ?? Math.max(high - low, 0.01);

  const stopDistanceValue = Math.max(atr * 0.65, close - low);
  const targetDistanceValue = Math.max(atr * 1.4, high - close + atr);

  const expectedRRValue =
    stopDistanceValue > 0 ? targetDistanceValue / stopDistanceValue : 0;

  const volatilityPenalty =
    close > 0 ? Math.min(35, (atr / close) * 100 * 4) : 20;

  const rrScore = clamp(expectedRRValue * 35);
  const score = clamp(
    rrScore * 0.45 +
      entryQuality.score * 0.3 +
      trendStrength.score * 0.25 -
      volatilityPenalty
  );

  let badge = "Neutral";
  let subtitle = "Risk is acceptable only with confirmation.";

  if (score >= 85) {
    badge = "Excellent";
    subtitle = "Risk/reward profile is strong and supports the trade.";
  } else if (score >= 70) {
    badge = "Good";
    subtitle = "Risk is favorable if the setup confirms.";
  } else if (score >= 55) {
    badge = "Acceptable";
    subtitle = "Risk is manageable but not ideal.";
  } else if (score >= 40) {
    badge = "Elevated";
    subtitle = "Risk is elevated. Consider waiting or reducing size.";
  } else {
    badge = "Poor";
    subtitle = "Risk/reward is poor. Avoid forcing the trade.";
  }

  return {
    score,
    badge,
    subtitle,
    tone: toneFromScore(score),
    stopDistance: formatPrice(stopDistanceValue),
    targetDistance: formatPrice(targetDistanceValue),
    expectedRR: expectedRRValue > 0 ? expectedRRValue.toFixed(2) : "--",
  };
}