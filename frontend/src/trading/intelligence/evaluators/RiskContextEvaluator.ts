// src/trading/intelligence/evaluators/RiskContextEvaluator.ts

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

export type SetupGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface RiskContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;

  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  secondaryTargetPrice?: number;

  riskPerShare?: number;
  rewardPerShare?: number;
  rewardRiskRatio?: number;
  secondaryRewardRiskRatio?: number;

  invalidationDistance?: number;
  invalidationDistancePct?: number;
  targetDistance?: number;
  targetDistancePct?: number;

  accountRiskDollars?: number;
  positionSize?: number;

  nearbyLiquidityObstacle?: boolean;
  nearbyOpposingFvg?: boolean;
  nearbySupport?: boolean;
  nearbyResistance?: boolean;

  trendAligned?: boolean;
  structureAligned?: boolean;
  liquidityAligned?: boolean;
  vwapAligned?: boolean;
  momentumAligned?: boolean;
  fvgAligned?: boolean;

  extendedFromVwap?: boolean;
  extendedFromTrend?: boolean;
  volatilityElevated?: boolean;
  lowParticipation?: boolean;
  compressionBreakout?: boolean;
  breakoutConfirmed?: boolean;
  reversalRisk?: boolean;

  confluenceCount?: number;
  conflictCount?: number;
  availableRoom?: number;
  availableRoomPct?: number;

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

function statusFromScore(score: number, confidence: number): MarketContextStatus {
  if (score >= 70 && confidence >= 0.65) return "confirmed";
  if (score >= 45) return "forming";
  return "pending";
}

