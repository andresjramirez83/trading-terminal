// src/trading/intelligence/MarketContextEngine.ts

import type {
  MarketContextBias,
  MarketContextBuildRequest,
  MarketContextBuildResult,
  MarketContextCategory,
  MarketContextComponent,
  MarketContextDelta,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextInputSnapshot,
  MarketContextMetric,
  MarketContextReason,
  MarketContextSnapshot,
  MarketContextStatus,
  MarketRegime,
  MarketRegimeAssessment,
  MarketRegimeFamily,
} from "./types/MarketContextTypes";
import {
  aggregateComponentScores,
  biasFromScore,
  buildScoredContext,
  clampConfidence,
  clampScore,
  directionFromSignedScore,
  roundScore,
  scoreEvidence,
} from "./scoring/MarketContextScoring";

export interface MarketContextEvaluation {
  components?: MarketContextComponent[];
  evidence?: MarketContextEvidence[];
  reasons?: MarketContextReason[];
  metrics?: MarketContextMetric[];
  tags?: string[];
  warnings?: string[];
}

export interface MarketContextEvaluatorContext {
  request: MarketContextBuildRequest;
  input: MarketContextInputSnapshot;
  previousSnapshot: MarketContextSnapshot | null;
  now: number;
}

export interface MarketContextEvaluator {
  readonly id: string;
  readonly categories: readonly MarketContextCategory[];
  evaluate(
    context: MarketContextEvaluatorContext,
  ): MarketContextEvaluation | null;
}

export interface MarketContextEngineOptions {
  version?: number;
  includeInputSnapshot?: boolean;
  componentWeights?: Partial<Record<MarketContextCategory, number>>;
  evaluators?: readonly MarketContextEvaluator[];
  idFactory?: (prefix: string, timestamp: number) => string;
  now?: () => number;
}

const DEFAULT_COMPONENT_WEIGHTS: Partial<
  Record<MarketContextCategory, number>
> = {
  structure: 1.35,
  trend: 1.25,
  momentum: 1.1,
  volatility: 0.9,
  volume: 0.85,
  participation: 0.85,
  liquidity: 0.8,
  location: 1,
  timing: 0.75,
  session: 0.6,
  risk: 1.2,
  "entry-quality": 1.2,
  "trade-readiness": 1.3,
};

