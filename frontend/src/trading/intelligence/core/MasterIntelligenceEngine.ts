// src/trading/intelligence/core/MasterIntelligenceEngine.ts

/**
 * Central orchestration engine for the Trading OS intelligence layer.
 *
 * Every consumer sends one MarketIntelligenceRequest here. The engine creates
 * an immutable IntelligenceContext, resolves the correct registry components,
 * executes them in dependency order, merges their contributions, and returns
 * one MarketIntelligenceReport shared by Live Trading, Practice Center, Replay,
 * Scanner, Decision Center, AI Coach, Journal, Trading DNA, and Auto Trader.
 */

import type {
  MarketContextDelta,
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextMetric,
  MarketContextReason,
  MarketContextSnapshot,
  MarketContextStrength,
} from "../types/MarketContextTypes";
import type { TradingDecisionResult } from "../evaluators/TradingDecisionEngine";
import type { MarketMemoryEngineResult } from "../../memory/MarketMemoryEngine";
import {
  IntelligenceContext,
  IntelligenceContextError,
  type IntelligenceContextIssue,
  type IntelligenceContextOptions,
} from "./IntelligenceContext";
import {
  IntelligenceRegistry,
  type IntelligenceRegistrationKind,
  type IntelligenceRegistryRuntime,
  type ResolvedIntelligenceRegistration,
} from "./IntelligenceRegistry";
import {
  INTELLIGENCE_REPORT_VERSION,
  type IntelligenceCoachAssessment,
  type IntelligenceDiagnostics,
  type IntelligenceEngine,
  type IntelligenceEntryAssessment,
  type IntelligenceExecutionAssessment,
  type IntelligenceNarrative,
  type IntelligenceObjective,
  type IntelligenceProbabilitySet,
  type IntelligenceQuality,
  type IntelligenceRecommendation,
  type IntelligenceReportListener,
  type IntelligenceRiskAssessment,
  type IntelligenceTrigger,
  type MarketIntelligenceBuildResult,
  type MarketIntelligenceReport,
  type MarketIntelligenceRequest,
} from "./IntelligenceTypes";

const EXECUTION_KINDS: readonly IntelligenceRegistrationKind[] = [
  "context-evaluator",
  "event-engine",
  "memory-engine",
  "decision-engine",
  "narrative-engine",
  "coach-engine",
  "execution-evaluator",
  "report-enricher",
];

export interface IntelligenceStageContribution {
  context?: MarketContextSnapshot;
  contextDelta?: MarketContextDelta | null;
  decision?: TradingDecisionResult;
  memory?: MarketMemoryEngineResult;
  narrative?: IntelligenceNarrative;
  coach?: IntelligenceCoachAssessment;
  risk?: IntelligenceRiskAssessment;
  entry?: IntelligenceEntryAssessment;
  execution?: IntelligenceExecutionAssessment | null;
  recommendation?: IntelligenceRecommendation;
  probabilities?: Partial<IntelligenceProbabilitySet>;
  objectives?: readonly IntelligenceObjective[];
  triggers?: readonly IntelligenceTrigger[];
  evidence?: readonly MarketContextEvidence[];
  reasons?: readonly MarketContextReason[];
  metrics?: readonly MarketContextMetric[];
  tags?: readonly string[];
  warnings?: readonly string[];
  metadata?: Record<string, unknown>;
  report?: MarketIntelligenceReport;
}

export interface IntelligenceComponentFailure {
  registrationId: string;
  kind: IntelligenceRegistrationKind;
  required: boolean;
  message: string;
  error: unknown;
}

export interface MasterIntelligenceEngineOptions {
  registry?: IntelligenceRegistry;
  context?: IntelligenceContextOptions;
  now?: () => number;
  idFactory?: (prefix: string, timestamp: number) => string;
  staleAfterMs?: number;
  continueOnOptionalFailure?: boolean;
  markFailedRegistrations?: boolean;
  executionKinds?: readonly IntelligenceRegistrationKind[];
}

