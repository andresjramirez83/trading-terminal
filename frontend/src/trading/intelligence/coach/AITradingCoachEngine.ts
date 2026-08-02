// src/trading/intelligence/coach/AITradingCoachEngine.ts

/**
 * Deterministic real-time trading coach for the Trading OS.
 *
 * This engine does not create market signals and does not replace the trading
 * decision engine. It converts the current market narrative, trade quality,
 * risk, active position, account limits, and trader-behavior state into clear,
 * supportive coaching guidance that can be reused by Live Trading, Practice
 * Center, Replay, Journal review, and future Trading DNA workflows.
 */

import type {
  MarketContextDirection,
  MarketContextEvidence,
  MarketContextSnapshot,
} from "../types/MarketContextTypes";
import type { TradingDecisionResult } from "../evaluators/TradingDecisionEngine";
import type { IntelligenceRegistryRuntime } from "../core/IntelligenceRegistry";
import type { MarketObjectDecisionAdjustment } from "../integration/MarketObjectDecisionAdapter";
import type {
  CoachMessage,
  IntelligenceAccountInput,
  IntelligenceBehaviorInput,
  IntelligenceCoachAssessment,
  IntelligenceEntryAssessment,
  IntelligenceNarrative,
  IntelligencePositionInput,
  IntelligenceRecommendationAction,
  IntelligenceRiskAssessment,
  IntelligenceTradePlanInput,
} from "../core/IntelligenceTypes";

export interface AITradingCoachEngineOptions {
  now?: () => number;
  maximumMessages?: number;
  interruptPriority?: number;
  warningPriority?: number;
  minimumConfidence?: number;
}

export interface AITradingCoachInput {
  context: MarketContextSnapshot;
  decision: TradingDecisionResult;
  narrative: IntelligenceNarrative;
  risk?: IntelligenceRiskAssessment;
  entry?: IntelligenceEntryAssessment;
  behavior?: IntelligenceBehaviorInput | null;
  account?: IntelligenceAccountInput | null;
  position?: IntelligencePositionInput | null;
  tradePlan?: IntelligenceTradePlanInput | null;
  previousCoach?: IntelligenceCoachAssessment | null;
  marketObjectAdjustment?: MarketObjectDecisionAdjustment | null;
}

export interface AITradingCoachContribution {
  coach: IntelligenceCoachAssessment;
  tags: string[];
  warnings: string[];
  metadata: Record<string, unknown>;
}

