// src/trading/intelligence/evaluators/BalanceContextEvaluator.ts

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

export type BalanceState =
  | "balanced"
  | "bullish-imbalance"
  | "bearish-imbalance"
  | "transitioning"
  | "breaking"
  | "failed-break"
  | "unknown";

export interface BalanceContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;
  state?: BalanceState;

  balanced?: boolean;
  bullishImbalance?: boolean;
  bearishImbalance?: boolean;
  transitioning?: boolean;

  rangeHigh?: number;
  rangeLow?: number;
  midpoint?: number;
  rangeWidth?: number;
  rangeWidthPct?: number;

  priceAboveMidpoint?: boolean;
  priceBelowMidpoint?: boolean;
  midpointAccepted?: boolean;
  midpointRejected?: boolean;

  upperAcceptance?: boolean;
  lowerAcceptance?: boolean;
  upperRejection?: boolean;
  lowerRejection?: boolean;

  bullishBreak?: boolean;
  bearishBreak?: boolean;
  failedBullishBreak?: boolean;
  failedBearishBreak?: boolean;

  valueAreaHigh?: number;
  valueAreaLow?: number;
  pointOfControl?: number;

  overlapRatio?: number;
  rotationCount?: number;
  chopRisk?: boolean;
  directionalEfficiency?: number;
  balanceDurationBars?: number;

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

function stateValue(value: unknown): BalanceState | undefined {
  return value === "balanced" ||
    value === "bullish-imbalance" ||
    value === "bearish-imbalance" ||
    value === "transitioning" ||
    value === "breaking" ||
    value === "failed-break" ||
    value === "unknown"
    ? value
    : undefined;
}

