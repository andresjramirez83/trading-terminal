// src/trading/intelligence/narrative/MarketNarrativeEngine.ts

/**
 * Converts structured market context and trading decisions into a concise,
 * deterministic market story. This engine never creates trade signals; it
 * explains the current decision, the evidence behind it, the next conditions
 * to watch, and the condition that invalidates the active thesis.
 */

import type {
  MarketContextComponent,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextSnapshot,
  MarketRegime,
} from "../intelligence/types/MarketContextTypes";
import type { TradingDecisionResult } from "../intelligence/evaluators/TradingDecisionEngine";
import type { IntelligenceRegistryRuntime } from "../intelligence/core/IntelligenceRegistry";
import type {
  IntelligenceNarrative,
  IntelligenceObjective,
  IntelligenceProbabilitySet,
  IntelligenceQuality,
  IntelligenceTrigger,
  MarketCharacter,
  MarketPhase,
} from "../intelligence/core/IntelligenceTypes";

export interface MarketNarrativeEngineOptions {
  now?: () => number;
  maxStorySentences?: number;
  maxAlternativeObjectives?: number;
  minimumObjectiveConfidence?: number;
}

export interface MarketNarrativeInput {
  context: MarketContextSnapshot;
  decision: TradingDecisionResult;
  probabilities?: Partial<IntelligenceProbabilitySet>;
  objectives?: readonly IntelligenceObjective[];
  triggers?: readonly IntelligenceTrigger[];
  entryIsChasing?: boolean;
  entryIsLate?: boolean;
  extensionRisk?: number;
  previousNarrative?: IntelligenceNarrative | null;
}

export interface MarketNarrativeContribution {
  narrative: IntelligenceNarrative;
  probabilities: IntelligenceProbabilitySet;
  objectives: IntelligenceObjective[];
  triggers: IntelligenceTrigger[];
  tags: string[];
  metadata: Record<string, unknown>;
}

const COMPONENT_IDS = {
  structure: ["market-structure", "structure"],
  liquidity: ["liquidity"],
  fvg: ["fair-value-gap", "fvg", "ifvg"],
  vwap: ["vwap"],
  momentum: ["momentum"],
  volatility: ["volatility"],
  compression: ["compression"],
  trend: ["trend"],
  participation: ["participation", "volume"],
  risk: ["risk"],
  balance: ["balance"],
  entry: ["entry-quality", "entry"],
  session: ["session"],
  regime: ["market-regime", "regime"],
} as const;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function score01(value: unknown, fallback = 0.5): number {
  if (!finite(value)) return fallback;
  return clamp(value > 1 ? value / 100 : value);
}