const REGIME_FAMILY: Record<MarketRegime, MarketRegimeFamily> = {
  "strong-uptrend": "trend",
  uptrend: "trend",
  "bullish-expansion": "expansion",
  "bullish-pullback": "trend",
  range: "range",
  compression: "compression",
  breakout: "expansion",
  breakdown: "expansion",
  volatile: "transition",
  "low-volatility": "compression",
  "bearish-pullback": "trend",
  "bearish-expansion": "expansion",
  downtrend: "trend",
  "strong-downtrend": "trend",
  transition: "transition",
  unknown: "unknown",
};

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function average(values: readonly number[], fallback = 0): number {
  const valid = values.filter(finite);
  if (valid.length === 0) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function createDefaultId(prefix: string, timestamp: number): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${timestamp}_${random}`;
}

function directionSign(direction: MarketContextDirection): number {
  if (direction === "bullish") return 1;
  if (direction === "bearish") return -1;
  return 0;
}

function statusFromConfidence(confidence: number): MarketContextStatus {
  if (confidence >= 0.7) return "confirmed";
  if (confidence >= 0.35) return "forming";
  return "pending";
}

function createEvidence(
  id: string,
  category: MarketContextCategory,
  label: string,
  reason: string,
  polarity: MarketContextEvidence["polarity"],
  scoreImpact: number,
  confidence: number,
  value?: MarketContextEvidence["value"],
): MarketContextEvidence {
  return {
    id,
    category,
    label,
    reason,
    polarity,
    severity: polarity === "negative" ? "warning" : "supporting",
    weight: 1,
    scoreImpact: Math.abs(scoreImpact),
    confidence: clampConfidence(confidence),
    value,
  };
}

function createReasonFromEvidence(
  evidence: MarketContextEvidence,
): MarketContextReason {
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

function deriveStructureComponent(
  input: MarketContextInputSnapshot,
  now: number,
): MarketContextComponent | null {
  const structure = input.structure;
  const evidence: MarketContextEvidence[] = [];

  if (structure.higherHighs) {
    evidence.push(createEvidence(
      "structure_higher_highs",
      "structure",
      "Higher highs",
      "Price is forming higher highs.",
      "positive",
      14,
      structure.confidence ?? 0.7,
      true,
    ));
  }

  if (structure.higherLows) {
    evidence.push(createEvidence(
      "structure_higher_lows",
      "structure",
      "Higher lows",
      "Price is holding higher lows.",
      "positive",
      14,
      structure.confidence ?? 0.7,
      true,
    ));
  }

  if (structure.lowerHighs) {
    evidence.push(createEvidence(
      "structure_lower_highs",
      "structure",
      "Lower highs",
      "Price is forming lower highs.",
      "negative",
      14,
      structure.confidence ?? 0.7,
      true,
    ));
  }

  if (structure.lowerLows) {
    evidence.push(createEvidence(
      "structure_lower_lows",
      "structure",
      "Lower lows",
      "Price is forming lower lows.",
      "negative",
      14,
      structure.confidence ?? 0.7,
      true,
    ));
  }

  if (structure.breakOfStructure) {
    const direction = structure.direction ?? structure.trend ?? "neutral";
    evidence.push(createEvidence(
      "structure_break",
      "structure",
      "Break of structure",
      direction === "bearish"
        ? "Bearish structure has been broken lower."
        : "Bullish structure has been broken higher.",
      direction === "bearish" ? "negative" : direction === "bullish" ? "positive" : "neutral",
      20,
      structure.confidence ?? 0.75,
      true,
    ));
  }

  if (structure.changeOfCharacter) {
    evidence.push(createEvidence(
      "structure_change_of_character",
      "structure",
      "Change of character",
      "Market structure is showing a possible directional transition.",
      "neutral",
      12,
      structure.confidence ?? 0.6,
      true,
    ));
  }

  const explicitDirection = structure.direction ?? structure.trend;
  if (evidence.length === 0 && !explicitDirection && !finite(structure.score)) {
    return null;
  }

  const evidenceScore = scoreEvidence(evidence);
  const direction = explicitDirection ?? directionFromSignedScore(
    evidence.reduce(
      (sum, item) => sum + directionSign(
        item.polarity === "positive"
          ? "bullish"
          : item.polarity === "negative"
            ? "bearish"
            : "neutral",
      ) * item.scoreImpact * item.confidence,
      0,
    ),
  );
  const score = finite(structure.score)
    ? clampScore(structure.score)
    : direction === "neutral"
      ? evidenceScore.score
      : clampScore(50 + Math.abs(evidenceScore.score - 50) * 2);
  const confidence = clampConfidence(
    structure.confidence ?? evidenceScore.confidence,
  );
  const scored = buildScoredContext({ score, confidence, direction });

  return {
    id: "structure",
    category: "structure",
    label: "Market Structure",
    summary: direction === "neutral"
      ? "Structure is mixed or not yet confirmed."
      : `${direction === "bullish" ? "Bullish" : "Bearish"} market structure is present.`,
    status: statusFromConfidence(confidence),
    ...scored,
    reasons: evidence.map(createReasonFromEvidence),
    evidence,
    metrics: [
      {
        key: "structure.score",
        label: "Structure score",
        category: "structure",
        value: scored.normalizedScore,
        unit: "score",
        confidence,
        timestamp: input.timestamp,
      },
    ],
    tags: ["structure", direction],
    updatedAt: now,
  };
}

function deriveTrendComponent(
  input: MarketContextInputSnapshot,
  now: number,
): MarketContextComponent | null {
  const { close } = input.price;
  const { ema9, ema20, ema50, ema200, vwap, vwapSlope, trendStrengthScore } =
    input.indicators;
  const evidence: MarketContextEvidence[] = [];

  if (finite(close) && finite(ema20)) {
    const bullish = close >= ema20;
    evidence.push(createEvidence(
      "trend_close_ema20",
      "trend",
      "Price versus EMA 20",
      bullish ? "Price is above the EMA 20." : "Price is below the EMA 20.",
      bullish ? "positive" : "negative",
      10,
      0.75,
      close - ema20,
    ));
  }

  if (finite(ema9) && finite(ema20)) {
    const bullish = ema9 >= ema20;
    evidence.push(createEvidence(
      "trend_ema9_ema20",
      "trend",
      "EMA alignment",
      bullish ? "EMA 9 is above EMA 20." : "EMA 9 is below EMA 20.",
      bullish ? "positive" : "negative",
      11,
      0.8,
      ema9 - ema20,
    ));
  }

  if (finite(ema20) && finite(ema50)) {
    const bullish = ema20 >= ema50;
    evidence.push(createEvidence(
      "trend_ema20_ema50",
      "trend",
      "Intermediate trend alignment",
      bullish ? "EMA 20 is above EMA 50." : "EMA 20 is below EMA 50.",
      bullish ? "positive" : "negative",
      12,
      0.8,
      ema20 - ema50,
    ));
  }

  if (finite(ema50) && finite(ema200)) {
    const bullish = ema50 >= ema200;
    evidence.push(createEvidence(
      "trend_ema50_ema200",
      "trend",
      "Long-term trend alignment",
      bullish ? "EMA 50 is above EMA 200." : "EMA 50 is below EMA 200.",
      bullish ? "positive" : "negative",
      13,
      0.85,
      ema50 - ema200,
    ));
  }

  if (finite(close) && finite(vwap)) {
    const bullish = close >= vwap;
    evidence.push(createEvidence(
      "trend_close_vwap",
      "trend",
      "Price versus VWAP",
      bullish ? "Price is trading above VWAP." : "Price is trading below VWAP.",
      bullish ? "positive" : "negative",
      9,
      0.75,
      close - vwap,
    ));
  }

  if (finite(vwapSlope) && vwapSlope !== 0) {
    const bullish = vwapSlope > 0;
    evidence.push(createEvidence(
      "trend_vwap_slope",
      "trend",
      "VWAP slope",
      bullish ? "VWAP is sloping upward." : "VWAP is sloping downward.",
      bullish ? "positive" : "negative",
      8,
      0.7,
      vwapSlope,
    ));
  }

  if (evidence.length === 0 && !finite(trendStrengthScore)) return null;

  const signed = evidence.reduce(
    (sum, item) => sum + (item.polarity === "positive" ? 1 : -1) * item.scoreImpact * item.confidence,
    0,
  );
  const direction = directionFromSignedScore(signed);
  const agreement = evidence.length > 0
    ? Math.abs(signed) / evidence.reduce((sum, item) => sum + item.scoreImpact * item.confidence, 0)
    : 0;
  const score = finite(trendStrengthScore)
    ? clampScore(trendStrengthScore)
    : clampScore(45 + agreement * 55);
  const confidence = clampConfidence(0.45 + agreement * 0.5);
  const scored = buildScoredContext({ score, confidence, direction });

  return {
    id: "trend",
    category: "trend",
    label: "Trend",
    summary: direction === "neutral"
      ? "Trend signals are mixed."
      : `${direction === "bullish" ? "Bullish" : "Bearish"} trend alignment is ${scored.strength}.`,
    status: statusFromConfidence(confidence),
    ...scored,
    reasons: evidence.map(createReasonFromEvidence),
    evidence,
    metrics: [
      {
        key: "trend.strength",
        label: "Trend strength",
        category: "trend",
        value: scored.normalizedScore,
        unit: "score",
        confidence,
        timestamp: input.timestamp,
      },
    ],
    tags: ["trend", direction],
    updatedAt: now,
  };
}

function deriveMomentumComponent(
  input: MarketContextInputSnapshot,
  now: number,
): MarketContextComponent | null {
  const score = input.indicators.momentumScore;
  if (!finite(score)) return null;

  const normalized = clampScore(score);
  const direction: MarketContextDirection = normalized > 55
    ? "bullish"
    : normalized < 45
      ? "bearish"
      : "neutral";
  const directionalStrength = clampScore(Math.abs(normalized - 50) * 2);
  const confidence = clampConfidence(0.45 + directionalStrength / 200);
  const scored = buildScoredContext({
    score: directionalStrength,
    confidence,
    direction,
  });
  const evidence = [createEvidence(
    "momentum_score",
    "momentum",
    "Momentum score",
    direction === "bullish"
      ? "Momentum favors buyers."
      : direction === "bearish"
        ? "Momentum favors sellers."
        : "Momentum is balanced.",
    direction === "bullish" ? "positive" : direction === "bearish" ? "negative" : "neutral",
    directionalStrength,
    confidence,
    normalized,
  )];

  return {
    id: "momentum",
    category: "momentum",
    label: "Momentum",
    summary: evidence[0].reason,
    status: statusFromConfidence(confidence),
    ...scored,
    reasons: evidence.map(createReasonFromEvidence),
    evidence,
    metrics: [{
      key: "momentum.score",
      label: "Momentum score",
      category: "momentum",
      value: normalized,
      unit: "score",
      confidence,
      timestamp: input.timestamp,
    }],
    tags: ["momentum", direction],
    updatedAt: now,
  };
}

function deriveVolatilityComponent(
  input: MarketContextInputSnapshot,
  now: number,
): MarketContextComponent | null {
  const volatility = input.volatility;
  const expansion = finite(volatility.expansionScore)
    ? clampScore(volatility.expansionScore)
    : null;
  const compression = finite(volatility.compressionScore)
    ? clampScore(volatility.compressionScore)
    : finite(input.indicators.compressionScore)
      ? clampScore(input.indicators.compressionScore)
      : null;

  if (expansion === null && compression === null && !finite(volatility.atrPercent)) {
    return null;
  }

  const expansionValue = expansion ?? 0;
  const compressionValue = compression ?? 0;
  const score = Math.max(expansionValue, compressionValue, 25);
  const confidence = clampConfidence(0.45 + score / 200);
  const scored = buildScoredContext({
    score,
    confidence,
    direction: "neutral",
  });
  const evidence: MarketContextEvidence[] = [];

  if (compressionValue >= expansionValue && compressionValue >= 50) {
    evidence.push(createEvidence(
      "volatility_compression",
      "volatility",
      "Volatility compression",
      "Price volatility is compressing.",
      "neutral",
      compressionValue,
      confidence,
      compressionValue,
    ));
  } else if (expansionValue >= 50) {
    evidence.push(createEvidence(
      "volatility_expansion",
      "volatility",
      "Volatility expansion",
      "Price volatility is expanding.",
      "neutral",
      expansionValue,
      confidence,
      expansionValue,
    ));
  }

  return {
    id: "volatility",
    category: "volatility",
    label: "Volatility",
    summary: evidence[0]?.reason ?? "Volatility context is available.",
    status: statusFromConfidence(confidence),
    ...scored,
    reasons: evidence.map(createReasonFromEvidence),
    evidence,
    metrics: [
      {
        key: "volatility.atrPercent",
        label: "ATR percent",
        category: "volatility",
        value: volatility.atrPercent ?? null,
        unit: "%",
        confidence,
        timestamp: input.timestamp,
      },
      {
        key: "volatility.expansion",
        label: "Expansion score",
        category: "volatility",
        value: expansion,
        unit: "score",
        confidence,
        timestamp: input.timestamp,
      },
      {
        key: "volatility.compression",
        label: "Compression score",
        category: "volatility",
        value: compression,
        unit: "score",
        confidence,
        timestamp: input.timestamp,
      },
    ],
    tags: [
      "volatility",
      compressionValue >= expansionValue ? "compression" : "expansion",
    ],
    updatedAt: now,
  };
}

function deriveParticipationComponent(
  input: MarketContextInputSnapshot,
  now: number,
): MarketContextComponent | null {
  const relativeVolume = input.volume.relative;
  const explicit = input.indicators.participationScore;
  if (!finite(relativeVolume) && !finite(explicit)) return null;

  const score = finite(explicit)
    ? clampScore(explicit)
    : clampScore((relativeVolume as number) * 50);
  const confidence = clampConfidence(0.45 + Math.min(score, 100) / 200);
  const direction: MarketContextDirection = "neutral";
  const scored = buildScoredContext({ score, confidence, direction });
  const strong = finite(relativeVolume) ? relativeVolume >= 1.5 : score >= 70;
  const evidence = [createEvidence(
    "participation_relative_volume",
    "participation",
    "Market participation",
    strong
      ? "Participation is elevated relative to normal."
      : "Participation is normal or below average.",
    strong ? "positive" : "neutral",
    score,
    confidence,
    relativeVolume ?? explicit ?? null,
  )];

  return {
    id: "participation",
    category: "participation",
    label: "Participation",
    summary: evidence[0].reason,
    status: statusFromConfidence(confidence),
    ...scored,
    reasons: evidence.map(createReasonFromEvidence),
    evidence,
    metrics: [{
      key: "participation.relativeVolume",
      label: "Relative volume",
      category: "participation",
      value: relativeVolume ?? null,
      unit: "x",
      confidence,
      timestamp: input.timestamp,
    }],
    tags: ["participation", strong ? "elevated" : "normal"],
    updatedAt: now,
  };
}

function inferRegime(
  components: readonly MarketContextComponent[],
  input: MarketContextInputSnapshot,
  previous: MarketContextSnapshot | null,
): MarketRegimeAssessment {
  const byCategory = new Map(
    components.map((component) => [component.category, component]),
  );
  const trend = byCategory.get("trend");
  const structure = byCategory.get("structure");
  const momentum = byCategory.get("momentum");
  const volatility = byCategory.get("volatility");
  const participation = byCategory.get("participation");
  const compression = input.volatility.compressionScore
    ?? input.indicators.compressionScore
    ?? 0;
  const expansion = input.volatility.expansionScore ?? 0;
  const trendScore = trend?.normalizedScore ?? input.indicators.trendStrengthScore ?? 0;
  const directionalVotes = [trend, structure, momentum]
    .filter((component): component is MarketContextComponent => Boolean(component))
    .reduce((sum, component) => (
      sum + directionSign(component.direction) * component.normalizedScore * component.confidence
    ), 0);
  const direction = directionFromSignedScore(directionalVotes, 8);

  let regime: MarketRegime = "unknown";

  if (compression >= 70) {
    regime = "compression";
  } else if (expansion >= 70) {
    regime = direction === "bullish"
      ? "bullish-expansion"
      : direction === "bearish"
        ? "bearish-expansion"
        : "volatile";
  } else if (trendScore >= 82 && direction === "bullish") {
    regime = "strong-uptrend";
  } else if (trendScore >= 82 && direction === "bearish") {
    regime = "strong-downtrend";
  } else if (trendScore >= 58 && direction === "bullish") {
    regime = "uptrend";
  } else if (trendScore >= 58 && direction === "bearish") {
    regime = "downtrend";
  } else if (trendScore < 45 && compression < 55) {
    regime = "range";
  } else if (volatility && volatility.normalizedScore >= 75) {
    regime = "volatile";
  } else {
    regime = "transition";
  }

  const relevant = [trend, structure, momentum, volatility, participation]
    .filter((component): component is MarketContextComponent => Boolean(component));
  const confidence = clampConfidence(average(relevant.map((item) => item.confidence)));
  const score = clampScore(average(relevant.map((item) => item.normalizedScore)));
  const scored = buildScoredContext({ score, confidence, direction });
  const changed = Boolean(previous && previous.regime.regime !== regime);

  return {
    ...scored,
    regime,
    family: REGIME_FAMILY[regime],
    status: statusFromConfidence(confidence),
    durationBars: changed
      ? 1
      : (previous?.regime.durationBars ?? 0) + 1,
    startedAt: changed
      ? input.timestamp
      : previous?.regime.startedAt ?? input.timestamp,
    transitionFrom: changed ? previous?.regime.regime : undefined,
    transitionProbability: changed
      ? roundScore(confidence, 4)
      : undefined,
    supportingEvidenceIds: relevant
      .filter((component) => component.direction === direction || component.direction === "neutral")
      .flatMap((component) => component.evidence.map((item) => item.id)),
    conflictingEvidenceIds: relevant
      .filter((component) => (
        direction !== "neutral" &&
        component.direction !== "neutral" &&
        component.direction !== direction
      ))
      .flatMap((component) => component.evidence.map((item) => item.id)),
  };
}

function buildDelta(
  previous: MarketContextSnapshot | null,
  current: MarketContextSnapshot,
): MarketContextDelta | null {
  if (!previous) return null;

  const previousEvidence = new Set(previous.evidence.map((item) => item.id));
  const currentEvidence = new Set(current.evidence.map((item) => item.id));
  const previousReasons = new Map(previous.reasons.map((item) => [item.id, item]));
  const currentReasons = new Map(current.reasons.map((item) => [item.id, item]));

  const strengthenedReasonIds: string[] = [];
  const weakenedReasonIds: string[] = [];

  for (const [id, reason] of currentReasons) {
    const prior = previousReasons.get(id);
    if (!prior) continue;

    const currentStrength = reason.importance * reason.confidence;
    const previousStrength = prior.importance * prior.confidence;

    if (currentStrength > previousStrength + 0.01) strengthenedReasonIds.push(id);
    if (currentStrength < previousStrength - 0.01) weakenedReasonIds.push(id);
  }

  return {
    fromSnapshotId: previous.id,
    toSnapshotId: current.id,
    scoreChange: roundScore(current.normalizedScore - previous.normalizedScore),
    confidenceChange: roundScore(current.confidence - previous.confidence, 4),
    directionChanged: current.direction !== previous.direction,
    biasChanged: current.bias !== previous.bias,
    regimeChanged: current.regime.regime !== previous.regime.regime,
    addedEvidenceIds: current.evidence
      .filter((item) => !previousEvidence.has(item.id))
      .map((item) => item.id),
    removedEvidenceIds: previous.evidence
      .filter((item) => !currentEvidence.has(item.id))
      .map((item) => item.id),
    strengthenedReasonIds,
    weakenedReasonIds,
  };
}

function summarize(
  bias: MarketContextBias,
  regime: MarketRegime,
  confidence: number,
): string {
  const biasText = bias.replace(/-/g, " ");
  const regimeText = regime.replace(/-/g, " ");
  const confidenceText = confidence >= 0.75
    ? "high confidence"
    : confidence >= 0.5
      ? "moderate confidence"
      : "low confidence";

  return `${biasText} context in a ${regimeText} regime with ${confidenceText}.`;
}

export class MarketContextEngine {
  private readonly version: number;
  private readonly includeInputSnapshot: boolean;
  private readonly componentWeights: Partial<Record<MarketContextCategory, number>>;
  private readonly evaluators: MarketContextEvaluator[];
  private readonly idFactory: (prefix: string, timestamp: number) => string;
  private readonly now: () => number;

  constructor(options: MarketContextEngineOptions = {}) {
    this.version = Math.max(1, Math.floor(options.version ?? 1));
    this.includeInputSnapshot = options.includeInputSnapshot ?? true;
    this.componentWeights = {
      ...DEFAULT_COMPONENT_WEIGHTS,
      ...options.componentWeights,
    };
    this.evaluators = [...(options.evaluators ?? [])];
    this.idFactory = options.idFactory ?? createDefaultId;
    this.now = options.now ?? Date.now;
  }

  registerEvaluator(evaluator: MarketContextEvaluator): () => void {
    const existingIndex = this.evaluators.findIndex((item) => item.id === evaluator.id);

    if (existingIndex >= 0) {
      this.evaluators.splice(existingIndex, 1, evaluator);
    } else {
      this.evaluators.push(evaluator);
    }

    return () => this.unregisterEvaluator(evaluator.id);
  }

  unregisterEvaluator(id: string): void {
    const index = this.evaluators.findIndex((item) => item.id === id);
    if (index >= 0) this.evaluators.splice(index, 1);
  }

  build(request: MarketContextBuildRequest): MarketContextBuildResult {
    const startedAt = this.now();
    const now = startedAt;
    const previousSnapshot = request.previousSnapshot ?? null;
    const warnings: string[] = [];
    const enabledCategories = request.enabledCategories
      ? new Set(request.enabledCategories)
      : null;
    const components: MarketContextComponent[] = [];

    const addBuiltIn = (component: MarketContextComponent | null): void => {
      if (!component) return;
      if (enabledCategories && !enabledCategories.has(component.category)) return;
      components.push(component);
    };

    addBuiltIn(deriveStructureComponent(request.input, now));
    addBuiltIn(deriveTrendComponent(request.input, now));
    addBuiltIn(deriveMomentumComponent(request.input, now));
    addBuiltIn(deriveVolatilityComponent(request.input, now));
    addBuiltIn(deriveParticipationComponent(request.input, now));

    const externalEvidence: MarketContextEvidence[] = [];
    const externalReasons: MarketContextReason[] = [];
    const externalMetrics: MarketContextMetric[] = [];
    const externalTags: string[] = [];

    for (const evaluator of this.evaluators) {
      if (
        enabledCategories &&
        !evaluator.categories.some((category) => enabledCategories.has(category))
      ) {
        continue;
      }

      try {
        const evaluation = evaluator.evaluate({
          request,
          input: request.input,
          previousSnapshot,
          now,
        });

        if (!evaluation) continue;
        components.push(...(evaluation.components ?? []));
        externalEvidence.push(...(evaluation.evidence ?? []));
        externalReasons.push(...(evaluation.reasons ?? []));
        externalMetrics.push(...(evaluation.metrics ?? []));
        externalTags.push(...(evaluation.tags ?? []));
        warnings.push(...(evaluation.warnings ?? []));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Evaluator ${evaluator.id} failed: ${message}`);
      }
    }

    const componentResult = aggregateComponentScores(
      components,
      this.componentWeights,
    );
    const evidence = [
      ...components.flatMap((component) => component.evidence),
      ...externalEvidence,
    ];
    const reasons = [
      ...components.flatMap((component) => component.reasons),
      ...externalReasons,
    ];
    const metrics = [
      ...components.flatMap((component) => component.metrics),
      ...externalMetrics,
    ];
    const regime = inferRegime(components, request.input, previousSnapshot);
    const direction = componentResult.direction;
    const score = componentResult.normalizedScore;
    const confidence = componentResult.confidence;
    const bias = biasFromScore(score, direction);
    const status = statusFromConfidence(confidence);
    const snapshotId = this.idFactory(
      `context_${request.input.symbol}_${request.input.timeframe}`,
      request.input.timestamp,
    );

    const snapshot: MarketContextSnapshot = {
      id: snapshotId,
      version: this.version,
      symbol: request.input.symbol,
      timeframe: request.input.timeframe,
      timestamp: request.input.timestamp,
      createdAt: now,
      source: request.source,
      mode: request.mode,
      session: request.input.session,
      tradingDate: request.input.tradingDate,
      barIndex: request.input.barIndex,
      score,
      maxScore: 100,
      normalizedScore: score,
      confidence,
      direction,
      strength: componentResult.strength,
      quality: componentResult.quality,
      bias,
      status,
      summary: summarize(bias, regime.regime, confidence),
      regime,
      components,
      reasons,
      evidence,
      metrics,
      tags: unique([
        request.input.symbol,
        request.input.timeframe,
        request.source,
        request.mode,
        request.input.session,
        direction,
        bias,
        regime.regime,
        regime.family,
        ...components.flatMap((component) => component.tags),
        ...externalTags,
      ]),
      input: this.includeInputSnapshot ? request.input : undefined,
      parentSnapshotId: previousSnapshot?.id,
      correlationId: request.correlationId,
      metadata: {
        componentCount: components.length,
        totalComponentWeight: componentResult.totalWeight,
        ...request.metadata,
      },
    };

    const delta = buildDelta(previousSnapshot, snapshot);

    return {
      snapshot,
      delta,
      warnings: unique(warnings),
      processingTimeMs: Math.max(0, this.now() - startedAt),
    };
  }
}

export const marketContextEngine = new MarketContextEngine();
