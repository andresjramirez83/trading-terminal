// src/trading/intelligence/scoring/MarketContextScoring.ts

import type {
  EvidencePolarity,
  MarketContextBias,
  MarketContextComponent,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextQuality,
  MarketContextStrength,
  ScoredContext,
} from "../types/MarketContextTypes";

export interface MarketContextScoreInput {
  score: number;
  maxScore?: number;
  confidence?: number;
  direction?: MarketContextDirection;
}

export interface WeightedScoreInput {
  score: number;
  weight?: number;
  confidence?: number;
}

export interface EvidenceScoreResult {
  score: number;
  confidence: number;
  positiveImpact: number;
  negativeImpact: number;
  neutralImpact: number;
  totalWeight: number;
}

export interface ComponentScoreResult extends ScoredContext {
  componentCount: number;
  totalWeight: number;
}

const DEFAULT_MAX_SCORE = 100;

export function clampNumber(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

export function clampScore(value: number): number {
  return clampNumber(value, 0, 100);
}

export function clampConfidence(value: number): number {
  return clampNumber(value, 0, 1);
}

export function roundScore(value: number, precision = 2): number {
  const factor = 10 ** Math.max(0, precision);
  return Math.round(value * factor) / factor;
}

export function normalizeScore(score: number, maxScore = DEFAULT_MAX_SCORE): number {
  const safeMaxScore = Number.isFinite(maxScore) && maxScore > 0
    ? maxScore
    : DEFAULT_MAX_SCORE;

  return roundScore(clampScore((score / safeMaxScore) * 100));
}

export function directionFromSignedScore(
  signedScore: number,
  neutralThreshold = 5,
): MarketContextDirection {
  const threshold = Math.max(0, neutralThreshold);

  if (signedScore > threshold) {
    return "bullish";
  }

  if (signedScore < -threshold) {
    return "bearish";
  }

  return "neutral";
}

export function strengthFromScore(score: number): MarketContextStrength {
  const normalized = clampScore(score);

  if (normalized >= 85) return "very-strong";
  if (normalized >= 70) return "strong";
  if (normalized >= 50) return "moderate";
  if (normalized >= 30) return "weak";
  return "very-weak";
}

export function qualityFromScore(
  score: number,
  confidence = 1,
): MarketContextQuality {
  const normalized = clampScore(score);
  const trustedScore = normalized * clampConfidence(confidence);

  if (trustedScore >= 85) return "excellent";
  if (trustedScore >= 70) return "good";
  if (trustedScore >= 50) return "fair";
  if (trustedScore >= 25) return "poor";
  return "invalid";
}

export function biasFromScore(
  score: number,
  direction: MarketContextDirection,
): MarketContextBias {
  const normalized = clampScore(score);

  if (direction === "bullish") {
    return normalized >= 80 ? "strong-bullish" : "bullish";
  }

  if (direction === "bearish") {
    return normalized >= 80 ? "strong-bearish" : "bearish";
  }

  return "neutral";
}

export function buildScoredContext(input: MarketContextScoreInput): ScoredContext {
  const maxScore = Number.isFinite(input.maxScore) && (input.maxScore ?? 0) > 0
    ? input.maxScore as number
    : DEFAULT_MAX_SCORE;

  const score = clampNumber(input.score, 0, maxScore);
  const normalizedScore = normalizeScore(score, maxScore);
  const confidence = clampConfidence(input.confidence ?? 0);
  const direction = input.direction ?? "neutral";

  return {
    score: roundScore(score),
    maxScore: roundScore(maxScore),
    normalizedScore,
    confidence,
    direction,
    strength: strengthFromScore(normalizedScore),
    quality: qualityFromScore(normalizedScore, confidence),
  };
}

export function calculateWeightedScore(
  inputs: readonly WeightedScoreInput[],
  fallbackScore = 0,
): number {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const input of inputs) {
    const weight = Math.max(0, input.weight ?? 1);
    const confidence = clampConfidence(input.confidence ?? 1);
    const effectiveWeight = weight * confidence;

    if (effectiveWeight <= 0 || !Number.isFinite(input.score)) {
      continue;
    }

    weightedTotal += clampScore(input.score) * effectiveWeight;
    totalWeight += effectiveWeight;
  }

  if (totalWeight <= 0) {
    return clampScore(fallbackScore);
  }

  return roundScore(weightedTotal / totalWeight);
}