function titleCase(value: string): string {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function findComponent(
  context: MarketContextSnapshot,
  ids: readonly string[],
): MarketContextComponent | undefined {
  return context.components.find(
    (component) => ids.includes(component.id) || ids.includes(String(component.category)),
  );
}

function metricValue(
  context: MarketContextSnapshot,
  keys: readonly string[],
): unknown {
  const all = [...context.metrics, ...context.components.flatMap((item) => item.metrics)];
  const metric = all.find((item) => keys.includes(item.key));
  return metric?.value;
}

function metricNumber(
  context: MarketContextSnapshot,
  keys: readonly string[],
): number | undefined {
  const value = metricValue(context, keys);
  return finite(value) ? value : undefined;
}

function componentScore(component: MarketContextComponent | undefined): number {
  if (!component) return 0.5;
  return score01(component.normalizedScore, score01(component.score));
}

function resolvePhase(context: MarketContextSnapshot): MarketPhase {
  const regime = context.regime.regime;
  const family = context.regime.family;
  const balance = findComponent(context, COMPONENT_IDS.balance);
  const compression = findComponent(context, COMPONENT_IDS.compression);
  const momentum = findComponent(context, COMPONENT_IDS.momentum);

  if (regime === "bullish-pullback" || regime === "bearish-pullback") return "pullback";
  if (regime === "bullish-expansion" || regime === "bearish-expansion") return "expansion";
  if (regime === "breakout" || regime === "breakdown") return "expansion";
  if (regime === "strong-uptrend" || regime === "uptrend" || regime === "strong-downtrend" || regime === "downtrend") return "trend";
  if (family === "range" || componentScore(balance) >= 0.68) return "balance";
  if (family === "compression" || componentScore(compression) >= 0.7) return "accumulation";
  if (family === "expansion") return "expansion";
  if (family === "trend") return "trend";
  if (family === "transition") return "transition";
  if (momentum?.status === "weakening" && context.direction !== "neutral") return "distribution";
  return "unknown";
}

function resolveCharacter(context: MarketContextSnapshot): MarketCharacter {
  const regime = context.regime.regime;
  const volatility = findComponent(context, COMPONENT_IDS.volatility);
  const compression = findComponent(context, COMPONENT_IDS.compression);
  const balance = findComponent(context, COMPONENT_IDS.balance);
  const liquidity = findComponent(context, COMPONENT_IDS.liquidity);
  const tags = new Set(context.tags.flatMap((tag) => [tag, tag.toLowerCase()]));

  if (tags.has("failed-breakout")) return "failed-breakout";
  if (tags.has("failed-breakdown")) return "failed-breakdown";
  if (tags.has("thin-liquidity") || liquidity?.tags.includes("thin-liquidity")) return "thin-liquidity";
  if (regime === "compression" || componentScore(compression) >= 0.72) return "tight-compression";
  if (regime === "range" || componentScore(balance) >= 0.7) return "balanced-auction";
  if (regime === "bullish-expansion" || regime === "bearish-expansion" || regime === "breakout" || regime === "breakdown") return "impulsive-expansion";
  if (regime === "bullish-pullback" || regime === "bearish-pullback") return "orderly-pullback";
  if (regime.includes("trend")) {
    return componentScore(volatility) >= 0.72 ? "volatile-trend" : "clean-trend";
  }
  if (tags.has("choppy") || balance?.tags.includes("chop-risk")) return "choppy";
  return context.direction === "neutral" ? "mixed" : "unknown";
}

function qualityFromScore(score: number): IntelligenceQuality {
  if (score >= 0.92) return "A+";
  if (score >= 0.82) return "A";
  if (score >= 0.7) return "B";
  if (score >= 0.58) return "C";
  if (score >= 0.45) return "D";
  return "F";
}

function resolveProbabilities(
  context: MarketContextSnapshot,
  decision: TradingDecisionResult,
  supplied: Partial<IntelligenceProbabilitySet> = {},
): IntelligenceProbabilitySet {
  const bullish = score01(decision.bullishScore);
  const bearish = score01(decision.bearishScore);
  const neutral = score01(decision.neutralScore);
  const conflictPenalty = decision.conflicts.some((item) => item.severity === "high") ? 0.18 : 0;
  const regimeConfidence = score01(context.regime.confidence);
  const baseConfidence = clamp((score01(context.confidence) + score01(decision.confidence)) / 2 - conflictPenalty);

  return {
    bullishContinuation: score01(supplied.bullishContinuation, decision.direction === "bullish" ? bullish : bullish * 0.55),
    bearishContinuation: score01(supplied.bearishContinuation, decision.direction === "bearish" ? bearish : bearish * 0.55),
    reversal: score01(supplied.reversal, clamp(0.18 + conflictPenalty + (context.regime.status === "weakening" ? 0.2 : 0))),
    balance: score01(supplied.balance, context.regime.family === "range" ? Math.max(0.65, neutral) : neutral),
    expansion: score01(supplied.expansion, context.regime.family === "expansion" ? Math.max(0.68, regimeConfidence) : 0.24),
    trendDay: score01(supplied.trendDay, context.regime.family === "trend" ? Math.max(0.62, regimeConfidence) : 0.22),
    confidence: score01(supplied.confidence, baseConfidence),
  };
}

function evidenceRank(evidence: MarketContextEvidence): number {
  const severity = evidence.severity === "critical" ? 4 : evidence.severity === "warning" ? 3 : evidence.severity === "supporting" ? 2 : 1;
  return severity * Math.max(0.1, evidence.weight) * Math.max(0.1, evidence.confidence);
}

function selectEvidence(
  decision: TradingDecisionResult,
  polarity: "positive" | "negative",
  limit: number,
): MarketContextEvidence[] {
  return decision.evidence
    .filter((item) => item.polarity === polarity)
    .sort((a, b) => evidenceRank(b) - evidenceRank(a))
    .slice(0, limit);
}

function priceObjective(
  id: string,
  label: string,
  price: number,
  direction: MarketContextDirection,
  currentPrice: number | undefined,
  confidence: number,
  priority: number,
  reason: string,
  evidenceIds: string[],
): IntelligenceObjective {
  return {
    id,
    label,
    type: label.toLowerCase().includes("vwap") ? "vwap" : label.toLowerCase().includes("session") || label.toLowerCase().includes("day") || label.toLowerCase().includes("premarket") || label.toLowerCase().includes("overnight") ? "session-level" : "structure-level",
    direction,
    price,
    distance: finite(currentPrice) ? Math.abs(price - currentPrice) : undefined,
    probability: clamp(confidence),
    confidence: clamp(confidence),
    priority,
    reason,
    evidenceIds,
    reached: finite(currentPrice) ? Math.abs(price - currentPrice) <= Math.max(Math.abs(price) * 0.0002, 0.01) : false,
    invalidated: false,
  };
}

function inferObjectives(
  context: MarketContextSnapshot,
  decision: TradingDecisionResult,
  supplied: readonly IntelligenceObjective[] = [],
): IntelligenceObjective[] {
  if (supplied.length) return [...supplied].sort((a, b) => b.priority - a.priority);

  const input = context.input;
  const current = input?.price.last ?? input?.price.close;
  const structure = input?.structure;
  const direction = decision.direction;
  const targets: IntelligenceObjective[] = [];
  const evidenceIds = decision.evidence.map((item) => item.id);

  const candidates: Array<{ id: string; label: string; price?: number; direction: MarketContextDirection; priority: number }> = direction === "bearish"
    ? [
        { id: "objective_swing_low", label: "Recent Swing Low", price: structure?.lastSwingLow ?? structure?.swingLow, direction: "bearish", priority: 100 },
        { id: "objective_support", label: "Nearest Support", price: structure?.support?.filter((value) => !finite(current) || value < current).sort((a, b) => b - a)[0], direction: "bearish", priority: 90 },
        { id: "objective_vwap", label: "VWAP", price: input?.indicators.vwap, direction: "bearish", priority: 70 },
      ]
    : [
        { id: "objective_swing_high", label: "Recent Swing High", price: structure?.lastSwingHigh ?? structure?.swingHigh, direction: "bullish", priority: 100 },
        { id: "objective_resistance", label: "Nearest Resistance", price: structure?.resistance?.filter((value) => !finite(current) || value > current).sort((a, b) => a - b)[0], direction: "bullish", priority: 90 },
        { id: "objective_vwap", label: "VWAP", price: input?.indicators.vwap, direction: "bullish", priority: 70 },
      ];

  for (const candidate of candidates) {
    if (!finite(candidate.price)) continue;
    if (finite(current) && candidate.direction === "bullish" && candidate.price <= current && candidate.id !== "objective_vwap") continue;
    if (finite(current) && candidate.direction === "bearish" && candidate.price >= current && candidate.id !== "objective_vwap") continue;
    targets.push(priceObjective(
      candidate.id,
      candidate.label,
      candidate.price,
      candidate.direction,
      current,
      score01(decision.confidence),
      candidate.priority,
      `${candidate.label} is the next visible level aligned with the active ${candidate.direction} thesis.`,
      evidenceIds,
    ));
  }

  return targets;
}

function trigger(
  id: string,
  label: string,
  description: string,
  direction: MarketContextDirection,
  price: number | undefined,
  decision: TradingDecisionResult,
): IntelligenceTrigger {
  const confirmed = decision.direction === direction && decision.canTrade && !decision.shouldWait;
  return {
    id,
    label,
    description,
    direction,
    status: confirmed ? "confirmed" : decision.shouldWait ? "forming" : "inactive",
    price,
    score: decision.tradeScore,
    confidence: score01(decision.confidence),
    evidenceIds: decision.evidence.map((item) => item.id),
  };
}

function inferTriggers(
  context: MarketContextSnapshot,
  decision: TradingDecisionResult,
  supplied: readonly IntelligenceTrigger[] = [],
): IntelligenceTrigger[] {
  if (supplied.length) return [...supplied];
  const input = context.input;
  const structure = input?.structure;
  const vwap = input?.indicators.vwap;
  const last = input?.price.last ?? input?.price.close;

  const bullPrice = structure?.lastSwingHigh ?? structure?.swingHigh ?? vwap;
  const bearPrice = structure?.lastSwingLow ?? structure?.swingLow ?? vwap;
  const bullDescription = finite(bullPrice)
    ? `Acceptance above ${bullPrice.toFixed(2)} with structure and participation aligned confirms the bullish continuation thesis.`
    : "A higher low followed by renewed momentum confirms the bullish continuation thesis.";
  const bearDescription = finite(bearPrice)
    ? `Acceptance below ${bearPrice.toFixed(2)} with structure and participation aligned confirms the bearish continuation thesis.`
    : "A lower high followed by renewed selling confirms the bearish continuation thesis.";

  return [
    trigger("trigger_bull", "Bullish Confirmation", bullDescription, "bullish", bullPrice, decision),
    trigger("trigger_bear", "Bearish Confirmation", bearDescription, "bearish", bearPrice, decision),
  ].map((item) => ({
    ...item,
    status: finite(last) && finite(item.price)
      ? item.direction === "bullish" && last >= item.price
        ? "confirmed"
        : item.direction === "bearish" && last <= item.price
          ? "confirmed"
          : item.status
      : item.status,
  }));
}

function sideLabel(direction: MarketContextDirection): string {
  return direction === "bullish" ? "buyers" : direction === "bearish" ? "sellers" : "neither side";
}

function buildHeadline(
  direction: MarketContextDirection,
  phase: MarketPhase,
  character: MarketCharacter,
): string {
  if (direction === "neutral") {
    return phase === "balance" || character === "balanced-auction"
      ? "Market remains balanced while both sides compete for control"
      : "Market evidence remains mixed; patience has the highest value";
  }
  return `${titleCase(direction)} ${titleCase(phase)} With ${titleCase(character)}`;
}

function componentSentence(component: MarketContextComponent | undefined): string | null {
  if (!component || !component.summary.trim()) return null;
  return sentence(component.summary);
}

function buildStory(
  context: MarketContextSnapshot,
  decision: TradingDecisionResult,
  phase: MarketPhase,
  objective: IntelligenceObjective | null,
  entryIsChasing: boolean,
  entryIsLate: boolean,
  extensionRisk: number,
  maxSentences: number,
): string {
  const candidates: string[] = [];
  candidates.push(sentence(`${titleCase(phase)} conditions currently favor ${sideLabel(decision.direction)}`));

  const structure = componentSentence(findComponent(context, COMPONENT_IDS.structure));
  const vwap = componentSentence(findComponent(context, COMPONENT_IDS.vwap));
  const momentum = componentSentence(findComponent(context, COMPONENT_IDS.momentum));
  const participation = componentSentence(findComponent(context, COMPONENT_IDS.participation));
  const liquidity = componentSentence(findComponent(context, COMPONENT_IDS.liquidity));

  for (const value of [liquidity, structure, vwap, momentum, participation]) {
    if (value) candidates.push(value);
  }

  if (objective) {
    candidates.push(sentence(`The next visible objective is ${objective.label}${finite(objective.price) ? ` near ${objective.price.toFixed(2)}` : ""}`));
  }
  if (entryIsChasing || entryIsLate || extensionRisk >= 65) {
    candidates.push(sentence("The market thesis may remain valid, but entry quality is deteriorating; waiting for a pullback improves reward-to-risk"));
  }
  if (decision.shouldWait) {
    candidates.push(sentence("Confirmation is still incomplete, so waiting is currently the higher-quality decision"));
  }

  return unique(candidates).slice(0, Math.max(2, maxSentences)).join(" ");
}

function resolveRiskText(decision: TradingDecisionResult, extensionRisk: number): string {
  if (decision.risk.blockers.length) return decision.risk.blockers[0];
  if (extensionRisk >= 65) return "Price is extended from value, reducing entry quality and increasing pullback risk.";
  if (decision.risk.warnings.length) return decision.risk.warnings[0];
  if (decision.conflicts.length) return decision.conflicts[0].description;
  return "No major conflict is currently invalidating the active thesis.";
}

function resolveInvalidation(context: MarketContextSnapshot, decision: TradingDecisionResult): string {
  const input = context.input;
  if (decision.direction === "bullish") {
    const price = input?.structure.lastSwingLow ?? input?.structure.swingLow;
    return finite(price)
      ? `The bullish thesis is invalidated by acceptance below the protected swing low near ${price.toFixed(2)}.`
      : "The bullish thesis is invalidated if price loses the protected higher low and fails to reclaim value.";
  }
  if (decision.direction === "bearish") {
    const price = input?.structure.lastSwingHigh ?? input?.structure.swingHigh;
    return finite(price)
      ? `The bearish thesis is invalidated by acceptance above the protected swing high near ${price.toFixed(2)}.`
      : "The bearish thesis is invalidated if price breaks the protected lower high and accepts back above value.";
  }
  return "The neutral thesis ends when price accepts outside balance with structure, momentum, and participation aligned.";
}

function extractRuntimeInputs(runtime: IntelligenceRegistryRuntime): MarketNarrativeInput {
  let context: MarketContextSnapshot | undefined;
  let decision: TradingDecisionResult | undefined;
  let probabilities: Partial<IntelligenceProbabilitySet> | undefined;
  let objectives: readonly IntelligenceObjective[] | undefined;
  let triggers: readonly IntelligenceTrigger[] | undefined;
  let entryIsChasing = false;
  let entryIsLate = false;
  let extensionRisk = 0;

  for (const value of runtime.shared.values()) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const candidateContext = (record.context ?? record.snapshot) as MarketContextSnapshot | undefined;
    const candidateDecision = record.decision as TradingDecisionResult | undefined;
    if (candidateContext?.components && candidateContext?.regime) context = candidateContext;
    if (candidateDecision?.factors && candidateDecision?.action) decision = candidateDecision;
    if (record.probabilities && typeof record.probabilities === "object") probabilities = record.probabilities as Partial<IntelligenceProbabilitySet>;
    if (Array.isArray(record.objectives)) objectives = record.objectives as IntelligenceObjective[];
    if (Array.isArray(record.triggers)) triggers = record.triggers as IntelligenceTrigger[];
    const entry = record.entry as { isChasing?: boolean; isLate?: boolean; extensionRisk?: number } | undefined;
    const risk = record.risk as { extensionRisk?: number } | undefined;
    entryIsChasing ||= Boolean(entry?.isChasing);
    entryIsLate ||= Boolean(entry?.isLate);
    if (finite(entry?.extensionRisk)) extensionRisk = Math.max(extensionRisk, entry.extensionRisk);
    if (finite(risk?.extensionRisk)) extensionRisk = Math.max(extensionRisk, risk.extensionRisk);
  }

  context ??= runtime.report?.context;
  decision ??= runtime.report?.decision;
  probabilities ??= runtime.report?.probabilities;
  objectives ??= runtime.report?.objectives;
  triggers ??= runtime.report?.triggers;
  entryIsChasing ||= Boolean(runtime.report?.entry.isChasing);
  entryIsLate ||= Boolean(runtime.report?.entry.isLate);
  extensionRisk = Math.max(extensionRisk, runtime.report?.risk.extensionRisk ?? 0);

  if (!context || !decision) {
    throw new Error("MarketNarrativeEngine requires both a MarketContextSnapshot and TradingDecisionResult. Register it after the context and decision engines.");
  }

  return { context, decision, probabilities, objectives, triggers, entryIsChasing, entryIsLate, extensionRisk };
}

