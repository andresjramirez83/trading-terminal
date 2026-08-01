// src/trading/intelligence/core/IntelligenceContext.ts

/**
 * Normalization and validation boundary for the Trading OS intelligence layer.
 *
 * Every consumer—Live Trading, Practice Center, Replay, Scanner, Journal,
 * Decision Center, AI Coach, Trading DNA, and Auto Trader—should send its raw
 * request through this module before invoking the intelligence engines.
 *
 * The context is intentionally immutable after construction. This prevents one
 * evaluator from changing the request seen by another evaluator and gives every
 * downstream engine the same source of truth.
 */

import type {
  MarketContextBuildRequest,
  MarketContextDirection,
  MarketContextInputSnapshot,
  MarketContextSnapshot,
  MarketContextSource,
  MarketSession,
} from "../types/MarketContextTypes";
import type {
  IntelligenceAccountInput,
  IntelligenceBehaviorInput,
  IntelligenceConsumer,
  IntelligenceMode,
  IntelligenceOrderInput,
  IntelligencePositionInput,
  IntelligenceTradePlanInput,
  MarketIntelligenceReport,
  MarketIntelligenceRequest,
} from "./IntelligenceTypes";

export type IntelligenceContextIssueSeverity = "warning" | "error";

export interface IntelligenceContextIssue {
  code: string;
  message: string;
  severity: IntelligenceContextIssueSeverity;
  path?: string;
  value?: unknown;
}

export interface IntelligenceContextOptions {
  now?: () => number;
  idFactory?: (prefix: string, timestamp: number) => string;
  defaultConsumer?: IntelligenceConsumer;
  defaultSource?: MarketContextSource;
  defaultMode?: IntelligenceMode;
  defaultMinimumConfidence?: number;
  defaultMinimumTradeScore?: number;
  strict?: boolean;
  freeze?: boolean;
}

export interface IntelligenceContextIdentity {
  contextId: string;
  correlationId: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  createdAt: number;
  tradingDate?: string;
  barIndex?: number;
  source: MarketContextSource;
  consumer: IntelligenceConsumer;
  mode: IntelligenceMode;
  session: MarketSession;
}

export interface IntelligenceContextState extends IntelligenceContextIdentity {
  request: Readonly<MarketIntelligenceRequest>;
  contextRequest: Readonly<MarketContextBuildRequest>;
  input: Readonly<MarketContextInputSnapshot>;
  previousContextSnapshot: MarketContextSnapshot | null;
  previousReport: MarketIntelligenceReport | null;
  preferredDirection: MarketContextDirection;
  tradePlan: Readonly<IntelligenceTradePlanInput> | null;
  position: Readonly<IntelligencePositionInput> | null;
  orders: readonly IntelligenceOrderInput[];
  account: Readonly<IntelligenceAccountInput> | null;
  behavior: Readonly<IntelligenceBehaviorInput> | null;
  includeCoach: boolean;
  includeNarrative: boolean;
  includeExecutionAssessment: boolean;
  minimumConfidence: number;
  minimumTradeScore: number;
  metadata: Readonly<Record<string, unknown>>;
  warnings: readonly IntelligenceContextIssue[];
  errors: readonly IntelligenceContextIssue[];
  valid: boolean;
}

export interface IntelligenceContextBuildResult {
  context: IntelligenceContext;
  valid: boolean;
  warnings: IntelligenceContextIssue[];
  errors: IntelligenceContextIssue[];
}

const DEFAULT_MINIMUM_CONFIDENCE = 0.55;
const DEFAULT_MINIMUM_TRADE_SCORE = 60;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createDefaultId(prefix: string, timestamp: number): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

function copyRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return value ? { ...value } : {};
}

function normalizeDirection(
  value: MarketContextDirection | undefined,
): MarketContextDirection {
  return value === "bullish" || value === "bearish" ? value : "neutral";
}

