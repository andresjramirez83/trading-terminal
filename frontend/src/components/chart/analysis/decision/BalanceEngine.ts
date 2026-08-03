import type { StudySnapshot } from "./snapshot/StudySnapshotBuilder";
import type { DecisionCenterBalance } from "./DecisionAnalysisTypes";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toneFromScore(score: number): "good" | "warn" | "bad" {
  if (score >= 70) return "good";
  if (score >= 45) return "warn";
  return "bad";
}

export function buildBalance(snapshot: StudySnapshot): DecisionCenterBalance {
  const price = snapshot.price ?? 0;
  const vwap = snapshot.vwap?.value ?? price;
  const standardDeviation = snapshot.vwap?.standardDeviation;
  const vwapZScore =
    standardDeviation != null && standardDeviation > 0
      ? (price - vwap) / standardDeviation
      : 0;

  const absoluteZScore = Math.abs(vwapZScore);
  const equilibrium = clamp(100 - absoluteZScore * 40);
  const directionalPressure = clamp(Math.min(50, absoluteZScore * 25));
  const buyers = clamp(50 + (vwapZScore >= 0 ? directionalPressure : -directionalPressure));
  const sellers = clamp(100 - buyers);
  const score = equilibrium;

  let badge = "Balanced";
  let subtitle = "Market is balanced with no clear directional control.";

  if (absoluteZScore <= 0.5) {
    badge = "Equilibrium";
    subtitle = "Price is within 0.5 standard deviations of VWAP and is balanced.";
  } else if (absoluteZScore <= 1) {
    badge = vwapZScore > 0 ? "Above VWAP" : "Below VWAP";
    subtitle = "Price is moderately displaced from VWAP but remains within one standard deviation.";
  } else if (absoluteZScore <= 2) {
    badge = vwapZScore > 0 ? "Extended Above" : "Extended Below";
    subtitle = "Price is more than one standard deviation from VWAP and is becoming extended.";
  } else {
    badge = vwapZScore > 0 ? "Far Above VWAP" : "Far Below VWAP";
    subtitle = "Price is beyond two standard deviations from VWAP and is highly extended.";
  }

  return {
    score,
    vwapZScore,
    badge,
    subtitle,
    tone: toneFromScore(score),
    buyers,
    sellers,
    equilibrium,
  };
}