export class MarketNarrativeEngine {
  public readonly id = "market-narrative";

  private readonly now: () => number;
  private readonly maxStorySentences: number;
  private readonly maxAlternativeObjectives: number;
  private readonly minimumObjectiveConfidence: number;

  public constructor(options: MarketNarrativeEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxStorySentences = Math.max(2, options.maxStorySentences ?? 6);
    this.maxAlternativeObjectives = Math.max(0, options.maxAlternativeObjectives ?? 3);
    this.minimumObjectiveConfidence = clamp(options.minimumObjectiveConfidence ?? 0.35);
  }

  public evaluate(runtime: IntelligenceRegistryRuntime): MarketNarrativeContribution {
    return this.build(extractRuntimeInputs(runtime));
  }

  public build(input: MarketNarrativeInput): MarketNarrativeContribution {
    const generatedAt = this.now();
    const phase = resolvePhase(input.context);
    const character = resolveCharacter(input.context);
    const probabilities = resolveProbabilities(input.context, input.decision, input.probabilities);
    const objectives = inferObjectives(input.context, input.decision, input.objectives)
      .filter((item) => item.confidence >= this.minimumObjectiveConfidence)
      .sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);
    const triggers = inferTriggers(input.context, input.decision, input.triggers);
    const currentObjective = objectives.find((item) => !item.reached && !item.invalidated) ?? objectives[0] ?? null;
    const alternatives = objectives.filter((item) => item.id !== currentObjective?.id).slice(0, this.maxAlternativeObjectives);
    const nextBullTrigger = triggers.find((item) => item.direction === "bullish" && item.status !== "invalidated" && item.status !== "expired") ?? null;
    const nextBearTrigger = triggers.find((item) => item.direction === "bearish" && item.status !== "invalidated" && item.status !== "expired") ?? null;
    const extensionRisk = Math.max(0, input.extensionRisk ?? 0);
    const story = buildStory(
      input.context,
      input.decision,
      phase,
      currentObjective,
      Boolean(input.entryIsChasing),
      Boolean(input.entryIsLate),
      extensionRisk,
      this.maxStorySentences,
    );

