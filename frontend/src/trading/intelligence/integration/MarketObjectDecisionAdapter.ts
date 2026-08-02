// src/trading/intelligence/integration/MarketObjectDecisionAdapter.ts

import type {
  MarketIntelligenceResult,
  MarketObjectEvaluation,
} from "../../../components/chart/analysis/market-objects/MarketIntelligenceEngine";
import type {
  MarketObject,
  MarketObjectBias,
  MarketObjectInteractionType,
  MarketObjectPriority,
} from "../../../components/chart/analysis/market-objects/MarketObjectTypes";
import type { MarketContextDirection } from "../types/MarketContextTypes";

export interface MarketObjectDecisionFactor {
  objectId: string;
  label: string;
  direction: MarketContextDirection;
  score: number;
  confidence: number;
  blocking: boolean;
  interactions: MarketObjectInteractionType[];
}

export interface MarketObjectDecisionAdjustment {
  direction: MarketContextDirection;
  scoreAdjustment: number;
  convictionAdjustment: number;
  shouldWait: boolean;
  blocked: boolean;
  supportingObjectIds: string[];
  opposingObjectIds: string[];
  blockingObjectIds: string[];
  factors: MarketObjectDecisionFactor[];
  reasons: string[];
  tags: string[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function objectLabel(object: MarketObject): string {
  return object.presentation?.label ?? object.type;
}

function directionFromBias(bias: MarketObjectBias): MarketContextDirection {
  return bias === "bullish" || bias === "bearish" ? bias : "neutral";
}

function priorityMultiplier(priority: MarketObjectPriority): number {
  switch (priority) {
    case "critical":
      return 1.3;
    case "high":
      return 1.15;
    case "low":
      return 0.7;
    case "normal":
    default:
      return 1;
  }
}

function hasInteraction(
  evaluation: MarketObjectEvaluation,
  interactions: readonly MarketObjectInteractionType[],
): boolean {
  return evaluation.interactions.some((interaction) =>
    interactions.includes(interaction),
  );
}

function factorScore(
  object: MarketObject,
  evaluation: MarketObjectEvaluation,
): number {
  const proximityWeight = evaluation.proximity.isInside
    ? 1
    : evaluation.proximity.isWithinAwarenessRadius
      ? clamp(evaluation.proximity.approachProgress / 100, 0.25, 0.9)
      : 0.15;
  const reactionBonus = hasInteraction(evaluation, [
    "wickRejected",
    "bodyRejected",
    "retestConfirmed",
    "structureHeld",
  ])
    ? 15
    : 0;
  const failurePenalty = hasInteraction(evaluation, [
    "invalidated",
    "structureFailed",
  ])
    ? 35
    : 0;
  const base =
    object.scoring.quality * 0.4 +
    object.scoring.health * 0.25 +
    object.scoring.confidence * 0.35;

  return clamp(
    (base * proximityWeight + reactionBonus - failurePenalty) *
      priorityMultiplier(object.scoring.priority),
    0,
    100,
  );
}

function isBlocking(
  object: MarketObject,
  evaluation: MarketObjectEvaluation,
): boolean {
  return (
    object.status === "invalidated" ||
    object.status === "broken" ||
    hasInteraction(evaluation, ["invalidated", "structureFailed"])
  );
}

function emptyAdjustment(): MarketObjectDecisionAdjustment {
  return {
    direction: "neutral",
    scoreAdjustment: 0,
    convictionAdjustment: 0,
    shouldWait: false,
    blocked: false,
    supportingObjectIds: [],
    opposingObjectIds: [],
    blockingObjectIds: [],
    factors: [],
    reasons: [],
    tags: ["market-object-confluence:none"],
  };
}

/** Converts live Market Object state into bounded decision adjustments. */
export function buildMarketObjectDecisionAdjustment(
  result: MarketIntelligenceResult | null | undefined,
  preferredDirection?: MarketContextDirection,
): MarketObjectDecisionAdjustment {
  if (!result) return emptyAdjustment();

  const objectsById = new Map(
    result.snapshot.objects.map((object) => [object.id, object]),
  );
  const factors: MarketObjectDecisionFactor[] = [];

  for (const evaluation of result.evaluations) {
    const object = objectsById.get(evaluation.objectId);
    if (!object || object.status === "archived" || object.status === "inactive") {
      continue;
    }

    const score = factorScore(object, evaluation);
    if (score < 20 && !isBlocking(object, evaluation)) continue;

    factors.push({
      objectId: object.id,
      label: objectLabel(object),
      direction: directionFromBias(object.bias),
      score,
      confidence: clamp(object.scoring.confidence / 100, 0, 1),
      blocking: isBlocking(object, evaluation),
      interactions: [...evaluation.interactions],
    });
  }

  const bullish = factors
    .filter((factor) => factor.direction === "bullish" && !factor.blocking)
    .reduce((total, factor) => total + factor.score * factor.confidence, 0);
  const bearish = factors
    .filter((factor) => factor.direction === "bearish" && !factor.blocking)
    .reduce((total, factor) => total + factor.score * factor.confidence, 0);
  const direction: MarketContextDirection =
    bullish >= bearish + 12
      ? "bullish"
      : bearish >= bullish + 12
        ? "bearish"
        : "neutral";
  const workingDirection =
    preferredDirection && preferredDirection !== "neutral"
      ? preferredDirection
      : direction;
  const supporting = factors.filter(
    (factor) => !factor.blocking && factor.direction === workingDirection,
  );
  const opposing = factors.filter(
    (factor) =>
      !factor.blocking &&
      factor.direction !== "neutral" &&
      workingDirection !== "neutral" &&
      factor.direction !== workingDirection,
  );
  const blocking = factors.filter(
    (factor) => factor.blocking && factor.direction === workingDirection,
  );
  const supportStrength = supporting.reduce(
    (total, factor) => total + factor.score * factor.confidence,
    0,
  );
  const oppositionStrength = opposing.reduce(
    (total, factor) => total + factor.score * factor.confidence,
    0,
  );
  const confluence = clamp(
    (supportStrength - oppositionStrength) / Math.max(1, factors.length * 12),
    -12,
    12,
  );
  const blocked = blocking.length > 0;
  const shouldWait =
    !blocked && opposing.length > 0 && oppositionStrength >= supportStrength * 0.85;

  return {
    direction,
    scoreAdjustment: blocked ? -18 : confluence,
    convictionAdjustment: blocked ? -15 : clamp(confluence * 0.8, -10, 10),
    shouldWait,
    blocked,
    supportingObjectIds: supporting.map((factor) => factor.objectId),
    opposingObjectIds: opposing.map((factor) => factor.objectId),
    blockingObjectIds: blocking.map((factor) => factor.objectId),
    factors,
    reasons: [
      supporting.length > 0
        ? `${supporting.length} active Market Object${supporting.length === 1 ? "" : "s"} support the ${workingDirection} thesis.`
        : "No nearby Market Object currently confirms the directional thesis.",
      opposing.length > 0
        ? `${opposing.length} nearby Market Object${opposing.length === 1 ? "" : "s"} oppose the thesis.`
        : "No nearby opposing Market Object was detected.",
      blocked
        ? "A thesis-supporting Market Object has failed or been invalidated."
        : "No Market Object invalidation is blocking the thesis.",
    ],
    tags: [
      "market-object-confluence",
      `market-object-direction:${direction}`,
      `market-object-support:${supporting.length}`,
      `market-object-opposition:${opposing.length}`,
      blocked ? "market-object-blocked" : "market-object-not-blocked",
      shouldWait ? "market-object-wait" : "market-object-ready",
    ],
  };
}

export default buildMarketObjectDecisionAdjustment;
