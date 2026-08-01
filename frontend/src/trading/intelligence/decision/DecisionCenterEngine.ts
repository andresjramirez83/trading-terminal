// src/trading/intelligence/decision/DecisionCenterEngine.ts

/**
 * Decision-center projection for the Trading OS intelligence layer.
 *
 * This engine does not recalculate market intelligence. It converts the shared
 * context, decision, narrative, coach, risk, and entry assessments into one
 * stable UI-facing model. Live Trading, Practice Center, Replay, Scanner, and
 * future mobile views can render the same state without duplicating rules.
 */

import type {
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextSnapshot,
} from "../types/MarketContextTypes";
import type {
  TradingDecisionAction,
  TradingDecisionConflict,
  TradingDecisionFactor,
  TradingDecisionResult,
  TradingDecisionRiskLevel,
} from "../evaluators/TradingDecisionEngine";
import type { IntelligenceRegistryRuntime } from "../core/IntelligenceRegistry";
import type {
  CoachMessage,
  IntelligenceCoachAssessment,
  IntelligenceEntryAssessment,
  IntelligenceNarrative,
  IntelligenceObjective,
  IntelligenceProbabilitySet,
  IntelligenceQuality,
  IntelligenceRecommendation,
  IntelligenceRecommendationAction,
  IntelligenceRiskAssessment,
  IntelligenceTrigger,
  MarketIntelligenceReport,
} from "../core/IntelligenceTypes";

export type DecisionCenterTone =
  | "positive"
  | "warning"
  | "negative"
  | "neutral"
  | "muted";

export type DecisionCenterReadiness =
  | "ready"
  | "forming"
  | "waiting"
  | "blocked"
  | "managing";

export type DecisionCenterUrgency = "low" | "normal" | "high" | "critical";

export interface DecisionCenterBadge {
  id: string;
  label: string;
  tone: DecisionCenterTone;
  tooltip?: string;
}

export interface DecisionCenterMeter {
  label: string;
  value: number;
  tone: DecisionCenterTone;
  detail: string;
}

export interface DecisionCenterReasonItem {
  id: string;
  label: string;
  description: string;
  tone: DecisionCenterTone;
  score: number;
  confidence: number;
  category: string;
  evidenceIds: string[];
}

export interface DecisionCenterConflictItem {
  id: string;
  label: string;
  description: string;
  severity: "low" | "medium" | "high";
  tone: DecisionCenterTone;
  componentIds: string[];
}

export interface DecisionCenterTriggerItem {
  id: string;
  label: string;
  description: string;
  direction: MarketContextDirection;
  status: IntelligenceTrigger["status"];
  price?: number;
  confidence: number;
  tone: DecisionCenterTone;
}

export interface DecisionCenterObjectiveItem {
  id: string;
  label: string;
  type: IntelligenceObjective["type"];
  direction: MarketContextDirection;
  price?: number;
  probability: number;
  confidence: number;
  priority: number;
  reached: boolean;
  invalidated: boolean;
  tone: DecisionCenterTone;
  reason: string;
}

export interface DecisionCenterActionModel {
  action: IntelligenceRecommendationAction;
  label: string;
  direction: MarketContextDirection;
  readiness: DecisionCenterReadiness;
  urgency: DecisionCenterUrgency;
  tone: DecisionCenterTone;
  canTrade: boolean;
  shouldWait: boolean;
  requiresConfirmation: boolean;
  summary: string;
  rationale: string;
  nextStep: string;
  invalidation: string;
}

export interface DecisionCenterRiskModel {
  level: TradingDecisionRiskLevel;
  score: number;
  approved: boolean;
  tone: DecisionCenterTone;
  rewardRiskRatio?: number;
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  invalidationPrice?: number;
  headline: string;
  blockers: string[];
  warnings: string[];
  strengths: string[];
}

export interface DecisionCenterEntryModel {
  grade: IntelligenceQuality;
  score: number;
  approved: boolean;
  tone: DecisionCenterTone;
  direction: MarketContextDirection;
  locationScore: number;
  timingScore: number;
  confirmationScore: number;
  confluenceScore: number;
  rewardRiskScore: number;
  chaseRisk: number;
  extensionRisk: number;
  isEarly: boolean;
  isLate: boolean;
  isChasing: boolean;
  headline: string;
  reasons: string[];
  warnings: string[];
}

