// src/trading/execution/providers/ReplayExecutionProvider.ts

import type { CleanBar } from "../../../components/chart/ChartTypes";
import type {
  CurrentPositionState,
  FilledOrderState,
  OpenOrderState,
  PerformanceSnapshot,
  QuickOrderEstimate,
  QuickOrderState,
} from "../../../components/chart/right-panel/workspaces/trading/TradingTypes";
import {
  EMPTY_PERFORMANCE_SNAPSHOT,
  type ClosePositionOptions,
  type FlattenPositionsResult,
  type SubmitQuickOrderResult,
  type TradeExecutionSnapshot,
} from "../../services/execution/TradeExecutionTypes";
import { ExecutionEventDispatcher } from "../events/ExecutionEventDispatcher";
import {
  ReplayFillEngine,
  type ReplayClosedTrade,
  type ReplayOrder,
  type ReplayPosition,
} from "../replay/ReplayFillEngine";
import {
  BaseExecutionProvider,
  type ExecutionOrderPatch,
} from "./ExecutionProvider";

const STARTING_BALANCE = 100_000;

function cleanSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function safeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positive(value: unknown): number {
  return Math.max(0, safeNumber(value));
}

function createSnapshot(balance = STARTING_BALANCE): TradeExecutionSnapshot {
  return {
    mode: "paper",
    connectionStatus: "connected",
    status: "idle",
    action: "idle",
    loading: false,
    lastError: null,
    lastMessage: "Practice account ready.",
    account: {
      buyingPower: balance,
      cash: balance,
      portfolioValue: balance,
      dayPnl: 0,
      dayPnlPct: 0,
    },
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
    updatedAt: Date.now(),
    refreshCount: 0,
  };
}

function orderType(order: ReplayOrder): OpenOrderState["type"] {
  return order.targetPrice || order.bracketStopPrice
    ? "bracket"
    : order.type;
}

