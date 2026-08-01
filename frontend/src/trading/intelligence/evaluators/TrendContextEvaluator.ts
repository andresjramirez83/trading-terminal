// src/trading/intelligence/evaluators/TrendContextEvaluator.ts

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

export type TrendState =
  | "strong"
  | "healthy"
  | "weak"
  | "transitioning"
  | "range"
  | "failed"
  | "unknown";

export interface TrendContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;
  state?: TrendState;

  emaFast?: number;
  emaMedium?: number;
  emaSlow?: number;
  smaFast?: number;
  smaSlow?: number;

  fastSlope?: number;
  mediumSlope?: number;
  slowSlope?: number;

  alignedBullish?: boolean;
  alignedBearish?: boolean;
  priceAboveFast?: boolean;
  priceAboveMedium?: boolean;
  priceAboveSlow?: boolean;
  priceBelowFast?: boolean;
  priceBelowMedium?: boolean;
  priceBelowSlow?: boolean;

  higherHighs?: boolean;
  higherLows?: boolean;
  lowerHighs?: boolean;
  lowerLows?: boolean;

  pullbackHealthy?: boolean;
  pullbackTooDeep?: boolean;
  trendResumed?: boolean;
  trendFailed?: boolean;
  reclaimTrend?: boolean;
  lostTrend?: boolean;

  adx?: number;
  trendStrength?: number;
  distanceFromFastAverage?: number;
  distanceFromSlowAverage?: number;
  barsInTrend?: number;

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

function stateValue(value: unknown): TrendState | undefined {
  return value === "strong" ||
    value === "healthy" ||
    value === "weak" ||
    value === "transitioning" ||
    value === "range" ||
    value === "failed" ||
    value === "unknown"
    ? value
    : undefined;
}