export interface MasterIntelligenceRunOptions {
  signal?: AbortSignal;
  shared?: Map<string, unknown>;
  executionKinds?: readonly IntelligenceRegistrationKind[];
}

export class MasterIntelligenceEngineError extends Error {
  public readonly code: string;
  public readonly failures: readonly IntelligenceComponentFailure[];
  public readonly issues: readonly IntelligenceContextIssue[];

  public constructor(
    code: string,
    message: string,
    options: {
      failures?: readonly IntelligenceComponentFailure[];
      issues?: readonly IntelligenceContextIssue[];
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "MasterIntelligenceEngineError";
    this.code = code;
    this.failures = [...(options.failures ?? [])];
    this.issues = [...(options.issues ?? [])];
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
      });
    }
  }
}

interface BuildAccumulator {
  context?: MarketContextSnapshot;
  contextDelta: MarketContextDelta | null;
  decision?: TradingDecisionResult;
  memory?: MarketMemoryEngineResult;
  narrative?: IntelligenceNarrative;
  coach?: IntelligenceCoachAssessment;
  risk?: IntelligenceRiskAssessment;
  entry?: IntelligenceEntryAssessment;
  execution: IntelligenceExecutionAssessment | null;
  recommendation?: IntelligenceRecommendation;
  probabilities: Partial<IntelligenceProbabilitySet>;
  objectives: IntelligenceObjective[];
  triggers: IntelligenceTrigger[];
  evidence: MarketContextEvidence[];
  reasons: MarketContextReason[];
  metrics: MarketContextMetric[];
  tags: string[];
  warnings: string[];
  metadata: Record<string, unknown>;
  report?: MarketIntelligenceReport;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampConfidence(value: unknown, fallback = 0): number {
  return finite(value) ? clamp(value, 0, 1) : fallback;
}

function clampScore(value: unknown, fallback = 0): number {
  return finite(value) ? clamp(value, 0, 100) : fallback;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown intelligence error";
}

function createDefaultId(prefix: string, timestamp: number): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof (value as PromiseLike<unknown>).then === "function",
  );
}

function isReport(value: unknown): value is MarketIntelligenceReport {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MarketIntelligenceReport>;
  return (
    typeof candidate.reportId === "string" &&
    typeof candidate.symbol === "string" &&
    typeof candidate.timeframe === "string" &&
    Boolean(candidate.context) &&
    Boolean(candidate.decision)
  );
}

