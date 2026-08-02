// src/trading/intelligence/evaluators/TradingDecisionEngine.ts

import type {
  MarketContextComponent,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextReason,
  MarketContextResult,
} from "../types/MarketContextTypes";
import type { MarketObjectDecisionAdjustment } from "../integration/MarketObjectDecisionAdapter";

export type TradingDecisionAction =
  | "strong-long"
  | "long"
  | "watch-long"
  | "wait"
  | "watch-short"
  | "short"
  | "strong-short"
  | "avoid";

export type TradingDecisionGrade = "A+" | "A" | "B" | "C" | "D" | "F";
export type TradingDecisionRiskLevel = "low" | "moderate" | "high" | "extreme";

export interface TradingDecisionInput {
  context: MarketContextResult;
  preferredDirection?: MarketContextDirection;
  minimumConfidence?: number;
  minimumTradeScore?: number;
  requireStructure?: boolean;
  requireRiskApproval?: boolean;
  requireEntryApproval?: boolean;
  longOnly?: boolean;
  shortOnly?: boolean;
  marketObjectAdjustment?: MarketObjectDecisionAdjustment;
  metadata?: Record<string, unknown>;
}

export interface TradingDecisionConflict {
  id: string;
  label: string;
  description: string;
  severity: "low" | "medium" | "high";
  componentIds: string[];
}

export interface TradingDecisionFactor {
  id: string;
  label: string;
  componentId: string;
  category: string;
  direction: MarketContextDirection;
  score: number;
  confidence: number;
  weightedScore: number;
  supportive: boolean;
  blocking: boolean;
}

export interface TradingDecisionRiskSummary {
  level: TradingDecisionRiskLevel;
  score: number;
  blockers: string[];
  warnings: string[];
  strengths: string[];
}

export interface TradingDecisionResult {
  symbol: string;
  timeframe: string;
  timestamp: number;
  action: TradingDecisionAction;
  direction: MarketContextDirection;
  grade: TradingDecisionGrade;
  tradeScore: number;
  convictionScore: number;
  confidence: number;
  bullishScore: number;
  bearishScore: number;
  neutralScore: number;
  thesis: string;
  summary: string;
  risk: TradingDecisionRiskSummary;
  factors: TradingDecisionFactor[];
  conflicts: TradingDecisionConflict[];
  supportingComponents: string[];
  opposingComponents: string[];
  blockingComponents: string[];
  evidence: MarketContextEvidence[];
  reasons: MarketContextReason[];
  metrics: MarketContextMetric[];
  tags: string[];
  canTrade: boolean;
  shouldWait: boolean;
  generatedAt: number;
}

export interface TradingDecisionWeights {
  structure: number;
  liquidity: number;
  fairValueGap: number;
  vwap: number;
  momentum: number;
  volatility: number;
  compression: number;
  trend: number;
  participation: number;
  risk: number;
  balance: number;
  entryQuality: number;
  session: number;
  regime: number;
  fallback: number;
}

const DEFAULT_WEIGHTS: TradingDecisionWeights = {
  structure: 2.2,
  liquidity: 1.15,
  fairValueGap: 1,
  vwap: 0.9,
  momentum: 0.95,
  volatility: 0.75,
  compression: 0.85,
  trend: 0.85,
  participation: 0.8,
  risk: 1.3,
  balance: 0.9,
  entryQuality: 1.35,
  session: 0.85,
  regime: 1.05,
  fallback: 0.75,
};

