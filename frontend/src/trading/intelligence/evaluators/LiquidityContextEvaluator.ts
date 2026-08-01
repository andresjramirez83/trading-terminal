// src/trading/intelligence/evaluators/LiquidityContextEvaluator.ts

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
  directionFromSignedScore,
  scoreEvidence,
} from "../scoring/MarketContextScoring";

export type LiquiditySweepDirection = "high" | "low" | "both" | "none";

export interface LiquidityContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;

  sweptHigh?: boolean;
  sweptLow?: boolean;
  reclaimedHigh?: boolean;
  reclaimedLow?: boolean;
  sweepDirection?: LiquiditySweepDirection;

  buySideLiquidityTaken?: boolean;
  sellSideLiquidityTaken?: boolean;
  buySideLiquidityDistance?: number;
  sellSideLiquidityDistance?: number;

  restingLiquidityAbove?: boolean;
  restingLiquidityBelow?: boolean;
  equalHighs?: boolean;
  equalLows?: boolean;

  trappedBuyers?: boolean;
  trappedSellers?: boolean;
  failedBreakout?: boolean;
  failedBreakdown?: boolean;

  nearestLiquidityAbove?: number;
  nearestLiquidityBelow?: number;
  liquidityImbalance?: number;

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

function sweepDirectionValue(value: unknown): LiquiditySweepDirection | undefined {
  return value === "high" ||
    value === "low" ||
    value === "both" ||
    value === "none"
    ? value
    : undefined;
}