function gradeFromScore(score: number): SetupGrade {
  if (score >= 92) return "A+";
  if (score >= 82) return "A";
  if (score >= 70) return "B";
  if (score >= 58) return "C";
  if (score >= 45) return "D";
  return "F";
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

function readRiskInput(
  context: MarketContextEvaluatorContext,
): RiskContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};
  const nestedMetadata: Record<string, unknown> = isRecord(metadata.risk)
    ? metadata.risk
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.risk)
    ? custom.risk
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`risk${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`risk${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),

    entryPrice: numberValue(read("entryPrice")),
    stopPrice: numberValue(read("stopPrice")),
    targetPrice: numberValue(read("targetPrice")),
    secondaryTargetPrice: numberValue(read("secondaryTargetPrice")),

    riskPerShare: numberValue(read("riskPerShare")),
    rewardPerShare: numberValue(read("rewardPerShare")),
    rewardRiskRatio: numberValue(read("rewardRiskRatio"), read("rMultiple")),
    secondaryRewardRiskRatio: numberValue(read("secondaryRewardRiskRatio")),

    invalidationDistance: numberValue(read("invalidationDistance")),
    invalidationDistancePct: numberValue(read("invalidationDistancePct")),
    targetDistance: numberValue(read("targetDistance")),
    targetDistancePct: numberValue(read("targetDistancePct")),

    accountRiskDollars: numberValue(read("accountRiskDollars")),
    positionSize: numberValue(read("positionSize")),

    nearbyLiquidityObstacle: booleanValue(read("nearbyLiquidityObstacle")),
    nearbyOpposingFvg: booleanValue(read("nearbyOpposingFvg")),
    nearbySupport: booleanValue(read("nearbySupport")),
    nearbyResistance: booleanValue(read("nearbyResistance")),

    trendAligned: booleanValue(read("trendAligned")),
    structureAligned: booleanValue(read("structureAligned")),
    liquidityAligned: booleanValue(read("liquidityAligned")),
    vwapAligned: booleanValue(read("vwapAligned")),
    momentumAligned: booleanValue(read("momentumAligned")),
    fvgAligned: booleanValue(read("fvgAligned")),

    extendedFromVwap: booleanValue(read("extendedFromVwap")),
    extendedFromTrend: booleanValue(read("extendedFromTrend")),
    volatilityElevated: booleanValue(read("volatilityElevated")),
    lowParticipation: booleanValue(read("lowParticipation")),
    compressionBreakout: booleanValue(read("compressionBreakout")),
    breakoutConfirmed: booleanValue(read("breakoutConfirmed")),
    reversalRisk: booleanValue(read("reversalRisk")),

    confluenceCount: numberValue(read("confluenceCount")),
    conflictCount: numberValue(read("conflictCount")),
    availableRoom: numberValue(read("availableRoom")),
    availableRoomPct: numberValue(read("availableRoomPct")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class RiskContextEvaluator implements MarketContextEvaluator {
  readonly id = "risk";
  readonly categories = ["risk", "entry-quality"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readRiskInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confidence = clampConfidence(input.confidence ?? 0.7);

    const direction = input.direction ?? "neutral";

    const entry = input.entryPrice;
    const stop = input.stopPrice;
    const target = input.targetPrice;
    const target2 = input.secondaryTargetPrice;

    const calculatedRisk =
      finite(input.riskPerShare)
        ? Math.abs(input.riskPerShare)
        : finite(entry) && finite(stop)
          ? Math.abs(entry - stop)
          : undefined;

    const calculatedReward =
      finite(input.rewardPerShare)
        ? Math.abs(input.rewardPerShare)
        : finite(entry) && finite(target)
          ? Math.abs(target - entry)
          : undefined;

    const calculatedRR =
      finite(input.rewardRiskRatio)
        ? input.rewardRiskRatio
        : finite(calculatedRisk) &&
            calculatedRisk > 0 &&
            finite(calculatedReward)
          ? calculatedReward / calculatedRisk
          : undefined;

    const calculatedRR2 =
      finite(input.secondaryRewardRiskRatio)
        ? input.secondaryRewardRiskRatio
        : finite(calculatedRisk) &&
            calculatedRisk > 0 &&
            finite(entry) &&
            finite(target2)
          ? Math.abs(target2 - entry) / calculatedRisk
          : undefined;

    const addEvidence = (
      id: string,
      label: string,
      reason: string,
      polarity: EvidencePolarity,
      scoreImpact: number,
      value?: EvidenceValue,
      category: MarketContextEvidence["category"] = "risk",
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

    if (finite(calculatedRR)) {
      if (calculatedRR >= 3) {
        addEvidence(
          "risk_rr_excellent",
          "Excellent reward-to-risk",
          "The planned trade offers at least 3R of potential reward.",
          "positive",
          24,
          calculatedRR,
          "entry-quality",
        );
      } else if (calculatedRR >= 2) {
        addEvidence(
          "risk_rr_good",
          "Good reward-to-risk",
          "The planned trade offers at least 2R of potential reward.",
          "positive",
          18,
          calculatedRR,
          "entry-quality",
        );
      } else if (calculatedRR >= 1.5) {
        addEvidence(
          "risk_rr_acceptable",
          "Acceptable reward-to-risk",
          "The planned trade has usable reward relative to risk.",
          "positive",
          10,
          calculatedRR,
          "entry-quality",
        );
      } else if (calculatedRR < 1) {
        addEvidence(
          "risk_rr_poor",
          "Poor reward-to-risk",
          "The planned reward is smaller than the defined risk.",
          "negative",
          24,
          calculatedRR,
        );
      } else {
        addEvidence(
          "risk_rr_weak",
          "Weak reward-to-risk",
          "The planned trade offers limited reward relative to its risk.",
          "negative",
          14,
          calculatedRR,
        );
      }
    }

    const alignedFactors = [
      input.trendAligned,
      input.structureAligned,
      input.liquidityAligned,
      input.vwapAligned,
      input.momentumAligned,
      input.fvgAligned,
    ].filter((value) => value === true).length;

    const conflictedFactors = [
      input.trendAligned,
      input.structureAligned,
      input.liquidityAligned,
      input.vwapAligned,
      input.momentumAligned,
      input.fvgAligned,
    ].filter((value) => value === false).length;

    const confluenceCount = input.confluenceCount ?? alignedFactors;
    const conflictCount = input.conflictCount ?? conflictedFactors;

    if (confluenceCount >= 5) {
      addEvidence(
        "risk_high_confluence",
        "High confluence",
        "Trend, structure, liquidity, VWAP, momentum, and imbalance context strongly align.",
        "positive",
        24,
        confluenceCount,
        "entry-quality",
      );
    } else if (confluenceCount >= 3) {
      addEvidence(
        "risk_good_confluence",
        "Good confluence",
        "Multiple independent context factors support the setup.",
        "positive",
        15,
        confluenceCount,
        "entry-quality",
      );
    } else if (confluenceCount <= 1) {
      addEvidence(
        "risk_low_confluence",
        "Low confluence",
        "Few independent context factors support the setup.",
        "negative",
        15,
        confluenceCount,
      );
    }

    if (conflictCount >= 3) {
      addEvidence(
        "risk_context_conflict",
        "Conflicting context",
        "Several market context factors disagree with the planned direction.",
        "negative",
        22,
        conflictCount,
      );
    }

    if (input.nearbyLiquidityObstacle) {
      addEvidence(
        "risk_liquidity_obstacle",
        "Nearby liquidity obstacle",
        "A nearby liquidity pool may limit available reward or cause rejection.",
        "negative",
        18,
        true,
      );
    }

    if (input.nearbyOpposingFvg) {
      addEvidence(
        "risk_opposing_fvg",
        "Nearby opposing imbalance",
        "An opposing fair value gap may act as a reaction zone before the target.",
        "negative",
        14,
        true,
      );
    }

    const adverseSupport =
      direction === "bearish" && input.nearbySupport === true;
    const adverseResistance =
      direction === "bullish" && input.nearbyResistance === true;

    if (adverseSupport || adverseResistance) {
      addEvidence(
        "risk_nearby_structure_obstacle",
        "Nearby structural obstacle",
        "Nearby support or resistance reduces clean room to the target.",
        "negative",
        16,
        true,
      );
    }

    if (input.extendedFromVwap) {
      addEvidence(
        "risk_vwap_extension",
        "Extended from VWAP",
        "Price is extended from VWAP and vulnerable to mean reversion.",
        "negative",
        18,
        true,
      );
    }

    if (input.extendedFromTrend) {
      addEvidence(
        "risk_trend_extension",
        "Extended from trend",
        "Price is stretched from its trend averages and entry timing is degraded.",
        "negative",
        16,
        true,
      );
    }

    if (input.volatilityElevated) {
      addEvidence(
        "risk_elevated_volatility",
        "Elevated volatility",
        "Volatility is elevated and may require a wider stop or smaller position.",
        "negative",
        12,
        true,
      );
    }

    if (input.lowParticipation) {
      addEvidence(
        "risk_low_participation",
        "Low participation",
        "Weak participation reduces breakout reliability.",
        "negative",
        14,
        true,
      );
    }

    if (input.compressionBreakout && input.breakoutConfirmed) {
      addEvidence(
        "risk_confirmed_compression_breakout",
        "Confirmed compression breakout",
        "Price broke from compression with confirmation and improved continuation odds.",
        "positive",
        18,
        true,
        "entry-quality",
      );
    } else if (input.compressionBreakout && !input.breakoutConfirmed) {
      addEvidence(
        "risk_unconfirmed_compression_breakout",
        "Unconfirmed compression breakout",
        "Price broke from compression without sufficient confirmation.",
        "negative",
        16,
        true,
      );
    }

    if (input.reversalRisk) {
      addEvidence(
        "risk_reversal_pressure",
        "Reversal pressure",
        "The current location or momentum profile carries elevated reversal risk.",
        "negative",
        20,
        true,
      );
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string,
      unit?: string,
      category: MarketContextMetric["category"] = "risk",
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

    if (finite(entry)) {
      addMetric("risk.entryPrice", "Entry price", entry, "price");
    }
    if (finite(stop)) {
      addMetric("risk.stopPrice", "Stop price", stop, "price");
    }
    if (finite(target)) {
      addMetric("risk.targetPrice", "Target price", target, "price");
    }
    if (finite(target2)) {
      addMetric(
        "risk.secondaryTargetPrice",
        "Secondary target price",
        target2,
        "price",
      );
    }
    if (finite(calculatedRisk)) {
      addMetric("risk.perShare", "Risk per share", calculatedRisk, "price");
    }
    if (finite(calculatedReward)) {
      addMetric(
        "risk.rewardPerShare",
        "Reward per share",
        calculatedReward,
        "price",
      );
    }
    if (finite(calculatedRR)) {
      addMetric("risk.rewardRiskRatio", "Reward-to-risk", calculatedRR, "R");
    }
    if (finite(calculatedRR2)) {
      addMetric(
        "risk.secondaryRewardRiskRatio",
        "Secondary reward-to-risk",
        calculatedRR2,
        "R",
      );
    }
    if (finite(input.invalidationDistance)) {
      addMetric(
        "risk.invalidationDistance",
        "Invalidation distance",
        input.invalidationDistance,
        "price",
      );
    }
    if (finite(input.invalidationDistancePct)) {
      addMetric(
        "risk.invalidationDistancePct",
        "Invalidation distance",
        input.invalidationDistancePct,
        "%",
      );
    }
    if (finite(input.targetDistance)) {
      addMetric(
        "risk.targetDistance",
        "Target distance",
        input.targetDistance,
        "price",
      );
    }
    if (finite(input.targetDistancePct)) {
      addMetric(
        "risk.targetDistancePct",
        "Target distance",
        input.targetDistancePct,
        "%",
      );
    }
    if (finite(input.accountRiskDollars)) {
      addMetric(
        "risk.accountRiskDollars",
        "Account risk",
        input.accountRiskDollars,
        "USD",
      );
    }
    if (finite(input.positionSize)) {
      addMetric(
        "risk.positionSize",
        "Position size",
        input.positionSize,
        "shares",
      );
    }
    if (finite(input.availableRoom)) {
      addMetric(
        "risk.availableRoom",
        "Available room",
        input.availableRoom,
        "price",
      );
    }
    if (finite(input.availableRoomPct)) {
      addMetric(
        "risk.availableRoomPct",
        "Available room",
        input.availableRoomPct,
        "%",
      );
    }

    addMetric(
      "risk.confluenceCount",
      "Confluence count",
      confluenceCount,
      "factors",
      "entry-quality",
    );
    addMetric(
      "risk.conflictCount",
      "Conflict count",
      conflictCount,
      "factors",
    );

    if (
      evidence.length === 0 &&
      metrics.length <= 2 &&
      !finite(input.score) &&
      !finite(calculatedRR)
    ) {
      return null;
    }

    const evidenceScore = scoreEvidence(evidence);

    let rawScore = finite(input.score)
      ? input.score
      : evidenceScore.score;

    if (!finite(input.score)) {
      rawScore = 50;

      for (const item of evidence) {
        const contribution =
          item.scoreImpact * item.weight * item.confidence * 0.55;

        if (item.polarity === "positive") rawScore += contribution;
        if (item.polarity === "negative") rawScore -= contribution;
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
      id: "risk",
      category: "risk",
      label: "Risk & Setup Quality",
      summary:
        grade === "A+" || grade === "A"
          ? `High-quality ${grade} setup with strong reward and confluence.`
          : grade === "B"
            ? "Solid setup with acceptable risk and multiple supporting factors."
            : grade === "C"
              ? "Usable setup, but risk or context conflicts require caution."
              : grade === "D"
                ? "Weak setup with limited reward or meaningful context conflict."
                : "Poor setup quality; risk outweighs available opportunity.",
      status: statusFromScore(scored.normalizedScore, scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "risk.score",
          label: "Risk quality score",
          category: "risk",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        {
          key: "risk.grade",
          label: "Setup grade",
          category: "entry-quality",
          value: grade,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "risk",
        `grade-${grade.toLowerCase().replace("+", "-plus")}`,
        direction,
        finite(calculatedRR) && calculatedRR >= 2 ? "good-r-multiple" : "",
        confluenceCount >= 5 ? "high-confluence" : "",
        conflictCount >= 3 ? "context-conflict" : "",
        input.extendedFromVwap ? "vwap-extension-risk" : "",
        input.extendedFromTrend ? "trend-extension-risk" : "",
        input.nearbyLiquidityObstacle ? "liquidity-obstacle" : "",
        input.reversalRisk ? "reversal-risk" : "",
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

export default RiskContextEvaluator;
