// src/components/chart/analysis/market-objects/MarketMemoryService.ts

import type { Time } from "lightweight-charts";
import {
  marketObjectRegistry,
  type MarketObjectRegistry,
} from "./MarketObjectRegistry";
import type {
  MarketObject,
  MarketObjectInteraction,
  MarketObjectInteractionType,
  MarketObjectLifecycleStage,
  MarketObjectMemory,
  MarketObjectStatus,
} from "./MarketObjectTypes";

export type RecordMarketInteractionInput = {
  type: MarketObjectInteractionType;
  time: Time;
  price?: number;
  barIndex?: number;
  confidenceDelta?: number;
  note?: string;
  metadata?: Record<string, unknown>;
};

export type MarketObjectMemorySummary = {
  objectId: string;
  touchCount: number;
  rejectionCount: number;
  successfulRetestCount: number;
  failedRetestCount: number;
  freshnessScore: number;
  reactionQualityScore: number;
  retestReliabilityScore: number;
  confidenceDrift: number;
  healthScore: number;
  latestInteraction?: MarketObjectInteraction;
};

const REJECTION_TYPES = new Set<MarketObjectInteractionType>([
  "wickRejected",
  "bodyRejected",
]);

const TOUCH_TYPES = new Set<MarketObjectInteractionType>([
  "entered",
  "touched",
]);

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function makeInteractionId(objectId: string): string {
  return `market_interaction_${objectId}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function latestInteraction(
  memory: MarketObjectMemory,
): MarketObjectInteraction | undefined {
  return memory.interactions[memory.interactions.length - 1];
}

function defaultConfidenceDelta(type: MarketObjectInteractionType): number {
  switch (type) {
    case "wickRejected":
      return 4;
    case "bodyRejected":
      return 7;
    case "structureHeld":
      return 8;
    case "retestConfirmed":
      return 10;
    case "bullishClose":
    case "bearishClose":
      return 2;
    case "structureFailed":
      return -12;
    case "closedAbove":
    case "closedBelow":
      return -4;
    case "invalidated":
      return -25;
    default:
      return 0;
  }
}

function nextLifecycleStage(
  object: MarketObject,
  type: MarketObjectInteractionType,
  nextTouchCount: number,
): MarketObjectLifecycleStage {
  switch (type) {
    case "entered":
    case "touched":
      return nextTouchCount <= 1 ? "firstTouch" : "multipleTouches";
    case "wickRejected":
    case "bodyRejected":
    case "structureHeld":
      return "rejected";
    case "retestStarted":
      return "retestPending";
    case "retestConfirmed":
      return "retested";
    case "structureFailed":
      return "accepted";
    case "invalidated":
      return "closeBroken";
    case "archived":
      return "expired";
    default:
      return object.lifecycleStage;
  }
}

function nextStatus(
  object: MarketObject,
  type: MarketObjectInteractionType,
): MarketObjectStatus {
  switch (type) {
    case "approachStarted":
      return "approaching";
    case "approachUpdated":
    case "retestStarted":
      return "watching";
    case "entered":
    case "touched":
      return "touched";
    case "wickRejected":
    case "bodyRejected":
    case "bullishClose":
    case "bearishClose":
    case "structureHeld":
      return "responding";
    case "retestConfirmed":
      return "confirmed";
    case "structureFailed":
      return "weakened";
    case "invalidated":
      return "invalidated";
    case "archived":
      return "archived";
    default:
      return object.status;
  }
}

export class MarketMemoryService {
  constructor(
    private readonly registry: MarketObjectRegistry = marketObjectRegistry,
  ) {}

  recordInteraction(
    objectId: string,
    input: RecordMarketInteractionInput,
  ): MarketObject | null {
    const object = this.registry.get(objectId);
    if (!object) return null;

    const interaction: MarketObjectInteraction = {
      id: makeInteractionId(objectId),
      type: input.type,
      time: input.time,
      price: input.price,
      barIndex: input.barIndex,
      confidenceDelta:
        input.confidenceDelta ?? defaultConfidenceDelta(input.type),
      note: input.note,
      metadata: input.metadata,
      recordedAt: Date.now(),
    };

    const nextMemory = this.buildMemory(object.memory, interaction);
    const scores = this.calculateScores(object, nextMemory);
    const status = nextStatus(object, input.type);
    const invalidatedAt =
      input.type === "invalidated" ? Date.now() : object.invalidatedAt;
    const archivedAt =
      input.type === "archived" ? Date.now() : object.archivedAt;

    return this.registry.update(objectId, {
      status,
      lifecycleStage: nextLifecycleStage(
        object,
        input.type,
        nextMemory.touchCount,
      ),
      active: status !== "invalidated" && status !== "archived",
      invalidatedAt,
      archivedAt,
      memory: {
        ...nextMemory,
        interactions: [...nextMemory.interactions, interaction],
      },
      scoring: {
        ...object.scoring,
        health: scores.healthScore,
        confidence: scores.confidenceScore,
        zoneQuality: object.scoring.zoneQuality
          ? {
              ...object.scoring.zoneQuality,
              freshness: scores.freshnessScore,
              reaction: scores.reactionQualityScore,
            }
          : undefined,
      },
      updatedTime: input.time,
      updatedBarIndex: input.barIndex ?? object.updatedBarIndex,
    });
  }

  recordTouch(
    objectId: string,
    time: Time,
    price?: number,
    barIndex?: number,
  ): MarketObject | null {
    return this.recordInteraction(objectId, {
      type: "touched",
      time,
      price,
      barIndex,
    });
  }

  recordRejection(
    objectId: string,
    time: Time,
    price?: number,
    kind: "wick" | "body" = "wick",
    barIndex?: number,
  ): MarketObject | null {
    return this.recordInteraction(objectId, {
      type: kind === "body" ? "bodyRejected" : "wickRejected",
      time,
      price,
      barIndex,
    });
  }

  recordRetest(
    objectId: string,
    time: Time,
    successful: boolean,
    price?: number,
    barIndex?: number,
  ): MarketObject | null {
    return this.recordInteraction(objectId, {
      type: successful ? "retestConfirmed" : "structureFailed",
      time,
      price,
      barIndex,
      metadata: { successfulRetest: successful },
    });
  }

  recordInvalidation(
    objectId: string,
    time: Time,
    price?: number,
    note?: string,
  ): MarketObject | null {
    return this.recordInteraction(objectId, {
      type: "invalidated",
      time,
      price,
      note,
    });
  }

  refreshObjectHealth(objectId: string): MarketObject | null {
    const object = this.registry.get(objectId);
    if (!object) return null;

    const scores = this.calculateScores(object, object.memory);
    return this.registry.update(objectId, {
      scoring: {
        ...object.scoring,
        health: scores.healthScore,
        confidence: scores.confidenceScore,
        zoneQuality: object.scoring.zoneQuality
          ? {
              ...object.scoring.zoneQuality,
              freshness: scores.freshnessScore,
              reaction: scores.reactionQualityScore,
            }
          : undefined,
      },
    });
  }

  getSummary(objectId: string): MarketObjectMemorySummary | null {
    const object = this.registry.get(objectId);
    if (!object) return null;

    const scores = this.calculateScores(object, object.memory);
    return {
      objectId,
      touchCount: object.memory.touchCount,
      rejectionCount: object.memory.rejectionCount,
      successfulRetestCount: object.memory.successfulRetestCount,
      failedRetestCount: object.memory.failedRetestCount,
      freshnessScore: scores.freshnessScore,
      reactionQualityScore: scores.reactionQualityScore,
      retestReliabilityScore: scores.retestReliabilityScore,
      confidenceDrift: scores.confidenceDrift,
      healthScore: scores.healthScore,
      latestInteraction: latestInteraction(object.memory),
    };
  }

  private buildMemory(
    memory: MarketObjectMemory,
    interaction: MarketObjectInteraction,
  ): MarketObjectMemory {
    const isTouch = TOUCH_TYPES.has(interaction.type);
    const isRejection = REJECTION_TYPES.has(interaction.type);
    const successfulRetest = interaction.type === "retestConfirmed";
    const failedRetest =
      interaction.type === "structureFailed" &&
      interaction.metadata?.successfulRetest === false;

    return {
      ...memory,
      touchCount: memory.touchCount + (isTouch ? 1 : 0),
      rejectionCount: memory.rejectionCount + (isRejection ? 1 : 0),
      successfulRetestCount:
        memory.successfulRetestCount + (successfulRetest ? 1 : 0),
      failedRetestCount: memory.failedRetestCount + (failedRetest ? 1 : 0),
      lastTouchedTime: isTouch ? interaction.time : memory.lastTouchedTime,
      lastReactionTime:
        isRejection || successfulRetest
          ? interaction.time
          : memory.lastReactionTime,
      interactions: memory.interactions,
    };
  }

  private calculateScores(object: MarketObject, memory: MarketObjectMemory) {
    const freshnessScore = clampScore(100 - memory.touchCount * 16);
    const reactionQualityScore =
      memory.touchCount === 0
        ? 50
        : clampScore((memory.rejectionCount / memory.touchCount) * 100);

    const retestTotal =
      memory.successfulRetestCount + memory.failedRetestCount;
    const retestReliabilityScore =
      retestTotal === 0
        ? 50
        : clampScore((memory.successfulRetestCount / retestTotal) * 100);

    const confidenceDrift = clampScore(
      50 +
        memory.interactions.reduce(
          (total, interaction) =>
            total +
            (interaction.confidenceDelta ??
              defaultConfidenceDelta(interaction.type)),
          0,
        ),
    ) - 50;

    const invalidPenalty =
      object.status === "invalidated" || object.status === "archived" ? 100 : 0;
    const failurePenalty = memory.failedRetestCount * 14;
    const healthScore = clampScore(
      freshnessScore * 0.35 +
        reactionQualityScore * 0.35 +
        retestReliabilityScore * 0.3 -
        failurePenalty -
        invalidPenalty,
    );
    const confidenceScore = clampScore(
      object.scoring.quality * 0.45 +
        healthScore * 0.4 +
        (50 + confidenceDrift) * 0.15,
    );

    return {
      freshnessScore,
      reactionQualityScore,
      retestReliabilityScore,
      confidenceDrift,
      healthScore,
      confidenceScore,
    };
  }
}

export const marketMemoryService = new MarketMemoryService();