function statusFromConfidence(confidence: number): MarketContextStatus {
  if (confidence >= 0.7) return "confirmed";
  if (confidence >= 0.35) return "forming";
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

function readLiquidityInput(
  context: MarketContextEvaluatorContext,
): LiquidityContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = isRecord(context.input.indicators.custom)
    ? context.input.indicators.custom
    : {};

  const nestedMetadata: Record<string, unknown> = isRecord(metadata.liquidity)
    ? metadata.liquidity
    : {};

  const nestedCustom: Record<string, unknown> = isRecord(custom.liquidity)
    ? custom.liquidity
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score"), read("liquidityScore")),
    confidence: numberValue(
      read("confidence"),
      read("liquidityConfidence"),
    ),

    sweptHigh: booleanValue(read("sweptHigh"), read("highSweep")),
    sweptLow: booleanValue(read("sweptLow"), read("lowSweep")),
    reclaimedHigh: booleanValue(
      read("reclaimedHigh"),
      read("highReclaim"),
    ),
    reclaimedLow: booleanValue(
      read("reclaimedLow"),
      read("lowReclaim"),
    ),
    sweepDirection: sweepDirectionValue(read("sweepDirection")),

    buySideLiquidityTaken: booleanValue(
      read("buySideLiquidityTaken"),
      read("bslTaken"),
    ),
    sellSideLiquidityTaken: booleanValue(
      read("sellSideLiquidityTaken"),
      read("sslTaken"),
    ),
    buySideLiquidityDistance: numberValue(
      read("buySideLiquidityDistance"),
      read("bslDistance"),
    ),
    sellSideLiquidityDistance: numberValue(
      read("sellSideLiquidityDistance"),
      read("sslDistance"),
    ),

    restingLiquidityAbove: booleanValue(
      read("restingLiquidityAbove"),
      read("liquidityAbove"),
    ),
    restingLiquidityBelow: booleanValue(
      read("restingLiquidityBelow"),
      read("liquidityBelow"),
    ),
    equalHighs: booleanValue(read("equalHighs")),
    equalLows: booleanValue(read("equalLows")),

    trappedBuyers: booleanValue(read("trappedBuyers")),
    trappedSellers: booleanValue(read("trappedSellers")),
    failedBreakout: booleanValue(read("failedBreakout")),
    failedBreakdown: booleanValue(read("failedBreakdown")),

    nearestLiquidityAbove: numberValue(
      read("nearestLiquidityAbove"),
      read("liquidityAbovePrice"),
    ),
    nearestLiquidityBelow: numberValue(
      read("nearestLiquidityBelow"),
      read("liquidityBelowPrice"),
    ),
    liquidityImbalance: numberValue(
      read("liquidityImbalance"),
      read("imbalance"),
    ),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class LiquidityContextEvaluator implements MarketContextEvaluator {
  readonly id = "liquidity";
  readonly categories = ["liquidity", "location"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readLiquidityInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confidence = clampConfidence(input.confidence ?? 0.65);

    const addEvidence = (
      id: string,
      label: string,
      reason: string,
      polarity: EvidencePolarity,
      scoreImpact: number,
      value?: EvidenceValue,
    ): void => {
      evidence.push({
        id,
        category: "liquidity",
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

    const sweptHigh =
      input.sweptHigh ||
      input.sweepDirection === "high" ||
      input.sweepDirection === "both";

    const sweptLow =
      input.sweptLow ||
      input.sweepDirection === "low" ||
      input.sweepDirection === "both";

    if (sweptLow && input.reclaimedLow) {
      addEvidence(
        "liquidity_sell_side_sweep_reclaim",
        "Sell-side sweep reclaimed",
        "Price swept liquidity below a low and reclaimed the level.",
        "positive",
        24,
        true,
      );
    } else if (sweptLow) {
      addEvidence(
        "liquidity_sell_side_sweep",
        "Sell-side liquidity swept",
        "Price traded through liquidity below a prior low.",
        "neutral",
        12,
        true,
      );
    }

    if (sweptHigh && input.reclaimedHigh) {
      addEvidence(
        "liquidity_buy_side_sweep_reclaim",
        "Buy-side sweep rejected",
        "Price swept liquidity above a high and failed to hold the breakout.",
        "negative",
        24,
        true,
      );
    } else if (sweptHigh) {
      addEvidence(
        "liquidity_buy_side_sweep",
        "Buy-side liquidity swept",
        "Price traded through liquidity above a prior high.",
        "neutral",
        12,
        true,
      );
    }

    if (input.sellSideLiquidityTaken && !sweptLow) {
      addEvidence(
        "liquidity_sell_side_taken",
        "Sell-side liquidity taken",
        "Liquidity resting below price has been consumed.",
        "positive",
        14,
        true,
      );
    }

    if (input.buySideLiquidityTaken && !sweptHigh) {
      addEvidence(
        "liquidity_buy_side_taken",
        "Buy-side liquidity taken",
        "Liquidity resting above price has been consumed.",
        "negative",
        14,
        true,
      );
    }

    if (input.trappedSellers || input.failedBreakdown) {
      addEvidence(
        "liquidity_trapped_sellers",
        "Trapped sellers",
        "A failed downside break may force short covering.",
        "positive",
        20,
        true,
      );
    }

    if (input.trappedBuyers || input.failedBreakout) {
      addEvidence(
        "liquidity_trapped_buyers",
        "Trapped buyers",
        "A failed upside break may force long liquidation.",
        "negative",
        20,
        true,
      );
    }

    if (input.equalHighs || input.restingLiquidityAbove) {
      addEvidence(
        "liquidity_resting_above",
        "Liquidity resting above",
        "Visible liquidity remains above price as a potential target.",
        "positive",
        8,
        input.nearestLiquidityAbove ?? true,
      );
    }

    if (input.equalLows || input.restingLiquidityBelow) {
      addEvidence(
        "liquidity_resting_below",
        "Liquidity resting below",
        "Visible liquidity remains below price as a potential target.",
        "negative",
        8,
        input.nearestLiquidityBelow ?? true,
      );
    }

    if (finite(input.nearestLiquidityAbove)) {
      metrics.push({
        key: "liquidity.nearestAbove",
        label: "Nearest liquidity above",
        category: "liquidity",
        value: input.nearestLiquidityAbove,
        unit: "price",
        confidence,
        timestamp: context.input.timestamp,
      });
    }

    if (finite(input.nearestLiquidityBelow)) {
      metrics.push({
        key: "liquidity.nearestBelow",
        label: "Nearest liquidity below",
        category: "liquidity",
        value: input.nearestLiquidityBelow,
        unit: "price",
        confidence,
        timestamp: context.input.timestamp,
      });
    }

    if (finite(input.buySideLiquidityDistance)) {
      metrics.push({
        key: "liquidity.buySideDistance",
        label: "Buy-side liquidity distance",
        category: "liquidity",
        value: input.buySideLiquidityDistance,
        unit: "price",
        confidence,
        timestamp: context.input.timestamp,
      });
    }

    if (finite(input.sellSideLiquidityDistance)) {
      metrics.push({
        key: "liquidity.sellSideDistance",
        label: "Sell-side liquidity distance",
        category: "liquidity",
        value: input.sellSideLiquidityDistance,
        unit: "price",
        confidence,
        timestamp: context.input.timestamp,
      });
    }

    if (finite(input.liquidityImbalance)) {
      metrics.push({
        key: "liquidity.imbalance",
        label: "Liquidity imbalance",
        category: "liquidity",
        value: input.liquidityImbalance,
        score: clampScore(50 + input.liquidityImbalance),
        confidence,
        timestamp: context.input.timestamp,
      });
    }

    if (
      evidence.length === 0 &&
      metrics.length === 0 &&
      !finite(input.score) &&
      !input.direction
    ) {
      return null;
    }

    const signedImpact = evidence.reduce((total, item) => {
      if (item.polarity === "positive") {
        return total + item.scoreImpact * item.weight * item.confidence;
      }

      if (item.polarity === "negative") {
        return total - item.scoreImpact * item.weight * item.confidence;
      }

      return total;
    }, 0);

    const direction =
      input.direction ?? directionFromSignedScore(signedImpact);

    const evidenceScore = scoreEvidence(evidence);

    const score = finite(input.score)
      ? clampScore(input.score)
      : direction === "neutral"
        ? evidenceScore.score
        : clampScore(50 + Math.min(50, Math.abs(signedImpact)));

    const scored = buildScoredContext({
      score,
      confidence:
        input.confidence ?? evidenceScore.confidence ?? confidence,
      direction,
    });

    const reasons = evidence.map(createReason);

    const component: MarketContextComponent = {
      id: "liquidity",
      category: "liquidity",
      label: "Liquidity",
      summary:
        direction === "bullish"
          ? "Liquidity conditions favor the bullish side."
          : direction === "bearish"
            ? "Liquidity conditions favor the bearish side."
            : "Liquidity is balanced, unresolved, or acting as a two-sided target.",
      status: statusFromConfidence(scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "liquidity.score",
          label: "Liquidity score",
          category: "liquidity",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "liquidity",
        direction,
        sweptHigh ? "high-sweep" : "",
        sweptLow ? "low-sweep" : "",
        input.failedBreakout ? "failed-breakout" : "",
        input.failedBreakdown ? "failed-breakdown" : "",
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

export default LiquidityContextEvaluator;