export interface DecisionCenterCoachModel {
  headline: string;
  summary: string;
  recommendation: string;
  immediateAction: IntelligenceRecommendationAction;
  processScore: number;
  patienceScore: number;
  disciplineScore: number;
  confidence: number;
  shouldInterrupt: boolean;
  shouldWarn: boolean;
  primaryMessage: CoachMessage | null;
  messages: CoachMessage[];
  strengths: string[];
  improvements: string[];
}

export interface DecisionCenterMarketModel {
  headline: string;
  summary: string;
  story: string;
  direction: MarketContextDirection;
  phase: IntelligenceNarrative["phase"];
  regime: IntelligenceNarrative["regime"];
  character: IntelligenceNarrative["marketCharacter"];
  dominantSide: MarketContextDirection;
  currentRisk: string;
  invalidation: string;
}

export interface DecisionCenterState {
  symbol: string;
  timeframe: string;
  timestamp: number;
  generatedAt: number;
  grade: IntelligenceQuality;
  marketConfidence: number;
  convictionScore: number;
  tradeScore: number;
  readinessScore: number;
  readiness: DecisionCenterReadiness;
  direction: MarketContextDirection;
  tone: DecisionCenterTone;
  action: DecisionCenterActionModel;
  market: DecisionCenterMarketModel;
  risk: DecisionCenterRiskModel;
  entry: DecisionCenterEntryModel;
  coach: DecisionCenterCoachModel;
  probabilities: IntelligenceProbabilitySet;
  meters: DecisionCenterMeter[];
  badges: DecisionCenterBadge[];
  supportingReasons: DecisionCenterReasonItem[];
  opposingReasons: DecisionCenterReasonItem[];
  conflicts: DecisionCenterConflictItem[];
  blockers: string[];
  warnings: string[];
  objectives: DecisionCenterObjectiveItem[];
  triggers: DecisionCenterTriggerItem[];
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface DecisionCenterInput {
  context: MarketContextSnapshot;
  decision: TradingDecisionResult;
  narrative: IntelligenceNarrative;
  coach: IntelligenceCoachAssessment;
  risk: IntelligenceRiskAssessment;
  entry: IntelligenceEntryAssessment;
  recommendation: IntelligenceRecommendation;
  probabilities?: IntelligenceProbabilitySet;
  objectives?: readonly IntelligenceObjective[];
  triggers?: readonly IntelligenceTrigger[];
  report?: MarketIntelligenceReport | null;
}

export interface DecisionCenterContribution {
  tags: string[];
  warnings: string[];
  metadata: {
    decisionCenter: DecisionCenterState;
  };
}

export interface DecisionCenterEngineOptions {
  now?: () => number;
  maximumReasons?: number;
  maximumConflicts?: number;
  maximumObjectives?: number;
  maximumTriggers?: number;
  readyThreshold?: number;
  formingThreshold?: number;
}

const DEFAULT_MAXIMUM_REASONS = 6;
const DEFAULT_MAXIMUM_CONFLICTS = 5;
const DEFAULT_MAXIMUM_OBJECTIVES = 4;
const DEFAULT_MAXIMUM_TRIGGERS = 4;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function score100(value: unknown, fallback = 50): number {
  if (!finite(value)) return fallback;
  return clamp(value >= 0 && value <= 1 ? value * 100 : value);
}

function probability100(value: unknown, fallback = 50): number {
  return Math.round(score100(value, fallback));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeGrade(
  value: IntelligenceQuality | undefined,
  score: number,
): IntelligenceQuality {
  if (value) return value;
  if (score >= 92) return "A+";
  if (score >= 82) return "A";
  if (score >= 70) return "B";
  if (score >= 58) return "C";
  if (score >= 45) return "D";
  return "F";
}

function directionTone(direction: MarketContextDirection): DecisionCenterTone {
  if (direction === "bullish") return "positive";
  if (direction === "bearish") return "negative";
  return "neutral";
}

function riskTone(level: TradingDecisionRiskLevel): DecisionCenterTone {
  if (level === "low") return "positive";
  if (level === "moderate") return "warning";
  return "negative";
}

function scoreTone(score: number): DecisionCenterTone {
  if (score >= 75) return "positive";
  if (score >= 55) return "warning";
  if (score >= 40) return "neutral";
  return "negative";
}

function actionTone(
  action: IntelligenceRecommendationAction,
  direction: MarketContextDirection,
): DecisionCenterTone {
  if (action === "avoid" || action === "cancel" || action === "exit") {
    return "negative";
  }
  if (action === "wait" || action === "observe" || action === "prepare") {
    return "warning";
  }
  if (action === "reduce" || action === "review") return "warning";
  return directionTone(direction);
}

function actionUrgency(
  action: IntelligenceRecommendationAction,
  coach: IntelligenceCoachAssessment,
  risk: IntelligenceRiskAssessment,
): DecisionCenterUrgency {
  if (coach.shouldInterrupt || risk.level === "extreme") return "critical";
  if (coach.shouldWarn || risk.level === "high") return "high";
  if (action === "enter-long" || action === "enter-short" || action === "exit") {
    return "high";
  }
  if (action === "prepare" || action === "reduce" || action === "cancel") {
    return "normal";
  }
  return "low";
}

function nextStepFromInput(input: DecisionCenterInput): string {
  const { recommendation, narrative, coach } = input;
  const message = coach.messages
    .slice()
    .sort((left, right) => right.priority - left.priority)[0];

  if (message?.action) return message.action;
  if (recommendation.nextTriggerId) {
    const trigger = (input.triggers ?? []).find(
      (item) => item.id === recommendation.nextTriggerId,
    );
    if (trigger) return trigger.description || trigger.label;
  }
  if (recommendation.shouldWait) {
    const trigger =
      recommendation.direction === "bearish"
        ? narrative.nextBearTrigger
        : narrative.nextBullTrigger;
    if (trigger) return trigger.description || trigger.label;
    return "Wait for confirmation before committing risk.";
  }
  return recommendation.summary || coach.recommendation;
}

function readinessFrom(
  input: DecisionCenterInput,
  readinessScore: number,
  readyThreshold: number,
  formingThreshold: number,
): DecisionCenterReadiness {
  if (input.report?.metadata?.hasOpenPosition === true) return "managing";
  if (!input.recommendation.canTrade || input.risk.approved === false) return "blocked";
  if (input.recommendation.shouldWait) {
    return readinessScore >= formingThreshold ? "forming" : "waiting";
  }
  if (readinessScore >= readyThreshold && input.entry.approved) return "ready";
  return readinessScore >= formingThreshold ? "forming" : "waiting";
}

function factorEvidenceIds(
  factor: TradingDecisionFactor,
  evidence: readonly MarketContextEvidence[],
): string[] {
  return evidence
    .filter(
      (item) =>
        item.source === factor.componentId ||
        item.category === factor.category,
    )
    .map((item) => item.id);
}

function mapFactor(
  factor: TradingDecisionFactor,
  decision: TradingDecisionResult,
): DecisionCenterReasonItem {
  const value = score100(factor.weightedScore, score100(factor.score));
  const negative = factor.blocking || !factor.supportive;
  return {
    id: factor.id,
    label: factor.label,
    description: `${factor.category} is ${negative ? "opposing" : "supporting"} the ${decision.direction} thesis.`,
    tone: factor.blocking ? "negative" : negative ? "warning" : directionTone(factor.direction),
    score: Math.round(value),
    confidence: probability100(factor.confidence),
    category: factor.category,
    evidenceIds: factorEvidenceIds(factor, decision.evidence),
  };
}

function mapConflict(conflict: TradingDecisionConflict): DecisionCenterConflictItem {
  return {
    id: conflict.id,
    label: conflict.label,
    description: conflict.description,
    severity: conflict.severity,
    tone: conflict.severity === "high" ? "negative" : "warning",
    componentIds: [...conflict.componentIds],
  };
}

function mapObjective(objective: IntelligenceObjective): DecisionCenterObjectiveItem {
  return {
    id: objective.id,
    label: objective.label,
    type: objective.type,
    direction: objective.direction,
    price: objective.price,
    probability: probability100(objective.probability),
    confidence: probability100(objective.confidence),
    priority: objective.priority,
    reached: objective.reached,
    invalidated: objective.invalidated,
    tone: objective.invalidated
      ? "negative"
      : objective.reached
        ? "positive"
        : directionTone(objective.direction),
    reason: objective.reason,
  };
}

function mapTrigger(trigger: IntelligenceTrigger): DecisionCenterTriggerItem {
  let tone: DecisionCenterTone = directionTone(trigger.direction);
  if (trigger.status === "invalidated" || trigger.status === "expired") {
    tone = "negative";
  } else if (trigger.status === "forming" || trigger.status === "armed") {
    tone = "warning";
  } else if (trigger.status === "inactive") {
    tone = "muted";
  }

  return {
    id: trigger.id,
    label: trigger.label,
    description: trigger.description,
    direction: trigger.direction,
    status: trigger.status,
    price: trigger.price,
    confidence: probability100(trigger.confidence),
    tone,
  };
}

function resolveReadinessScore(input: DecisionCenterInput): number {
  const trade = score100(input.decision.tradeScore);
  const confidence = score100(input.decision.confidence);
  const entry = score100(input.entry.score);
  const riskApproval = input.risk.approved
    ? clamp(100 - score100(input.risk.score, 35))
    : clamp(55 - score100(input.risk.score, 55) * 0.4);
  const conflictPenalty = input.decision.conflicts.reduce(
    (total, conflict) =>
      total + (conflict.severity === "high" ? 12 : conflict.severity === "medium" ? 6 : 3),
    0,
  );
  const blockerPenalty = input.recommendation.blockers.length * 10;

  return Math.round(
    clamp(
      trade * 0.3 +
        confidence * 0.2 +
        entry * 0.3 +
        riskApproval * 0.2 -
        conflictPenalty -
        blockerPenalty,
    ),
  );
}

function buildMeters(input: DecisionCenterInput): DecisionCenterMeter[] {
  const probabilities = input.probabilities ?? input.narrative.probabilities;
  const riskQuality = clamp(100 - score100(input.risk.score));

  return [
    {
      label: "Market Confidence",
      value: Math.round(score100(input.narrative.confidence)),
      tone: scoreTone(score100(input.narrative.confidence)),
      detail: input.narrative.marketCharacter.replace(/-/g, " "),
    },
    {
      label: "Trade Quality",
      value: Math.round(score100(input.decision.tradeScore)),
      tone: scoreTone(score100(input.decision.tradeScore)),
      detail: `${input.decision.grade} setup`,
    },
    {
      label: "Entry Quality",
      value: Math.round(score100(input.entry.score)),
      tone: input.entry.approved ? scoreTone(score100(input.entry.score)) : "negative",
      detail: input.entry.isChasing
        ? "Chasing risk"
        : input.entry.isLate
          ? "Late entry"
          : input.entry.isEarly
            ? "Early entry"
            : "Timing acceptable",
    },
    {
      label: "Risk Quality",
      value: Math.round(riskQuality),
      tone: riskTone(input.risk.level),
      detail: `${input.risk.level} risk`,
    },
    {
      label: "Continuation",
      value:
        input.decision.direction === "bearish"
          ? probability100(probabilities.bearishContinuation)
          : probability100(probabilities.bullishContinuation),
      tone: directionTone(input.decision.direction),
      detail: `${input.decision.direction} continuation`,
    },
    {
      label: "Process",
      value: Math.round(score100(input.coach.processScore)),
      tone: scoreTone(score100(input.coach.processScore)),
      detail: input.coach.shouldWarn ? "Coach warning active" : "Process aligned",
    },
  ];
}

function buildBadges(input: DecisionCenterInput): DecisionCenterBadge[] {
  const badges: DecisionCenterBadge[] = [
    {
      id: "phase",
      label: input.narrative.phase.replace(/-/g, " "),
      tone: directionTone(input.narrative.dominantSide),
      tooltip: "Current market phase",
    },
    {
      id: "regime",
      label: input.narrative.regime.replace(/-/g, " "),
      tone: directionTone(input.decision.direction),
      tooltip: "Current market regime",
    },
    {
      id: "grade",
      label: input.recommendation.grade,
      tone: scoreTone(score100(input.recommendation.score)),
      tooltip: "Overall opportunity grade",
    },
  ];

  if (input.entry.isChasing) {
    badges.push({ id: "chasing", label: "Do Not Chase", tone: "negative" });
  }
  if (input.decision.shouldWait) {
    badges.push({ id: "waiting", label: "Confirmation Needed", tone: "warning" });
  }
  if (input.risk.approved && input.entry.approved && input.decision.canTrade) {
    badges.push({ id: "approved", label: "Trade Approved", tone: "positive" });
  }
  if (input.coach.shouldInterrupt) {
    badges.push({ id: "coach-interrupt", label: "Coach Alert", tone: "negative" });
  }

  return badges;
}

function findShared<T>(
  runtime: IntelligenceRegistryRuntime,
  predicate: (value: unknown) => value is T,
): T | undefined {
  for (const value of runtime.shared.values()) {
    if (predicate(value)) return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const nested of Object.values(record)) {
        if (predicate(nested)) return nested;
      }
    }
  }
  return undefined;
}