type MessageDraft = Omit<CoachMessage, "id" | "evidenceIds"> & {
  key: string;
  evidenceIds?: string[];
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function confidence01(value: unknown, fallback = 0.5): number {
  if (!finite(value)) return fallback;
  return Math.min(1, Math.max(0, value > 1 ? value / 100 : value));
}

function score100(value: unknown, fallback = 50): number {
  if (!finite(value)) return fallback;
  return clamp(value <= 1 ? value * 100 : value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function titleDirection(direction: MarketContextDirection): string {
  if (direction === "bullish") return "Bullish";
  if (direction === "bearish") return "Bearish";
  return "Neutral";
}

function opposingDirection(
  left: MarketContextDirection | undefined,
  right: MarketContextDirection | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left !== "neutral" &&
      right !== "neutral" &&
      left !== right,
  );
}

function evidenceIds(
  decision: TradingDecisionResult,
  polarity?: "positive" | "negative" | "neutral",
): string[] {
  return decision.evidence
    .filter((item) => !polarity || item.polarity === polarity)
    .map((item) => item.id);
}

function recommendationAction(
  decision: TradingDecisionResult,
  position: IntelligencePositionInput | null | undefined,
  risk: IntelligenceRiskAssessment | undefined,
  entry: IntelligenceEntryAssessment | undefined,
): IntelligenceRecommendationAction {
  if (position) {
    if (risk?.level === "extreme" || risk?.approved === false) return "reduce";
    return "hold";
  }

  if (!decision.canTrade) return "observe";
  if (decision.shouldWait || entry?.approved === false) return "prepare";
  return decision.direction === "bullish"
    ? "enter-long"
    : decision.direction === "bearish"
      ? "enter-short"
      : "observe";
}

function processScore(
  decision: TradingDecisionResult,
  risk: IntelligenceRiskAssessment | undefined,
  entry: IntelligenceEntryAssessment | undefined,
  behavior: IntelligenceBehaviorInput | null | undefined,
): number {
  const decisionScore = score100(decision.tradeScore);
  const riskScore = risk ? clamp(100 - score100(risk.score)) : score100(decision.risk.score, 50);
  const entryScore = entry ? score100(entry.score) : decisionScore;
  const recentProcess = finite(behavior?.processScoreToday)
    ? clamp(behavior.processScoreToday)
    : decisionScore;

  return Math.round(
    decisionScore * 0.3 +
      riskScore * 0.25 +
      entryScore * 0.3 +
      recentProcess * 0.15,
  );
}

function patienceScore(
  decision: TradingDecisionResult,
  entry: IntelligenceEntryAssessment | undefined,
  behavior: IntelligenceBehaviorInput | null | undefined,
): number {
  let score = 85;
  if (decision.shouldWait) score += 8;
  if (entry?.isChasing) score -= 35;
  if (entry?.isLate) score -= 20;
  if (entry?.isEarly) score -= 12;
  score -= score100(behavior?.chasingRisk, 0) * 0.25;
  score -= score100(behavior?.overtradingRisk, 0) * 0.15;
  return Math.round(clamp(score));
}

function disciplineScore(
  decision: TradingDecisionResult,
  risk: IntelligenceRiskAssessment | undefined,
  behavior: IntelligenceBehaviorInput | null | undefined,
  tradePlan: IntelligenceTradePlanInput | null | undefined,
): number {
  let score = 80;
  if (risk?.approved) score += 8;
  if (tradePlan?.entryPrice && tradePlan?.stopPrice) score += 7;
  if (decision.blockingComponents.length) score -= 12;
  score -= score100(behavior?.revengeTradingRisk, 0) * 0.3;
  score -= score100(behavior?.fatigueRisk, 0) * 0.15;
  score -= score100(behavior?.overtradingRisk, 0) * 0.2;
  return Math.round(clamp(score));
}

function makeMessage(
  draft: MessageDraft,
  generatedAt: number,
): CoachMessage {
  return {
    id: `coach_${draft.key}_${generatedAt}`,
    level: draft.level,
    category: draft.category,
    title: draft.title,
    message: draft.message,
    action: draft.action,
    priority: clamp(draft.priority, 0, 100),
    confidence: confidence01(draft.confidence),
    dismissible: draft.dismissible,
    expiresAt: draft.expiresAt,
    evidenceIds: unique(draft.evidenceIds ?? []),
    metadata: draft.metadata,
  };
}

function addMarketMessages(
  drafts: MessageDraft[],
  input: AITradingCoachInput,
): void {
  const { decision, narrative } = input;
  const positiveIds = evidenceIds(decision, "positive");
  const negativeIds = evidenceIds(decision, "negative");

  if (!decision.canTrade) {
    drafts.push({
      key: "protect-capital",
      level: "warning",
      category: "patience",
      title: "Protect Capital",
      message:
        "The current evidence does not support a clean trade. Staying out is the disciplined decision until structure and risk improve.",
      action: "Wait for a confirmed setup instead of forcing activity.",
      priority: 91,
      confidence: decision.confidence,
      dismissible: true,
      evidenceIds: negativeIds,
    });
  } else if (decision.shouldWait) {
    drafts.push({
      key: "wait-confirmation",
      level: "info",
      category: "patience",
      title: "Good Idea, Not Yet",
      message: `${titleDirection(decision.direction)} evidence is developing, but confirmation is still incomplete.`,
      action:
        narrative.nextBullTrigger && decision.direction === "bullish"
          ? narrative.nextBullTrigger.description
          : narrative.nextBearTrigger && decision.direction === "bearish"
            ? narrative.nextBearTrigger.description
            : "Wait for the next confirmation trigger before entering.",
      priority: 84,
      confidence: narrative.confidence,
      dismissible: true,
      evidenceIds: [...positiveIds, ...negativeIds],
    });
  } else if (decision.canTrade && decision.direction !== "neutral") {
    drafts.push({
      key: "setup-aligned",
      level: "positive",
      category: "market-reading",
      title: "Setup Aligned",
      message: `${titleDirection(decision.direction)} structure, context, and trade quality are sufficiently aligned.`,
      action: "Follow the planned entry and invalidation; do not add risk outside the plan.",
      priority: 70,
      confidence: decision.confidence,
      dismissible: true,
      evidenceIds: positiveIds,
    });
  }

  if (decision.conflicts.length > 0) {
    drafts.push({
      key: "mixed-evidence",
      level: "warning",
      category: "market-reading",
      title: "Mixed Evidence",
      message: `${decision.conflicts.length} material conflict${decision.conflicts.length === 1 ? " is" : "s are"} weakening the current thesis.`,
      action: "Reduce conviction and require stronger confirmation before increasing size.",
      priority: 76,
      confidence: decision.confidence,
      dismissible: true,
      evidenceIds: negativeIds,
    });
  }
}

function addMarketObjectMessages(
  drafts: MessageDraft[],
  input: AITradingCoachInput,
): void {
  const adjustment = input.marketObjectAdjustment;
  if (!adjustment || adjustment.factors.length === 0) return;

  if (adjustment.blocked) {
    const labels = adjustment.factors
      .filter((factor) => factor.blocking)
      .slice(0, 2)
      .map((factor) => factor.label);
    drafts.push({
      key: "market-object-invalidated",
      level: "critical",
      category: "risk",
      title: "Market Object Invalidated",
      message: labels.length
        ? `${labels.join(" and ")} no longer support the active thesis.`
        : "A key market object has invalidated the active thesis.",
      action: "Do not enter until a new thesis and invalidation level are defined.",
      priority: 98,
      confidence: 0.9,
      dismissible: false,
      evidenceIds: adjustment.blockingObjectIds,
    });
    return;
  }

  if (adjustment.shouldWait) {
    drafts.push({
      key: "market-object-conflict",
      level: "warning",
      category: "patience",
      title: "Confluence Is Mixed",
      message: "Nearby market objects conflict with the active directional thesis.",
      action: "Wait for price to confirm which object is controlling the auction.",
      priority: 88,
      confidence: 0.78,
      dismissible: true,
      evidenceIds: adjustment.opposingObjectIds,
    });
    return;
  }

  const aligned = adjustment.factors
    .filter(
      (factor) =>
        !factor.blocking &&
        adjustment.direction !== "neutral" &&
        factor.direction === adjustment.direction,
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, 2);

  if (aligned.length > 0) {
    drafts.push({
      key: "market-object-confluence",
      level: "positive",
      category: "market-reading",
      title: "Market Objects Aligned",
      message: `${aligned.map((factor) => factor.label).join(" and ")} support the ${adjustment.direction} thesis.`,
      action: "Use the planned trigger and keep risk defined at thesis invalidation.",
      priority: 74,
      confidence: Math.max(...aligned.map((factor) => factor.confidence)),
      dismissible: true,
      evidenceIds: aligned.map((factor) => factor.objectId),
    });
  }
}

function addEntryMessages(
  drafts: MessageDraft[],
  input: AITradingCoachInput,
): void {
  const { entry, decision } = input;
  if (!entry) return;

  if (entry.isChasing || entry.chaseRisk >= 65) {
    drafts.push({
      key: "do-not-chase",
      level: "warning",
      category: "entry",
      title: "Do Not Chase",
      message:
        "The market idea may still be valid, but the current entry is too far from the best location and reduces reward-to-risk.",
      action: "Wait for a pullback, retest, or fresh higher-quality trigger.",
      priority: 96,
      confidence: entry.confidence,
      dismissible: false,
      evidenceIds: evidenceIds(decision),
    });
  } else if (entry.isLate) {
    drafts.push({
      key: "late-entry",
      level: "warning",
      category: "entry",
      title: "Entry Is Late",
      message:
        "The setup has already progressed beyond the ideal entry window. A correct thesis does not automatically make this a good entry.",
      action: "Skip the entry or wait for the market to create a new invalidation point.",
      priority: 88,
      confidence: entry.confidence,
      dismissible: true,
      evidenceIds: evidenceIds(decision),
    });
  } else if (entry.isEarly) {
    drafts.push({
      key: "early-entry",
      level: "info",
      category: "entry",
      title: "Confirmation Still Forming",
      message:
        "The entry is early relative to the current confirmation sequence. Waiting may reduce false-start risk.",
      action: "Let the trigger confirm before committing full risk.",
      priority: 79,
      confidence: entry.confidence,
      dismissible: true,
      evidenceIds: evidenceIds(decision),
    });
  } else if (entry.approved && entry.score >= 80) {
    drafts.push({
      key: "entry-quality",
      level: "positive",
      category: "entry",
      title: "High-Quality Entry",
      message:
        "Entry location, timing, confirmation, and reward-to-risk are aligned with the active thesis.",
      action: "Execute the plan without widening the stop or increasing unplanned risk.",
      priority: 68,
      confidence: entry.confidence,
      dismissible: true,
      evidenceIds: evidenceIds(decision, "positive"),
    });
  }
}

function addRiskMessages(
  drafts: MessageDraft[],
  input: AITradingCoachInput,
): void {
  const { risk, decision, account, tradePlan } = input;
  if (!risk) return;

  if (risk.level === "extreme" || risk.approved === false) {
    drafts.push({
      key: "risk-blocked",
      level: "critical",
      category: "risk",
      title: "Risk Is Not Approved",
      message:
        risk.invalidationReason ||
        risk.blockers[0] ||
        "Current risk conditions do not justify a new position.",
      action: "Do not enter. Existing positions should be reduced or managed to the planned invalidation.",
      priority: 100,
      confidence: risk.confidence,
      dismissible: false,
      evidenceIds: evidenceIds(decision, "negative"),
    });
  } else if (risk.level === "high") {
    drafts.push({
      key: "high-risk",
      level: "warning",
      category: "risk",
      title: "High Risk Environment",
      message:
        risk.warnings[0] ||
        "Volatility, extension, liquidity, or reversal risk is elevated.",
      action: "Reduce size and require a clear stop before entry.",
      priority: 92,
      confidence: risk.confidence,
      dismissible: false,
      evidenceIds: evidenceIds(decision, "negative"),
    });
  }

  if (finite(risk.rewardRiskRatio) && risk.rewardRiskRatio < 1.5) {
    drafts.push({
      key: "poor-r-multiple",
      level: "warning",
      category: "risk",
      title: "Reward Does Not Justify Risk",
      message: `Current reward-to-risk is approximately ${risk.rewardRiskRatio.toFixed(2)}R.`,
      action: "Improve the entry location, tighten the logical risk, or pass on the trade.",
      priority: 94,
      confidence: risk.confidence,
      dismissible: false,
      evidenceIds: evidenceIds(decision, "negative"),
    });
  }

  if (!tradePlan?.stopPrice && !risk.stopPrice) {
    drafts.push({
      key: "missing-stop",
      level: "critical",
      category: "risk",
      title: "Define Invalidation First",
      message: "No clear stop or invalidation price is available for this trade plan.",
      action: "Do not enter until the thesis has a specific invalidation level.",
      priority: 99,
      confidence: 1,
      dismissible: false,
      evidenceIds: evidenceIds(decision),
    });
  }

  if (
    finite(account?.dailyPnL) &&
    finite(account?.dailyLossLimit) &&
    account.dailyLossLimit > 0 &&
    account.dailyPnL <= -Math.abs(account.dailyLossLimit)
  ) {
    drafts.push({
      key: "daily-loss-limit",
      level: "critical",
      category: "discipline",
      title: "Daily Loss Limit Reached",
      message: "The account has reached or exceeded the configured daily loss limit.",
      action: "Stop taking new trades and begin the review process.",
      priority: 100,
      confidence: 1,
      dismissible: false,
      evidenceIds: [],
    });
  }
}

function addBehaviorMessages(
  drafts: MessageDraft[],
  behavior: IntelligenceBehaviorInput | null | undefined,
): void {
  if (!behavior) return;

  if (score100(behavior.revengeTradingRisk, 0) >= 65) {
    drafts.push({
      key: "revenge-risk",
      level: "critical",
      category: "discipline",
      title: "Reset Before the Next Trade",
      message:
        "Recent behavior suggests elevated revenge-trading risk. The next decision may be driven by the previous result instead of the current setup.",
      action: "Pause, reset, and require a fully qualified setup before returning.",
      priority: 100,
      confidence: confidence01(behavior.revengeTradingRisk),
      dismissible: false,
    });
  }

  if (score100(behavior.overtradingRisk, 0) >= 65) {
    drafts.push({
      key: "overtrading-risk",
      level: "warning",
      category: "discipline",
      title: "Activity Is Becoming the Goal",
      message:
        "Trade frequency is elevated relative to process quality. More trades do not create more edge.",
      action: "Only take the next setup if it meets every required condition.",
      priority: 93,
      confidence: confidence01(behavior.overtradingRisk),
      dismissible: false,
    });
  }

  if (score100(behavior.fatigueRisk, 0) >= 70) {
    drafts.push({
      key: "fatigue-risk",
      level: "warning",
      category: "discipline",
      title: "Decision Quality May Be Fading",
      message:
        "Fatigue risk is high enough to affect patience, sizing, and reaction speed.",
      action: "Reduce size, simplify decisions, or end the session.",
      priority: 90,
      confidence: confidence01(behavior.fatigueRisk),
      dismissible: false,
    });
  }

  if (finite(behavior.consecutiveLosses) && behavior.consecutiveLosses >= 3) {
    drafts.push({
      key: "loss-streak",
      level: "warning",
      category: "discipline",
      title: "Protect the Process",
      message: `${behavior.consecutiveLosses} consecutive losses can increase pressure to force the next result.`,
      action: "Reduce size and judge the next trade only by setup quality.",
      priority: 89,
      confidence: 0.9,
      dismissible: true,
    });
  }

  if (score100(behavior.hesitationRisk, 0) >= 70) {
    drafts.push({
      key: "hesitation-risk",
      level: "info",
      category: "execution",
      title: "Trust a Valid Plan",
      message:
        "Hesitation risk is elevated. Waiting is correct before confirmation, but hesitation after confirmation can damage execution.",
      action: "Predefine the trigger, size, stop, and target so execution becomes mechanical.",
      priority: 72,
      confidence: confidence01(behavior.hesitationRisk),
      dismissible: true,
    });
  }
}

function addPositionMessages(
  drafts: MessageDraft[],
  input: AITradingCoachInput,
): void {
  const { position, decision, narrative, risk } = input;
  if (!position) return;

  if (opposingDirection(position.direction, decision.direction)) {
    drafts.push({
      key: "position-conflict",
      level: "critical",
      category: "management",
      title: "Market Thesis Opposes the Position",
      message: `The active position is ${position.direction}, while current intelligence is ${decision.direction}.`,
      action: "Respect the planned invalidation and consider reducing exposure rather than defending the original idea.",
      priority: 100,
      confidence: decision.confidence,
      dismissible: false,
      evidenceIds: evidenceIds(decision, "negative"),
    });
  } else if (decision.direction === position.direction && decision.canTrade) {
    drafts.push({
      key: "hold-thesis",
      level: "positive",
      category: "management",
      title: "Thesis Still Intact",
      message: `${narrative.shortSummary} The position remains aligned with the dominant market side.`,
      action: "Manage against structure and the original invalidation rather than reacting to normal candle noise.",
      priority: 74,
      confidence: narrative.confidence,
      dismissible: true,
      evidenceIds: narrative.supportingEvidenceIds,
    });
  }

  if (risk?.level === "high" || risk?.level === "extreme") {
    drafts.push({
      key: "position-risk",
      level: risk.level === "extreme" ? "critical" : "warning",
      category: "management",
      title: "Position Risk Increased",
      message: risk.warnings[0] ?? risk.invalidationReason ?? "Risk has increased since entry.",
      action: "Do not widen the stop. Reduce exposure if the planned invalidation is threatened.",
      priority: risk.level === "extreme" ? 100 : 92,
      confidence: risk.confidence,
      dismissible: false,
      evidenceIds: evidenceIds(decision, "negative"),
    });
  }
}

function headlineFor(messages: readonly CoachMessage[]): string {
  const primary = messages[0];
  if (!primary) return "Stay Patient and Follow the Plan";
  return primary.title;
}

function summaryFor(
  input: AITradingCoachInput,
  messages: readonly CoachMessage[],
): string {
  const primary = messages[0];
  if (primary) return primary.message;
  return input.narrative.shortSummary;
}

function recommendationFor(
  action: IntelligenceRecommendationAction,
  input: AITradingCoachInput,
): string {
  switch (action) {
    case "enter-long":
      return "The long setup is approved. Execute only at the planned trigger with defined risk.";
    case "enter-short":
      return "The short setup is approved. Execute only at the planned trigger with defined risk.";
    case "prepare":
      return "Prepare the trade, but wait for the required confirmation.";
    case "hold":
      return "Hold while the thesis and invalidation remain intact.";
    case "reduce":
      return "Reduce exposure because current risk is no longer fully aligned with the position.";
    case "exit":
      return "Exit because the active thesis has been invalidated.";
    case "review":
      return "Stop trading and review the decision process.";
    default:
      return input.decision.canTrade
        ? "Observe the setup and act only when the plan is complete."
        : "Wait. Capital preservation is the correct decision right now.";
  }
}

function extractContribution<T>(value: unknown, key: string): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key] as T | undefined;
}

