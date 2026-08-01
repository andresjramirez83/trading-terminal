// src/trading/intelligence/evaluators/CompressionContextEvaluator.ts

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

export type CompressionState =
  | "none"
  | "forming"
  | "active"
  | "mature"
  | "breaking"
  | "failed";

export interface CompressionContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;
  state?: CompressionState;

  active?: boolean;
  mature?: boolean;
  breaking?: boolean;
  failedBreak?: boolean;

  rangeCompression?: number;
  atrCompression?: number;
  volumeCompression?: number;
  durationBars?: number;
  breakoutPressure?: number;

  bullishBias?: boolean;
  bearishBias?: boolean;
  bullishBreakout?: boolean;
  bearishBreakout?: boolean;
  bullishReclaim?: boolean;
  bearishReclaim?: boolean;

  absoluteBreakout?: boolean;
  falseBreakRisk?: boolean;
  expandingVolume?: boolean;
  decliningVolume?: boolean;

  upperBoundary?: number;
  lowerBoundary?: number;
  midpoint?: number;
  distanceToUpperBoundary?: number;
  distanceToLowerBoundary?: number;

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

function stateValue(value: unknown): CompressionState | undefined {
  return value === "none" ||
    value === "forming" ||
    value === "active" ||
    value === "mature" ||
    value === "breaking" ||
    value === "failed"
    ? value
    : undefined;
}