function isContext(value: unknown): value is MarketContextSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as MarketContextSnapshot).symbol === "string" &&
      Array.isArray((value as MarketContextSnapshot).components) &&
      (value as MarketContextSnapshot).regime,
  );
}

function isDecision(value: unknown): value is TradingDecisionResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as TradingDecisionResult).action === "string" &&
      Array.isArray((value as TradingDecisionResult).factors) &&
      Array.isArray((value as TradingDecisionResult).conflicts),
  );
}

function isNarrative(value: unknown): value is IntelligenceNarrative {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as IntelligenceNarrative).headline === "string" &&
      typeof (value as IntelligenceNarrative).story === "string" &&
      (value as IntelligenceNarrative).probabilities,
  );
}

function isCoach(value: unknown): value is IntelligenceCoachAssessment {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as IntelligenceCoachAssessment).recommendation === "string" &&
      Array.isArray((value as IntelligenceCoachAssessment).messages),
  );
}

function isRisk(value: unknown): value is IntelligenceRiskAssessment {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as IntelligenceRiskAssessment).approved === "boolean" &&
      typeof (value as IntelligenceRiskAssessment).level === "string" &&
      Array.isArray((value as IntelligenceRiskAssessment).blockers),
  );
}

function isEntry(value: unknown): value is IntelligenceEntryAssessment {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as IntelligenceEntryAssessment).approved === "boolean" &&
      typeof (value as IntelligenceEntryAssessment).grade === "string" &&
      typeof (value as IntelligenceEntryAssessment).locationScore === "number",
  );
}