const COMPONENT_ALIASES: Record<string, keyof TradingDecisionWeights> = {
  "market-structure": "structure",
  structure: "structure",
  liquidity: "liquidity",
  "fair-value-gap": "fairValueGap",
  fvg: "fairValueGap",
  ifvg: "fairValueGap",
  vwap: "vwap",
  momentum: "momentum",
  volatility: "volatility",
  compression: "compression",
  trend: "trend",
  participation: "participation",
  risk: "risk",
  balance: "balance",
  "entry-quality": "entryQuality",
  entry: "entryQuality",
  session: "session",
  "market-regime": "regime",
  regime: "regime",
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeScore(component: MarketContextComponent): number {
  if (finite(component.normalizedScore)) return clamp(component.normalizedScore);
  if (finite(component.score)) return clamp(component.score);
  return 50;
}

function componentWeight(component: MarketContextComponent, weights: TradingDecisionWeights): number {
  const alias = COMPONENT_ALIASES[component.id] ?? COMPONENT_ALIASES[String(component.category)];
  return alias ? weights[alias] : weights.fallback;
}

function directionSign(direction: MarketContextDirection): number {
  if (direction === "bullish") return 1;
  if (direction === "bearish") return -1;
  return 0;
}

function gradeFromScore(score: number): TradingDecisionGrade {
  if (score >= 92) return "A+";
  if (score >= 82) return "A";
  if (score >= 70) return "B";
  if (score >= 58) return "C";
  if (score >= 45) return "D";
  return "F";
}

function riskLevelFromScore(score: number): TradingDecisionRiskLevel {
  if (score >= 80) return "low";
  if (score >= 62) return "moderate";
  if (score >= 42) return "high";
  return "extreme";
}

function findComponent(components: MarketContextComponent[], ids: string[]): MarketContextComponent | undefined {
  return components.find((component) => ids.includes(component.id) || ids.includes(String(component.category)));
}

function confirmedStructureDirection(
  component: MarketContextComponent | undefined,
): MarketContextDirection {
  if (!component) return "neutral";

  const tags = new Set(component.tags ?? []);
  const confirmed =
    component.status === "confirmed" ||
    tags.has("confirmed-hh-hl") ||
    tags.has("confirmed-ll-lh") ||
    normalizeScore(component) >= 55;

  if (!confirmed) return "neutral";

  return component.direction === "bullish" ||
    component.direction === "bearish"
    ? component.direction
    : "neutral";
}

function componentIsBlocking(component: MarketContextComponent): boolean {
  if (component.status === "invalidated") return true;
  const tags = new Set(component.tags ?? []);
  return [
    "context-conflict",
    "chasing",
    "late-entry",
    "poor-risk",
    "inside-balance",
    "reversal-risk",
    "nearby-obstacle",
  ].some((tag) => tags.has(tag));
}

function createFactors(
  components: MarketContextComponent[],
  weights: TradingDecisionWeights,
): TradingDecisionFactor[] {
  return components.map((component) => {
    const score = normalizeScore(component);
    const confidence = clampConfidence(component.confidence ?? 0.5);
    const weightedScore =
      directionSign(component.direction) *
      Math.abs(score - 50) *
      componentWeight(component, weights) *
      confidence;

    return {
      id: `factor_${component.id}`,
      label: component.label,
      componentId: component.id,
      category: String(component.category),
      direction: component.direction,
      score,
      confidence,
      weightedScore,
      supportive: score >= 58 && component.direction !== "neutral",
      blocking: componentIsBlocking(component),
    };
  });
}

function createConflicts(components: MarketContextComponent[]): TradingDecisionConflict[] {
  const conflicts: TradingDecisionConflict[] = [];
  const structure = findComponent(components, ["market-structure", "structure"]);
  const trend = findComponent(components, ["trend"]);
  const momentum = findComponent(components, ["momentum"]);
  const risk = findComponent(components, ["risk"]);
  const entry = findComponent(components, ["entry-quality", "entry"]);
  const balance = findComponent(components, ["balance"]);

  if (structure && trend && structure.direction !== "neutral" && trend.direction !== "neutral" && structure.direction !== trend.direction) {
    conflicts.push({
      id: "conflict_structure_trend",
      label: "Structure and trend disagree",
      description: "Market structure and broader trend are pointing in opposite directions.",
      severity: "high",
      componentIds: [structure.id, trend.id],
    });
  }

  if (momentum && trend && momentum.direction !== "neutral" && trend.direction !== "neutral" && momentum.direction !== trend.direction) {
    conflicts.push({
      id: "conflict_momentum_trend",
      label: "Momentum opposes trend",
      description: "Momentum is moving against the established trend.",
      severity: "medium",
      componentIds: [momentum.id, trend.id],
    });
  }

  if (risk && normalizeScore(risk) < 50) {
    conflicts.push({
      id: "conflict_risk_rejection",
      label: "Risk quality is weak",
      description: "Available reward, invalidation quality, or nearby obstacles make the setup unattractive.",
      severity: "high",
      componentIds: [risk.id],
    });
  }

  if (entry && normalizeScore(entry) < 50) {
    conflicts.push({
      id: "conflict_entry_rejection",
      label: "Entry quality is weak",
      description: "The current entry is poorly timed, extended, late, or insufficiently confirmed.",
      severity: "high",
      componentIds: [entry.id],
    });
  }

  if (balance && balance.direction === "neutral" && normalizeScore(balance) >= 55) {
    conflicts.push({
      id: "conflict_balance_chop",
      label: "Market remains balanced",
      description: "Price is still rotating inside balance, reducing directional edge.",
      severity: "medium",
      componentIds: [balance.id],
    });
  }

  return conflicts;
}

function collectRiskSummary(
  components: MarketContextComponent[],
  conflicts: TradingDecisionConflict[],
): TradingDecisionRiskSummary {
  const risk = findComponent(components, ["risk"]);
  const entry = findComponent(components, ["entry-quality", "entry"]);
  const score = risk ? normalizeScore(risk) : entry ? normalizeScore(entry) : 50;

  return {
    level: riskLevelFromScore(score),
    score,
    blockers: conflicts.filter((item) => item.severity === "high").map((item) => item.label),
    warnings: conflicts.filter((item) => item.severity === "medium").map((item) => item.label),
    strengths: [
      risk && normalizeScore(risk) >= 75 ? "Strong reward-to-risk" : "",
      entry && normalizeScore(entry) >= 75 ? "High-quality entry" : "",
    ].filter(Boolean),
  };
}

function determineAction(
  direction: MarketContextDirection,
  tradeScore: number,
  confidence: number,
  canTrade: boolean,
  shouldWait: boolean,
): TradingDecisionAction {
  if (!canTrade) return "avoid";
  if (shouldWait || direction === "neutral") return "wait";

  if (direction === "bullish") {
    if (tradeScore >= 86 && confidence >= 0.78) return "strong-long";
    if (tradeScore >= 72 && confidence >= 0.65) return "long";
    return "watch-long";
  }

  if (tradeScore >= 86 && confidence >= 0.78) return "strong-short";
  if (tradeScore >= 72 && confidence >= 0.65) return "short";
  return "watch-short";
}

export class TradingDecisionEngine {
  private readonly weights: TradingDecisionWeights;

  constructor(weights: Partial<TradingDecisionWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  evaluate(input: TradingDecisionInput): TradingDecisionResult {
    const context = input.context;
    const marketObjects = input.marketObjectAdjustment;
    const components = context.components ?? [];
    const factors = createFactors(components, this.weights);
    const conflicts = createConflicts(components);

    const bullishRaw = factors
      .filter((factor) => factor.direction === "bullish")
      .reduce((total, factor) => total + Math.abs(factor.weightedScore), 0);

    const bearishRaw = factors
      .filter((factor) => factor.direction === "bearish")
      .reduce((total, factor) => total + Math.abs(factor.weightedScore), 0);

    const neutralFactors = factors.filter((factor) => factor.direction === "neutral");
    const neutralRaw = neutralFactors.reduce(
      (total, factor) => total + Math.abs(factor.score - 50) * factor.confidence,
      0,
    );

    const directionalTotal = bullishRaw + bearishRaw;
    const bullishScore = directionalTotal > 0 ? clamp((bullishRaw / directionalTotal) * 100) : 50;
    const bearishScore = directionalTotal > 0 ? clamp((bearishRaw / directionalTotal) * 100) : 50;
    const neutralScore = clamp(neutralRaw / Math.max(1, neutralFactors.length));

    const structureComponent = findComponent(
      components,
      ["market-structure", "structure"],
    );
    const structureDirection =
      confirmedStructureDirection(structureComponent);

    /**
     * Market structure owns directional bias.
     * Other components determine quality, readiness, and risk—not a separate
     * conflicting market direction.
     */
    let direction: MarketContextDirection =
      structureDirection !== "neutral"
        ? structureDirection
        : bullishScore >= bearishScore + 8
          ? "bullish"
          : bearishScore >= bullishScore + 8
            ? "bearish"
            : "neutral";

    if (
      structureDirection === "neutral" &&
      input.preferredDirection &&
      input.preferredDirection !== "neutral" &&
      Math.abs(bullishScore - bearishScore) < 12
    ) {
      direction = input.preferredDirection;
    }

    const supporting = components.filter(
      (component) => component.direction === direction && normalizeScore(component) >= 55,
    );

    const opposing = components.filter(
      (component) => direction !== "neutral" && component.direction !== "neutral" && component.direction !== direction,
    );

    const blocking = components.filter(componentIsBlocking);
    const rawDirectionalStrength =
      direction === "bullish"
        ? bullishScore
        : direction === "bearish"
          ? bearishScore
          : 50;

    const directionalStrength =
      structureDirection !== "neutral"
        ? Math.max(
            rawDirectionalStrength,
            normalizeScore(structureComponent as MarketContextComponent),
            68,
          )
        : rawDirectionalStrength;

    const confidence = factors.length > 0
      ? clampConfidence(factors.reduce((total, factor) => total + factor.confidence, 0) / factors.length)
      : clampConfidence(context.confidence ?? 0.5);

    const baseScore = finite(context.score)
      ? clamp(context.score)
      : finite(context.normalizedScore)
        ? clamp(context.normalizedScore)
        : 50;

    const tradeScore = clamp(
      baseScore * 0.3 +
      directionalStrength * 0.45 +
      confidence * 100 * 0.25 +
      Math.min(15, supporting.length * 2.5) -
      conflicts.filter((item) => item.severity === "high").length * 12 -
      conflicts.filter((item) => item.severity === "medium").length * 6 -
      blocking.length * 8 +
      (marketObjects?.scoreAdjustment ?? 0),
    );

    const convictionScore = clamp(
      directionalStrength * confidence +
      supporting.length * 3 -
      opposing.length * 4 -
      conflicts.length * 3 +
      (marketObjects?.convictionAdjustment ?? 0),
    );

    const risk = collectRiskSummary(components, conflicts);
    const minimumConfidence = input.minimumConfidence ?? 0.58;
    const minimumTradeScore = input.minimumTradeScore ?? 55;

    const structure = structureComponent;
    const riskComponent = findComponent(components, ["risk"]);
    const entryComponent = findComponent(components, ["entry-quality", "entry"]);

    const structureApproved = !input.requireStructure || (!!structure && structure.direction === direction && normalizeScore(structure) >= 55);
    const riskApproved = !input.requireRiskApproval || (!!riskComponent && normalizeScore(riskComponent) >= 55);
    const entryApproved = !input.requireEntryApproval || (!!entryComponent && normalizeScore(entryComponent) >= 55);
    const directionAllowed = direction === "neutral" || ((!input.longOnly || direction === "bullish") && (!input.shortOnly || direction === "bearish"));
    const hardBlock =
      conflicts.some((item) => item.severity === "high") ||
      risk.level === "extreme" ||
      (marketObjects?.blocked ?? false);

    const canTrade =
      direction !== "neutral" &&
      directionAllowed &&
      confidence >= minimumConfidence &&
      tradeScore >= minimumTradeScore &&
      structureApproved &&
      riskApproved &&
      entryApproved &&
      !hardBlock;

    const shouldWait =
      direction === "neutral" ||
      confidence < minimumConfidence ||
      tradeScore < minimumTradeScore ||
      conflicts.some((item) => item.severity === "medium") ||
      blocking.length > 0 ||
      (marketObjects?.shouldWait ?? false);

    const grade = gradeFromScore(tradeScore);

    const structureInvalidated =
      structure?.status === "invalidated" ||
      (marketObjects?.blocked ?? false);
    const extremeRisk =
      risk.level === "extreme" ||
      (riskComponent?.status === "invalidated");

    /**
     * Direction and trade readiness are separate:
     * - Confirmed bullish structure + weak entry = watch-long, not bearish.
     * - Confirmed bearish structure + weak entry = watch-short, not bullish.
     * - AVOID is reserved for invalidated structure or extreme risk.
     */
    const action: TradingDecisionAction =
      structureInvalidated || extremeRisk
        ? "avoid"
        : canTrade
          ? determineAction(
              direction,
              tradeScore,
              confidence,
              true,
              shouldWait,
            )
          : direction === "bullish"
            ? "watch-long"
            : direction === "bearish"
              ? "watch-short"
              : "wait";

    const thesis = direction === "neutral"
      ? "No confirmed directional structure is present. Wait for a validated HH/HL or LL/LH sequence."
      : `${grade} ${direction} thesis anchored to confirmed market structure and qualified by entry, risk, momentum, and location.`;

    const summary = action === "avoid"
      ? "Avoid execution because structure is invalidated or risk is extreme."
      : action === "wait"
        ? "Wait for confirmed market direction."
        : action === "watch-long"
          ? "Bullish structure is confirmed, but the current entry is not ready."
          : action === "watch-short"
            ? "Bearish structure is confirmed, but the current entry is not ready."
            : action.includes("long")
              ? "Bullish structure and trade-readiness conditions are actionable."
              : "Bearish structure and trade-readiness conditions are actionable.";

    return {
      symbol: context.symbol,
      timeframe: context.timeframe,
      timestamp: context.timestamp,
      action,
      direction,
      grade,
      tradeScore,
      convictionScore,
      confidence,
      bullishScore,
      bearishScore,
      neutralScore,
      thesis,
      summary,
      risk,
      factors,
      conflicts,
      supportingComponents: [
        ...supporting.map((item) => item.id),
        ...(marketObjects?.supportingObjectIds ?? []),
      ],
      opposingComponents: [
        ...opposing.map((item) => item.id),
        ...(marketObjects?.opposingObjectIds ?? []),
      ],
      blockingComponents: [
        ...blocking.map((item) => item.id),
        ...(marketObjects?.blockingObjectIds ?? []),
      ],
      evidence: components.flatMap((item) => item.evidence ?? []),
      reasons: components.flatMap((item) => item.reasons ?? []),
      metrics: components.flatMap((item) => item.metrics ?? []),
      tags: [
        "trading-decision",
        direction,
        action,
        `grade-${grade.toLowerCase().replace("+", "-plus")}`,
        `risk-${risk.level}`,
        canTrade ? "trade-approved" : "trade-not-approved",
        shouldWait ? "wait-required" : "",
        structureDirection !== "neutral"
          ? "direction-from-market-structure"
          : "direction-from-context-vote",
        ...(marketObjects?.tags ?? []),
      ].filter(Boolean),
      canTrade,
      shouldWait,
      generatedAt: Date.now(),
    };
  }
}

export default TradingDecisionEngine;
