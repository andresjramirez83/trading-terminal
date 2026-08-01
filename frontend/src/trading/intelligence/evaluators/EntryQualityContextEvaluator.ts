// src/trading/intelligence/evaluators/EntryQualityContextEvaluator.ts

import type {
  EvidencePolarity,
  EvidenceValue,
  MarketContextComponent,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextReason,
  MarketContextStatus,
} from "../types/MarketContextTypes";
import type {
  MarketContextEvaluation,
  MarketContextEvaluator,
  MarketContextEvaluatorContext,
} from "../MarketContextEngine";
import {
  buildScoredContext,
  clampConfidence,
  clampScore,
  scoreEvidence,
} from "../scoring/MarketContextScoring";

export type EntryQualityGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface EntryQualityContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;

  entryPrice?: number;
  currentPrice?: number;
  stopPrice?: number;
  targetPrice?: number;

  locationScore?: number;
  timingScore?: number;
  confirmationScore?: number;
  confluenceScore?: number;

  atSupport?: boolean;
  atResistance?: boolean;
  atDemand?: boolean;
  atSupply?: boolean;
  atFvg?: boolean;
  atVwap?: boolean;
  atTrendSupport?: boolean;
  atTrendResistance?: boolean;

  structureConfirmed?: boolean;
  liquidityConfirmed?: boolean;
  momentumConfirmed?: boolean;
  volumeConfirmed?: boolean;
  breakoutConfirmed?: boolean;
  reclaimConfirmed?: boolean;
  retestConfirmed?: boolean;

  chasing?: boolean;
  extended?: boolean;
  lateEntry?: boolean;
  earlyEntry?: boolean;
  insideBalance?: boolean;
  lowParticipation?: boolean;
  nearbyObstacle?: boolean;
  poorStopLocation?: boolean;
  invalidationClear?: boolean;

  distanceFromIdealEntry?: number;
  distanceFromIdealEntryPct?: number;
  distanceToInvalidation?: number;
  distanceToTarget?: number;
  rewardRiskRatio?: number;

  setupAgeBars?: number;
  confirmationCount?: number;
  conflictCount?: number;

  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (finite(value)) return value;
  }
  return undefined;
}

function directionValue(value: unknown): MarketContextDirection | undefined {
  return value === "bullish" || value === "bearish" || value === "neutral"
    ? value
    : undefined;
}

function gradeFromScore(score: number): EntryQualityGrade {
  if (score >= 92) return "A+";
  if (score >= 82) return "A";
  if (score >= 70) return "B";
  if (score >= 58) return "C";
  if (score >= 45) return "D";
  return "F";
}

function statusFromScore(
  score: number,
  confidence: number,
): MarketContextStatus {
  if (score >= 72 && confidence >= 0.65) return "confirmed";
  if (score >= 48) return "forming";
  return "pending";
}

function createReason(evidence: MarketContextEvidence): MarketContextReason {
  return {
    id: `reason_${evidence.id}`,
    text: evidence.reason,
    category: evidence.category,
    polarity: evidence.polarity,
    importance: clampScore(Math.abs(evidence.scoreImpact)),
    confidence: clampConfidence(evidence.confidence),
    evidenceIds: [evidence.id],
  };
}