function statusFromState(
  state: BalanceState | undefined,
  confidence: number,
): MarketContextStatus {
  if (state === "failed-break") return "invalidated";
  if (state === "transitioning" || state === "breaking") return "forming";
  if (
    state === "balanced" ||
    state === "bullish-imbalance" ||
    state === "bearish-imbalance"
  ) {
    return confidence >= 0.7 ? "confirmed" : "forming";
  }
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

function readBalanceInput(
  context: MarketContextEvaluatorContext,
): BalanceContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};
  const nestedMetadata: Record<string, unknown> = isRecord(metadata.balance)
    ? metadata.balance
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.balance)
    ? custom.balance
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`balance${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`balance${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),
    state: stateValue(read("state")),

    balanced: booleanValue(read("balanced")),
    bullishImbalance: booleanValue(read("bullishImbalance")),
    bearishImbalance: booleanValue(read("bearishImbalance")),
    transitioning: booleanValue(read("transitioning")),

    rangeHigh: numberValue(read("rangeHigh")),
    rangeLow: numberValue(read("rangeLow")),
    midpoint: numberValue(read("midpoint")),
    rangeWidth: numberValue(read("rangeWidth")),
    rangeWidthPct: numberValue(read("rangeWidthPct")),

    priceAboveMidpoint: booleanValue(read("priceAboveMidpoint")),
    priceBelowMidpoint: booleanValue(read("priceBelowMidpoint")),
    midpointAccepted: booleanValue(read("midpointAccepted")),
    midpointRejected: booleanValue(read("midpointRejected")),

    upperAcceptance: booleanValue(read("upperAcceptance")),
    lowerAcceptance: booleanValue(read("lowerAcceptance")),
    upperRejection: booleanValue(read("upperRejection")),
    lowerRejection: booleanValue(read("lowerRejection")),

    bullishBreak: booleanValue(read("bullishBreak")),
    bearishBreak: booleanValue(read("bearishBreak")),
    failedBullishBreak: booleanValue(read("failedBullishBreak")),
    failedBearishBreak: booleanValue(read("failedBearishBreak")),

    valueAreaHigh: numberValue(read("valueAreaHigh")),
    valueAreaLow: numberValue(read("valueAreaLow")),
    pointOfControl: numberValue(read("pointOfControl"), read("poc")),

    overlapRatio: numberValue(read("overlapRatio")),
    rotationCount: numberValue(read("rotationCount")),
    chopRisk: booleanValue(read("chopRisk")),
    directionalEfficiency: numberValue(read("directionalEfficiency")),
    balanceDurationBars: numberValue(read("balanceDurationBars")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class BalanceContextEvaluator implements MarketContextEvaluator {
  readonly id = "balance";
  readonly categories = ["balance", "structure", "risk"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readBalanceInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confidence = clampConfidence(input.confidence ?? 0.65);
    const price = context.input.bar.close;

    const inferredMidpoint =
      finite(input.midpoint)
        ? input.midpoint
        : finite(input.rangeHigh) && finite(input.rangeLow)
          ? (input.rangeHigh + input.rangeLow) / 2
          : undefined;

    const inferredRangeWidth =
      finite(input.rangeWidth)
        ? input.rangeWidth
        : finite(input.rangeHigh) && finite(input.rangeLow)
          ? Math.abs(input.rangeHigh - input.rangeLow)
          : undefined;

    const inferredState: BalanceState | undefined =
      input.failedBullishBreak || input.failedBearishBreak
        ? "failed-break"
        : input.bullishBreak || input.bearishBreak
          ? "breaking"
          : input.transitioning
            ? "transitioning"
            : input.bullishImbalance
              ? "bullish-imbalance"
              : input.bearishImbalance
                ? "bearish-imbalance"
                : input.balanced
                  ? "balanced"
                  : input.state;

    const addEvidence = (
      id: string,
      label: string,
      reason: string,
      polarity: EvidencePolarity,
      scoreImpact: number,
      value?: EvidenceValue,
      category: MarketContextEvidence["category"] = "balance",
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

    if (inferredState === "balanced") {
      addEvidence(
        "balance_active",
        "Balanced auction",
        "Price is rotating within an accepted range without sustained directional control.",
        "neutral",
        14,
        true,
      );
    }

    if (inferredState === "bullish-imbalance") {
      addEvidence(
        "balance_bullish_imbalance",
        "Bullish imbalance",
        "Buyers are controlling the auction and price is moving away from balance.",
        "positive",
        22,
        true,
      );
    }

    if (inferredState === "bearish-imbalance") {
      addEvidence(
        "balance_bearish_imbalance",
        "Bearish imbalance",
        "Sellers are controlling the auction and price is moving away from balance.",
        "negative",
        22,
        true,
      );
    }

    const aboveMidpoint =
      input.priceAboveMidpoint ||
      (finite(inferredMidpoint) && price > inferredMidpoint);

    const belowMidpoint =
      input.priceBelowMidpoint ||
      (finite(inferredMidpoint) && price < inferredMidpoint);

    if (aboveMidpoint && input.midpointAccepted) {
      addEvidence(
        "balance_midpoint_accepted_above",
        "Acceptance above midpoint",
        "Price is accepting above the balance midpoint, favoring the upper half of the range.",
        "positive",
        14,
        inferredMidpoint,
      );
    }

    if (belowMidpoint && input.midpointAccepted) {
      addEvidence(
        "balance_midpoint_accepted_below",
        "Acceptance below midpoint",
        "Price is accepting below the balance midpoint, favoring the lower half of the range.",
        "negative",
        14,
        inferredMidpoint,
      );
    }

    if (input.upperAcceptance) {
      addEvidence(
        "balance_upper_acceptance",
        "Upper-range acceptance",
        "Price is holding near or above the upper balance boundary.",
        "positive",
        18,
        input.rangeHigh,
        "structure",
      );
    }

    if (input.lowerAcceptance) {
      addEvidence(
        "balance_lower_acceptance",
        "Lower-range acceptance",
        "Price is holding near or below the lower balance boundary.",
        "negative",
        18,
        input.rangeLow,
        "structure",
      );
    }

    if (input.upperRejection) {
      addEvidence(
        "balance_upper_rejection",
        "Upper-range rejection",
        "Price rejected the upper balance boundary and returned toward value.",
        "negative",
        16,
        input.rangeHigh,
        "structure",
      );
    }

    if (input.lowerRejection) {
      addEvidence(
        "balance_lower_rejection",
        "Lower-range rejection",
        "Price rejected the lower balance boundary and returned toward value.",
        "positive",
        16,
        input.rangeLow,
        "structure",
      );
    }

    if (input.bullishBreak) {
      addEvidence(
        "balance_bullish_break",
        "Bullish balance break",
        "Price broke above the accepted range.",
        "positive",
        24,
        input.rangeHigh,
        "entry-quality",
      );
    }

    if (input.bearishBreak) {
      addEvidence(
        "balance_bearish_break",
        "Bearish balance break",
        "Price broke below the accepted range.",
        "negative",
        24,
        input.rangeLow,
        "entry-quality",
      );
    }

    if (input.failedBullishBreak) {
      addEvidence(
        "balance_failed_bullish_break",
        "Failed bullish break",
        "Price failed to hold above balance and returned inside the range.",
        "negative",
        24,
        input.rangeHigh,
        "risk",
      );
    }

    if (input.failedBearishBreak) {
      addEvidence(
        "balance_failed_bearish_break",
        "Failed bearish break",
        "Price failed to hold below balance and returned inside the range.",
        "positive",
        24,
        input.rangeLow,
        "risk",
      );
    }

    if (input.chopRisk) {
      addEvidence(
        "balance_chop_risk",
        "Elevated chop risk",
        "High overlap and repeated rotation increase the risk of low-quality entries.",
        "neutral",
        20,
        true,
        "risk",
      );
    }

    if (finite(input.overlapRatio)) {
      if (input.overlapRatio >= 0.65) {
        addEvidence(
          "balance_high_overlap",
          "High candle overlap",
          "Recent candles overlap heavily, indicating balanced or choppy trade.",
          "neutral",
          14,
          input.overlapRatio,
          "risk",
        );
      } else if (input.overlapRatio <= 0.3) {
        addEvidence(
          "balance_low_overlap",
          "Low candle overlap",
          "Low overlap supports directional efficiency and imbalance.",
          aboveMidpoint ? "positive" : belowMidpoint ? "negative" : "neutral",
          10,
          input.overlapRatio,
        );
      }
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string,
      unit?: string,
      category: MarketContextMetric["category"] = "balance",
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

    if (inferredState) {
      addMetric("balance.state", "Balance state", inferredState);
    }
    if (finite(input.rangeHigh)) {
      addMetric("balance.rangeHigh", "Range high", input.rangeHigh, "price");
    }
    if (finite(input.rangeLow)) {
      addMetric("balance.rangeLow", "Range low", input.rangeLow, "price");
    }
    if (finite(inferredMidpoint)) {
      addMetric(
        "balance.midpoint",
        "Range midpoint",
        inferredMidpoint,
        "price",
      );
    }
    if (finite(inferredRangeWidth)) {
      addMetric(
        "balance.rangeWidth",
        "Range width",
        inferredRangeWidth,
        "price",
      );
    }
    if (finite(input.rangeWidthPct)) {
      addMetric(
        "balance.rangeWidthPct",
        "Range width",
        input.rangeWidthPct,
        "%",
      );
    }
    if (finite(input.valueAreaHigh)) {
      addMetric(
        "balance.valueAreaHigh",
        "Value area high",
        input.valueAreaHigh,
        "price",
      );
    }
    if (finite(input.valueAreaLow)) {
      addMetric(
        "balance.valueAreaLow",
        "Value area low",
        input.valueAreaLow,
        "price",
      );
    }
    if (finite(input.pointOfControl)) {
      addMetric(
        "balance.pointOfControl",
        "Point of control",
        input.pointOfControl,
        "price",
      );
    }
    if (finite(input.overlapRatio)) {
      addMetric(
        "balance.overlapRatio",
        "Candle overlap ratio",
        input.overlapRatio,
        "%",
      );
    }
    if (finite(input.rotationCount)) {
      addMetric(
        "balance.rotationCount",
        "Range rotations",
        input.rotationCount,
        "rotations",
      );
    }
    if (finite(input.directionalEfficiency)) {
      addMetric(
        "balance.directionalEfficiency",
        "Directional efficiency",
        input.directionalEfficiency,
        "score",
      );
    }
    if (finite(input.balanceDurationBars)) {
      addMetric(
        "balance.duration",
        "Balance duration",
        input.balanceDurationBars,
        "bars",
      );
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
      input.direction ??
      (inferredState === "bullish-imbalance" || input.bullishBreak
        ? "bullish"
        : inferredState === "bearish-imbalance" || input.bearishBreak
          ? "bearish"
          : inferredState === "balanced"
            ? "neutral"
            : directionFromSignedScore(signedImpact));

    const evidenceScore = scoreEvidence(evidence);

    const score = finite(input.score)
      ? clampScore(input.score)
      : direction === "neutral"
        ? inferredState === "balanced"
          ? 62
          : evidenceScore.score
        : clampScore(50 + Math.min(50, Math.abs(signedImpact)));

    const failedPenalty = inferredState === "failed-break" ? 12 : 0;

    const scored = buildScoredContext({
      score: Math.max(0, score - failedPenalty),
      confidence:
        input.confidence ?? evidenceScore.confidence ?? confidence,
      direction,
    });

    const reasons = evidence.map(createReason);

    const component: MarketContextComponent = {
      id: "balance",
      category: "balance",
      label: "Balance",
      summary:
        inferredState === "failed-break"
          ? "The attempted range break failed and price returned toward balance."
          : inferredState === "breaking"
            ? direction === "bullish"
              ? "Price is breaking above balance with bullish intent."
              : direction === "bearish"
                ? "Price is breaking below balance with bearish intent."
                : "Price is attempting to leave balance."
            : inferredState === "bullish-imbalance"
              ? "The auction is imbalanced upward and buyers control price discovery."
              : inferredState === "bearish-imbalance"
                ? "The auction is imbalanced downward and sellers control price discovery."
                : inferredState === "balanced"
                  ? "Price is rotating in balance; mean-reversion and chop risk are elevated."
                  : "Balance conditions are unresolved.",
      status: statusFromState(inferredState, scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "balance.score",
          label: "Balance score",
          category: "balance",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "balance",
        direction,
        inferredState ?? "",
        input.chopRisk ? "chop-risk" : "",
        input.upperAcceptance ? "upper-acceptance" : "",
        input.lowerAcceptance ? "lower-acceptance" : "",
        input.upperRejection ? "upper-rejection" : "",
        input.lowerRejection ? "lower-rejection" : "",
        input.failedBullishBreak ? "failed-bullish-break" : "",
        input.failedBearishBreak ? "failed-bearish-break" : "",
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

export default BalanceContextEvaluator;