function statusFromState(
  state: CompressionState | undefined,
  confidence: number,
): MarketContextStatus {
  if (state === "failed") return "invalidated";
  if (state === "forming") return "forming";
  if (state === "active" || state === "mature" || state === "breaking") {
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

function readCompressionInput(
  context: MarketContextEvaluatorContext,
): CompressionContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};
  const nestedMetadata: Record<string, unknown> = isRecord(metadata.compression)
    ? metadata.compression
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.compression)
    ? custom.compression
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`compression${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`compression${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),
    state: stateValue(read("state")),

    active: booleanValue(read("active")),
    mature: booleanValue(read("mature")),
    breaking: booleanValue(read("breaking")),
    failedBreak: booleanValue(read("failedBreak"), read("failed")),

    rangeCompression: numberValue(read("rangeCompression")),
    atrCompression: numberValue(read("atrCompression")),
    volumeCompression: numberValue(read("volumeCompression")),
    durationBars: numberValue(read("durationBars")),
    breakoutPressure: numberValue(read("breakoutPressure")),

    bullishBias: booleanValue(read("bullishBias")),
    bearishBias: booleanValue(read("bearishBias")),
    bullishBreakout: booleanValue(read("bullishBreakout")),
    bearishBreakout: booleanValue(read("bearishBreakout")),
    bullishReclaim: booleanValue(read("bullishReclaim")),
    bearishReclaim: booleanValue(read("bearishReclaim")),

    absoluteBreakout: booleanValue(
      read("absoluteBreakout"),
      read("compressionAbsBreakout"),
    ),
    falseBreakRisk: booleanValue(read("falseBreakRisk")),
    expandingVolume: booleanValue(read("expandingVolume")),
    decliningVolume: booleanValue(read("decliningVolume")),

    upperBoundary: numberValue(read("upperBoundary"), read("high")),
    lowerBoundary: numberValue(read("lowerBoundary"), read("low")),
    midpoint: numberValue(read("midpoint"), read("mid")),
    distanceToUpperBoundary: numberValue(read("distanceToUpperBoundary")),
    distanceToLowerBoundary: numberValue(read("distanceToLowerBoundary")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class CompressionContextEvaluator
  implements MarketContextEvaluator {
  readonly id = "compression";
  readonly categories = ["volatility", "entry-quality", "risk"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readCompressionInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confidence = clampConfidence(input.confidence ?? 0.65);

    const inferredState: CompressionState | undefined =
      input.failedBreak
        ? "failed"
        : input.breaking
          ? "breaking"
          : input.mature
            ? "mature"
            : input.active
              ? "active"
              : input.state;

    const addEvidence = (
      id: string,
      label: string,
      reason: string,
      polarity: EvidencePolarity,
      scoreImpact: number,
      value?: EvidenceValue,
      category: MarketContextEvidence["category"] = "volatility",
    ): void => {
      evidence.push({
        id,
        category,
        label,
        reason,
        polarity,
        severity:
          inferredState === "failed" || polarity === "negative"
            ? "warning"
            : "supporting",
        weight: 1,
        scoreImpact,
        confidence,
        value,
        source: this.id,
        timeframe: context.input.timeframe,
        timestamp: context.input.timestamp,
      });
    };

    if (
      inferredState === "forming" ||
      inferredState === "active" ||
      inferredState === "mature"
    ) {
      addEvidence(
        "compression_active",
        "Price compression",
        "Price range is contracting and stored energy may be building.",
        "neutral",
        inferredState === "mature" ? 20 : 14,
        inferredState,
      );
    }

    if (input.decliningVolume) {
      addEvidence(
        "compression_declining_volume",
        "Volume contracting",
        "Volume is declining while price compresses.",
        "neutral",
        8,
        true,
        "volume",
      );
    }

    if (input.bullishBias) {
      addEvidence(
        "compression_bullish_bias",
        "Bullish compression bias",
        "Price is compressing with bullish directional pressure.",
        "positive",
        12,
        true,
        "entry-quality",
      );
    }

    if (input.bearishBias) {
      addEvidence(
        "compression_bearish_bias",
        "Bearish compression bias",
        "Price is compressing with bearish directional pressure.",
        "negative",
        12,
        true,
        "entry-quality",
      );
    }

    if (input.bullishBreakout) {
      addEvidence(
        "compression_bullish_breakout",
        "Bullish compression breakout",
        "Price broke above the compression range.",
        "positive",
        input.absoluteBreakout ? 28 : 22,
        true,
        "entry-quality",
      );
    }

    if (input.bearishBreakout) {
      addEvidence(
        "compression_bearish_breakout",
        "Bearish compression breakout",
        "Price broke below the compression range.",
        "negative",
        input.absoluteBreakout ? 28 : 22,
        true,
        "entry-quality",
      );
    }

    if (input.expandingVolume && (input.bullishBreakout || input.bearishBreakout)) {
      addEvidence(
        "compression_volume_confirmation",
        "Breakout volume confirmation",
        "Volume expanded with the compression breakout.",
        input.bearishBreakout ? "negative" : "positive",
        14,
        true,
        "volume",
      );
    }

    if (input.bullishReclaim) {
      addEvidence(
        "compression_bullish_reclaim",
        "Bullish boundary reclaim",
        "Price reclaimed the compression boundary after a downside probe.",
        "positive",
        18,
        true,
        "entry-quality",
      );
    }

    if (input.bearishReclaim) {
      addEvidence(
        "compression_bearish_reclaim",
        "Bearish boundary reclaim",
        "Price rejected or reclaimed below the compression boundary after an upside probe.",
        "negative",
        18,
        true,
        "entry-quality",
      );
    }

    if (input.falseBreakRisk) {
      addEvidence(
        "compression_false_break_risk",
        "False-break risk",
        "The breakout lacks confirmation or remains vulnerable to returning inside the range.",
        "neutral",
        18,
        true,
        "risk",
      );
    }

    if (inferredState === "failed") {
      addEvidence(
        "compression_failed_break",
        "Compression breakout failed",
        "Price broke from compression but failed to maintain acceptance.",
        input.bullishBreakout ? "negative" : input.bearishBreakout ? "positive" : "neutral",
        24,
        true,
        "risk",
      );
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string,
      unit?: string,
      category: MarketContextMetric["category"] = "volatility",
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
      addMetric("compression.state", "Compression state", inferredState);
    }
    if (finite(input.rangeCompression)) {
      addMetric(
        "compression.range",
        "Range compression",
        input.rangeCompression,
        "%",
      );
    }
    if (finite(input.atrCompression)) {
      addMetric(
        "compression.atr",
        "ATR compression",
        input.atrCompression,
        "%",
      );
    }
    if (finite(input.volumeCompression)) {
      addMetric(
        "compression.volume",
        "Volume compression",
        input.volumeCompression,
        "%",
        "volume",
      );
    }
    if (finite(input.durationBars)) {
      addMetric(
        "compression.duration",
        "Compression duration",
        input.durationBars,
        "bars",
      );
    }
    if (finite(input.breakoutPressure)) {
      addMetric(
        "compression.breakoutPressure",
        "Breakout pressure",
        input.breakoutPressure,
        "score",
      );
    }
    if (finite(input.upperBoundary)) {
      addMetric(
        "compression.upperBoundary",
        "Compression upper boundary",
        input.upperBoundary,
        "price",
      );
    }
    if (finite(input.lowerBoundary)) {
      addMetric(
        "compression.lowerBoundary",
        "Compression lower boundary",
        input.lowerBoundary,
        "price",
      );
    }
    if (finite(input.midpoint)) {
      addMetric(
        "compression.midpoint",
        "Compression midpoint",
        input.midpoint,
        "price",
      );
    }
    if (finite(input.distanceToUpperBoundary)) {
      addMetric(
        "compression.distanceToUpper",
        "Distance to upper boundary",
        input.distanceToUpperBoundary,
        "price",
      );
    }
    if (finite(input.distanceToLowerBoundary)) {
      addMetric(
        "compression.distanceToLower",
        "Distance to lower boundary",
        input.distanceToLowerBoundary,
        "price",
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
      (input.bullishBreakout || input.bullishBias || input.bullishReclaim
        ? "bullish"
        : input.bearishBreakout || input.bearishBias || input.bearishReclaim
          ? "bearish"
          : directionFromSignedScore(signedImpact));

    const evidenceScore = scoreEvidence(evidence);

    const score = finite(input.score)
      ? clampScore(input.score)
      : direction === "neutral"
        ? evidenceScore.score
        : clampScore(50 + Math.min(50, Math.abs(signedImpact)));

    const failedPenalty = inferredState === "failed" ? 15 : 0;

    const scored = buildScoredContext({
      score: Math.max(0, score - failedPenalty),
      confidence:
        input.confidence ?? evidenceScore.confidence ?? confidence,
      direction,
    });

    const reasons = evidence.map(createReason);

    const component: MarketContextComponent = {
      id: "compression",
      category: "volatility",
      label: "Compression",
      summary:
        inferredState === "failed"
          ? "The compression breakout failed and reversal risk is elevated."
          : inferredState === "breaking"
            ? direction === "bullish"
              ? "Compression is resolving upward."
              : direction === "bearish"
                ? "Compression is resolving downward."
                : "Compression is beginning to resolve."
            : inferredState === "mature"
              ? "Compression is mature and breakout potential is elevated."
              : inferredState === "active" || inferredState === "forming"
                ? "Price is compressing and building potential energy."
                : "No meaningful compression condition is active.",
      status: statusFromState(inferredState, scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "compression.score",
          label: "Compression score",
          category: "volatility",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "compression",
        direction,
        inferredState ?? "",
        input.absoluteBreakout ? "absolute-breakout" : "",
        input.falseBreakRisk ? "false-break-risk" : "",
        input.expandingVolume ? "volume-expansion" : "",
        input.decliningVolume ? "volume-contraction" : "",
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

export default CompressionContextEvaluator;
