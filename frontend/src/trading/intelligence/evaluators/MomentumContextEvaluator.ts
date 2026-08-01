// src/trading/intelligence/evaluators/MomentumContextEvaluator.ts

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

export type MomentumState =
  | "accelerating"
  | "steady"
  | "decelerating"
  | "exhausted"
  | "mixed"
  | "unknown";

export interface MomentumContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;
  state?: MomentumState;

  rsi?: number;
  rsiSlope?: number;
  macdHistogram?: number;
  macdHistogramSlope?: number;
  rateOfChange?: number;
  relativeVolume?: number;

  bullishDivergence?: boolean;
  bearishDivergence?: boolean;
  bullishExpansion?: boolean;
  bearishExpansion?: boolean;
  bullishExhaustion?: boolean;
  bearishExhaustion?: boolean;

  consecutiveBullBars?: number;
  consecutiveBearBars?: number;
  averageBodyExpansion?: number;
  closeLocationValue?: number;
  impulseStrength?: number;
  continuationPressure?: number;
  reversalPressure?: number;

  overbought?: boolean;
  oversold?: boolean;
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

function stateValue(value: unknown): MomentumState | undefined {
  return value === "accelerating" ||
    value === "steady" ||
    value === "decelerating" ||
    value === "exhausted" ||
    value === "mixed" ||
    value === "unknown"
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

function readMomentumInput(
  context: MarketContextEvaluatorContext,
): MomentumContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};
  const nestedMetadata: Record<string, unknown> = isRecord(metadata.momentum)
    ? metadata.momentum
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.momentum)
    ? custom.momentum
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`momentum${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`momentum${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),
    state: stateValue(read("state")),

    rsi: numberValue(read("rsi"), context.input.indicators.rsi),
    rsiSlope: numberValue(read("rsiSlope")),
    macdHistogram: numberValue(
      read("macdHistogram"),
      context.input.indicators.macdHistogram,
    ),
    macdHistogramSlope: numberValue(read("macdHistogramSlope")),
    rateOfChange: numberValue(
      read("rateOfChange"),
      read("roc"),
      context.input.indicators.roc,
    ),
    relativeVolume: numberValue(
      read("relativeVolume"),
      read("rvol"),
      context.input.indicators.relativeVolume,
    ),

    bullishDivergence: booleanValue(read("bullishDivergence")),
    bearishDivergence: booleanValue(read("bearishDivergence")),
    bullishExpansion: booleanValue(read("bullishExpansion")),
    bearishExpansion: booleanValue(read("bearishExpansion")),
    bullishExhaustion: booleanValue(read("bullishExhaustion")),
    bearishExhaustion: booleanValue(read("bearishExhaustion")),

    consecutiveBullBars: numberValue(read("consecutiveBullBars")),
    consecutiveBearBars: numberValue(read("consecutiveBearBars")),
    averageBodyExpansion: numberValue(read("averageBodyExpansion")),
    closeLocationValue: numberValue(
      read("closeLocationValue"),
      read("clv"),
    ),
    impulseStrength: numberValue(read("impulseStrength")),
    continuationPressure: numberValue(read("continuationPressure")),
    reversalPressure: numberValue(read("reversalPressure")),

    overbought: booleanValue(read("overbought")),
    oversold: booleanValue(read("oversold")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class MomentumContextEvaluator implements MarketContextEvaluator {
  readonly id = "momentum";
  readonly categories = ["momentum", "entry-quality", "risk"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readMomentumInput(context);
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
      category: MarketContextEvidence["category"] = "momentum",
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

    if (finite(input.rsi)) {
      if (input.rsi >= 55 && input.rsi < 70) {
        addEvidence(
          "momentum_rsi_bullish",
          "Bullish RSI",
          "RSI is above its neutral zone and supports bullish momentum.",
          "positive",
          10,
          input.rsi,
        );
      } else if (input.rsi <= 45 && input.rsi > 30) {
        addEvidence(
          "momentum_rsi_bearish",
          "Bearish RSI",
          "RSI is below its neutral zone and supports bearish momentum.",
          "negative",
          10,
          input.rsi,
        );
      }
    }

    if (input.overbought || (finite(input.rsi) && input.rsi >= 70)) {
      addEvidence(
        "momentum_overbought",
        "Overbought momentum",
        "Momentum is extended to the upside and continuation risk is increasing.",
        "neutral",
        12,
        input.rsi ?? true,
        "risk",
      );
    }

    if (input.oversold || (finite(input.rsi) && input.rsi <= 30)) {
      addEvidence(
        "momentum_oversold",
        "Oversold momentum",
        "Momentum is extended to the downside and reversal risk is increasing.",
        "neutral",
        12,
        input.rsi ?? true,
        "risk",
      );
    }

    if (finite(input.rsiSlope)) {
      if (input.rsiSlope > 0) {
        addEvidence(
          "momentum_rsi_rising",
          "RSI rising",
          "RSI is increasing and momentum is improving.",
          "positive",
          8,
          input.rsiSlope,
        );
      } else if (input.rsiSlope < 0) {
        addEvidence(
          "momentum_rsi_falling",
          "RSI falling",
          "RSI is decreasing and momentum is weakening.",
          "negative",
          8,
          input.rsiSlope,
        );
      }
    }

    if (finite(input.macdHistogram)) {
      if (input.macdHistogram > 0) {
        addEvidence(
          "momentum_macd_positive",
          "Positive MACD momentum",
          "MACD histogram is above zero.",
          "positive",
          9,
          input.macdHistogram,
        );
      } else if (input.macdHistogram < 0) {
        addEvidence(
          "momentum_macd_negative",
          "Negative MACD momentum",
          "MACD histogram is below zero.",
          "negative",
          9,
          input.macdHistogram,
        );
      }
    }

    if (finite(input.macdHistogramSlope)) {
      if (input.macdHistogramSlope > 0) {
        addEvidence(
          "momentum_macd_accelerating",
          "MACD momentum accelerating",
          "MACD histogram is expanding upward.",
          "positive",
          10,
          input.macdHistogramSlope,
        );
      } else if (input.macdHistogramSlope < 0) {
        addEvidence(
          "momentum_macd_decelerating",
          "MACD momentum weakening",
          "MACD histogram is contracting or expanding downward.",
          "negative",
          10,
          input.macdHistogramSlope,
        );
      }
    }

    if (finite(input.rateOfChange)) {
      if (input.rateOfChange > 0) {
        addEvidence(
          "momentum_roc_positive",
          "Positive rate of change",
          "Price rate of change is positive.",
          "positive",
          8,
          input.rateOfChange,
        );
      } else if (input.rateOfChange < 0) {
        addEvidence(
          "momentum_roc_negative",
          "Negative rate of change",
          "Price rate of change is negative.",
          "negative",
          8,
          input.rateOfChange,
        );
      }
    }

    if (input.bullishExpansion) {
      addEvidence(
        "momentum_bullish_expansion",
        "Bullish expansion",
        "Bullish candles are expanding with directional pressure.",
        "positive",
        20,
        true,
        "entry-quality",
      );
    }

    if (input.bearishExpansion) {
      addEvidence(
        "momentum_bearish_expansion",
        "Bearish expansion",
        "Bearish candles are expanding with directional pressure.",
        "negative",
        20,
        true,
        "entry-quality",
      );
    }

    if (input.bullishDivergence) {
      addEvidence(
        "momentum_bullish_divergence",
        "Bullish divergence",
        "Price and momentum are diverging in a way that may support an upside reversal.",
        "positive",
        18,
        true,
        "entry-quality",
      );
    }

    if (input.bearishDivergence) {
      addEvidence(
        "momentum_bearish_divergence",
        "Bearish divergence",
        "Price and momentum are diverging in a way that may support a downside reversal.",
        "negative",
        18,
        true,
        "entry-quality",
      );
    }

    if (input.bullishExhaustion) {
      addEvidence(
        "momentum_bullish_exhaustion",
        "Bullish exhaustion",
        "Upside momentum is losing force and may be vulnerable to reversal.",
        "negative",
        16,
        true,
        "risk",
      );
    }

    if (input.bearishExhaustion) {
      addEvidence(
        "momentum_bearish_exhaustion",
        "Bearish exhaustion",
        "Downside momentum is losing force and may be vulnerable to reversal.",
        "positive",
        16,
        true,
        "risk",
      );
    }

    if (finite(input.continuationPressure)) {
      const polarity: EvidencePolarity =
        input.direction === "bearish" ? "negative" : "positive";

      addEvidence(
        "momentum_continuation_pressure",
        "Continuation pressure",
        "Momentum supports continuation in the current directional move.",
        polarity,
        Math.min(20, Math.abs(input.continuationPressure)),
        input.continuationPressure,
      );
    }

    if (finite(input.reversalPressure) && input.reversalPressure > 0) {
      addEvidence(
        "momentum_reversal_pressure",
        "Reversal pressure",
        "Momentum conditions indicate elevated reversal pressure.",
        "neutral",
        Math.min(20, input.reversalPressure),
        input.reversalPressure,
        "risk",
      );
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string,
      unit?: string,
      category: MarketContextMetric["category"] = "momentum",
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

    if (finite(input.rsi)) addMetric("momentum.rsi", "RSI", input.rsi);
    if (finite(input.rsiSlope)) {
      addMetric("momentum.rsiSlope", "RSI slope", input.rsiSlope);
    }
    if (finite(input.macdHistogram)) {
      addMetric(
        "momentum.macdHistogram",
        "MACD histogram",
        input.macdHistogram,
      );
    }
    if (finite(input.macdHistogramSlope)) {
      addMetric(
        "momentum.macdHistogramSlope",
        "MACD histogram slope",
        input.macdHistogramSlope,
      );
    }
    if (finite(input.rateOfChange)) {
      addMetric("momentum.roc", "Rate of change", input.rateOfChange, "%");
    }
    if (finite(input.relativeVolume)) {
      addMetric(
        "momentum.relativeVolume",
        "Relative volume",
        input.relativeVolume,
        "x",
        "volume",
      );
    }
    if (finite(input.consecutiveBullBars)) {
      addMetric(
        "momentum.consecutiveBullBars",
        "Consecutive bullish bars",
        input.consecutiveBullBars,
        "bars",
      );
    }
    if (finite(input.consecutiveBearBars)) {
      addMetric(
        "momentum.consecutiveBearBars",
        "Consecutive bearish bars",
        input.consecutiveBearBars,
        "bars",
      );
    }
    if (finite(input.averageBodyExpansion)) {
      addMetric(
        "momentum.bodyExpansion",
        "Average body expansion",
        input.averageBodyExpansion,
        "x",
      );
    }
    if (finite(input.closeLocationValue)) {
      addMetric(
        "momentum.closeLocationValue",
        "Close location value",
        input.closeLocationValue,
      );
    }
    if (finite(input.impulseStrength)) {
      addMetric(
        "momentum.impulseStrength",
        "Impulse strength",
        input.impulseStrength,
        "score",
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
      input.direction ?? directionFromSignedScore(signedImpact);

    const evidenceScore = scoreEvidence(evidence);

    const score = finite(input.score)
      ? clampScore(input.score)
      : direction === "neutral"
        ? evidenceScore.score
        : clampScore(50 + Math.min(50, Math.abs(signedImpact)));

    const statePenalty =
      input.state === "exhausted"
        ? 12
        : input.state === "decelerating"
          ? 6
          : 0;

    const scored = buildScoredContext({
      score: Math.max(0, score - statePenalty),
      confidence:
        input.confidence ?? evidenceScore.confidence ?? confidence,
      direction,
    });

    const reasons = evidence.map(createReason);

    const component: MarketContextComponent = {
      id: "momentum",
      category: "momentum",
      label: "Momentum",
      summary:
        input.state === "exhausted"
          ? "Momentum is exhausted and reversal risk is elevated."
          : input.state === "decelerating"
            ? "Momentum remains directional but is losing force."
            : direction === "bullish"
              ? "Momentum favors bullish continuation."
              : direction === "bearish"
                ? "Momentum favors bearish continuation."
                : "Momentum is mixed or unresolved.",
      status: statusFromConfidence(scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "momentum.score",
          label: "Momentum score",
          category: "momentum",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "momentum",
        direction,
        input.state ?? "",
        input.bullishDivergence ? "bullish-divergence" : "",
        input.bearishDivergence ? "bearish-divergence" : "",
        input.bullishExpansion ? "bullish-expansion" : "",
        input.bearishExpansion ? "bearish-expansion" : "",
        input.bullishExhaustion ? "bullish-exhaustion" : "",
        input.bearishExhaustion ? "bearish-exhaustion" : "",
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

export default MomentumContextEvaluator;
