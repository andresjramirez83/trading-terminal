// src/trading/intelligence/evaluators/FairValueGapContextEvaluator.ts

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

export type FairValueGapDirection = "bullish" | "bearish";
export type FairValueGapState =
  | "forming"
  | "active"
  | "retested"
  | "partially-filled"
  | "filled"
  | "flipped"
  | "invalidated";

export interface FairValueGapContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;

  gapDirection?: FairValueGapDirection;
  state?: FairValueGapState;
  active?: boolean;
  validated?: boolean;
  reclaimed?: boolean;
  retested?: boolean;
  partiallyFilled?: boolean;
  filled?: boolean;
  flipped?: boolean;
  invalidated?: boolean;

  top?: number;
  bottom?: number;
  midpoint?: number;
  entryPrice?: number;
  invalidationPrice?: number;
  distanceToGap?: number;
  distanceToMidpoint?: number;
  gapSize?: number;
  gapSizeAtr?: number;
  displacementAtr?: number;
  ageBars?: number;

  rank?: "A" | "B" | "C";
  isNewest?: boolean;
  isHigherTimeframe?: boolean;
  originTimeframe?: string;
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

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function directionValue(value: unknown): MarketContextDirection | undefined {
  return value === "bullish" || value === "bearish" || value === "neutral"
    ? value
    : undefined;
}

function gapDirectionValue(value: unknown): FairValueGapDirection | undefined {
  return value === "bullish" || value === "bearish" ? value : undefined;
}

function stateValue(value: unknown): FairValueGapState | undefined {
  return value === "forming" ||
    value === "active" ||
    value === "retested" ||
    value === "partially-filled" ||
    value === "filled" ||
    value === "flipped" ||
    value === "invalidated"
    ? value
    : undefined;
}

function rankValue(value: unknown): "A" | "B" | "C" | undefined {
  return value === "A" || value === "B" || value === "C"
    ? value
    : undefined;
}

