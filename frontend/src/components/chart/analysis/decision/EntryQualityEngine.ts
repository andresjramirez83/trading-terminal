import type { StudySnapshot } from "./snapshot/StudySnapshotBuilder";
import type {
  DecisionCenterBalance,
  DecisionCenterEntryQuality,
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

export function buildEntryQuality(
  snapshot: StudySnapshot,
  trendStrength: DecisionCenterTrendStrength,
  balance: DecisionCenterBalance
): DecisionCenterEntryQuality {
  const momentumScore = snapshot.momentum?.score ?? 50;
  const structureStrength = snapshot.structure?.strength ?? 50;
  const compressionScore = snapshot.compression?.score ?? 50;

  const location = clamp(
    (trendStrength.vwapAlignment + trendStrength.emaAlignment) / 2
  );

  const confirmation = clamp(
    momentumScore * 0.4 +
      structureStrength * 0.35 +
      trendStrength.score * 0.25
  );

  const timing = clamp(
    momentumScore * 0.35 +
      compressionScore * 0.3 +
      balance.score * 0.2 +
      trendStrength.score * 0.15
  );

  const riskReward = clamp(
    trendStrength.continuationProbability * 0.35 +
      confirmation * 0.3 +
      timing * 0.2 +
      (100 - balance.equilibrium) * 0.15
  );

  const score = clamp(
    location * 0.25 +
      confirmation * 0.3 +
      timing * 0.25 +
      riskReward * 0.2
  );

  let badge = "Neutral";
  let subtitle = "Entry quality is mixed. Wait for clearer confirmation.";

  if (score >= 85) {
    badge = "Excellent";
    subtitle = "High-quality entry environment with strong confirmation.";
  } else if (score >= 70) {
    badge = "Good";
    subtitle = "Entry quality is favorable if risk is controlled.";
  } else if (score >= 55) {
    badge = "Developing";
    subtitle = "Setup is developing but needs stronger confirmation.";
  } else if (score >= 40) {
    badge = "Weak";
    subtitle = "Entry quality is weak. Be selective or reduce size.";
  } else {
    badge = "Avoid";
    subtitle = "Entry conditions are poor. Avoid forcing the trade.";
  }

  return {
    score,
    badge,
    subtitle,
    tone: toneFromScore(score),
    location,
    confirmation,
    timing,
    riskReward,
  };
}