function isContribution(value: unknown): value is IntelligenceStageContribution {
  return Boolean(value && typeof value === "object");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[] | undefined,
): T[] {
  if (!incoming?.length) return [...current];
  const merged = new Map<string, T>();
  for (const item of current) merged.set(item.id, item);
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

function mergeMetrics(
  current: readonly MarketContextMetric[],
  incoming: readonly MarketContextMetric[] | undefined,
): MarketContextMetric[] {
  if (!incoming?.length) return [...current];
  const merged = new Map<string, MarketContextMetric>();
  for (const metric of current) merged.set(metric.key, metric);
  for (const metric of incoming) merged.set(metric.key, metric);
  return [...merged.values()];
}

function qualityFromScore(score: number): IntelligenceQuality {
  if (score >= 92) return "A+";
  if (score >= 82) return "A";
  if (score >= 70) return "B";
  if (score >= 58) return "C";
  if (score >= 45) return "D";
  return "F";
}

function directionStrength(
  direction: MarketContextDirection,
  score: number,
): MarketContextStrength {
  if (direction === "neutral") return score >= 65 ? "moderate" : "weak";
  if (score >= 85) return "very-strong";
  if (score >= 70) return "strong";
  if (score >= 55) return "moderate";
  return "weak";
}

function createProbabilities(
  context: MarketContextSnapshot,
  decision: TradingDecisionResult,
  supplied: Partial<IntelligenceProbabilitySet>,
): IntelligenceProbabilitySet {
  const bullish = clampConfidence(decision.bullishScore / 100);
  const bearish = clampConfidence(decision.bearishScore / 100);
  const neutral = clampConfidence(decision.neutralScore / 100);
  const family = context.regime.family;
  const reversalBase = decision.conflicts.some((item) => item.severity === "high")
    ? 0.55
    : 0.2;

  return {
    bullishContinuation: clampConfidence(
      supplied.bullishContinuation,
      decision.direction === "bullish" ? bullish : bullish * 0.55,
    ),
    bearishContinuation: clampConfidence(
      supplied.bearishContinuation,
      decision.direction === "bearish" ? bearish : bearish * 0.55,
    ),
    reversal: clampConfidence(supplied.reversal, reversalBase),
    balance: clampConfidence(
      supplied.balance,
      family === "range" ? Math.max(0.65, neutral) : neutral,
    ),
    expansion: clampConfidence(
      supplied.expansion,
      family === "expansion" ? Math.max(0.7, context.confidence) : 0.25,
    ),
    trendDay: clampConfidence(
      supplied.trendDay,
      family === "trend" ? Math.max(0.65, context.confidence) : 0.25,
    ),
    confidence: clampConfidence(
      supplied.confidence,
      (context.confidence + decision.confidence) / 2,
    ),
  };
}

function createFallbackRisk(
  decision: TradingDecisionResult,
): IntelligenceRiskAssessment {
  return {
    level: decision.risk.level,
    score: clampScore(decision.risk.score, 50),
    confidence: clampConfidence(decision.confidence),
    approved: decision.risk.blockers.length === 0 && decision.canTrade,
    extensionRisk: 0,
    volatilityRisk: 0,
    liquidityRisk: 0,
    reversalRisk: decision.conflicts.some((item) => item.severity === "high")
      ? 70
      : 25,
    eventRisk: 0,
    blockers: [...decision.risk.blockers],
    warnings: [...decision.risk.warnings],
    strengths: [...decision.risk.strengths],
  };
}

function createFallbackEntry(
  decision: TradingDecisionResult,
): IntelligenceEntryAssessment {
  const approved = decision.canTrade && !decision.shouldWait;
  const score = clampScore(decision.tradeScore);
  return {
    grade: decision.grade,
    score,
    confidence: clampConfidence(decision.confidence),
    approved,
    direction: decision.direction,
    locationScore: score,
    timingScore: score,
    confirmationScore: score,
    confluenceScore: clampScore(decision.convictionScore),
    rewardRiskScore: clampScore(decision.risk.score),
    chaseRisk: 0,
    extensionRisk: 0,
    isEarly: false,
    isLate: false,
    isChasing: false,
    reasons: decision.reasons.map((reason) => reason.text),
    warnings: [...decision.risk.warnings],
  };
}

function recommendationAction(
  decision: TradingDecisionResult,
): IntelligenceRecommendation["action"] {
  if (decision.action === "strong-long" || decision.action === "long") {
    return "enter-long";
  }
  if (decision.action === "strong-short" || decision.action === "short") {
    return "enter-short";
  }
  if (decision.action === "watch-long" || decision.action === "watch-short") {
    return "prepare";
  }
  if (decision.action === "avoid") return "avoid";
  return "wait";
}

function createFallbackRecommendation(
  decision: TradingDecisionResult,
): IntelligenceRecommendation {
  return {
    action: recommendationAction(decision),
    direction: decision.direction,
    label: decision.action.replaceAll("-", " "),
    summary: decision.summary,
    rationale: decision.thesis,
    grade: decision.grade,
    score: clampScore(decision.tradeScore),
    confidence: clampConfidence(decision.confidence),
    canTrade: decision.canTrade,
    shouldWait: decision.shouldWait,
    requiresConfirmation:
      decision.shouldWait ||
      decision.action === "watch-long" ||
      decision.action === "watch-short",
    blockers: [...decision.risk.blockers],
    warnings: [...decision.risk.warnings],
  };
}

function createFallbackNarrative(
  context: IntelligenceContext,
  snapshot: MarketContextSnapshot,
  decision: TradingDecisionResult,
  probabilities: IntelligenceProbabilitySet,
  now: number,
): IntelligenceNarrative {
  const include = context.includeNarrative;
  return {
    headline: include ? decision.summary : "Narrative disabled",
    story: include ? decision.thesis : "Narrative generation was not requested.",
    shortSummary: include ? snapshot.summary : decision.summary,
    phase: snapshot.regime.family === "range"
      ? "balance"
      : snapshot.regime.family === "expansion"
        ? "expansion"
        : snapshot.regime.family === "trend"
          ? "trend"
          : snapshot.regime.family === "compression"
            ? "accumulation"
            : snapshot.regime.family === "transition"
              ? "transition"
              : "unknown",
    regime: snapshot.regime.regime,
    dominantSide: decision.direction,
    marketCharacter: snapshot.regime.family === "trend"
      ? "clean-trend"
      : snapshot.regime.family === "range"
        ? "balanced-auction"
        : snapshot.regime.family === "compression"
          ? "tight-compression"
          : snapshot.regime.family === "expansion"
            ? "impulsive-expansion"
            : "mixed",
    currentObjective: null,
    alternativeObjectives: [],
    nextBullTrigger: null,
    nextBearTrigger: null,
    currentRisk:
      decision.risk.blockers[0] ?? decision.risk.warnings[0] ?? "No major risk identified.",
    invalidation: "Use the active trade plan or market-structure invalidation.",
    quality: decision.grade,
    confidence: clampConfidence(decision.confidence),
    probabilities,
    supportingEvidenceIds: decision.evidence.map((item) => item.id),
    conflictingEvidenceIds: decision.conflicts.flatMap((item) => item.componentIds),
    generatedAt: now,
  };
}

function createFallbackCoach(
  context: IntelligenceContext,
  decision: TradingDecisionResult,
  now: number,
): IntelligenceCoachAssessment {
  const include = context.includeCoach;
  const recommendation = decision.shouldWait
    ? "Wait for confirmation before committing risk."
    : decision.canTrade
      ? "The setup is approved. Execute only according to the trade plan."
      : "Protect capital and do not force this setup.";

  return {
    headline: include ? decision.summary : "Coach disabled",
    summary: include ? decision.thesis : "Coach generation was not requested.",
    recommendation,
    immediateAction: recommendationAction(decision),
    processScore: clampScore(decision.tradeScore),
    patienceScore: decision.shouldWait ? 100 : 75,
    disciplineScore: decision.canTrade ? 85 : 70,
    confidence: clampConfidence(decision.confidence),
    messages: [],
    strengths: [...decision.risk.strengths],
    improvements: [...decision.risk.warnings, ...decision.risk.blockers],
    questions: [],
    shouldInterrupt: decision.risk.level === "extreme",
    shouldWarn: decision.risk.level === "high" || decision.risk.level === "extreme",
    generatedAt: now,
  };
}

function makeAccumulator(): BuildAccumulator {
  return {
    contextDelta: null,
    execution: null,
    probabilities: {},
    objectives: [],
    triggers: [],
    evidence: [],
    reasons: [],
    metrics: [],
    tags: [],
    warnings: [],
    metadata: {},
  };
}

function mergeContribution(
  accumulator: BuildAccumulator,
  value: unknown,
): void {
  if (value === undefined || value === null) return;

  if (isReport(value)) {
    accumulator.report = value;
    return;
  }

  if (!isContribution(value)) return;
  const contribution = value as IntelligenceStageContribution;

  if (contribution.report) accumulator.report = contribution.report;
  if (contribution.context) accumulator.context = contribution.context;
  if (contribution.contextDelta !== undefined) {
    accumulator.contextDelta = contribution.contextDelta;
  }
  if (contribution.decision) accumulator.decision = contribution.decision;
  if (contribution.memory) accumulator.memory = contribution.memory;
  if (contribution.narrative) accumulator.narrative = contribution.narrative;
  if (contribution.coach) accumulator.coach = contribution.coach;
  if (contribution.risk) accumulator.risk = contribution.risk;
  if (contribution.entry) accumulator.entry = contribution.entry;
  if (contribution.execution !== undefined) {
    accumulator.execution = contribution.execution;
  }
  if (contribution.recommendation) {
    accumulator.recommendation = contribution.recommendation;
  }
  if (contribution.probabilities) {
    accumulator.probabilities = {
      ...accumulator.probabilities,
      ...contribution.probabilities,
    };
  }

  accumulator.objectives = mergeById(
    accumulator.objectives,
    contribution.objectives,
  );
  accumulator.triggers = mergeById(
    accumulator.triggers,
    contribution.triggers,
  );
  accumulator.evidence = mergeById(
    accumulator.evidence,
    contribution.evidence,
  );
  accumulator.reasons = mergeById(accumulator.reasons, contribution.reasons);
  accumulator.metrics = mergeMetrics(accumulator.metrics, contribution.metrics);
  accumulator.tags = uniqueStrings([
    ...accumulator.tags,
    ...(contribution.tags ?? []),
  ]);
  accumulator.warnings = uniqueStrings([
    ...accumulator.warnings,
    ...(contribution.warnings ?? []),
  ]);
  accumulator.metadata = {
    ...accumulator.metadata,
    ...(contribution.metadata ?? {}),
  };
}

function synchronizeSharedState(
  shared: Map<string, unknown>,
  accumulator: BuildAccumulator,
): void {
  if (accumulator.context) shared.set("marketContext", accumulator.context);
  if (accumulator.contextDelta !== undefined) {
    shared.set("marketContextDelta", accumulator.contextDelta);
  }
  if (accumulator.memory) {
    shared.set("marketMemory", accumulator.memory);
    shared.set("marketMemorySnapshot", accumulator.memory.memory);
    shared.set("marketStory", accumulator.memory.story);
    shared.set("marketRegimeMemory", accumulator.memory.regime);
    shared.set("marketSessionMemory", accumulator.memory.session);
  }
  if (accumulator.decision) shared.set("tradingDecision", accumulator.decision);
  if (accumulator.narrative) shared.set("marketNarrative", accumulator.narrative);
  if (accumulator.coach) shared.set("aiTradingCoach", accumulator.coach);
}

export class MasterIntelligenceEngine implements IntelligenceEngine {
  public readonly registry: IntelligenceRegistry;

  private readonly contextOptions: IntelligenceContextOptions;
  private readonly now: () => number;
  private readonly idFactory: (prefix: string, timestamp: number) => string;
  private readonly staleAfterMs?: number;
  private readonly continueOnOptionalFailure: boolean;
  private readonly markFailedRegistrations: boolean;
  private readonly executionKinds: readonly IntelligenceRegistrationKind[];
  private readonly listeners = new Set<IntelligenceReportListener>();

  public constructor(options: MasterIntelligenceEngineOptions = {}) {
    this.registry = options.registry ?? new IntelligenceRegistry();
    this.contextOptions = options.context ?? {};
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? createDefaultId;
    this.staleAfterMs = options.staleAfterMs;
    this.continueOnOptionalFailure = options.continueOnOptionalFailure ?? true;
    this.markFailedRegistrations = options.markFailedRegistrations ?? true;
    this.executionKinds = options.executionKinds ?? EXECUTION_KINDS;
  }

  /**
   * Synchronous evaluation for chart loops and existing callers.
   * Registered components used here must return synchronously.
   */
  public evaluate(request: MarketIntelligenceRequest): MarketIntelligenceBuildResult {
    const startedAt = this.now();
    const context = this.buildContext(request);
    const registrations = this.resolve(context, this.executionKinds);
    const shared = new Map<string, unknown>();
    const accumulator = makeAccumulator();
    const failures: IntelligenceComponentFailure[] = [];
    let successfulCount = 0;

    shared.set("intelligenceContext", context);
    shared.set("previousReport", context.previousReport);

    for (const registration of registrations) {
      this.assertNotAborted(undefined);
      try {
        const result = this.invoke(registration, {
          context,
          registry: this.registry,
          shared,
        });
        if (isPromiseLike(result)) {
          throw new MasterIntelligenceEngineError(
            "ASYNC_COMPONENT_IN_SYNC_EVALUATION",
            `Registration "${registration.id}" returned a Promise during synchronous evaluation. Use evaluateAsync().`,
          );
        }
        mergeContribution(accumulator, result);
        synchronizeSharedState(shared, accumulator);
        successfulCount += 1;
        shared.set(registration.id, result);
      } catch (error) {
        this.handleFailure(registration, error, failures, accumulator);
      }
    }

    return this.complete(
      context,
      accumulator,
      registrations.length,
      successfulCount,
      failures,
      startedAt,
    );
  }

  /** Asynchronous evaluation for components that call services or storage. */
  public async evaluateAsync(
    request: MarketIntelligenceRequest,
    options: MasterIntelligenceRunOptions = {},
  ): Promise<MarketIntelligenceBuildResult> {
    const startedAt = this.now();
    const context = this.buildContext(request);
    const registrations = this.resolve(
      context,
      options.executionKinds ?? this.executionKinds,
    );
    const shared = options.shared ?? new Map<string, unknown>();
    const accumulator = makeAccumulator();
    const failures: IntelligenceComponentFailure[] = [];
    let successfulCount = 0;

    shared.set("intelligenceContext", context);
    shared.set("previousReport", context.previousReport);

    for (const registration of registrations) {
      this.assertNotAborted(options.signal);
      try {
        const result = await this.invoke(registration, {
          context,
          registry: this.registry,
          shared,
          signal: options.signal,
        });
        mergeContribution(accumulator, result);
        synchronizeSharedState(shared, accumulator);
        successfulCount += 1;
        shared.set(registration.id, result);
      } catch (error) {
        this.handleFailure(registration, error, failures, accumulator);
      }
    }

    return this.complete(
      context,
      accumulator,
      registrations.length,
      successfulCount,
      failures,
      startedAt,
    );
  }

  public subscribe(listener: IntelligenceReportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async initialize(): Promise<void> {
    await this.registry.initializeAll({ kinds: [...this.executionKinds] });
  }

  public async dispose(): Promise<void> {
    this.listeners.clear();
    await this.registry.clear();
  }

  private buildContext(request: MarketIntelligenceRequest): IntelligenceContext {
    try {
      return IntelligenceContext.create(request, {
        ...this.contextOptions,
        now: this.contextOptions.now ?? this.now,
      }).context;
    } catch (error) {
      if (error instanceof IntelligenceContextError) {
        throw new MasterIntelligenceEngineError(
          "INVALID_INTELLIGENCE_CONTEXT",
          error.message,
          { issues: error.issues, cause: error },
        );
      }
      throw error;
    }
  }

  private resolve(
    context: IntelligenceContext,
    kinds: readonly IntelligenceRegistrationKind[],
  ): ResolvedIntelligenceRegistration[] {
    const validation = this.registry.validate({
      kinds,
      mode: context.mode,
      consumer: context.consumer,
    });

    if (!validation.valid) {
      throw new MasterIntelligenceEngineError(
        "INVALID_INTELLIGENCE_REGISTRY",
        validation.errors.map((item) => item.message).join(" "),
      );
    }

    return this.registry.resolveForContext(context, kinds);
  }

  private invoke(
    registration: ResolvedIntelligenceRegistration,
    runtime: IntelligenceRegistryRuntime,
  ): unknown | Promise<unknown> {
    const component = registration.component as {
      evaluate?: (runtime: IntelligenceRegistryRuntime) => unknown | Promise<unknown>;
      execute?: (runtime: IntelligenceRegistryRuntime) => unknown | Promise<unknown>;
    };

    if (typeof component.evaluate === "function") {
      return component.evaluate(runtime);
    }
    if (typeof component.execute === "function") {
      return component.execute(runtime);
    }

    throw new MasterIntelligenceEngineError(
      "NON_EXECUTABLE_REGISTRATION",
      `Registration "${registration.id}" has no evaluate() or execute() method.`,
    );
  }

  private handleFailure(
    registration: ResolvedIntelligenceRegistration,
    error: unknown,
    failures: IntelligenceComponentFailure[],
    accumulator: BuildAccumulator,
  ): void {
    const failure: IntelligenceComponentFailure = {
      registrationId: registration.id,
      kind: registration.kind,
      required: registration.required,
      message: toErrorMessage(error),
      error,
    };
    failures.push(failure);
    accumulator.warnings.push(
      `${registration.id}: ${failure.message}`,
    );

    if (this.markFailedRegistrations) {
      this.registry.markFailed(registration.id, error);
    }

    if (registration.required || !this.continueOnOptionalFailure) {
      throw new MasterIntelligenceEngineError(
        "INTELLIGENCE_COMPONENT_FAILED",
        `Intelligence component "${registration.id}" failed: ${failure.message}`,
        { failures, cause: error },
      );
    }
  }

  private complete(
    context: IntelligenceContext,
    accumulator: BuildAccumulator,
    evaluatorCount: number,
    successfulEvaluatorCount: number,
    failures: readonly IntelligenceComponentFailure[],
    startedAt: number,
  ): MarketIntelligenceBuildResult {
    if (accumulator.report) {
      return this.publish(
        accumulator.report,
        context.previousReport,
        startedAt,
        accumulator.warnings,
      );
    }

    if (!accumulator.context) {
      throw new MasterIntelligenceEngineError(
        "MISSING_MARKET_CONTEXT",
        "No registered context evaluator produced a MarketContextSnapshot.",
        { failures },
      );
    }

    if (!accumulator.decision) {
      throw new MasterIntelligenceEngineError(
        "MISSING_TRADING_DECISION",
        "No registered decision engine produced a TradingDecisionResult.",
        { failures },
      );
    }

    const generatedAt = this.now();
    const snapshot = accumulator.context;
    const decision = accumulator.decision;
    const probabilities = createProbabilities(
      snapshot,
      decision,
      accumulator.probabilities,
    );
    const risk = accumulator.risk ?? createFallbackRisk(decision);
    const entry = accumulator.entry ?? createFallbackEntry(decision);
    const recommendation =
      accumulator.recommendation ?? createFallbackRecommendation(decision);
    const narrative =
      accumulator.narrative ??
      createFallbackNarrative(context, snapshot, decision, probabilities, generatedAt);
    const coach =
      accumulator.coach ?? createFallbackCoach(context, decision, generatedAt);

    const evidence = mergeById(
      mergeById(snapshot.evidence, decision.evidence),
      accumulator.evidence,
    );
    const reasons = mergeById(
      mergeById(snapshot.reasons, decision.reasons),
      accumulator.reasons,
    );
    const metrics = mergeMetrics(
      mergeMetrics(snapshot.metrics, decision.metrics),
      accumulator.metrics,
    );
    const tags = uniqueStrings([
      ...snapshot.tags,
      ...decision.tags,
      ...accumulator.tags,
    ]);
    const processingTimeMs = Math.max(0, generatedAt - startedAt);
    const status = failures.length > 0 ? "degraded" : "ready";
    const tradeScore = clampScore(decision.tradeScore);
    const marketConfidence = clampConfidence(
      (snapshot.confidence + decision.confidence + probabilities.confidence) / 3,
    );

    const diagnostics: IntelligenceDiagnostics = {
      status,
      processingTimeMs,
      evaluatorCount,
      successfulEvaluatorCount,
      failedEvaluatorIds: failures.map((failure) => failure.registrationId),
      warnings: uniqueStrings([
        ...context.warnings.map((issue) => issue.message),
        ...accumulator.warnings,
      ]),
      errors: failures
        .filter((failure) => failure.required)
        .map((failure) => failure.message),
      cacheHit: false,
      stale: false,
      staleAfterMs: this.staleAfterMs,
      generatedFromSnapshotId: snapshot.id,
      metadata: {
        registrySize: this.registry.size,
        contextId: context.contextId,
      },
    };

    const report: MarketIntelligenceReport = {
      reportId: this.idFactory("intelligence", generatedAt),
      version: INTELLIGENCE_REPORT_VERSION,
      correlationId: context.correlationId,
      parentReportId: context.previousReport?.reportId,
      symbol: context.symbol,
      timeframe: context.timeframe,
      timestamp: context.timestamp,
      generatedAt,
      tradingDate: context.tradingDate,
      barIndex: context.barIndex,
      source: context.source,
      consumer: context.consumer,
      mode: context.mode,
      session: context.session,
      status,
      direction: decision.direction,
      strength: directionStrength(decision.direction, decision.convictionScore),
      grade: qualityFromScore(tradeScore),
      marketConfidence,
      convictionScore: clampScore(decision.convictionScore),
      tradeScore,
      summary: decision.summary,
      thesis: decision.thesis,
      context: snapshot,
      contextDelta: accumulator.contextDelta,
      decision,
      narrative,
      coach,
      risk,
      entry,
      execution: context.includeExecutionAssessment
        ? accumulator.execution
        : null,
      recommendation,
      probabilities,
      objectives: [...accumulator.objectives],
      triggers: [...accumulator.triggers],
      evidence,
      reasons,
      metrics,
      tags,
      diagnostics,
      metadata: {
        ...context.metadata,
        ...accumulator.metadata,
        ...(accumulator.memory
          ? {
              marketMemory: accumulator.memory.memory,
              marketMemorySession: accumulator.memory.session,
              marketMemoryRegime: accumulator.memory.regime,
              marketMemorySequences: accumulator.memory.sequences,
              marketStory: accumulator.memory.story,
              marketMemoryLatestEvent: accumulator.memory.latestEvent,
            }
          : {}),
      },
    };

    return this.publish(
      report,
      context.previousReport,
      startedAt,
      diagnostics.warnings,
    );
  }

  private publish(
    report: MarketIntelligenceReport,
    previousReport: MarketIntelligenceReport | null,
    startedAt: number,
    warnings: readonly string[],
  ): MarketIntelligenceBuildResult {
    const processingTimeMs = Math.max(0, this.now() - startedAt);
    const changed = !previousReport || this.reportChanged(previousReport, report);

    for (const listener of this.listeners) {
      try {
        listener(report, previousReport);
      } catch {
        // A UI or storage listener must never break intelligence evaluation.
      }
    }

    return {
      report,
      previousReport,
      changed,
      warnings: uniqueStrings([...warnings]),
      processingTimeMs,
    };
  }

  private reportChanged(
    previous: MarketIntelligenceReport,
    current: MarketIntelligenceReport,
  ): boolean {
    return (
      previous.direction !== current.direction ||
      previous.grade !== current.grade ||
      previous.recommendation.action !== current.recommendation.action ||
      Math.abs(previous.tradeScore - current.tradeScore) >= 1 ||
      Math.abs(previous.marketConfidence - current.marketConfidence) >= 0.01 ||
      previous.context.regime.regime !== current.context.regime.regime
    );
  }

  private assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new MasterIntelligenceEngineError(
        "INTELLIGENCE_EVALUATION_ABORTED",
        "Intelligence evaluation was aborted.",
      );
    }
  }
}

export default MasterIntelligenceEngine;
