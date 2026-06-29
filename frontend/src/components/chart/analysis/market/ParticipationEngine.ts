import type { MarketEngineResult } from "./MarketTypes";

export function analyzeParticipation(): MarketEngineResult {
  return {
    direction: "bullish",
    strength: "moderate",
    score: 81,
    confidence: 0.84,
    summary: "Strong Participation",

    reasons: [
      "Relative Volume",
      "Volume Increasing",
    ],
  };
}