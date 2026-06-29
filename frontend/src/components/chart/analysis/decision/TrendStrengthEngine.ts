import type { StudySnapshot } from "./snapshot/StudySnapshotBuilder";
import type { DecisionCenterTrendStrength } from "./DecisionAnalysisTypes";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function buildTrendStrength(
  snapshot: StudySnapshot
): DecisionCenterTrendStrength {
  let score = 50;

  let emaAlignment = 50;
  let vwapAlignment = 50;
  let structureAlignment = 50;
  let momentumAlignment = 50;

  //
  // EMA Alignment
  //

  if (snapshot.ema9 > snapshot.ema20) {
    emaAlignment = 100;
    score += 12;
  } else {
    emaAlignment = 20;
    score -= 12;
  }

  //
  // VWAP Alignment
  //

  if (snapshot.close >= snapshot.vwap) {
    vwapAlignment = 100;
    score += 10;
  } else {
    vwapAlignment = 20;
    score -= 10;
  }

  //
  // Structure Alignment
  //

  if (snapshot.structureScore !== undefined) {
    structureAlignment = clamp(snapshot.structureScore);
    score += (structureAlignment - 50) * 0.20;
  }

  //
  // Momentum Alignment
  //

  if (snapshot.momentumScore !== undefined) {
    momentumAlignment = clamp(snapshot.momentumScore);
    score += (momentumAlignment - 50) * 0.20;
  }

  score = clamp(score);

  let badge = "Neutral";
  let subtitle = "Trend lacks conviction.";
  let tone: "good" | "warn" | "bad" = "warn";

  if (score >= 85) {
    badge = "Excellent";
    subtitle = "Trend is healthy and supports continuation.";
    tone = "good";
  } else if (score >= 70) {
    badge = "Strong";
    subtitle = "Trend remains healthy.";
    tone = "good";
  } else if (score >= 55) {
    badge = "Developing";
    subtitle = "Trend is improving but needs confirmation.";
    tone = "warn";
  } else if (score >= 40) {
    badge = "Weak";
    subtitle = "Trend is weakening.";
    tone = "warn";
  } else {
    badge = "Broken";
    subtitle = "Trend has lost directional control.";
    tone = "bad";
  }

  return {
    score,

    badge,

    subtitle,

    tone,

    emaAlignment,

    vwapAlignment,

    structureAlignment,

    momentumAlignment,

    continuationProbability: score,
  };
}