function isRecommendation(value: unknown): value is IntelligenceRecommendation {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as IntelligenceRecommendation).action === "string" &&
      typeof (value as IntelligenceRecommendation).canTrade === "boolean" &&
      Array.isArray((value as IntelligenceRecommendation).blockers),
  );
}

export class DecisionCenterEngine {
  public readonly id = "decision-center-engine";

  private readonly now: () => number;
  private readonly maximumReasons: number;
  private readonly maximumConflicts: number;
  private readonly maximumObjectives: number;
  private readonly maximumTriggers: number;
  private readonly readyThreshold: number;
  private readonly formingThreshold: number;

  public constructor(options: DecisionCenterEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maximumReasons = Math.max(1, options.maximumReasons ?? DEFAULT_MAXIMUM_REASONS);
    this.maximumConflicts = Math.max(1, options.maximumConflicts ?? DEFAULT_MAXIMUM_CONFLICTS);
    this.maximumObjectives = Math.max(1, options.maximumObjectives ?? DEFAULT_MAXIMUM_OBJECTIVES);
    this.maximumTriggers = Math.max(1, options.maximumTriggers ?? DEFAULT_MAXIMUM_TRIGGERS);
    this.readyThreshold = clamp(options.readyThreshold ?? 72);
    this.formingThreshold = clamp(options.formingThreshold ?? 52);
  }

