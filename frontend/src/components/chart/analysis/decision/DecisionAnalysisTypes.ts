export type DecisionDirection = "bullish" | "bearish" | "neutral";
export type DecisionTone = "good" | "warn" | "bad" | "neutral";

export interface DecisionSignal {
  label: string;
  passed: boolean;
  tone: DecisionTone;
  points: number;
  maxPoints: number;
}

export interface DecisionAnalysisResult {
  direction: DecisionDirection;
  score: number;
  maxScore: number;
  confidence: number;
  signals: DecisionSignal[];
}