export function calculateWeightedConfidence(
  inputs: readonly WeightedScoreInput[],
  fallbackConfidence = 0,
): number {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const input of inputs) {
    const weight = Math.max(0, input.weight ?? 1);

    if (weight <= 0) {
      continue;
    }

    weightedTotal += clampConfidence(input.confidence ?? 0) * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return clampConfidence(fallbackConfidence);
  }

  return roundScore(weightedTotal / totalWeight, 4);
}

function polarityMultiplier(polarity: EvidencePolarity): number {
  if (polarity === "positive") return 1;
  if (polarity === "negative") return -1;
  return 0;
}

export function scoreEvidence(
  evidence: readonly MarketContextEvidence[],
  neutralBaseScore = 50,
): EvidenceScoreResult {
  let signedImpact = 0;
  let positiveImpact = 0;
  let negativeImpact = 0;
  let neutralImpact = 0;
  let weightedConfidence = 0;
  let totalWeight = 0;

  for (const item of evidence) {
    const weight = Math.max(0, item.weight);
    const confidence = clampConfidence(item.confidence);
    const impact = Math.abs(item.scoreImpact) * weight * confidence;
    const multiplier = polarityMultiplier(item.polarity);

    signedImpact += impact * multiplier;
    weightedConfidence += confidence * weight;
    totalWeight += weight;

    if (item.polarity === "positive") {
      positiveImpact += impact;
    } else if (item.polarity === "negative") {
      negativeImpact += impact;
    } else {
      neutralImpact += Math.abs(item.scoreImpact) * weight;
    }
  }

  const confidence = totalWeight > 0
    ? clampConfidence(weightedConfidence / totalWeight)
    : 0;

  return {
    score: roundScore(clampScore(neutralBaseScore + signedImpact)),
    confidence: roundScore(confidence, 4),
    positiveImpact: roundScore(positiveImpact),
    negativeImpact: roundScore(negativeImpact),
    neutralImpact: roundScore(neutralImpact),
    totalWeight: roundScore(totalWeight),
  };
}

export function aggregateComponentScores(
  components: readonly MarketContextComponent[],
  componentWeights: Partial<Record<MarketContextComponent["category"], number>> = {},
): ComponentScoreResult {
  const scoreInputs: WeightedScoreInput[] = [];
  let bullishWeight = 0;
  let bearishWeight = 0;
  let neutralWeight = 0;
  let totalWeight = 0;

  for (const component of components) {
    const weight = Math.max(0, componentWeights[component.category] ?? 1);
    const confidence = clampConfidence(component.confidence);
    const effectiveWeight = weight * confidence;

    scoreInputs.push({
      score: component.normalizedScore,
      weight,
      confidence,
    });

    totalWeight += weight;

    if (component.direction === "bullish") {
      bullishWeight += effectiveWeight;
    } else if (component.direction === "bearish") {
      bearishWeight += effectiveWeight;
    } else {
      neutralWeight += effectiveWeight;
    }
  }

  const normalizedScore = calculateWeightedScore(scoreInputs);
  const confidence = calculateWeightedConfidence(scoreInputs);
  const directionalBalance = bullishWeight - bearishWeight;
  const neutralThreshold = Math.max(0.01, neutralWeight * 0.25);
  const direction = directionFromSignedScore(directionalBalance, neutralThreshold);
  const scored = buildScoredContext({
    score: normalizedScore,
    maxScore: 100,
    confidence,
    direction,
  });

  return {
    ...scored,
    componentCount: components.length,
    totalWeight: roundScore(totalWeight),
  };
}

export function combineConfidence(...values: number[]): number {
  const validValues = values
    .filter(Number.isFinite)
    .map(clampConfidence);

  if (validValues.length === 0) {
    return 0;
  }

  const failureProbability = validValues.reduce(
    (product, value) => product * (1 - value),
    1,
  );

  return roundScore(clampConfidence(1 - failureProbability), 4);
}

export function reduceConfidenceForConflict(
  confidence: number,
  conflictStrength: number,
): number {
  const reduction = clampConfidence(conflictStrength);
  return roundScore(clampConfidence(confidence * (1 - reduction)), 4);
}