function readEntryInput(
  context: MarketContextEvaluatorContext,
): EntryQualityContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};
  const nestedMetadata: Record<string, unknown> = isRecord(metadata.entryQuality)
    ? metadata.entryQuality
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.entryQuality)
    ? custom.entryQuality
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`entry${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`entry${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),

    entryPrice: numberValue(read("entryPrice")),
    currentPrice: numberValue(read("currentPrice"), context.input.bar.close),
    stopPrice: numberValue(read("stopPrice")),
    targetPrice: numberValue(read("targetPrice")),

    locationScore: numberValue(read("locationScore")),
    timingScore: numberValue(read("timingScore")),
    confirmationScore: numberValue(read("confirmationScore")),
    confluenceScore: numberValue(read("confluenceScore")),

    atSupport: booleanValue(read("atSupport")),
    atResistance: booleanValue(read("atResistance")),
    atDemand: booleanValue(read("atDemand")),
    atSupply: booleanValue(read("atSupply")),
    atFvg: booleanValue(read("atFvg")),
    atVwap: booleanValue(read("atVwap")),
    atTrendSupport: booleanValue(read("atTrendSupport")),
    atTrendResistance: booleanValue(read("atTrendResistance")),

    structureConfirmed: booleanValue(read("structureConfirmed")),
    liquidityConfirmed: booleanValue(read("liquidityConfirmed")),
    momentumConfirmed: booleanValue(read("momentumConfirmed")),
    volumeConfirmed: booleanValue(read("volumeConfirmed")),
    breakoutConfirmed: booleanValue(read("breakoutConfirmed")),
    reclaimConfirmed: booleanValue(read("reclaimConfirmed")),
    retestConfirmed: booleanValue(read("retestConfirmed")),

    chasing: booleanValue(read("chasing")),
    extended: booleanValue(read("extended")),
    lateEntry: booleanValue(read("lateEntry")),
    earlyEntry: booleanValue(read("earlyEntry")),
    insideBalance: booleanValue(read("insideBalance")),
    lowParticipation: booleanValue(read("lowParticipation")),
    nearbyObstacle: booleanValue(read("nearbyObstacle")),
    poorStopLocation: booleanValue(read("poorStopLocation")),
    invalidationClear: booleanValue(read("invalidationClear")),

    distanceFromIdealEntry: numberValue(read("distanceFromIdealEntry")),
    distanceFromIdealEntryPct: numberValue(read("distanceFromIdealEntryPct")),
    distanceToInvalidation: numberValue(read("distanceToInvalidation")),
    distanceToTarget: numberValue(read("distanceToTarget")),
    rewardRiskRatio: numberValue(read("rewardRiskRatio"), read("rMultiple")),

    setupAgeBars: numberValue(read("setupAgeBars")),
    confirmationCount: numberValue(read("confirmationCount")),
    conflictCount: numberValue(read("conflictCount")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class EntryQualityContextEvaluator
  implements MarketContextEvaluator {
  readonly id = "entry-quality";
  readonly categories = ["entry-quality", "risk"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readEntryInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confidence = clampConfidence(input.confidence ?? 0.7);
    const direction = input.direction ?? "neutral";

    const addEvidence = (
      id: string,
      label: string,
      reason: string,
      polarity: EvidencePolarity,
      scoreImpact: number,
      value?: EvidenceValue,
      category: MarketContextEvidence["category"] = "entry-quality",
    ): void => {
      evidence.push({
        id,
        category,
        label,
        reason,
        polarity,
        severity: polarity === "negative" ? "warning" : "supporting",
        weight: 1,
        scoreImpact,
        confidence,
        value,
        source: this.id,
        timeframe: context.input.timeframe,
        timestamp: context.input.timestamp,
      });
    };

    const favorableLocation =
      direction === "bullish"
        ? input.atSupport || input.atDemand || input.atTrendSupport
        : direction === "bearish"
          ? input.atResistance || input.atSupply || input.atTrendResistance
          : false;

    const adverseLocation =
      direction === "bullish"
        ? input.atResistance || input.atSupply || input.atTrendResistance
        : direction === "bearish"
          ? input.atSupport || input.atDemand || input.atTrendSupport
          : false;

    if (favorableLocation) {
      addEvidence(
        "entry_favorable_location",
        "Favorable trade location",
        "The entry is positioned near a level that supports the planned direction.",
        "positive",
        20,
        true,
      );
    }

    if (adverseLocation) {
      addEvidence(
        "entry_adverse_location",
        "Adverse trade location",
        "The entry is positioned near an opposing structural level.",
        "negative",
        22,
        true,
        "risk",
      );
    }

    if (input.atFvg) {
      addEvidence(
        "entry_fvg_location",
        "Entry at imbalance",
        "The entry is located within or near a fair value gap reaction zone.",
        "positive",
        14,
        true,
      );
    }

    if (input.atVwap) {
      addEvidence(
        "entry_vwap_location",
        "Entry near VWAP",
        "The entry is occurring near VWAP, improving location and invalidation clarity.",
        "positive",
        12,
        true,
      );
    }

    if (input.structureConfirmed) {
      addEvidence(
        "entry_structure_confirmed",
        "Structure confirmed",
        "Market structure supports the planned entry direction.",
        "positive",
        18,
        true,
      );
    }

    if (input.liquidityConfirmed) {
      addEvidence(
        "entry_liquidity_confirmed",
        "Liquidity event confirmed",
        "A sweep, reclaim, or liquidity reaction supports the entry.",
        "positive",
        18,
        true,
      );
    }

    if (input.momentumConfirmed) {
      addEvidence(
        "entry_momentum_confirmed",
        "Momentum confirmed",
        "Momentum is expanding in the planned direction.",
        "positive",
        14,
        true,
      );
    }

    if (input.volumeConfirmed) {
      addEvidence(
        "entry_volume_confirmed",
        "Participation confirmed",
        "Volume or order-flow participation supports the entry.",
        "positive",
        14,
        true,
      );
    }

    if (input.breakoutConfirmed) {
      addEvidence(
        "entry_breakout_confirmed",
        "Breakout confirmed",
        "Price has confirmed acceptance beyond the breakout level.",
        "positive",
        18,
        true,
      );
    }

    if (input.reclaimConfirmed) {
      addEvidence(
        "entry_reclaim_confirmed",
        "Reclaim confirmed",
        "Price reclaimed a key level and maintained acceptance.",
        "positive",
        20,
        true,
      );
    }

    if (input.retestConfirmed) {
      addEvidence(
        "entry_retest_confirmed",
        "Retest confirmed",
        "The breakout or reclaimed level held on retest.",
        "positive",
        20,
        true,
      );
    }

    if (input.chasing) {
      addEvidence(
        "entry_chasing",
        "Chasing price",
        "The entry is too far from the ideal location and carries elevated pullback risk.",
        "negative",
        24,
        true,
        "risk",
      );
    }

    if (input.extended) {
      addEvidence(
        "entry_extended",
        "Extended entry",
        "Price is stretched from value or trend support, degrading entry quality.",
        "negative",
        20,
        true,
        "risk",
      );
    }

    if (input.lateEntry) {
      addEvidence(
        "entry_late",
        "Late entry",
        "Much of the planned move has already occurred before entry.",
        "negative",
        18,
        true,
        "risk",
      );
    }

    if (input.earlyEntry) {
      addEvidence(
        "entry_early",
        "Early entry",
        "The entry is occurring before sufficient confirmation.",
        "negative",
        16,
        true,
        "risk",
      );
    }

    if (input.insideBalance) {
      addEvidence(
        "entry_inside_balance",
        "Entry inside balance",
        "The entry is located inside a rotational range where directional edge is weaker.",
        "negative",
        18,
        true,
        "risk",
      );
    }

    if (input.lowParticipation) {
      addEvidence(
        "entry_low_participation",
        "Low participation",
        "Weak participation reduces confidence in the entry signal.",
        "negative",
        14,
        true,
        "risk",
      );
    }

    if (input.nearbyObstacle) {
      addEvidence(
        "entry_nearby_obstacle",
        "Nearby obstacle",
        "Nearby liquidity, support, resistance, or imbalance limits available room.",
        "negative",
        18,
        true,
        "risk",
      );
    }

    if (input.poorStopLocation) {
      addEvidence(
        "entry_poor_stop",
        "Poor stop location",
        "The stop is not located beyond a clear technical invalidation point.",
        "negative",
        22,
        true,
        "risk",
      );
    }

    if (input.invalidationClear) {
      addEvidence(
        "entry_clear_invalidation",
        "Clear invalidation",
        "The setup has a clear technical level that defines when the trade thesis is wrong.",
        "positive",
        18,
        true,
      );
    }

    if (finite(input.rewardRiskRatio)) {
      if (input.rewardRiskRatio >= 2) {
        addEvidence(
          "entry_good_rr",
          "Good reward-to-risk",
          "The entry provides at least 2R of available reward.",
          "positive",
          18,
          input.rewardRiskRatio,
        );
      } else if (input.rewardRiskRatio < 1.25) {
        addEvidence(
          "entry_weak_rr",
          "Weak reward-to-risk",
          "The remaining reward is too small relative to the required risk.",
          "negative",
          22,
          input.rewardRiskRatio,
          "risk",
        );
      }
    }

    const inferredConfirmations = [
      input.structureConfirmed,
      input.liquidityConfirmed,
      input.momentumConfirmed,
      input.volumeConfirmed,
      input.breakoutConfirmed,
      input.reclaimConfirmed,
      input.retestConfirmed,
    ].filter((value) => value === true).length;

    const inferredConflicts = [
      input.chasing,
      input.extended,
      input.lateEntry,
      input.earlyEntry,
      input.insideBalance,
      input.lowParticipation,
      input.nearbyObstacle,
      input.poorStopLocation,
    ].filter((value) => value === true).length;

    const confirmationCount =
      input.confirmationCount ?? inferredConfirmations;
    const conflictCount = input.conflictCount ?? inferredConflicts;

    if (confirmationCount >= 4) {
      addEvidence(
        "entry_multi_confirmation",
        "Multiple confirmations",
        "The setup is supported by several independent entry confirmations.",
        "positive",
        18,
        confirmationCount,
      );
    }

    if (conflictCount >= 3) {
      addEvidence(
        "entry_multiple_conflicts",
        "Multiple entry conflicts",
        "Several timing, location, or risk factors reduce entry quality.",
        "negative",
        22,
        conflictCount,
        "risk",
      );
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string,
      unit?: string,
      category: MarketContextMetric["category"] = "entry-quality",
    ): void => {
      metrics.push({
        key,
        label,
        category,
        value,
        unit,
        confidence,
        timestamp: context.input.timestamp,
      });
    };

    if (finite(input.entryPrice)) {
      addMetric("entry.price", "Entry price", input.entryPrice, "price");
    }
    if (finite(input.currentPrice)) {
      addMetric("entry.currentPrice", "Current price", input.currentPrice, "price");
    }
    if (finite(input.stopPrice)) {
      addMetric("entry.stopPrice", "Stop price", input.stopPrice, "price");
    }
    if (finite(input.targetPrice)) {
      addMetric("entry.targetPrice", "Target price", input.targetPrice, "price");
    }
    if (finite(input.locationScore)) {
      addMetric("entry.locationScore", "Location score", input.locationScore, "score");
    }
    if (finite(input.timingScore)) {
      addMetric("entry.timingScore", "Timing score", input.timingScore, "score");
    }
    if (finite(input.confirmationScore)) {
      addMetric(
        "entry.confirmationScore",
        "Confirmation score",
        input.confirmationScore,
        "score",
      );
    }
    if (finite(input.confluenceScore)) {
      addMetric(
        "entry.confluenceScore",
        "Confluence score",
        input.confluenceScore,
        "score",
      );
    }
    if (finite(input.distanceFromIdealEntry)) {
      addMetric(
        "entry.distanceFromIdeal",
        "Distance from ideal entry",
        input.distanceFromIdealEntry,
        "price",
      );
    }
    if (finite(input.distanceFromIdealEntryPct)) {
      addMetric(
        "entry.distanceFromIdealPct",
        "Distance from ideal entry",
        input.distanceFromIdealEntryPct,
        "%",
      );
    }
    if (finite(input.distanceToInvalidation)) {
      addMetric(
        "entry.distanceToInvalidation",
        "Distance to invalidation",
        input.distanceToInvalidation,
        "price",
      );
    }
    if (finite(input.distanceToTarget)) {
      addMetric(
        "entry.distanceToTarget",
        "Distance to target",
        input.distanceToTarget,
        "price",
      );
    }
    if (finite(input.rewardRiskRatio)) {
      addMetric(
        "entry.rewardRiskRatio",
        "Reward-to-risk",
        input.rewardRiskRatio,
        "R",
      );
    }
    if (finite(input.setupAgeBars)) {
      addMetric("entry.setupAge", "Setup age", input.setupAgeBars, "bars");
    }

    addMetric(
      "entry.confirmationCount",
      "Confirmation count",
      confirmationCount,
      "factors",
    );
    addMetric(
      "entry.conflictCount",
      "Conflict count",
      conflictCount,
      "factors",
      "risk",
    );

    if (
      evidence.length === 0 &&
      metrics.length <= 2 &&
      !finite(input.score)
    ) {
      return null;
    }

    const evidenceScore = scoreEvidence(evidence);

    let rawScore = finite(input.score) ? input.score : 50;

    if (!finite(input.score)) {
      for (const item of evidence) {
        const contribution =
          item.scoreImpact * item.weight * item.confidence * 0.5;

        if (item.polarity === "positive") rawScore += contribution;
        if (item.polarity === "negative") rawScore -= contribution;
      }

      const subScores = [
        input.locationScore,
        input.timingScore,
        input.confirmationScore,
        input.confluenceScore,
      ].filter(finite);

      if (subScores.length > 0) {
        const average =
          subScores.reduce((total, value) => total + value, 0) /
          subScores.length;

        rawScore = rawScore * 0.6 + average * 0.4;
      }
    }

    const scored = buildScoredContext({
      score: clampScore(rawScore),
      confidence:
        input.confidence ?? evidenceScore.confidence ?? confidence,
      direction,
    });

    const grade = gradeFromScore(scored.normalizedScore);
    const reasons = evidence.map(createReason);

    const component: MarketContextComponent = {
      id: "entry-quality",
      category: "entry-quality",
      label: "Entry Quality",
      summary:
        grade === "A+" || grade === "A"
          ? `High-quality ${grade} entry with strong timing, location, and confirmation.`
          : grade === "B"
            ? "Solid entry with acceptable location and confirmation."
            : grade === "C"
              ? "Usable entry, but timing or location requires caution."
              : grade === "D"
                ? "Weak entry with meaningful timing, location, or confirmation problems."
                : "Poor entry quality; avoid chasing or entering without confirmation.",
      status: statusFromScore(scored.normalizedScore, scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "entry.score",
          label: "Entry quality score",
          category: "entry-quality",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        {
          key: "entry.grade",
          label: "Entry grade",
          category: "entry-quality",
          value: grade,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "entry-quality",
        direction,
        `grade-${grade.toLowerCase().replace("+", "-plus")}`,
        favorableLocation ? "favorable-location" : "",
        input.retestConfirmed ? "retest-confirmed" : "",
        input.reclaimConfirmed ? "reclaim-confirmed" : "",
        input.chasing ? "chasing" : "",
        input.extended ? "extended" : "",
        input.lateEntry ? "late-entry" : "",
        input.earlyEntry ? "early-entry" : "",
        input.insideBalance ? "inside-balance" : "",
        input.nearbyObstacle ? "nearby-obstacle" : "",
      ].filter(Boolean),
      updatedAt: context.now,
    };

    return {
      components: [component],
      evidence,
      reasons,
      metrics: component.metrics,
      tags: component.tags,
    };
  }
}

export default EntryQualityContextEvaluator;