function extractRuntimeInput(runtime: IntelligenceRegistryRuntime): AITradingCoachInput {
  let context = runtime.report?.context;
  let decision = runtime.report?.decision;
  let narrative = runtime.report?.narrative;
  let risk = runtime.report?.risk;
  let entry = runtime.report?.entry;
  const marketObjectAdjustment = runtime.shared.get(
    "market-objects:decision-adjustment",
  ) as MarketObjectDecisionAdjustment | undefined;

  for (const value of runtime.shared.values()) {
    context ??= extractContribution<MarketContextSnapshot>(value, "context");
    decision ??= extractContribution<TradingDecisionResult>(value, "decision");
    narrative ??= extractContribution<IntelligenceNarrative>(value, "narrative");
    risk ??= extractContribution<IntelligenceRiskAssessment>(value, "risk");
    entry ??= extractContribution<IntelligenceEntryAssessment>(value, "entry");
  }

  if (!context || !decision || !narrative) {
    throw new Error(
      "AITradingCoachEngine requires context, decision, and narrative outputs. Register it after those engines.",
    );
  }

  return {
    context,
    decision,
    narrative,
    risk,
    entry,
    behavior: runtime.context.behavior,
    account: runtime.context.account,
    position: runtime.context.position,
    tradePlan: runtime.context.tradePlan,
    previousCoach: runtime.context.previousReport?.coach ?? null,
    marketObjectAdjustment,
  };
}

