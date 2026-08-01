import {
  cancelAlpacaOrder,
  fetchAlpacaAccount,
  fetchAlpacaOrders,
  fetchAlpacaPositions,
  placeAlpacaOrder,
  updateAlpacaOrder,
  type AlpacaMode,
  type AlpacaOrderClass,
  type AlpacaSide,
} from "../../services/api";
import type {
  QuickOrderEstimate,
  QuickOrderState,
} from "../../components/chart/right-panel/workspaces/trading/TradingTypes";
import { getSharedTradeHistoryEngine } from "../history/TradeHistoryEngine";
import { getSharedTradeEngine } from "../engine/TradeEngineRuntime";
import { roundToTick } from "../pricing/TickSizeManager";
import {
  cleanSymbol,
  isFilledOrder,
  normalizeAccount,
  normalizeFilledOrder,
  normalizeOpenOrder,
  normalizePosition,
  roundShares,
  validateQuickOrder,
} from "./execution/TradeExecutionMappers";
import {
  EMPTY_PERFORMANCE_SNAPSHOT,
  EMPTY_TRADING_ACCOUNT,
  type ClosePositionOptions,
  type FlattenPositionsResult,
  type SubmitQuickOrderResult,
  type TradeExecutionListener,
  type TradeExecutionSnapshot,
} from "./execution/TradeExecutionTypes";

export type {
  ClosePositionOptions,
  FlattenPositionsResult,
  SubmitQuickOrderResult,
  TradeConnectionStatus,
  TradeExecutionAction,
  TradeExecutionListener,
  TradeExecutionSnapshot,
  TradeExecutionStatus,
} from "./execution/TradeExecutionTypes";


const TERMINAL_ALPACA_STATUSES = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "replaced",
  "rejected",
  "done_for_day",
]);

const ACTIVE_ALPACA_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "held",
  "pending_cancel",
  "pending_replace",
  "partially_filled",
]);

function rawOrderId(order: unknown): string {
  if (!order || typeof order !== "object") return "";
  const record = order as Record<string, unknown>;
  return String(record.id ?? record.order_id ?? record.orderId ?? "").trim();
}

function rawOrderStatus(order: unknown): string {
  if (!order || typeof order !== "object") return "";
  const record = order as Record<string, unknown>;
  return String(record.status ?? "").trim().toLowerCase();
}

function rawOrderSymbol(order: unknown): string {
  if (!order || typeof order !== "object") return "";
  const record = order as Record<string, unknown>;
  return cleanSymbol(String(record.symbol ?? ""));
}

function rawOrderSide(order: unknown): "buy" | "sell" | "" {
  if (!order || typeof order !== "object") return "";
  const record = order as Record<string, unknown>;
  const side = String(record.side ?? "").trim().toLowerCase();
  return side === "buy" || side === "sell" ? side : "";
}

