// src/trading/intelligence/evaluators/VWAPContextEvaluator.ts

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

export type VWAPPosition =
  | "above"
  | "below"
  | "at"
  | "crossing"
  | "unknown";

export interface VWAPContextInput {
  direction?: MarketContextDirection;
  score?: number;
  confidence?: number;

  price?: number;
  vwap?: number;
  position?: VWAPPosition;

  reclaimed?: boolean;
  rejected?: boolean;
  crossedAbove?: boolean;
  crossedBelow?: boolean;
  holdingAbove?: boolean;
  holdingBelow?: boolean;

  standardDeviation?: number;
  signedStandardDeviation?: number;
  distanceFromVWAP?: number;
  percentFromVWAP?: number;

  upperBand1?: number;
  upperBand2?: number;
  upperBand3?: number;
  lowerBand1?: number;
  lowerBand2?: number;
  lowerBand3?: number;

  extended?: boolean;
  meanReversionRisk?: boolean;
  trendAcceptance?: boolean;
  sessionVWAP?: boolean;
  anchoredVWAP?: boolean;
  anchorLabel?: string;

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

function positionValue(value: unknown): VWAPPosition | undefined {
  return value === "above" ||
    value === "below" ||
    value === "at" ||
    value === "crossing" ||
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

function readVWAPInput(
  context: MarketContextEvaluatorContext,
): VWAPContextInput {
  const metadata = isRecord(context.input.metadata)
    ? context.input.metadata
    : {};

  const custom = context.input.indicators.custom ?? {};

  const nestedMetadata: Record<string, unknown> = isRecord(metadata.vwap)
    ? metadata.vwap
    : {};
  const nestedCustom: Record<string, unknown> = isRecord(custom.vwap)
    ? custom.vwap
    : {};

  const read = (key: string): unknown =>
    nestedMetadata[key] ??
    nestedCustom[key] ??
    metadata[`vwap${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    custom[`vwap${key.charAt(0).toUpperCase()}${key.slice(1)}`] ??
    metadata[key] ??
    custom[key];

  const price =
    numberValue(read("price")) ??
    context.input.bar.close;

  const vwap =
    numberValue(read("value"), read("vwap")) ??
    context.input.indicators.vwap;

  let position = positionValue(read("position"));

  if (!position && finite(price) && finite(vwap)) {
    position =
      Math.abs(price - vwap) < Number.EPSILON
        ? "at"
        : price > vwap
          ? "above"
          : "below";
  }

  return {
    direction: directionValue(read("direction")),
    score: numberValue(read("score")),
    confidence: numberValue(read("confidence")),

    price,
    vwap,
    position,

    reclaimed: booleanValue(read("reclaimed"), read("reclaim")),
    rejected: booleanValue(read("rejected"), read("rejection")),
    crossedAbove: booleanValue(read("crossedAbove")),
    crossedBelow: booleanValue(read("crossedBelow")),
    holdingAbove: booleanValue(read("holdingAbove")),
    holdingBelow: booleanValue(read("holdingBelow")),

    standardDeviation: numberValue(
      read("standardDeviation"),
      read("stdDev"),
      read("std"),
    ),
    signedStandardDeviation: numberValue(
      read("signedStandardDeviation"),
      read("signedStdDev"),
      read("signedStd"),
    ),
    distanceFromVWAP: numberValue(read("distanceFromVWAP"), read("distance")),
    percentFromVWAP: numberValue(read("percentFromVWAP"), read("percent")),

    upperBand1: numberValue(read("upperBand1")),
    upperBand2: numberValue(read("upperBand2")),
    upperBand3: numberValue(read("upperBand3")),
    lowerBand1: numberValue(read("lowerBand1")),
    lowerBand2: numberValue(read("lowerBand2")),
    lowerBand3: numberValue(read("lowerBand3")),

    extended: booleanValue(read("extended")),
    meanReversionRisk: booleanValue(read("meanReversionRisk")),
    trendAcceptance: booleanValue(read("trendAcceptance")),
    sessionVWAP: booleanValue(read("sessionVWAP")),
    anchoredVWAP: booleanValue(read("anchoredVWAP")),
    anchorLabel: stringValue(read("anchorLabel"), read("anchor")),

    metadata: {
      ...nestedCustom,
      ...nestedMetadata,
    },
  };
}

export class VWAPContextEvaluator implements MarketContextEvaluator {
  readonly id = "vwap";
  readonly categories = ["location", "trend", "entry-quality"] as const;

  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null {
    const input = readVWAPInput(context);
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
      category: MarketContextEvidence["category"] = "location",
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

    if (input.position === "above") {
      addEvidence(
        "vwap_above",
        "Price above VWAP",
        "Price is trading above VWAP, supporting bullish intraday control.",
        "positive",
        12,
        input.price,
      );
    }

    if (input.position === "below") {
      addEvidence(
        "vwap_below",
        "Price below VWAP",
        "Price is trading below VWAP, supporting bearish intraday control.",
        "negative",
        12,
        input.price,
      );
    }

    if (input.reclaimed || input.crossedAbove) {
      addEvidence(
        "vwap_reclaim",
        "VWAP reclaimed",
        "Price crossed above VWAP and reclaimed it as support.",
        "positive",
        22,
        true,
        "entry-quality",
      );
    }

    if (input.rejected || input.crossedBelow) {
      addEvidence(
        "vwap_rejection",
        "VWAP rejected",
        "Price failed at VWAP or crossed below it, weakening bullish control.",
        "negative",
        22,
        true,
        "entry-quality",
      );
    }

    if (input.holdingAbove) {
      addEvidence(
        "vwap_holding_above",
        "Holding above VWAP",
        "Price is accepting above VWAP instead of immediately mean reverting.",
        "positive",
        18,
        true,
        "trend",
      );
    }

    if (input.holdingBelow) {
      addEvidence(
        "vwap_holding_below",
        "Holding below VWAP",
        "Price is accepting below VWAP instead of immediately reclaiming it.",
        "negative",
        18,
        true,
        "trend",
      );
    }

    if (input.trendAcceptance) {
      addEvidence(
        "vwap_trend_acceptance",
        "VWAP trend acceptance",
        "Price is maintaining directional acceptance relative to VWAP.",
        input.position === "below" ? "negative" : "positive",
        16,
        true,
        "trend",
      );
    }

    const signedStd =
      input.signedStandardDeviation ??
      (finite(input.standardDeviation)
        ? input.position === "below"
          ? -Math.abs(input.standardDeviation)
          : Math.abs(input.standardDeviation)
        : undefined);

    const isExtended =
      input.extended ||
      input.meanReversionRisk ||
      (finite(signedStd) && Math.abs(signedStd) >= 2);

    if (isExtended) {
      addEvidence(
        "vwap_extension",
        "Extended from VWAP",
        "Price is significantly extended from VWAP, increasing mean-reversion risk.",
        "neutral",
        18,
        signedStd ?? true,
        "risk",
      );
    }

    if (finite(signedStd) && signedStd >= 1 && signedStd < 2) {
      addEvidence(
        "vwap_positive_dispersion",
        "Positive VWAP dispersion",
        "Price is trading above VWAP with positive dispersion.",
        "positive",
        8,
        signedStd,
      );
    }

    if (finite(signedStd) && signedStd <= -1 && signedStd > -2) {
      addEvidence(
        "vwap_negative_dispersion",
        "Negative VWAP dispersion",
        "Price is trading below VWAP with negative dispersion.",
        "negative",
        8,
        signedStd,
      );
    }

    const addMetric = (
      key: string,
      label: string,
      value: number | string | boolean,
      unit?: string,
      category: MarketContextMetric["category"] = "location",
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

    if (finite(input.price)) {
      addMetric("vwap.price", "Price", input.price, "price");
    }
    if (finite(input.vwap)) {
      addMetric("vwap.value", "VWAP", input.vwap, "price");
    }
    if (input.position) {
      addMetric("vwap.position", "VWAP position", input.position);
    }
    if (finite(input.distanceFromVWAP)) {
      addMetric(
        "vwap.distance",
        "Distance from VWAP",
        input.distanceFromVWAP,
        "price",
      );
    }
    if (finite(input.percentFromVWAP)) {
      addMetric(
        "vwap.percent",
        "Percent from VWAP",
        input.percentFromVWAP,
        "%",
      );
    }
    if (finite(input.standardDeviation)) {
      addMetric(
        "vwap.stdDev",
        "VWAP standard deviation",
        input.standardDeviation,
        "σ",
      );
    }
    if (finite(signedStd)) {
      addMetric(
        "vwap.signedStdDev",
        "Signed VWAP standard deviation",
        signedStd,
        "σ",
      );
    }

    const bandMetrics: Array<[string, string, number | undefined]> = [
      ["vwap.upperBand1", "VWAP upper band 1", input.upperBand1],
      ["vwap.upperBand2", "VWAP upper band 2", input.upperBand2],
      ["vwap.upperBand3", "VWAP upper band 3", input.upperBand3],
      ["vwap.lowerBand1", "VWAP lower band 1", input.lowerBand1],
      ["vwap.lowerBand2", "VWAP lower band 2", input.lowerBand2],
      ["vwap.lowerBand3", "VWAP lower band 3", input.lowerBand3],
    ];

    for (const [key, label, value] of bandMetrics) {
      if (finite(value)) addMetric(key, label, value, "price");
    }

    if (input.anchoredVWAP) {
      addMetric(
        "vwap.anchored",
        "Anchored VWAP",
        input.anchorLabel ?? true,
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

    const adjustedScore = isExtended
      ? Math.max(0, score - 8)
      : score;

    const scored = buildScoredContext({
      score: adjustedScore,
      confidence:
        input.confidence ?? evidenceScore.confidence ?? confidence,
      direction,
    });

    const reasons = evidence.map(createReason);

    const component: MarketContextComponent = {
      id: "vwap",
      category: "location",
      label: input.anchoredVWAP ? "Anchored VWAP" : "VWAP",
      summary:
        isExtended
          ? "VWAP direction is present, but price is extended and mean-reversion risk is elevated."
          : direction === "bullish"
            ? "VWAP context supports bullish control and acceptance."
            : direction === "bearish"
              ? "VWAP context supports bearish control and acceptance."
              : "VWAP context is balanced or unresolved.",
      status: statusFromConfidence(scored.confidence),
      ...scored,
      reasons,
      evidence,
      metrics: [
        {
          key: "vwap.score",
          label: "VWAP score",
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
        "vwap",
        direction,
        input.position ?? "",
        input.reclaimed ? "reclaim" : "",
        input.rejected ? "rejection" : "",
        isExtended ? "extended" : "",
        input.anchoredVWAP ? "anchored" : "",
        input.sessionVWAP ? "session" : "",
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

export default VWAPContextEvaluator;