export class AITradingCoachEngine {
  public readonly id = "ai-trading-coach";

  private readonly now: () => number;
  private readonly maximumMessages: number;
  private readonly interruptPriority: number;
  private readonly warningPriority: number;
  private readonly minimumConfidence: number;

  public constructor(options: AITradingCoachEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maximumMessages = Math.max(1, options.maximumMessages ?? 7);
    this.interruptPriority = clamp(options.interruptPriority ?? 96);
    this.warningPriority = clamp(options.warningPriority ?? 85);
    this.minimumConfidence = confidence01(options.minimumConfidence ?? 0.45);
  }

  public evaluate(runtime: IntelligenceRegistryRuntime): AITradingCoachContribution {
    return this.build(extractRuntimeInput(runtime));
  }

  public build(input: AITradingCoachInput): AITradingCoachContribution {
    const generatedAt = this.now();
    const drafts: MessageDraft[] = [];

    addBehaviorMessages(drafts, input.behavior);
    addRiskMessages(drafts, input);
    addPositionMessages(drafts, input);
    addEntryMessages(drafts, input);
    addMarketMessages(drafts, input);
    addMarketObjectMessages(drafts, input);

    const messages = drafts
      .map((draft) => makeMessage(draft, generatedAt))
      .filter((message) => message.confidence >= this.minimumConfidence)
      .sort((left, right) => right.priority - left.priority || right.confidence - left.confidence)
      .slice(0, this.maximumMessages);

    const action = recommendationAction(
      input.decision,
      input.position,
      input.risk,
      input.entry,
    );
    const process = processScore(input.decision, input.risk, input.entry, input.behavior);
    const patience = patienceScore(input.decision, input.entry, input.behavior);
    const discipline = disciplineScore(
      input.decision,
      input.risk,
      input.behavior,
      input.tradePlan,
    );

    const strengths = unique([
      ...input.decision.risk.strengths,
      ...(input.risk?.strengths ?? []),
      ...(input.entry?.approved ? ["Entry conditions are aligned with the current thesis."] : []),
      ...(input.decision.canTrade && !input.decision.shouldWait
        ? ["The trader is acting only after the setup reached confirmation."]
        : []),
    ]).slice(0, 8);

    const improvements = unique([
      ...input.decision.risk.warnings,
      ...input.decision.risk.blockers,
      ...(input.risk?.warnings ?? []),
      ...(input.risk?.blockers ?? []),
      ...(input.entry?.warnings ?? []),
      ...messages
        .filter((message) => message.level === "warning" || message.level === "critical")
        .map((message) => message.action ?? message.message),
    ]).slice(0, 8);

    const questions = unique([
      input.tradePlan?.stopPrice || input.risk?.stopPrice
        ? "Does the planned stop still represent true thesis invalidation?"
        : "Where is the exact thesis invalidation before entry?",
      input.decision.shouldWait
        ? "What specific confirmation would make this trade valid?"
        : "Am I executing the plan or reacting to the last candle?",
      input.entry?.isChasing
        ? "Would I still take this trade after a pullback improves the entry?"
        : "Is the expected reward still worth the defined risk?",
    ]).slice(0, 3);

    const coach: IntelligenceCoachAssessment = {
      headline: headlineFor(messages),
      summary: summaryFor(input, messages),
      recommendation: recommendationFor(action, input),
      immediateAction: action,
      processScore: process,
      patienceScore: patience,
      disciplineScore: discipline,
      confidence: confidence01(
        (input.narrative.confidence + confidence01(input.decision.confidence)) / 2,
      ),
      messages,
      strengths,
      improvements,
      questions,
      shouldInterrupt: messages.some(
        (message) => !message.dismissible && message.priority >= this.interruptPriority,
      ),
      shouldWarn: messages.some(
        (message) =>
          (message.level === "warning" || message.level === "critical") &&
          message.priority >= this.warningPriority,
      ),
      generatedAt,
    };

    return {
      coach,
      tags: unique([
        "ai-trading-coach",
        `coach-action:${action}`,
        `coach-process:${Math.round(process / 10) * 10}`,
        ...(coach.shouldInterrupt ? ["coach-interrupt"] : []),
        ...(coach.shouldWarn ? ["coach-warning"] : []),
        ...(input.marketObjectAdjustment?.factors.length
          ? ["market-object-aware"]
          : []),
      ]),
      warnings: messages
        .filter((message) => message.level === "critical")
        .map((message) => message.message),
      metadata: {
        coachEngineId: this.id,
        coachGeneratedAt: generatedAt,
        coachMessageCount: messages.length,
        coachPrimaryMessageId: messages[0]?.id ?? null,
        coachImmediateAction: action,
        marketObjectFactorCount:
          input.marketObjectAdjustment?.factors.length ?? 0,
        marketObjectBlocked:
          input.marketObjectAdjustment?.blocked ?? false,
      },
    };
  }
}

export default AITradingCoachEngine;