    const positive = selectEvidence(input.decision, "positive", 8);
    const negative = selectEvidence(input.decision, "negative", 8);
    const confidence = probabilities.confidence;
    const quality = qualityFromScore(clamp((score01(input.decision.tradeScore) + confidence) / 2));
    const riskText = resolveRiskText(input.decision, extensionRisk);
    const invalidation = resolveInvalidation(input.context, input.decision);
    const headline = buildHeadline(input.decision.direction, phase, character);
    const shortSummary = input.decision.shouldWait
      ? `${titleCase(input.decision.direction)} thesis forming; wait for confirmation.`
      : input.decision.canTrade
        ? `${titleCase(input.decision.direction)} thesis confirmed with ${Math.round(confidence * 100)}% narrative confidence.`
        : "Market quality is insufficient for a new trade.";

    const narrative: IntelligenceNarrative = {
      headline,
      story,
      shortSummary,
      phase,
      regime: input.context.regime.regime,
      dominantSide: input.decision.direction,
      marketCharacter: character,
      currentObjective,
      alternativeObjectives: alternatives,
      nextBullTrigger,
      nextBearTrigger,
      currentRisk: riskText,
      invalidation,
      quality,
      confidence,
      probabilities,
      supportingEvidenceIds: positive.map((item) => item.id),
      conflictingEvidenceIds: unique([
        ...negative.map((item) => item.id),
        ...input.decision.conflicts.flatMap((item) => item.componentIds),
      ]),
      generatedAt,
    };

    return {
      narrative,
      probabilities,
      objectives,
      triggers,
      tags: unique([
        "market-narrative",
        `phase:${phase}`,
        `character:${character}`,
        `dominant:${input.decision.direction}`,
        `quality:${quality}`,
      ]),
      metadata: {
        narrativeEngineId: this.id,
        narrativeGeneratedAt: generatedAt,
        narrativeRegime: input.context.regime.regime as MarketRegime,
        narrativeObjectiveId: currentObjective?.id ?? null,
      },
    };
  }
}

export default MarketNarrativeEngine;