function formatOrderTime(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) return value;

  return new Date(timestamp).toLocaleTimeString([], {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function calculatePerformance(
  closedTrades: ReplayClosedTrade[],
  openPositionCount: number,
): PerformanceSnapshot {
  if (closedTrades.length === 0) {
    return {
      ...EMPTY_PERFORMANCE_SNAPSHOT,
      totalTrades: openPositionCount,
      openTrades: openPositionCount,
    };
  }

  const winners = closedTrades.filter((trade) => trade.grossPnl > 0);
  const losers = closedTrades.filter((trade) => trade.grossPnl < 0);
  const grossProfit = winners.reduce(
    (sum, trade) => sum + trade.grossPnl,
    0,
  );
  const grossLoss = losers.reduce(
    (sum, trade) => sum + trade.grossPnl,
    0,
  );
  const netPnl = grossProfit + grossLoss;

  return {
    ...EMPTY_PERFORMANCE_SNAPSHOT,
    totalTrades: closedTrades.length + openPositionCount,
    closedTrades: closedTrades.length,
    openTrades: openPositionCount,
    wins: winners.length,
    losses: losers.length,
    winRate:
      closedTrades.length > 0
        ? (winners.length / closedTrades.length) * 100
        : 0,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor:
      grossLoss < 0
        ? grossProfit / Math.abs(grossLoss)
        : grossProfit > 0
          ? grossProfit
          : 0,
    expectancy: netPnl / closedTrades.length,
    averageWinner:
      winners.length > 0 ? grossProfit / winners.length : 0,
    averageLoser:
      losers.length > 0 ? grossLoss / losers.length : 0,
    largestWinner:
      winners.length > 0
        ? Math.max(...winners.map((trade) => trade.grossPnl))
        : 0,
    largestLoser:
      losers.length > 0
        ? Math.min(...losers.map((trade) => trade.grossPnl))
        : 0,
  };
}

export class ReplayExecutionProvider extends BaseExecutionProvider {
  readonly id = "replay" as const;

  private readonly fillEngine = new ReplayFillEngine();
  private readonly events = new ExecutionEventDispatcher("replay");
  private snapshot = createSnapshot();
  private initialized = false;
  private startingBalance = STARTING_BALANCE;
  private currentSymbol = "";
  private currentBar: CleanBar | null = null;
  private currentBarTime: number | null = null;
  private lastProcessedBarKey = "";

  async initialize(): Promise<void> {
    this.initialized = true;
    this.rebuildSnapshot("Practice execution connected.");
    this.events.snapshotUpdated(this.snapshot);
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.setSnapshot({
      connectionStatus: "disconnected",
      status: "idle",
      action: "idle",
      loading: false,
      lastMessage: "Practice execution disconnected.",
    });
    this.events.snapshotUpdated(this.snapshot);
  }

  getSnapshot(): TradeExecutionSnapshot {
    return this.snapshot;
  }

  async refresh(): Promise<TradeExecutionSnapshot> {
    this.rebuildSnapshot("Practice account refreshed.");
    this.events.snapshotUpdated(this.snapshot);
    return this.snapshot;
  }

  setReplayContext(symbol: string, bar: CleanBar | null): void {
    this.currentSymbol = cleanSymbol(symbol);
    this.currentBar = bar ? { ...bar } : null;
    this.currentBarTime = bar ? Number(bar.time) : null;
  }

  processReplayBar(
    symbol: string,
    bar: CleanBar,
  ): TradeExecutionSnapshot {
    const safeSymbol = cleanSymbol(symbol);
    const barTime = Number(bar.time);

    if (!safeSymbol || !Number.isFinite(barTime)) {
      return this.snapshot;
    }

    this.setReplayContext(safeSymbol, bar);

    const barKey = `${safeSymbol}:${barTime}`;
    if (barKey === this.lastProcessedBarKey) {
      return this.snapshot;
    }

    this.lastProcessedBarKey = barKey;
    const result = this.fillEngine.processBar(safeSymbol, bar);

    this.rebuildSnapshot(
      result.changed
        ? "Practice candle processed. Simulated execution updated."
        : "Practice candle processed.",
    );

    this.events.replayBarProcessed(result, this.snapshot);

    return this.snapshot;
  }

  async submitQuickOrder(
    order: QuickOrderState,
    estimate: QuickOrderEstimate,
  ): Promise<SubmitQuickOrderResult> {
    if (!this.initialized) await this.initialize();

    const symbol = cleanSymbol(order.symbol);
    const qty = Math.max(
      0,
      Math.floor(safeNumber(estimate.estimatedShares)),
    );

    if (!symbol || symbol === "—") {
      return this.fail("Symbol is required.", "submit-order");
    }

    if (qty <= 0) {
      return this.fail(
        "Practice order quantity must be greater than 0.",
        "submit-order",
      );
    }

    if (order.orderType === "limit" && order.limitPrice <= 0) {
      return this.fail("Limit price is required.", "submit-order");
    }

    if (order.orderType === "stop" && order.stopPrice <= 0) {
      return this.fail("Stop price is required.", "submit-order");
    }

    const now = new Date().toISOString();

    const replayOrder: ReplayOrder = {
      id: crypto.randomUUID(),
      symbol,
      side: order.side,
      qty,
      type: order.orderType,
      status: "accepted",
      limitPrice:
        order.orderType === "limit"
          ? positive(order.limitPrice)
          : undefined,
      stopPrice:
        order.orderType === "stop"
          ? positive(order.stopPrice)
          : undefined,
      targetPrice:
        order.bracketEnabled && order.bracketTarget > 0
          ? positive(order.bracketTarget)
          : undefined,
      bracketStopPrice:
        order.bracketEnabled && order.bracketStop > 0
          ? positive(order.bracketStop)
          : undefined,
      createdAt: now,
      updatedAt: now,
      submittedBarTime:
        this.currentSymbol === symbol
          ? this.currentBarTime ?? undefined
          : undefined,
    };

    const accepted = this.fillEngine.submitOrder(replayOrder);

    if (accepted.status === "rejected") {
      this.events.orderRejected(accepted);
      return this.fail("Practice order was rejected.", "submit-order");
    }

    this.events.orderAccepted(accepted);

    if (
      accepted.type === "market" &&
      this.currentSymbol === symbol &&
      this.currentBar != null
    ) {
      const result = this.fillEngine.fillMarketOrderAtCurrentBar(
        accepted.id,
        this.currentBar,
      );

      if (result.filledOrders.length > 0) {
        const filled = result.filledOrders[0];
        this.rebuildSnapshot(
          "Practice market order filled at the current replay price.",
        );
        this.events.replayBarProcessed(result, this.snapshot);

        return {
          ok: true,
          order: this.toRawOrder(filled),
        };
      }
    }

    this.rebuildSnapshot("Practice order accepted.");
    this.events.snapshotUpdated(this.snapshot);

    return {
      ok: true,
      order: this.toRawOrder(accepted),
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const canceled = this.fillEngine.cancelOrder(orderId);

    if (!canceled) return false;

    this.rebuildSnapshot("Practice order canceled.");
    this.events.orderCanceled(canceled);
    this.events.snapshotUpdated(this.snapshot);
    return true;
  }

  async modifyOrder(
    orderId: string,
    patch: ExecutionOrderPatch,
  ): Promise<unknown | null> {
    const updated = this.fillEngine.replaceOrder(orderId, {
      qty:
        patch.qty !== undefined
          ? Math.floor(positive(patch.qty))
          : undefined,
      limitPrice:
        patch.limit_price !== undefined
          ? positive(patch.limit_price)
          : undefined,
      stopPrice:
        patch.stop_price !== undefined
          ? positive(patch.stop_price)
          : undefined,
      targetPrice:
        patch.target_price !== undefined
          ? positive(patch.target_price)
          : undefined,
      bracketStopPrice:
        patch.bracket_stop_price !== undefined
          ? positive(patch.bracket_stop_price)
          : undefined,
    });

    if (!updated) return null;

    this.rebuildSnapshot("Practice order updated.");
    this.events.snapshotUpdated(this.snapshot);
    return this.toRawOrder(updated);
  }

  async modifyPositionProtection(
    symbol: string,
    patch: { targetPrice?: number; stopPrice?: number },
  ): Promise<ReplayPosition | null> {
    const updated = this.fillEngine.replacePositionProtection(symbol, patch);
    if (!updated) return null;

    this.rebuildSnapshot("Practice position protection updated.");
    this.events.snapshotUpdated(this.snapshot);
    return updated;
  }

  async closePosition(
    symbol: string,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    void options;
    return this.closePositionPercent(symbol, 100);
  }

  async closePositionShares(
    symbol: string,
    shares: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    void options;

    const safeSymbol = cleanSymbol(symbol);
    const position = this.fillEngine.getPosition(safeSymbol);

    if (!position) {
      return this.fail(
        `No practice position found for ${safeSymbol}.`,
        "close-position",
      );
    }

    const qty = Math.min(
      Math.floor(position.shares),
      Math.floor(positive(shares)),
    );

    if (qty <= 0) {
      return this.fail(
        "Close quantity must be greater than 0.",
        "close-position",
      );
    }

    const closeOrder: QuickOrderState = {
      symbol: safeSymbol,
      side: position.side === "long" ? "sell" : "buy",
      sizingMode: "shares",
      shares: qty,
      dollars: 0,
      orderType: "market",
      limitPrice: 0,
      stopPrice: 0,
      extendedHours: true,
      bracketEnabled: false,
      bracketTarget: 0,
      bracketStop: 0,
    };

    return this.submitQuickOrder(closeOrder, {
      estimatedShares: qty,
      estimatedCost: qty * position.averageEntry,
      riskPerShare: 0,
      totalRisk: 0,
      rewardPerShare: 0,
      totalReward: 0,
      rMultiple: 0,
    });
  }

  async closePositionPercent(
    symbol: string,
    percent: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    const safeSymbol = cleanSymbol(symbol);
    const position = this.fillEngine.getPosition(safeSymbol);

    if (!position) {
      return this.fail(
        `No practice position found for ${safeSymbol}.`,
        "close-position",
      );
    }

    const safePercent = Math.max(
      0,
      Math.min(100, safeNumber(percent)),
    );
    const shares = Math.floor(
      (position.shares * safePercent) / 100,
    );

    return this.closePositionShares(
      safeSymbol,
      shares,
      options,
    );
  }

  async flattenAllPositions(
    options?: ClosePositionOptions,
  ): Promise<FlattenPositionsResult> {
    const positions = this.fillEngine.getPositions();

    if (positions.length === 0) {
      return {
        ok: false,
        results: [],
        error: "No practice positions to flatten.",
      };
    }

    const results: SubmitQuickOrderResult[] = [];

    for (const position of positions) {
      results.push(
        await this.closePosition(position.symbol, options),
      );
    }

    const failed = results.find((result) => !result.ok);

    return {
      ok: !failed,
      results,
      error: failed?.error,
    };
  }

  resetAccount(startingBalance = STARTING_BALANCE): void {
    this.startingBalance = positive(startingBalance);
    this.fillEngine.reset();
    this.currentSymbol = "";
    this.currentBar = null;
    this.currentBarTime = null;
    this.lastProcessedBarKey = "";
    this.snapshot = createSnapshot(this.startingBalance);
    this.rebuildSnapshot("Practice account reset.");
    this.events.snapshotUpdated(this.snapshot);
  }

  private fail(
    error: string,
    operation?: string,
  ): SubmitQuickOrderResult {
    this.setSnapshot({
      status: "error",
      action: "idle",
      loading: false,
      lastError: error,
      lastMessage: null,
    });

    this.events.executionError(error, operation);
    this.events.snapshotUpdated(this.snapshot);

    return { ok: false, error };
  }

  private rebuildSnapshot(message: string): void {
    const state = this.fillEngine.getState();
    const working = state.orders.filter(
      (order) => order.status === "accepted",
    );
    const closed = state.orders.filter(
      (order) => order.status !== "accepted",
    );
    const filled = state.orders.filter(
      (order) => order.status === "filled",
    );

    const openOrders: OpenOrderState[] = working.map((order) => ({
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      type: orderType(order),
      shares: order.qty,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice ?? order.bracketStopPrice,
      targetPrice: order.targetPrice,
      status: "accepted",
      createdAt: formatOrderTime(order.createdAt),
    }));

    const filledOrders: FilledOrderState[] = filled.map((order) => ({
      id: order.id,
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      shares: order.filledQty ?? order.qty,
      type: orderType(order),
      averageFillPrice: order.fillPrice ?? 0,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice ?? order.bracketStopPrice,
      targetPrice: order.targetPrice,
      filledAt: order.filledAt ?? order.updatedAt,
      submittedAt: order.createdAt,
      status: "filled",
      raw: this.toRawOrder(order),
    }));

    const positions: CurrentPositionState[] =
      state.positions.map((position) =>
        this.toCurrentPosition(position),
      );

    const realizedPnl = state.closedTrades.reduce(
      (sum, trade) => sum + trade.grossPnl,
      0,
    );
    const unrealizedPnl = state.positions.reduce(
      (sum, position) => sum + position.unrealizedPnl,
      0,
    );

    const netCashFlow = state.fills.reduce((sum, fill) => {
      const notional = fill.qty * fill.price;
      return fill.side === "buy"
        ? sum - notional
        : sum + notional;
    }, 0);

    const cash = this.startingBalance + netCashFlow;
    const positionMarketValue = state.positions.reduce(
      (sum, position) => {
        const marketValue =
          position.shares * position.lastPrice;

        return position.side === "long"
          ? sum + marketValue
          : sum - marketValue;
      },
      0,
    );
    const portfolioValue = cash + positionMarketValue;
    const dayPnl = realizedPnl + unrealizedPnl;

    this.snapshot = {
      ...this.snapshot,
      connectionStatus: this.initialized
        ? "connected"
        : "disconnected",
      status: "success",
      action: "idle",
      loading: false,
      lastError: null,
      lastMessage: message,
      account: {
        buyingPower: Math.max(0, cash),
        cash,
        portfolioValue,
        dayPnl,
        dayPnlPct:
          this.startingBalance > 0
            ? (dayPnl / this.startingBalance) * 100
            : 0,
      },
      positions,
      openOrders,
      filledOrders,
      performance: calculatePerformance(
        state.closedTrades,
        state.positions.length,
      ),
      rawAccount: {
        starting_balance: this.startingBalance,
        cash,
        portfolio_value: portfolioValue,
        realized_pnl: realizedPnl,
        unrealized_pnl: unrealizedPnl,
      },
      rawPositions: state.positions.map((position) => ({
        ...position,
      })),
      rawOpenOrders: working.map((order) =>
        this.toRawOrder(order),
      ),
      rawClosedOrders: closed.map((order) =>
        this.toRawOrder(order),
      ),
      rawFilledOrders: filled.map((order) =>
        this.toRawOrder(order),
      ),
      updatedAt: Date.now(),
      refreshCount: this.snapshot.refreshCount + 1,
    };
  }

  private toCurrentPosition(
    position: ReplayPosition,
  ): CurrentPositionState {
    return {
      symbol: position.symbol,
      side: position.side,
      shares: position.shares,
      entry: position.averageEntry,
      target: position.targetPrice ?? 0,
      stop: position.stopPrice ?? 0,
    };
  }

  private setSnapshot(
    patch: Partial<TradeExecutionSnapshot>,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      updatedAt: Date.now(),
    };
  }

  private toRawOrder(
    order: ReplayOrder,
  ): Record<string, unknown> {
    return {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      type: order.type,
      status: order.status,
      limit_price: order.limitPrice,
      stop_price: order.stopPrice,
      take_profit: order.targetPrice
        ? { limit_price: order.targetPrice }
        : undefined,
      stop_loss: order.bracketStopPrice
        ? { stop_price: order.bracketStopPrice }
        : undefined,
      order_class:
        order.targetPrice || order.bracketStopPrice
          ? "bracket"
          : undefined,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
      submitted_bar_time: order.submittedBarTime,
      filled_at: order.filledAt,
      filled_qty: order.filledQty ?? 0,
      filled_avg_price: order.fillPrice,
      reduce_only: order.reduceOnly,
      parent_position_id: order.parentPositionId,
    };
  }
}