function normalizeSession(value: MarketSession | undefined): MarketSession {
  switch (value) {
    case "overnight":
    case "premarket":
    case "regular":
    case "after-hours":
    case "closed":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function normalizeMode(
  value: IntelligenceMode | undefined,
  fallback: IntelligenceMode,
): IntelligenceMode {
  return value === "live" || value === "replay" || value === "historical"
    ? value
    : fallback;
}

function normalizeNumber(
  value: unknown,
  fallback: number,
  minimum?: number,
  maximum?: number,
): number {
  let result = finite(value) ? value : fallback;
  if (finite(minimum)) result = Math.max(minimum, result);
  if (finite(maximum)) result = Math.min(maximum, result);
  return result;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return finite(value) ? value : undefined;
}

function normalizeTradePlan(
  value: IntelligenceTradePlanInput | undefined,
): IntelligenceTradePlanInput | null {
  if (!value) return null;

  return {
    direction:
      value.direction === "bullish" || value.direction === "bearish"
        ? value.direction
        : undefined,
    entryPrice: normalizeOptionalNumber(value.entryPrice),
    stopPrice: normalizeOptionalNumber(value.stopPrice),
    targetPrice: normalizeOptionalNumber(value.targetPrice),
    quantity: normalizeOptionalNumber(value.quantity),
    riskAmount: normalizeOptionalNumber(value.riskAmount),
    setupName: normalizeText(value.setupName) || undefined,
    notes: normalizeText(value.notes) || undefined,
    metadata: copyRecord(value.metadata),
  };
}

function normalizePosition(
  value: IntelligencePositionInput | null | undefined,
): IntelligencePositionInput | null {
  if (!value) return null;

  return {
    id: normalizeText(value.id) || undefined,
    symbol: normalizeText(value.symbol).toUpperCase(),
    direction: value.direction,
    quantity: normalizeNumber(value.quantity, 0, 0),
    averageEntryPrice: normalizeNumber(value.averageEntryPrice, 0, 0),
    currentPrice: normalizeOptionalNumber(value.currentPrice),
    stopPrice: normalizeOptionalNumber(value.stopPrice),
    targetPrice: normalizeOptionalNumber(value.targetPrice),
    unrealizedPnL: normalizeOptionalNumber(value.unrealizedPnL),
    realizedPnL: normalizeOptionalNumber(value.realizedPnL),
    openedAt: normalizeOptionalNumber(value.openedAt),
    metadata: copyRecord(value.metadata),
  };
}

function normalizeOrders(
  values: readonly IntelligenceOrderInput[] | undefined,
): IntelligenceOrderInput[] {
  if (!values) return [];

  return values
    .filter((order): order is IntelligenceOrderInput => Boolean(order))
    .map((order) => ({
      id: normalizeText(order.id),
      symbol: normalizeText(order.symbol).toUpperCase(),
      side: order.side,
      type: normalizeText(order.type) || "market",
      status: normalizeText(order.status) || "unknown",
      quantity: normalizeOptionalNumber(order.quantity),
      filledQuantity: normalizeOptionalNumber(order.filledQuantity),
      limitPrice: normalizeOptionalNumber(order.limitPrice),
      stopPrice: normalizeOptionalNumber(order.stopPrice),
      submittedAt: normalizeOptionalNumber(order.submittedAt),
      metadata: copyRecord(order.metadata),
    }));
}

function normalizeAccount(
  value: IntelligenceAccountInput | undefined,
): IntelligenceAccountInput | null {
  if (!value) return null;

  return {
    buyingPower: normalizeOptionalNumber(value.buyingPower),
    cash: normalizeOptionalNumber(value.cash),
    equity: normalizeOptionalNumber(value.equity),
    portfolioValue: normalizeOptionalNumber(value.portfolioValue),
    dayTradeCount: normalizeOptionalNumber(value.dayTradeCount),
    dailyPnL: normalizeOptionalNumber(value.dailyPnL),
    dailyLossLimit: normalizeOptionalNumber(value.dailyLossLimit),
    riskPerTrade: normalizeOptionalNumber(value.riskPerTrade),
    maxOpenPositions: normalizeOptionalNumber(value.maxOpenPositions),
    metadata: copyRecord(value.metadata),
  };
}

function normalizeBehavior(
  value: IntelligenceBehaviorInput | undefined,
): IntelligenceBehaviorInput | null {
  if (!value) return null;

  return {
    recentTradeCount: normalizeOptionalNumber(value.recentTradeCount),
    consecutiveWins: normalizeOptionalNumber(value.consecutiveWins),
    consecutiveLosses: normalizeOptionalNumber(value.consecutiveLosses),
    tradesToday: normalizeOptionalNumber(value.tradesToday),
    processScoreToday: finite(value.processScoreToday)
      ? clamp(value.processScoreToday, 0, 100)
      : undefined,
    overtradingRisk: finite(value.overtradingRisk)
      ? clamp(value.overtradingRisk, 0, 100)
      : undefined,
    revengeTradingRisk: finite(value.revengeTradingRisk)
      ? clamp(value.revengeTradingRisk, 0, 100)
      : undefined,
    hesitationRisk: finite(value.hesitationRisk)
      ? clamp(value.hesitationRisk, 0, 100)
      : undefined,
    chasingRisk: finite(value.chasingRisk)
      ? clamp(value.chasingRisk, 0, 100)
      : undefined,
    fatigueRisk: finite(value.fatigueRisk)
      ? clamp(value.fatigueRisk, 0, 100)
      : undefined,
    metadata: copyRecord(value.metadata),
  };
}

function normalizeInput(
  input: MarketContextInputSnapshot,
  timestamp: number,
): MarketContextInputSnapshot {
  return {
    symbol: normalizeText(input.symbol).toUpperCase(),
    timeframe: normalizeText(input.timeframe),
    timestamp: finite(input.timestamp) ? input.timestamp : timestamp,
    session: normalizeSession(input.session),
    bar: { ...input.bar },
    price: { ...input.price },
    volume: { ...input.volume },
    volatility: { ...input.volatility },
    structure: { ...input.structure },
    indicators: {
      ...input.indicators,
      custom: input.indicators.custom
        ? { ...input.indicators.custom }
        : undefined,
    },
    barIndex: normalizeOptionalNumber(input.barIndex),
    tradingDate: normalizeText(input.tradingDate) || undefined,
    metadata: copyRecord(input.metadata),
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function validateContext(state: {
  input: MarketContextInputSnapshot;
  position: IntelligencePositionInput | null;
  orders: readonly IntelligenceOrderInput[];
  tradePlan: IntelligenceTradePlanInput | null;
  minimumConfidence: number;
  minimumTradeScore: number;
}): IntelligenceContextIssue[] {
  const issues: IntelligenceContextIssue[] = [];
  const add = (
    code: string,
    message: string,
    severity: IntelligenceContextIssueSeverity,
    path?: string,
    value?: unknown,
  ): void => {
    issues.push({ code, message, severity, path, value });
  };

  if (!state.input.symbol) {
    add(
      "MISSING_SYMBOL",
      "A symbol is required to evaluate market intelligence.",
      "error",
      "contextRequest.input.symbol",
    );
  }

  if (!state.input.timeframe) {
    add(
      "MISSING_TIMEFRAME",
      "A timeframe is required to evaluate market intelligence.",
      "error",
      "contextRequest.input.timeframe",
    );
  }

  if (!finite(state.input.timestamp) || state.input.timestamp <= 0) {
    add(
      "INVALID_TIMESTAMP",
      "The market input timestamp must be a positive finite number.",
      "error",
      "contextRequest.input.timestamp",
      state.input.timestamp,
    );
  }

  const lastPrice = state.input.price.last ?? state.input.price.close;
  if (!finite(lastPrice)) {
    add(
      "MISSING_LAST_PRICE",
      "No finite last or close price was supplied. Price-dependent analysis may be degraded.",
      "warning",
      "contextRequest.input.price",
    );
  } else if (lastPrice <= 0) {
    add(
      "INVALID_LAST_PRICE",
      "The last market price must be greater than zero.",
      "error",
      "contextRequest.input.price.last",
      lastPrice,
    );
  }

  if (
    state.position &&
    state.position.symbol &&
    state.position.symbol !== state.input.symbol
  ) {
    add(
      "POSITION_SYMBOL_MISMATCH",
      "The open position symbol does not match the market context symbol.",
      "warning",
      "position.symbol",
      state.position.symbol,
    );
  }

  for (const [index, order] of state.orders.entries()) {
    if (!order.id) {
      add(
        "ORDER_MISSING_ID",
        "An order is missing its identifier and may not be tracked reliably.",
        "warning",
        `orders.${index}.id`,
      );
    }

    if (order.symbol && order.symbol !== state.input.symbol) {
      add(
        "ORDER_SYMBOL_MISMATCH",
        "An order symbol does not match the market context symbol.",
        "warning",
        `orders.${index}.symbol`,
        order.symbol,
      );
    }
  }

  const plan = state.tradePlan;
  if (plan?.entryPrice !== undefined && plan.entryPrice <= 0) {
    add(
      "INVALID_PLAN_ENTRY",
      "The planned entry price must be greater than zero.",
      "error",
      "tradePlan.entryPrice",
      plan.entryPrice,
    );
  }

  if (plan?.stopPrice !== undefined && plan.stopPrice <= 0) {
    add(
      "INVALID_PLAN_STOP",
      "The planned stop price must be greater than zero.",
      "error",
      "tradePlan.stopPrice",
      plan.stopPrice,
    );
  }

  if (plan?.targetPrice !== undefined && plan.targetPrice <= 0) {
    add(
      "INVALID_PLAN_TARGET",
      "The planned target price must be greater than zero.",
      "error",
      "tradePlan.targetPrice",
      plan.targetPrice,
    );
  }

  if (
    plan?.direction === "bullish" &&
    finite(plan.entryPrice) &&
    finite(plan.stopPrice) &&
    plan.stopPrice >= plan.entryPrice
  ) {
    add(
      "INVALID_LONG_STOP",
      "A bullish trade plan stop should be below its entry price.",
      "warning",
      "tradePlan.stopPrice",
      plan.stopPrice,
    );
  }

  if (
    plan?.direction === "bearish" &&
    finite(plan.entryPrice) &&
    finite(plan.stopPrice) &&
    plan.stopPrice <= plan.entryPrice
  ) {
    add(
      "INVALID_SHORT_STOP",
      "A bearish trade plan stop should be above its entry price.",
      "warning",
      "tradePlan.stopPrice",
      plan.stopPrice,
    );
  }

  if (state.minimumConfidence < 0 || state.minimumConfidence > 1) {
    add(
      "INVALID_MINIMUM_CONFIDENCE",
      "Minimum confidence must be between 0 and 1.",
      "error",
      "minimumConfidence",
      state.minimumConfidence,
    );
  }

  if (state.minimumTradeScore < 0 || state.minimumTradeScore > 100) {
    add(
      "INVALID_MINIMUM_TRADE_SCORE",
      "Minimum trade score must be between 0 and 100.",
      "error",
      "minimumTradeScore",
      state.minimumTradeScore,
    );
  }

  return issues;
}

export class IntelligenceContext implements IntelligenceContextState {
  readonly contextId!: string;
  readonly correlationId!: string;
  readonly symbol!: string;
  readonly timeframe!: string;
  readonly timestamp!: number;
  readonly createdAt!: number;
  readonly tradingDate?: string;
  readonly barIndex?: number;
  readonly source!: MarketContextSource;
  readonly consumer!: IntelligenceConsumer;
  readonly mode!: IntelligenceMode;
  readonly session!: MarketSession;
  readonly request!: Readonly<MarketIntelligenceRequest>;
  readonly contextRequest!: Readonly<MarketContextBuildRequest>;
  readonly input!: Readonly<MarketContextInputSnapshot>;
  readonly previousContextSnapshot!: MarketContextSnapshot | null;
  readonly previousReport!: MarketIntelligenceReport | null;
  readonly preferredDirection!: MarketContextDirection;
  readonly tradePlan!: Readonly<IntelligenceTradePlanInput> | null;
  readonly position!: Readonly<IntelligencePositionInput> | null;
  readonly orders!: readonly IntelligenceOrderInput[];
  readonly account!: Readonly<IntelligenceAccountInput> | null;
  readonly behavior!: Readonly<IntelligenceBehaviorInput> | null;
  readonly includeCoach!: boolean;
  readonly includeNarrative!: boolean;
  readonly includeExecutionAssessment!: boolean;
  readonly minimumConfidence!: number;
  readonly minimumTradeScore!: number;
  readonly metadata!: Readonly<Record<string, unknown>>;
  readonly warnings!: readonly IntelligenceContextIssue[];
  readonly errors!: readonly IntelligenceContextIssue[];
  readonly valid!: boolean;

  private constructor(state: IntelligenceContextState) {
    Object.assign(this, state);
  }

  static create(
    request: MarketIntelligenceRequest,
    options: IntelligenceContextOptions = {},
  ): IntelligenceContextBuildResult {
    const now = options.now ?? Date.now;
    const idFactory = options.idFactory ?? createDefaultId;
    const createdAt = now();
    const fallbackMode = options.defaultMode ?? "live";
    const fallbackSource = options.defaultSource ?? "system";
    const fallbackConsumer = options.defaultConsumer ?? "master-intelligence";

    const rawContextRequest = request.contextRequest;
    const rawInput = rawContextRequest?.input;

    if (!rawContextRequest || !rawInput) {
      const issue: IntelligenceContextIssue = {
        code: "MISSING_CONTEXT_REQUEST",
        message:
          "MarketIntelligenceRequest.contextRequest with an input snapshot is required.",
        severity: "error",
        path: "contextRequest",
      };
      throw new IntelligenceContextError(issue.message, [issue]);
    }

    const mode = normalizeMode(rawContextRequest.mode, fallbackMode);
    const source = rawContextRequest.source ?? fallbackSource;
    const input = normalizeInput(rawInput, createdAt);
    const correlationId =
      normalizeText(request.correlationId) ||
      normalizeText(rawContextRequest.correlationId) ||
      idFactory("correlation", createdAt);
    const contextId = idFactory("intelligence_context", input.timestamp);
    const consumer = request.consumer ?? fallbackConsumer;
    const tradePlan = normalizeTradePlan(request.tradePlan);
    const position = normalizePosition(request.position);
    const orders = normalizeOrders(request.orders);
    const account = normalizeAccount(request.account);
    const behavior = normalizeBehavior(request.behavior);
    const minimumConfidence = normalizeNumber(
      request.minimumConfidence,
      options.defaultMinimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE,
      0,
      1,
    );
    const minimumTradeScore = normalizeNumber(
      request.minimumTradeScore,
      options.defaultMinimumTradeScore ?? DEFAULT_MINIMUM_TRADE_SCORE,
      0,
      100,
    );
    const preferredDirection = normalizeDirection(request.preferredDirection);
    const metadata = {
      ...copyRecord(rawContextRequest.metadata),
      ...copyRecord(request.metadata),
      intelligenceContextId: contextId,
      correlationId,
      consumer,
    };

    const contextRequest: MarketContextBuildRequest = {
      input,
      source,
      mode,
      previousSnapshot: rawContextRequest.previousSnapshot ?? null,
      enabledCategories: rawContextRequest.enabledCategories
        ? [...rawContextRequest.enabledCategories]
        : undefined,
      correlationId,
      metadata,
    };

    const normalizedRequest: MarketIntelligenceRequest = {
      contextRequest,
      consumer,
      preferredDirection,
      tradePlan: tradePlan ?? undefined,
      position,
      orders,
      account: account ?? undefined,
      behavior: behavior ?? undefined,
      previousReport: request.previousReport ?? null,
      includeCoach: request.includeCoach ?? true,
      includeNarrative: request.includeNarrative ?? true,
      includeExecutionAssessment:
        request.includeExecutionAssessment ?? Boolean(position),
      minimumConfidence,
      minimumTradeScore,
      correlationId,
      metadata,
    };

    const issues = validateContext({
      input,
      position,
      orders,
      tradePlan,
      minimumConfidence,
      minimumTradeScore,
    });
    const warnings = issues.filter((issue) => issue.severity === "warning");
    const errors = issues.filter((issue) => issue.severity === "error");

    if (options.strict && errors.length > 0) {
      throw new IntelligenceContextError(
        `Invalid intelligence context: ${errors
          .map((issue) => issue.message)
          .join(" ")}`,
        errors,
      );
    }

    const state: IntelligenceContextState = {
      contextId,
      correlationId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      timestamp: input.timestamp,
      createdAt,
      tradingDate: input.tradingDate,
      barIndex: input.barIndex,
      source,
      consumer,
      mode,
      session: input.session,
      request: normalizedRequest,
      contextRequest,
      input,
      previousContextSnapshot: contextRequest.previousSnapshot ?? null,
      previousReport: normalizedRequest.previousReport ?? null,
      preferredDirection,
      tradePlan,
      position,
      orders,
      account,
      behavior,
      includeCoach: normalizedRequest.includeCoach ?? true,
      includeNarrative: normalizedRequest.includeNarrative ?? true,
      includeExecutionAssessment:
        normalizedRequest.includeExecutionAssessment ?? false,
      minimumConfidence,
      minimumTradeScore,
      metadata,
      warnings,
      errors,
      valid: errors.length === 0,
    };

    const context = new IntelligenceContext(state);
    if (options.freeze !== false) deepFreeze(context);

    return {
      context,
      valid: context.valid,
      warnings: [...warnings],
      errors: [...errors],
    };
  }

  /** Returns the normalized request accepted by MasterIntelligenceEngine. */
  toRequest(): MarketIntelligenceRequest {
    return this.request;
  }

  /** Returns true when the context belongs to the supplied market. */
  matches(symbol: string, timeframe?: string): boolean {
    const normalizedSymbol = normalizeText(symbol).toUpperCase();
    if (normalizedSymbol !== this.symbol) return false;
    return timeframe === undefined || normalizeText(timeframe) === this.timeframe;
  }

  /** Returns true when there is an open position for this context symbol. */
  hasPosition(): boolean {
    return Boolean(
      this.position &&
        this.position.symbol === this.symbol &&
        this.position.quantity > 0,
    );
  }

  /** Returns active orders belonging to this context symbol. */
  getSymbolOrders(): readonly IntelligenceOrderInput[] {
    return this.orders.filter(
      (order) => !order.symbol || order.symbol === this.symbol,
    );
  }

  /** Returns the best available current market price. */
  getCurrentPrice(): number | null {
    const price =
      this.input.price.last ??
      this.input.price.close ??
      this.input.price.midpoint ??
      this.input.price.bid ??
      this.input.price.ask;
    return finite(price) ? price : null;
  }

  /**
   * Produces a new normalized context while preserving correlation with the
   * current evaluation chain. Useful for each new live or replay bar.
   */
  next(
    request: MarketIntelligenceRequest,
    options: IntelligenceContextOptions = {},
  ): IntelligenceContextBuildResult {
    return IntelligenceContext.create(
      {
        ...request,
        previousReport: request.previousReport ?? this.previousReport,
        correlationId: request.correlationId ?? this.correlationId,
        metadata: {
          ...this.metadata,
          ...copyRecord(request.metadata),
          parentIntelligenceContextId: this.contextId,
        },
        contextRequest: {
          ...request.contextRequest,
          previousSnapshot:
            request.contextRequest.previousSnapshot ??
            this.previousContextSnapshot,
          correlationId:
            request.contextRequest.correlationId ?? this.correlationId,
          metadata: {
            ...this.contextRequest.metadata,
            ...copyRecord(request.contextRequest.metadata),
            parentIntelligenceContextId: this.contextId,
          },
        },
      },
      options,
    );
  }
}

export class IntelligenceContextError extends Error {
  readonly issues: readonly IntelligenceContextIssue[];

  constructor(message: string, issues: readonly IntelligenceContextIssue[]) {
    super(message);
    this.name = "IntelligenceContextError";
    this.issues = [...issues];
  }
}

export function createIntelligenceContext(
  request: MarketIntelligenceRequest,
  options?: IntelligenceContextOptions,
): IntelligenceContextBuildResult {
  return IntelligenceContext.create(request, options);
}