function statusFromState(
  state: FairValueGapState | undefined,
  confidence: number,
): MarketContextStatus {
  if (state === "invalidated" || state === "filled") return "invalidated";
  if (state === "forming") return "forming";
  if (state === "active" || state === "retested" || state === "flipped") {
    return confidence >= 0.7 ? "confirmed" : "forming";
  }
  return confidence >= 0.7 ? "confirmed" : "pending";
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

function readFairValueGapInput(
  context: MarketContextEvaluatorContext,
): FairValueGapContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const fvg = isRecord(metadata.fairValueGap)
    ? metadata.fairValueGap
    : isRecord(metadata.fvg)
      ? metadata.fvg
      : {};

  const custom = context.input.indicators.custom ?? {};

  const read = (key: string): unknown =>
    fvg[key] ??
    metadata[`fvg${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`fvg${key.charAt(0).toUpperCase()}${key.slice(1)}`];

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),

    gapDirection: gapDirectionValue(
      read("gapDirection") ?? read("type") ?? read("side"),
    ),
    state: stateValue(read("state")),
    active: booleanValue(read("active")),
    validated: booleanValue(read("validated"), read("confirmed")),
    reclaimed: booleanValue(read("reclaimed")),
    retested: booleanValue(read("retested")),
    partiallyFilled: booleanValue(
      read("partiallyFilled"),
      read("partialFill"),
    ),
    filled: booleanValue(read("filled"), read("mitigated")),
    flipped: booleanValue(read("flipped"), read("inverted"), read("ifvg")),
    invalidated: booleanValue(read("invalidated")),

    top: numberValue(read("top"), read("upper")),
    bottom: numberValue(read("bottom"), read("lower")),
    midpoint: numberValue(read("midpoint"), read("mid")),
    entryPrice: numberValue(read("entryPrice"), read("entry")),
    invalidationPrice: numberValue(
      read("invalidationPrice"),
      read("stop"),
    ),
    distanceToGap: numberValue(read("distanceToGap")),
    distanceToMidpoint: numberValue(read("distanceToMidpoint")),
    gapSize: numberValue(read("gapSize"), read("size")),
    gapSizeAtr: numberValue(read("gapSizeAtr"), read("sizeAtr")),
    displacementAtr: numberValue(
      read("displacementAtr"),
      read("displacement"),
    ),
    ageBars: numberValue(read("ageBars")),

    rank: rankValue(read("rank")),
    isNewest: booleanValue(read("isNewest"), read("newest")),
    isHigherTimeframe: booleanValue(
      read("isHigherTimeframe"),
      read("higherTimeframe"),
    ),
    originTimeframe: stringValue(read("originTimeframe")),
    metadata: fvg,
  };
}

export class FairValueGapContextEvaluator
  implements MarketContextEvaluator {
  readonly id = "fair-value-gap";
  readonly categories = ["location", "liquidity", "entry-quality"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readFairValueGapInput(context);
    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const confidence = clampConfidence(input.confidence ?? 0.65);

    const gapDirection = input.gapDirection;
    const inferredState: FairValueGapState | undefined =
      input.invalidated
        ? "invalidated"
        : input.filled
          ? "filled"
          : input.flipped
            ? "flipped"
            : input.retested
              ? "retested"
              : input.partiallyFilled
                ? "partially-filled"
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
      category: MarketContextEvidence["category"] = "location",
    ): void => {
      evidence.push({
        id,
        category,
        label,
        reason,
        polarity,
        severity:
          inferredState === "invalidated"
            ? "warning"
            : polarity === "negative"
              ? "warning"
              : "supporting",
        weight: input.isHigherTimeframe ? 1.25 : 1,
        scoreImpact,
        confidence,
        value,
        source: this.id,
        timeframe: input.originTimeframe ?? context.input.timeframe,
        timestamp: context.input.timestamp,
      });
    };

    if (gapDirection === "bullish") {
      addEvidence(
        "fvg_bullish",
        "Bullish fair value gap",
        "A bullish imbalance is present below or around current price.",
        "positive",
        14,
        true,
      );
    }

    if (gapDirection === "bearish") {
      addEvidence(
        "fvg_bearish",
        "Bearish fair value gap",
        "A bearish imbalance is present above or around current price.",
        "negative",
        14,
        true,
      );
    }

    if (input.validated || input.reclaimed) {
      addEvidence(
        "fvg_validated",
        "FVG validated",
        gapDirection === "bearish"
          ? "Price validated bearish imbalance behavior."
          : "Price validated bullish imbalance behavior.",
        gapDirection === "bearish" ? "negative" : "positive",
        18,
        true,
        "entry-quality",
      );
    }

    if (inferredState === "retested") {
      addEvidence(
        "fvg_retested",
        "FVG retest",
        "Price returned to the imbalance and respected the zone.",
        gapDirection === "bearish" ? "negative" : "positive",
        22,
        true,
        "entry-quality",
      );
    }

    if (inferredState === "partially-filled") {
      addEvidence(
        "fvg_partial_fill",
        "FVG partially filled",
        "Price partially mitigated the imbalance while the zone remains active.",
        "neutral",
        8,
        true,
      );
    }

    if (inferredState === "filled") {
      addEvidence(
        "fvg_filled",
        "FVG filled",
        "The imbalance has been fully mitigated and should no longer be treated as active.",
        "neutral",
        20,
        true,
      );
    }

    if (inferredState === "flipped") {
      addEvidence(
        "fvg_flipped",
        "Inverse fair value gap",
        gapDirection === "bearish"
          ? "A bearish FVG flipped and may now act as bullish support."
          : "A bullish FVG flipped and may now act as bearish resistance.",
        gapDirection === "bearish" ? "positive" : "negative",
        26,
        true,
        "entry-quality",
      );
    }

    if (inferredState === "invalidated") {
      addEvidence(
        "fvg_invalidated",
        "FVG invalidated",
        "Price invalidated the imbalance setup.",
        "neutral",
        24,
        true,
        "risk",
      );
    }

    if (input.rank === "A") {
      addEvidence(
        "fvg_rank_a",
        "A-rank FVG",
        "The imbalance meets the strongest configured quality criteria.",
        gapDirection === "bearish" ? "negative" : "positive",
        12,
        "A",
        "entry-quality",
      );
    } else if (input.rank === "B") {
      addEvidence(
        "fvg_rank_b",
        "B-rank FVG",
        "The imbalance meets moderate quality criteria.",
        gapDirection === "bearish" ? "negative" : "positive",
        7,
        "B",
        "entry-quality",
      );
    }

    if (input.isHigherTimeframe) {
      addEvidence(
        "fvg_higher_timeframe",
        "Higher-timeframe FVG",
        "The imbalance originates from a higher timeframe and carries added context weight.",
        "neutral",
        8,
        input.originTimeframe ?? true,
      );
    }

    const addMetric = (
      key: string,
      label: string,
      value: number,
      unit: string,
    ): void => {
      metrics.push({
        key,
        label,
        category: "location",
        value,
        unit,
        confidence,
        timestamp: context.input.timestamp,
      });
    };

    if (finite(input.top)) addMetric("fvg.top", "FVG top", input.top, "price");
    if (finite(input.bottom)) {
      addMetric("fvg.bottom", "FVG bottom", input.bottom, "price");
    }
    if (finite(input.midpoint)) {
      addMetric("fvg.midpoint", "FVG midpoint", input.midpoint, "price");
    }
    if (finite(input.entryPrice)) {
      addMetric("fvg.entry", "FVG entry", input.entryPrice, "price");
    }
    if (finite(input.invalidationPrice)) {
      addMetric(
        "fvg.invalidation",
        "FVG invalidation",
        input.invalidationPrice,
        "price",
      );
    }
    if (finite(input.distanceToGap)) {
      addMetric(
        "fvg.distanceToGap",
        "Distance to FVG",
        input.distanceToGap,
        "price",
      );
    }
    if (finite(input.distanceToMidpoint)) {
      addMetric(
        "fvg.distanceToMidpoint",
        "Distance to midpoint",
        input.distanceToMidpoint,
        "price",
      );
    }
    if (finite(input.gapSize)) {
      addMetric("fvg.size", "FVG size", input.gapSize, "price");
    }
    if (finite(input.gapSizeAtr)) {
      addMetric("fvg.sizeAtr", "FVG size in ATR", input.gapSizeAtr, "ATR");
    }
    if (finite(input.displacementAtr)) {
      addMetric(
        "fvg.displacementAtr",
        "Displacement in ATR",
        input.displacementAtr,
        "ATR",
      );
    }
    if (finite(input.ageBars)) {
      addMetric("fvg.ageBars", "FVG age", input.ageBars, "bars");
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
      (inferredState === "flipped" && gapDirection
        ? gapDirection === "bearish"
          ? "bullish"
          : "bearish"
        : gapDirection ?? directionFromSignedScore(signedImpact));

    const evidenceScore = scoreEvidence(evidence);
    const score = finite(input.score)
      ? clampScore(input.score)
      : inferredState === "invalidated" || inferredState === "filled"
        ? Math.min(evidenceScore.score, 35)
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
      id: "fair-value-gap",
      category: "location",
      label: "Fair Value Gap",
      summary:
        inferredState === "invalidated"
          ? "The current fair value gap setup is invalidated."
          : inferredState === "filled"
            ? "The current fair value gap has been fully filled."
            : inferredState === "flipped"
              ? "An inverse fair value gap is active."
              : direction === "bullish"
                ? "Fair value gap context favors bullish continuation or support."
                : direction === "bearish"
                  ? "Fair value gap context favors bearish continuation or resistance."
                  : "Fair value gap context is mixed or incomplete.",
      status: statusFromState(inferredState, scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "fvg.score",
          label: "FVG score",
          category: "location",
          value: scored.normalizedScore,
          unit: "score",
          score: scored.normalizedScore,
          confidence: scored.confidence,
          timestamp: context.input.timestamp,
        },
        ...metrics,
      ],
      tags: [
        "fair-value-gap",
        direction,
        gapDirection ? `${gapDirection}-fvg` : "",
        inferredState ?? "",
        input.rank ? `rank-${input.rank.toLowerCase()}` : "",
        input.isHigherTimeframe ? "higher-timeframe" : "",
        input.isNewest ? "newest" : "",
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

export default FairValueGapContextEvaluator;