  public build(input: DecisionCenterInput): DecisionCenterState {
    const generatedAt = this.now();
    const tradeScore = Math.round(score100(input.decision.tradeScore));
    const convictionScore = Math.round(score100(input.decision.convictionScore));
    const marketConfidence = Math.round(score100(input.narrative.confidence));
    const readinessScore = resolveReadinessScore(input);
    const readiness = readinessFrom(
      input,
      readinessScore,
      this.readyThreshold,
      this.formingThreshold,
    );
    const recommendation = input.recommendation;
    const action = recommendation.action;
    const sortedMessages = input.coach.messages
      .slice()
      .sort((left, right) => right.priority - left.priority);

    const supportingReasons = input.decision.factors
      .filter((factor) => factor.supportive && !factor.blocking)
      .sort((left, right) => right.weightedScore - left.weightedScore)
      .slice(0, this.maximumReasons)
      .map((factor) => mapFactor(factor, input.decision));

    const opposingReasons = input.decision.factors
      .filter((factor) => !factor.supportive || factor.blocking)
      .sort((left, right) => {
        if (left.blocking !== right.blocking) return left.blocking ? -1 : 1;
        return Math.abs(right.weightedScore) - Math.abs(left.weightedScore);
      })
      .slice(0, this.maximumReasons)
      .map((factor) => mapFactor(factor, input.decision));

    const blockers = unique([
      ...recommendation.blockers,
      ...input.risk.blockers,
      ...input.decision.blockingComponents,
    ]);
    const warnings = unique([
      ...recommendation.warnings,
      ...input.risk.warnings,
      ...input.entry.warnings,
      ...input.coach.improvements,
    ]);

    const state: DecisionCenterState = {
      symbol: input.decision.symbol || input.context.symbol,
      timeframe: input.decision.timeframe || input.context.timeframe,
      timestamp: input.decision.timestamp || input.context.timestamp,
      generatedAt,
      grade: normalizeGrade(recommendation.grade, tradeScore),
      marketConfidence,
      convictionScore,
      tradeScore,
      readinessScore,
      readiness,
      direction: recommendation.direction,
      tone: actionTone(action, recommendation.direction),
      action: {
        action,
        label: recommendation.label,
        direction: recommendation.direction,
        readiness,
        urgency: actionUrgency(action, input.coach, input.risk),
        tone: actionTone(action, recommendation.direction),
        canTrade: recommendation.canTrade,
        shouldWait: recommendation.shouldWait,
        requiresConfirmation: recommendation.requiresConfirmation,
        summary: recommendation.summary,
        rationale: recommendation.rationale,
        nextStep: nextStepFromInput(input),
        invalidation: recommendation.invalidation || input.narrative.invalidation,
      },
      market: {
        headline: input.narrative.headline,
        summary: input.narrative.shortSummary,
        story: input.narrative.story,
        direction: input.decision.direction,
        phase: input.narrative.phase,
        regime: input.narrative.regime,
        character: input.narrative.marketCharacter,
        dominantSide: input.narrative.dominantSide,
        currentRisk: input.narrative.currentRisk,
        invalidation: input.narrative.invalidation,
      },
      risk: {
        level: input.risk.level,
        score: Math.round(score100(input.risk.score)),
        approved: input.risk.approved,
        tone: riskTone(input.risk.level),
        rewardRiskRatio: input.risk.rewardRiskRatio,
        entryPrice: input.risk.entryPrice,
        stopPrice: input.risk.stopPrice,
        targetPrice: input.risk.targetPrice,
        invalidationPrice: input.risk.invalidationPrice,
        headline: input.risk.approved
          ? `${input.risk.level} risk — approved`
          : `${input.risk.level} risk — blocked`,
        blockers: [...input.risk.blockers],
        warnings: [...input.risk.warnings],
        strengths: [...input.risk.strengths],
      },
      entry: {
        grade: input.entry.grade,
        score: Math.round(score100(input.entry.score)),
        approved: input.entry.approved,
        tone: input.entry.approved
          ? scoreTone(score100(input.entry.score))
          : "negative",
        direction: input.entry.direction,
        locationScore: Math.round(score100(input.entry.locationScore)),
        timingScore: Math.round(score100(input.entry.timingScore)),
        confirmationScore: Math.round(score100(input.entry.confirmationScore)),
        confluenceScore: Math.round(score100(input.entry.confluenceScore)),
        rewardRiskScore: Math.round(score100(input.entry.rewardRiskScore)),
        chaseRisk: Math.round(score100(input.entry.chaseRisk)),
        extensionRisk: Math.round(score100(input.entry.extensionRisk)),
        isEarly: input.entry.isEarly,
        isLate: input.entry.isLate,
        isChasing: input.entry.isChasing,
        headline: input.entry.isChasing
          ? "Entry is extended — do not chase"
          : input.entry.isLate
            ? "Entry timing is late"
            : input.entry.isEarly
              ? "Entry needs confirmation"
              : input.entry.approved
                ? "Entry quality approved"
                : "Entry quality not approved",
        reasons: [...input.entry.reasons],
        warnings: [...input.entry.warnings],
      },
      coach: {
        headline: input.coach.headline,
        summary: input.coach.summary,
        recommendation: input.coach.recommendation,
        immediateAction: input.coach.immediateAction,
        processScore: Math.round(score100(input.coach.processScore)),
        patienceScore: Math.round(score100(input.coach.patienceScore)),
        disciplineScore: Math.round(score100(input.coach.disciplineScore)),
        confidence: Math.round(score100(input.coach.confidence)),
        shouldInterrupt: input.coach.shouldInterrupt,
        shouldWarn: input.coach.shouldWarn,
        primaryMessage: sortedMessages[0] ?? null,
        messages: sortedMessages,
        strengths: [...input.coach.strengths],
        improvements: [...input.coach.improvements],
      },
      probabilities: input.probabilities ?? input.narrative.probabilities,
      meters: buildMeters(input),
      badges: buildBadges(input),
      supportingReasons,
      opposingReasons,
      conflicts: input.decision.conflicts
        .slice()
        .sort((left, right) => {
          const rank = { high: 3, medium: 2, low: 1 } as const;
          return rank[right.severity] - rank[left.severity];
        })
        .slice(0, this.maximumConflicts)
        .map(mapConflict),
      blockers,
      warnings,
      objectives: (input.objectives ?? [
        ...(input.narrative.currentObjective ? [input.narrative.currentObjective] : []),
        ...input.narrative.alternativeObjectives,
      ])
        .slice()
        .sort((left, right) => right.priority - left.priority)
        .slice(0, this.maximumObjectives)
        .map(mapObjective),
      triggers: (input.triggers ?? [
        ...(input.narrative.nextBullTrigger ? [input.narrative.nextBullTrigger] : []),
        ...(input.narrative.nextBearTrigger ? [input.narrative.nextBearTrigger] : []),
      ])
        .slice(0, this.maximumTriggers)
        .map(mapTrigger),
      tags: unique([
        ...input.decision.tags,
        `decision-center:${readiness}`,
        `decision-action:${action}`,
        `decision-grade:${recommendation.grade}`,
      ]),
      metadata: {
        decisionAction: input.decision.action,
        recommendationAction: action,
        decisionRiskLevel: input.decision.risk.level,
        narrativeQuality: input.narrative.quality,
        contextSnapshotId: input.context.id,
      },
    };

    return state;
  }