function statusFromState(
  state: TrendState | undefined,
  confidence: number,
): MarketContextStatus {
  if (state === "failed") return "invalidated";
  if (state === "transitioning" || state === "weak") return "forming";
  if (state === "strong" || state === "healthy") {
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

function readTrendInput(
  context: MarketContextEvaluatorContext,
): TrendContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};
  const nestedMetadata: Record<string, unknown> = isRecord(metadata.trend)
    ? metadata.trend
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.trend)
    ? custom.trend
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`trend${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`trend${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(
      read("direction"),
    ) ?? context.input.structure.direction ?? context.input.structure.trend,
    score: numberValue(
      read("score"),
      context.input.structure.score,
      context.input.indicators.trendStrengthScore,
    ),
    confidence: numberValue(
      read("confidence"),
      context.input.structure.confidence,
    ),
    state: stateValue(read("state")),

    emaFast: numberValue(
      read("emaFast"),
      context.input.indicators.ema9,
    ),
    emaMedium: numberValue(
      read("emaMedium"),
      context.input.indicators.ema20,
    ),
    emaSlow: numberValue(
      read("emaSlow"),
      context.input.indicators.ema50,
      context.input.indicators.ema200,
    ),
    smaFast: numberValue(read("smaFast")),
    smaSlow: numberValue(read("smaSlow")),

    fastSlope: numberValue(read("fastSlope")),
    mediumSlope: numberValue(read("mediumSlope")),
    slowSlope: numberValue(read("slowSlope")),

    alignedBullish: booleanValue(read("alignedBullish")),
    alignedBearish: booleanValue(read("alignedBearish")),
    priceAboveFast: booleanValue(read("priceAboveFast")),
    priceAboveMedium: booleanValue(read("priceAboveMedium")),
    priceAboveSlow: booleanValue(read("priceAboveSlow")),
    priceBelowFast: booleanValue(read("priceBelowFast")),
    priceBelowMedium: booleanValue(read("priceBelowMedium")),
    priceBelowSlow: booleanValue(read("priceBelowSlow")),

    higherHighs: booleanValue(
      read("higherHighs"),
      context.input.structure.higherHighs,
    ),
    higherLows: booleanValue(
      read("higherLows"),
      context.input.structure.higherLows,
    ),
    lowerHighs: booleanValue(
      read("lowerHighs"),
      context.input.structure.lowerHighs,
    ),
    lowerLows: booleanValue(
      read("lowerLows"),
      context.input.structure.lowerLows,
    ),

    pullbackHealthy: booleanValue(read("pullbackHealthy")),
    pullbackTooDeep: booleanValue(read("pullbackTooDeep")),
    trendResumed: booleanValue(read("trendResumed")),
    trendFailed: booleanValue(read("trendFailed")),
    reclaimTrend: booleanValue(read("reclaimTrend")),
    lostTrend: booleanValue(read("lostTrend")),

    adx: numberValue(read("adx"), context.input.indicators.adx),
    trendStrength: numberValue(read("trendStrength")),
    distanceFromFastAverage: numberValue(read("distanceFromFastAverage")),
    distanceFromSlowAverage: numberValue(read("distanceFromSlowAverage")),
    barsInTrend: numberValue(read("barsInTrend")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class TrendContextEvaluator implements MarketContextEvaluator {
  readonly id = "trend";
  readonly categories = ["trend", "structure", "risk"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readTrendInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confirmedBullishStructure =
      input.higherHighs === true && input.higherLows === true;
    const confirmedBearishStructure =
      input.lowerHighs === true && input.lowerLows === true;

    const structureConfirmed =
      confirmedBullishStructure || confirmedBearishStructure;

    const confidence = clampConfidence(
      input.confidence ?? (structureConfirmed ? 0.82 : 0.65),
    );
    const price =
      context.input.price.last ??
      context.input.price.close ??
      0;

    const addEvidence = (
      id: string,
      label: string,
      reason: string,
      polarity: EvidencePolarity,
      scoreImpact: number,
      value?: EvidenceValue,
      category: MarketContextEvidence["category"] = "trend",
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

    const bullishAlignment =
      input.alignedBullish ||
      (finite(input.emaFast) &&
        finite(input.emaMedium) &&
        finite(input.emaSlow) &&
        input.emaFast > input.emaMedium &&
        input.emaMedium > input.emaSlow);

    const bearishAlignment =
      input.alignedBearish ||
      (finite(input.emaFast) &&
        finite(input.emaMedium) &&
        finite(input.emaSlow) &&
        input.emaFast < input.emaMedium &&
        input.emaMedium < input.emaSlow);

    if (bullishAlignment) {
      addEvidence(
        "trend_bullish_alignment",
        "Bullish average alignment",
        "Fast, medium, and slow averages are aligned bullishly.",
        "positive",
        20,
        true,
      );
    }

    if (bearishAlignment) {
      addEvidence(
        "trend_bearish_alignment",
        "Bearish average alignment",
        "Fast, medium, and slow averages are aligned bearishly.",
        "negative",
        20,
        true,
      );
    }

    const priceAboveFast =
      input.priceAboveFast ||
      (finite(input.emaFast) && price > input.emaFast);
    const priceAboveMedium =
      input.priceAboveMedium ||
      (finite(input.emaMedium) && price > input.emaMedium);
    const priceAboveSlow =
      input.priceAboveSlow ||
      (finite(input.emaSlow) && price > input.emaSlow);

    const priceBelowFast =
      input.priceBelowFast ||
      (finite(input.emaFast) && price < input.emaFast);
    const priceBelowMedium =
      input.priceBelowMedium ||
      (finite(input.emaMedium) && price < input.emaMedium);
    const priceBelowSlow =
      input.priceBelowSlow ||
      (finite(input.emaSlow) && price < input.emaSlow);

    if (priceAboveFast && priceAboveMedium && priceAboveSlow) {
      addEvidence(
        "trend_price_above_averages",
        "Price above trend averages",
        "Price is trading above the fast, medium, and slow trend averages.",
        "positive",
        16,
        price,
      );
    }

    if (priceBelowFast && priceBelowMedium && priceBelowSlow) {
      addEvidence(
        "trend_price_below_averages",
        "Price below trend averages",
        "Price is trading below the fast, medium, and slow trend averages.",
        "negative",
        16,
        price,
      );
    }

    const positiveSlopes = [
      input.fastSlope,
      input.mediumSlope,
      input.slowSlope,
    ].filter(finite).filter((value) => value > 0).length;

    const negativeSlopes = [
      input.fastSlope,
      input.mediumSlope,
      input.slowSlope,
    ].filter(finite).filter((value) => value < 0).length;

    if (positiveSlopes >= 2) {
      addEvidence(
        "trend_positive_slopes",
        "Trend slopes rising",
        "Multiple trend averages are sloping upward.",
        "positive",
        14,
        positiveSlopes,
      );
    }

    if (negativeSlopes >= 2) {
      addEvidence(
        "trend_negative_slopes",
        "Trend slopes falling",
        "Multiple trend averages are sloping downward.",
        "negative",
        14,
        negativeSlopes,
      );
    }

    if (input.higherHighs && input.higherLows) {
      addEvidence(
        "trend_higher_highs_lows",
        "Higher highs and higher lows",
        "Price structure is advancing in a confirmed bullish HH/HL sequence.",
        "positive",
        34,
        true,
        "structure",
      );
    }

    if (input.lowerHighs && input.lowerLows) {
      addEvidence(
        "trend_lower_highs_lows",
        "Lower highs and lower lows",
        "Price structure is declining in a confirmed bearish LL/LH sequence.",
        "negative",
        34,
        true,
        "structure",
      );
    }

    if (input.pullbackHealthy) {
      addEvidence(
        "trend_healthy_pullback",
        "Healthy pullback",
        "The pullback remains controlled and consistent with trend continuation.",
        input.direction === "bearish" ? "negative" : "positive",
        16,
        true,
        "entry-quality",
      );
    }

    if (input.pullbackTooDeep) {
      addEvidence(
        "trend_deep_pullback",
        "Deep pullback",
        "The pullback is deep enough to weaken trend quality.",
        "neutral",
        16,
        true,
        "risk",
      );
    }

    if (input.trendResumed || input.reclaimTrend) {
      addEvidence(
        "trend_resumed",
        "Trend resumed",
        "Price reclaimed trend support and resumed directional movement.",
        input.direction === "bearish" ? "negative" : "positive",
        22,
        true,
        "entry-quality",
      );
    }

    if (input.trendFailed || input.lostTrend) {
      addEvidence(
        "trend_failed",
        "Trend failure",
        "Price lost the trend structure or failed to maintain directional acceptance.",
        input.direction === "bearish" ? "positive" : "negative",
        24,
        true,
        "risk",
      );
    }

    if (finite(input.adx)) {
      if (input.adx >= 25) {
        addEvidence(
          "trend_adx_strong",
          "Strong ADX",
          "ADX indicates a meaningful directional trend.",
          input.direction === "bearish" ? "negative" : input.direction === "bullish" ? "positive" : "neutral",
          12,
          input.adx,
        );
      } else if (input.adx < 20) {
        addEvidence(
          "trend_adx_weak",
          "Weak ADX",
          "ADX indicates weak trend strength or range conditions.",
          "neutral",
          10,
          input.adx,
          "risk",
        );
      }
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string,
      unit?: string,
      category: MarketContextMetric["category"] = "trend",
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

    if (input.state) {
      addMetric("trend.state", "Trend state", input.state);
    }
    if (finite(input.emaFast)) {
      addMetric("trend.emaFast", "Fast EMA", input.emaFast, "price");
    }
    if (finite(input.emaMedium)) {
      addMetric("trend.emaMedium", "Medium EMA", input.emaMedium, "price");
    }
    if (finite(input.emaSlow)) {
      addMetric("trend.emaSlow", "Slow EMA", input.emaSlow, "price");
    }
    if (finite(input.smaFast)) {
      addMetric("trend.smaFast", "Fast SMA", input.smaFast, "price");
    }
    if (finite(input.smaSlow)) {
      addMetric("trend.smaSlow", "Slow SMA", input.smaSlow, "price");
    }
    if (finite(input.fastSlope)) {
      addMetric("trend.fastSlope", "Fast average slope", input.fastSlope);
    }
    if (finite(input.mediumSlope)) {
      addMetric(
        "trend.mediumSlope",
        "Medium average slope",
        input.mediumSlope,
      );
    }
    if (finite(input.slowSlope)) {
      addMetric("trend.slowSlope", "Slow average slope", input.slowSlope);
    }
    if (finite(input.adx)) {
      addMetric("trend.adx", "ADX", input.adx);
    }
    if (finite(input.trendStrength)) {
      addMetric(
        "trend.strength",
        "Trend strength",
        input.trendStrength,
        "score",
      );
    }
    if (finite(input.distanceFromFastAverage)) {
      addMetric(
        "trend.distanceFromFast",
        "Distance from fast average",
        input.distanceFromFastAverage,
        "price",
      );
    }
    if (finite(input.distanceFromSlowAverage)) {
      addMetric(
        "trend.distanceFromSlow",
        "Distance from slow average",
        input.distanceFromSlowAverage,
        "price",
      );
    }
    if (finite(input.barsInTrend)) {
      addMetric(
        "trend.barsInTrend",
        "Bars in trend",
        input.barsInTrend,
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

    /**
     * Confirmed market structure is the directional authority.
     * Averages, VWAP, slopes, and momentum can strengthen or weaken trend
     * quality, but they do not reverse a confirmed HH/HL or LL/LH sequence.
     */
    const structureDirection: MarketContextDirection =
      confirmedBullishStructure
        ? "bullish"
        : confirmedBearishStructure
          ? "bearish"
          : "neutral";

    const direction =
      structureDirection !== "neutral"
        ? structureDirection
        : input.direction ??
          (bullishAlignment
            ? "bullish"
            : bearishAlignment
              ? "bearish"
              : directionFromSignedScore(signedImpact));

    const evidenceScore = scoreEvidence(evidence);

    const directionalAgreement =
      direction === "bullish"
        ? signedImpact
        : direction === "bearish"
          ? -signedImpact
          : 0;

    const structureBaseScore =
      structureDirection !== "neutral"
        ? clampScore(
            Math.max(
              68,
              input.score ?? 0,
              68 + Math.min(22, Math.max(0, directionalAgreement) * 0.25),
            ),
          )
        : undefined;

    const score = finite(structureBaseScore)
      ? structureBaseScore
      : finite(input.score)
        ? clampScore(input.score)
        : direction === "neutral"
          ? evidenceScore.score
          : clampScore(50 + Math.min(50, Math.abs(signedImpact)));

    const statePenalty =
      input.state === "failed"
        ? 18
        : input.state === "weak"
          ? 10
          : input.state === "transitioning"
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
      id: "trend",
      category: "trend",
      label: "Trend",
      summary:
        input.state === "failed"
          ? "The active trend has failed or lost acceptance."
          : input.state === "transitioning"
            ? "Trend conditions are transitioning and require confirmation."
            : input.state === "weak"
              ? "Trend direction exists but strength is weak."
              : direction === "bullish"
                ? "Trend conditions favor bullish continuation."
                : direction === "bearish"
                  ? "Trend conditions favor bearish continuation."
                  : "Trend conditions are neutral or range-bound.",
      status: structureConfirmed
        ? "confirmed"
        : statusFromState(input.state, scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "trend.score",
          label: "Trend score",
          category: "trend",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "trend",
        direction,
        input.state ?? "",
        bullishAlignment ? "bullish-alignment" : "",
        bearishAlignment ? "bearish-alignment" : "",
        input.pullbackHealthy ? "healthy-pullback" : "",
        input.pullbackTooDeep ? "deep-pullback" : "",
        input.trendResumed ? "trend-resumed" : "",
        input.trendFailed ? "trend-failed" : "",
        confirmedBullishStructure ? "confirmed-hh-hl" : "",
        confirmedBearishStructure ? "confirmed-ll-lh" : "",
        structureConfirmed ? "structure-authoritative" : "",
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

export default TrendContextEvaluator;
