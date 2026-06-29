import type {
  DecisionCenterAI,
  DecisionCenterBalance,
  DecisionCenterEntryQuality,
  DecisionCenterRisk,
  DecisionCenterTrendStrength,
} from "./DecisionAnalysisTypes";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function buildDecisionEngine(
  trend: DecisionCenterTrendStrength,
  balance: DecisionCenterBalance,
  entry: DecisionCenterEntryQuality,
  risk: DecisionCenterRisk
): DecisionCenterAI {
  const confidence = clamp(
    trend.score * 0.32 +
      entry.score * 0.30 +
      risk.score * 0.23 +
      balance.score * 0.15
  );

  const sellersDominant = balance.sellers > balance.buyers + 12;
  const buyersDominant = balance.buyers > balance.sellers + 12;

  let action: "BUY" | "WAIT" | "SELL" | "AVOID" = "WAIT";
  let tone: "good" | "warn" | "bad" = "warn";
  let reason = "Conditions are mixed. Wait for clearer confirmation.";

  if (
    confidence >= 82 &&
    trend.score >= 72 &&
    entry.score >= 72 &&
    risk.score >= 60 &&
    buyersDominant
  ) {
    action = "BUY";
    tone = "good";
    reason =
      "Bullish conditions are aligned. Trend strength, entry quality, and buyer control support a long trade.";
  } else if (
    trend.score >= 65 &&
    entry.score >= 60 &&
    risk.score >= 50 &&
    !sellersDominant
  ) {
    action = "WAIT";
    tone = "warn";
    reason =
      "The setup is developing, but it needs stronger confirmation before a high-quality entry.";
  } else if (
    trend.score <= 38 &&
    entry.score <= 45 &&
    sellersDominant
  ) {
    action = "SELL";
    tone = "bad";
    reason =
      "Bearish control is dominant. Long setups are weak and downside pressure should be respected.";
  } else if (
    risk.score < 40 ||
    entry.score < 40 ||
    trend.score < 40
  ) {
    action = "AVOID";
    tone = "bad";
    reason =
      "The current setup does not provide enough edge. Risk, trend, or entry quality is below acceptable levels.";
  }

  return {
    action,
    confidence,
    reason,
    tone,
  };
}