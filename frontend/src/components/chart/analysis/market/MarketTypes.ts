export type MarketDirection = "bullish" | "bearish" | "neutral";

export type MarketStrength =
  | "very-weak"
  | "weak"
  | "moderate"
  | "strong"
  | "very-strong";

export interface MarketEngineResult {
  direction: MarketDirection;

  strength: MarketStrength;

  score: number;

  confidence: number;

  summary: string;

  reasons: string[];
}