  /** Registry-compatible execution path used by MasterIntelligenceEngine. */
  public evaluate(runtime: IntelligenceRegistryRuntime): DecisionCenterContribution {
    const report = runtime.report;
    const context = report?.context ?? findShared(runtime, isContext);
    const decision = report?.decision ?? findShared(runtime, isDecision);
    const narrative = report?.narrative ?? findShared(runtime, isNarrative);
    const coach = report?.coach ?? findShared(runtime, isCoach);
    const risk = report?.risk ?? findShared(runtime, isRisk);
    const entry = report?.entry ?? findShared(runtime, isEntry);
    const recommendation = report?.recommendation ?? findShared(runtime, isRecommendation);

    if (!context || !decision || !narrative || !coach || !risk || !entry || !recommendation) {
      const missing = [
        !context && "context",
        !decision && "decision",
        !narrative && "narrative",
        !coach && "coach",
        !risk && "risk",
        !entry && "entry",
        !recommendation && "recommendation",
      ].filter(Boolean);
      throw new Error(
        `DecisionCenterEngine is missing required intelligence inputs: ${missing.join(", ")}.`,
      );
    }

    const state = this.build({
      context,
      decision,
      narrative,
      coach,
      risk,
      entry,
      recommendation,
      probabilities: report?.probabilities,
      objectives: report?.objectives,
      triggers: report?.triggers,
      report,
    });

    runtime.shared.set("decisionCenter", state);

    return {
      tags: state.tags,
      warnings: state.warnings,
      metadata: { decisionCenter: state },
    };
  }
}

export function buildDecisionCenterState(
  input: DecisionCenterInput,
  options?: DecisionCenterEngineOptions,
): DecisionCenterState {
  return new DecisionCenterEngine(options).build(input);
}

export function decisionActionToLegacyLabel(
  action: IntelligenceRecommendationAction | TradingDecisionAction,
): "BUY" | "WAIT" | "SELL" | "AVOID" {
  if (
    action === "strong-long" ||
    action === "long" ||
    action === "enter-long"
  ) {
    return "BUY";
  }
  if (
    action === "strong-short" ||
    action === "short" ||
    action === "enter-short" ||
    action === "exit"
  ) {
    return "SELL";
  }
  if (action === "avoid" || action === "cancel") return "AVOID";
  return "WAIT";
}