function rawFilledQty(order: unknown): number {
  if (!order || typeof order !== "object") return 0;
  const record = order as Record<string, unknown>;
  const value = Number(record.filled_qty ?? 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function flattenRawOrders(orders: unknown[]): unknown[] {
  const flattened: unknown[] = [];

  const visit = (order: unknown): void => {
    if (!order || typeof order !== "object") return;
    flattened.push(order);

    const record = order as Record<string, unknown>;
    const legs = Array.isArray(record.legs) ? record.legs : [];
    for (const leg of legs) visit(leg);
  };

  for (const order of orders) visit(order);
  return flattened;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function rawOrderReplaces(order: unknown): string {
  if (!order || typeof order !== "object") return "";
  const record = order as Record<string, unknown>;
  return String(record.replaces ?? "").trim();
}

function mergeReplacementOrder(
  current: unknown,
  replacement: unknown,
  replacedOrderId: string,
): { order: unknown; changed: boolean } {
  if (!current || typeof current !== "object") {
    return { order: current, changed: false };
  }

  const record = current as Record<string, unknown>;
  const currentId = rawOrderId(record);
  const replacementId = rawOrderId(replacement);
  const replacesId = rawOrderReplaces(replacement);

  if (
    currentId &&
    (currentId === replacedOrderId || currentId === replacesId)
  ) {
    const next = {
      ...record,
      ...(replacement as Record<string, unknown>),
    };

    // Alpaca can omit bracket legs from the immediate PATCH response. Retain
    // the existing legs until the next nested broker snapshot supplies them.
    if (
      !Array.isArray(next.legs) &&
      Array.isArray(record.legs)
    ) {
      next.legs = record.legs;
    }

    if (replacementId) next.id = replacementId;
    return { order: next, changed: true };
  }

  const legs = Array.isArray(record.legs) ? record.legs : [];
  let changed = false;
  const nextLegs = legs.map((leg) => {
    const result = mergeReplacementOrder(leg, replacement, replacedOrderId);
    changed ||= result.changed;
    return result.order;
  });

  return changed
    ? { order: { ...record, legs: nextLegs }, changed: true }
    : { order: current, changed: false };
}

export class TradeExecutionService {
  private mode: AlpacaMode;
  private snapshot: TradeExecutionSnapshot;
  private listeners = new Set<TradeExecutionListener>();
  private refreshTimer: number | null = null;
  private refreshInFlight: Promise<TradeExecutionSnapshot> | null = null;
  private queuedRefresh = false;
  private historyEngine = getSharedTradeHistoryEngine();
  private tradeEngine = getSharedTradeEngine();

  constructor(mode: AlpacaMode = "paper") {
    this.mode = mode;

    this.snapshot = {
      mode,
      connectionStatus: "disconnected",
      status: "idle",
      action: "idle",
      loading: false,
      lastError: null,
      lastMessage: null,

      account: EMPTY_TRADING_ACCOUNT,
      positions: [],
      openOrders: [],
      filledOrders: [],
      tradeHistory: [],
      performance: EMPTY_PERFORMANCE_SNAPSHOT,

      rawAccount: null,
      rawPositions: [],
      rawOpenOrders: [],
      rawClosedOrders: [],
      rawFilledOrders: [],

      updatedAt: null,
      refreshCount: 0,
    };
  }

  getSnapshot(): TradeExecutionSnapshot {
    return this.snapshot;
  }

  getMode(): AlpacaMode {
    return this.mode;
  }

  setMode(mode: AlpacaMode): void {
    if (this.mode === mode) return;

    this.mode = mode;
    this.setSnapshot({
      mode,
      connectionStatus: "reconnecting",
      lastMessage: `Switched to ${mode} mode.`,
    });

    this.queueRefresh();
  }

  subscribe(listener: TradeExecutionListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);

    return () => {
      this.listeners.delete(listener);
    };
  }

  startPolling(intervalMs = 8000): void {
    this.stopPolling();

    this.setSnapshot({
      connectionStatus:
        this.snapshot.connectionStatus === "connected"
          ? "connected"
          : "connecting",
    });

    this.refreshTimer = window.setInterval(() => {
      this.queueRefresh();
    }, Math.max(3000, intervalMs));

    this.queueRefresh();
  }

  stopPolling(): void {
    if (this.refreshTimer != null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  queueRefresh(): void {
    if (this.refreshInFlight) {
      this.queuedRefresh = true;
      return;
    }

    this.refreshInFlight = this.refreshAll()
      .catch(() => this.snapshot)
      .finally(() => {
        this.refreshInFlight = null;

        if (this.queuedRefresh) {
          this.queuedRefresh = false;
          this.queueRefresh();
        }
      });
  }

  async refreshAll(): Promise<TradeExecutionSnapshot> {
    this.setSnapshot({
      status: "loading",
      action: "refreshing",
      loading: true,
      lastError: null,
      lastMessage: "Refreshing trading data...",
      connectionStatus:
        this.snapshot.connectionStatus === "connected"
          ? "connected"
          : "connecting",
    });

    try {
      const [rawAccount, rawPositions, rawOrders] = await Promise.all([
        fetchAlpacaAccount(this.mode),
        fetchAlpacaPositions(this.mode),
        // One atomic order snapshot prevents the race where an externally
        // cancelled order disappears from "open" before a separate "closed"
        // request sees it.
        fetchAlpacaOrders(this.mode, "all", true),
      ]);

      const rawPositionsArray = Array.isArray(rawPositions) ? rawPositions : [];
      const rawOrdersArray = Array.isArray(rawOrders) ? rawOrders : [];

      const rawOpenOrdersArray = rawOrdersArray.filter(
        (order) => !TERMINAL_ALPACA_STATUSES.has(rawOrderStatus(order)),
      );
      const rawClosedOrdersArray = rawOrdersArray.filter((order) =>
        TERMINAL_ALPACA_STATUSES.has(rawOrderStatus(order)),
      );

      const filledOrders = rawClosedOrdersArray
        .filter(isFilledOrder)
        .map(normalizeFilledOrder);

      this.reconcileTradeLifecycle(
        rawOpenOrdersArray,
        rawClosedOrdersArray,
      );

      this.historyEngine.setTrades(this.tradeEngine.getTrades());
      this.historyEngine.setFilledOrders(filledOrders);

      this.setSnapshot({
        status: "success",
        action: "idle",
        loading: false,
        connectionStatus: "connected",
        lastError: null,
        lastMessage: "Trading data refreshed.",

        account: normalizeAccount(rawAccount),
        positions: rawPositionsArray.map(normalizePosition),
        openOrders: rawOpenOrdersArray.map(normalizeOpenOrder),
        filledOrders,
        tradeHistory: this.historyEngine.getTradeHistory(),
        performance: this.historyEngine.getPerformance(),

        rawAccount,
        rawPositions: rawPositionsArray,
        rawOpenOrders: rawOpenOrdersArray,
        rawClosedOrders: rawClosedOrdersArray,
        // Temporary compatibility field. Remove after all consumers migrate
        // to rawClosedOrders.
        rawFilledOrders: rawClosedOrdersArray,

        updatedAt: Date.now(),
        refreshCount: this.snapshot.refreshCount + 1,
      });

      return this.snapshot;
    } catch (error) {
      this.setSnapshot({
        status: "error",
        action: "idle",
        loading: false,
        connectionStatus: "error",
        lastError: this.errorToMessage(error),
        lastMessage: null,
      });

      return this.snapshot;
    }
  }

  async submitQuickOrder(
    order: QuickOrderState,
    estimate: QuickOrderEstimate,
  ): Promise<SubmitQuickOrderResult> {
    const validationError = validateQuickOrder(order, estimate);

    if (validationError) {
      return this.failSubmit(validationError);
    }

    this.setSnapshot({
      status: "loading",
      action: "submitting-order",
      loading: true,
      lastError: null,
      lastMessage: "Sending order to Alpaca...",
    });

    const orderClass: AlpacaOrderClass | undefined = order.bracketEnabled
      ? "bracket"
      : undefined;

    const payload: any = {
      mode: this.mode,
      symbol: cleanSymbol(order.symbol),
      side: order.side as AlpacaSide,
      qty: estimate.estimatedShares,
      type: order.orderType,
      time_in_force: "day",
      extended_hours: Boolean(order.extendedHours),
      order_class: orderClass,
    };

    if (order.orderType === "limit") {
      payload.limit_price = roundToTick(order.limitPrice);
    }

    if (order.bracketEnabled && order.bracketTarget > 0) {
      payload.take_profit = {
        limit_price: roundToTick(order.bracketTarget),
      };
    }

    if (order.bracketEnabled && order.bracketStop > 0) {
      payload.stop_loss = {
        stop_price: roundToTick(order.bracketStop),
      };
    }

    try {
      const placedOrder = await placeAlpacaOrder(payload);
      const placedOrderId = rawOrderId(placedOrder);
      const optimisticOrder = normalizeOpenOrder(placedOrder);

      this.setSnapshot({
        status: "success",
        action: "idle",
        loading: false,
        connectionStatus: "connected",
        lastError: null,
        lastMessage: "Order submitted to Alpaca.",
        openOrders: [
          optimisticOrder,
          ...this.snapshot.openOrders.filter(
            (item) => !placedOrderId || item.id !== placedOrderId,
          ),
        ],
        rawOpenOrders: [
          placedOrder,
          ...this.snapshot.rawOpenOrders.filter(
            (item) => !placedOrderId || rawOrderId(item) !== placedOrderId,
          ),
        ],
      });

      this.queueRefresh();

      return {
        ok: true,
        order: placedOrder,
      };
    } catch (error) {
      return this.failSubmit(this.errorToMessage(error));
    }
  }

  async closePositionShares(
    symbol: string,
    shares: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    const safeSymbol = cleanSymbol(symbol);
    const closeShares = roundShares(shares);

    if (!safeSymbol || safeSymbol === "—") {
      return this.failSubmit("Symbol is required to close a position.");
    }

    if (closeShares <= 0) {
      return this.failSubmit("Close quantity must be greater than 0.");
    }

    const livePosition = this.snapshot.positions.find(
      (position) => position.symbol === safeSymbol,
    );

    if (!livePosition || livePosition.shares <= 0) {
      return this.failSubmit(`No live position found for ${safeSymbol}.`);
    }

    const qty = Math.min(closeShares, roundShares(livePosition.shares));
    const side: AlpacaSide = livePosition.side === "long" ? "sell" : "buy";

    this.setSnapshot({
      status: "loading",
      action: "closing-position",
      loading: true,
      lastError: null,
      lastMessage: `Closing ${qty} shares of ${safeSymbol}...`,
    });

    try {
      const order = await placeAlpacaOrder({
        mode: this.mode,
        symbol: safeSymbol,
        side,
        qty,
        type: "market",
        time_in_force: "day",
        extended_hours: Boolean(options?.extendedHours ?? true),
      });

      this.setSnapshot({
        status: "success",
        action: "idle",
        loading: false,
        connectionStatus: "connected",
        lastError: null,
        lastMessage: `Close order submitted for ${qty} ${safeSymbol}.`,
      });

      this.queueRefresh();

      return {
        ok: true,
        order,
      };
    } catch (error) {
      return this.failSubmit(this.errorToMessage(error));
    }
  }

  async closePositionPercent(
    symbol: string,
    percent: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    const safeSymbol = cleanSymbol(symbol);
    const livePosition = this.snapshot.positions.find(
      (position) => position.symbol === safeSymbol,
    );

    if (!livePosition || livePosition.shares <= 0) {
      return this.failSubmit(`No live position found for ${safeSymbol}.`);
    }

    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const shares = roundShares((livePosition.shares * safePercent) / 100);

    return this.closePositionShares(safeSymbol, shares, options);
  }

  async closePosition(
    symbol: string,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    return this.closePositionPercent(symbol, 100, options);
  }

  async flattenAllPositions(
    options?: ClosePositionOptions,
  ): Promise<FlattenPositionsResult> {
    const positions = this.snapshot.positions.filter(
      (position) => position.shares > 0,
    );

    if (positions.length === 0) {
      const error = "No live positions to flatten.";
      this.setSnapshot({
        status: "error",
        action: "idle",
        loading: false,
        lastError: error,
        lastMessage: null,
      });

      return {
        ok: false,
        results: [],
        error,
      };
    }

    this.setSnapshot({
      status: "loading",
      action: "flattening-positions",
      loading: true,
      lastError: null,
      lastMessage: `Flattening ${positions.length} positions...`,
    });

    const results: SubmitQuickOrderResult[] = [];

    for (const position of positions) {
      const side: AlpacaSide = position.side === "long" ? "sell" : "buy";
      const qty = roundShares(position.shares);

      try {
        const order = await placeAlpacaOrder({
          mode: this.mode,
          symbol: position.symbol,
          side,
          qty,
          type: "market",
          time_in_force: "day",
          extended_hours: Boolean(options?.extendedHours ?? true),
        });

        results.push({
          ok: true,
          order,
        });
      } catch (error) {
        results.push({
          ok: false,
          error: this.errorToMessage(error),
        });
      }
    }

    const failed = results.filter((result) => !result.ok);
    const ok = failed.length === 0;

    this.setSnapshot({
      status: ok ? "success" : "error",
      action: "idle",
      loading: false,
      lastError: ok ? null : failed[0]?.error ?? "One or more flatten orders failed.",
      lastMessage: ok
        ? `Flatten orders submitted for ${positions.length} positions.`
        : "One or more flatten orders failed.",
    });

    this.queueRefresh();

    return {
      ok,
      results,
      error: ok ? undefined : failed[0]?.error,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!orderId) return false;

    this.setSnapshot({
      status: "loading",
      action: "canceling-order",
      loading: true,
      lastError: null,
      lastMessage: "Canceling order...",
    });

    try {
      await cancelAlpacaOrder(orderId, this.mode);

      this.setSnapshot({
        status: "success",
        action: "idle",
        loading: false,
        lastError: null,
        lastMessage: "Order canceled.",
      });

      this.queueRefresh();
      return true;
    } catch (error) {
      this.setSnapshot({
        status: "error",
        action: "idle",
        loading: false,
        lastError: this.errorToMessage(error),
        lastMessage: null,
      });

      return false;
    }
  }

  async modifyOrder(
    orderId: string,
    patch: {
      qty?: number;
      limit_price?: number;
      stop_price?: number;
      time_in_force?: string;
    },
  ): Promise<any | null> {
    if (!orderId) return null;

    this.setSnapshot({
      status: "loading",
      action: "modifying-order",
      loading: true,
      lastError: null,
      lastMessage: "Updating order...",
    });

    try {
      const updated = await updateAlpacaOrder(orderId, {
        ...patch,
        limit_price:
          patch.limit_price !== undefined
            ? roundToTick(patch.limit_price)
            : undefined,
        stop_price:
          patch.stop_price !== undefined
            ? roundToTick(patch.stop_price)
            : undefined,
      }, this.mode);

      // PATCH /orders is a replacement operation in Alpaca. The confirmed
      // order normally has a new id (and `replaces` points to the old id).
      // Reconcile it immediately so chart overlays and Open Orders never keep
      // reading the stale parent/leg while the next poll is pending.
      let replacementApplied = false;
      const nextRawOpenOrders = this.snapshot.rawOpenOrders.map((order) => {
        const result = mergeReplacementOrder(order, updated, orderId);
        replacementApplied ||= result.changed;
        return result.order;
      });

      if (!replacementApplied && updated && typeof updated === "object") {
        nextRawOpenOrders.unshift(updated);
      }

      const activeRawOrders = nextRawOpenOrders.filter(
        (order) => !TERMINAL_ALPACA_STATUSES.has(rawOrderStatus(order)),
      );

      this.setSnapshot({
        rawOpenOrders: activeRawOrders,
        openOrders: activeRawOrders.map(normalizeOpenOrder),
      });

      this.setSnapshot({
        status: "success",
        action: "idle",
        loading: false,
        lastError: null,
        lastMessage: "Order updated.",
      });

      this.queueRefresh();
      return updated;
    } catch (error) {
      this.setSnapshot({
        status: "error",
        action: "idle",
        loading: false,
        lastError: this.errorToMessage(error),
        lastMessage: null,
      });

      return null;
    }
  }

  private reconcileTradeLifecycle(
    rawOpenOrders: unknown[],
    rawClosedOrders: unknown[],
  ): void {
    const openOrders = flattenRawOrders(rawOpenOrders);
    const closedOrders = flattenRawOrders(rawClosedOrders);

    for (const trade of this.tradeEngine.getTrades()) {
      if (
        !["submitted", "accepted", "partially_filled"].includes(
          trade.status,
        )
      ) {
        continue;
      }

      const linkedIds = trade.links.alpacaOrderIds ?? [];
      const expectedSide = trade.direction === "long" ? "buy" : "sell";
      const symbol = cleanSymbol(trade.symbol);

      const matchesTrade = (order: unknown): boolean => {
        const id = rawOrderId(order);

        if (id && linkedIds.includes(id)) {
          return true;
        }

        return (
          rawOrderSymbol(order) === symbol &&
          rawOrderSide(order) === expectedSide
        );
      };

      const matchingOpenOrders = openOrders.filter(matchesTrade);
      const matchingClosedOrders = closedOrders.filter(matchesTrade);

      if (matchingOpenOrders.length > 0) {
        const orderIds = uniqueStrings([
          ...linkedIds,
          ...matchingOpenOrders.map(rawOrderId),
        ]);

        const hasPartialFill = matchingOpenOrders.some(
          (order) =>
            rawOrderStatus(order) === "partially_filled" ||
            rawFilledQty(order) > 0,
        );

        const nextStatus = hasPartialFill
          ? "partially_filled"
          : "accepted";

        if (
          trade.status !== nextStatus ||
          orderIds.length !== linkedIds.length ||
          orderIds.some((id) => !linkedIds.includes(id))
        ) {
          this.tradeEngine.updateTrade(trade.id, {
            status: nextStatus,
            links: {
              ...trade.links,
              alpacaOrderIds: orderIds,
            },
          });
        }

        if (this.tradeEngine.getSelectedTradeId() === trade.id) {
          this.tradeEngine.selectTrade(trade.id);
        }

        continue;
      }

      if (matchingClosedOrders.length === 0) {
        continue;
      }

      const statuses = matchingClosedOrders.map(rawOrderStatus);

      let nextStatus: "filled" | "cancelled" | "rejected" | null = null;

      if (statuses.includes("rejected")) {
        nextStatus = "rejected";
      } else if (statuses.includes("filled")) {
        nextStatus = "filled";
      } else if (
        statuses.some((status) =>
          [
            "canceled",
            "cancelled",
            "expired",
            "replaced",
            "done_for_day",
          ].includes(status),
        )
      ) {
        nextStatus = "cancelled";
      }

      if (!nextStatus) continue;

      this.tradeEngine.updateTrade(trade.id, {
        status: nextStatus,
        links: {
          ...trade.links,
          alpacaOrderIds:
            nextStatus === "cancelled" || nextStatus === "rejected"
              ? []
              : uniqueStrings([
                  ...linkedIds,
                  ...matchingClosedOrders.map(rawOrderId),
                ]),
        },
      });

      // Re-emit selection so the Plan Trade card updates even if this trade
      // was already selected before the external Alpaca lifecycle change.
      if (this.tradeEngine.getSelectedTradeId() === trade.id) {
        this.tradeEngine.selectTrade(trade.id);
      }
    }
  }

  private failSubmit(error: string): SubmitQuickOrderResult {
    this.setSnapshot({
      status: "error",
      action: "idle",
      loading: false,
      lastError: error,
      lastMessage: null,
    });

    return {
      ok: false,
      error,
    };
  }

  private errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "Unknown trading execution error.";
  }

  private setSnapshot(patch: Partial<TradeExecutionSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
    };

    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}

const sharedTradeExecutionServices: Partial<
  Record<AlpacaMode, TradeExecutionService>
> = {};

export function getSharedTradeExecutionService(
  mode: AlpacaMode = "paper",
): TradeExecutionService {
  let service = sharedTradeExecutionServices[mode];

  if (!service) {
    service = new TradeExecutionService(mode);
    sharedTradeExecutionServices[mode] = service;
  }

  return service;
}
