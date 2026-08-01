// src/trading/history/TradeHistoryEngine.ts

import type {
  FilledOrderState,
  JournalExitReason,
  JournalTradeState,
  PerformanceSnapshot,
  TradeHistoryEntry,
} from "../../components/chart/right-panel/workspaces/trading/TradingTypes";
import type { TradeObject } from "../engine/TradeTypes";

type TradeJournalMetadata = {
  target: number;
  stop: number;
  strategy: string;
  holdTime: string;
};

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
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

function toTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDateTime(value: string): string {
  const timestamp = toTimestamp(value);
  if (!timestamp) return value;

  const date = new Date(timestamp);

  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatHoldTime(start: string, end?: string): string {
  const startMs = toTimestamp(start);
  const endMs = toTimestamp(end);

  if (!startMs || !endMs || endMs <= startMs) return "";

  const totalMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function weightedAverage(
  orders: FilledOrderState[],
  fallback = 0,
): number {
  const totalShares = orders.reduce(
    (sum, order) => sum + Math.max(0, safeNumber(order.shares)),
    0,
  );

  if (totalShares <= 0) return fallback;

  const weighted = orders.reduce(
    (sum, order) =>
      sum +
      Math.max(0, safeNumber(order.shares)) *
        safeNumber(order.averageFillPrice),
    0,
  );

  return weighted / totalShares;
}

function sumShares(orders: FilledOrderState[]): number {
  return orders.reduce(
    (sum, order) => sum + Math.max(0, safeNumber(order.shares)),
    0,
  );
}

function getPrimaryTarget(trade: TradeObject): number {
  return safeNumber(trade.targets[0]?.price);
}

function tradeFillsToFilledOrders(trade: TradeObject): FilledOrderState[] {
  return trade.fills
    .filter(
      (fill) =>
        Number(fill.shares) > 0 &&
        Number(fill.price) > 0,
    )
    .map((fill) => {
      const orderId = String(fill.orderId ?? fill.id).trim();

      return {
        id: orderId,
        orderId,
        symbol: cleanSymbol(trade.symbol),
        side: fill.side,
        shares: safeNumber(fill.shares),
        type: "unknown",
        averageFillPrice: safeNumber(fill.price),
        filledAt: fill.timestamp,
        status: "filled",
        raw: fill,
      };
    });
}

function mergeTradeFills(
  externalFills: FilledOrderState[],
  internalFills: FilledOrderState[],
): FilledOrderState[] {
  const merged = new Map<string, FilledOrderState>();

  for (const fill of externalFills) {
    const key = String(fill.orderId || fill.id).trim();
    if (key) merged.set(key, fill);
  }

  for (const fill of internalFills) {
    const key = String(fill.orderId || fill.id).trim();
    if (!key) continue;

    // TradeEngine fills are authoritative during Practice mode and also act as
    // a safe fallback when an execution snapshot no longer contains an older
    // completed order. Prefer the internal fill when both sources exist.
    merged.set(key, fill);
  }

  return Array.from(merged.values()).sort(
    (a, b) => toTimestamp(a.filledAt) - toTimestamp(b.filledAt),
  );
}

function inferExitReason(
  trade: TradeObject,
  exitPrice: number,
): JournalExitReason {
  const stop = safeNumber(trade.stop);
  const target = getPrimaryTarget(trade);
  const tolerance = Math.max(0.01, Math.abs(exitPrice) * 0.0005);

  if (stop > 0 && Math.abs(exitPrice - stop) <= tolerance) {
    return "stop";
  }

  if (target > 0 && Math.abs(exitPrice - target) <= tolerance) {
    return "target";
  }

  return "manual";
}

function calculatePnl(
  trade: TradeObject,
  entryPrice: number,
  exitPrice: number,
  closedShares: number,
): number {
  if (closedShares <= 0 || entryPrice <= 0 || exitPrice <= 0) return 0;

  const perShare =
    trade.direction === "long"
      ? exitPrice - entryPrice
      : entryPrice - exitPrice;

  return perShare * closedShares;
}

function calculateRMultiple(
  trade: TradeObject,
  entryPrice: number,
  netPnl: number,
  closedShares: number,
): number {
  if (closedShares <= 0) return 0;

  const stop = safeNumber(trade.stop);
  const riskPerShare =
    trade.direction === "long"
      ? Math.max(0, entryPrice - stop)
      : Math.max(0, stop - entryPrice);

  const totalRisk =
    riskPerShare > 0
      ? riskPerShare * closedShares
      : safeNumber(trade.metrics.riskAmount);

  return totalRisk > 0 ? netPnl / totalRisk : 0;
}

export class TradeHistoryEngine {
  private filledOrders: FilledOrderState[] = [];
  private trades: TradeObject[] = [];
  private tradeHistory: TradeHistoryEntry[] = [];
  private journalMetadata = new Map<string, TradeJournalMetadata>();

  setFilledOrders(orders: FilledOrderState[]): void {
    this.filledOrders = [...orders];
    this.rebuildHistory();
  }

  setTrades(trades: TradeObject[]): void {
    this.trades = [...trades];
    this.rebuildHistory();
  }

  mergeFilledOrders(orders: FilledOrderState[]): void {
    const merged = new Map<string, FilledOrderState>();

    for (const order of this.filledOrders) {
      const key = String(order.orderId || order.id).trim();
      if (key) merged.set(key, order);
    }

    for (const order of orders) {
      const key = String(order.orderId || order.id).trim();
      if (key) merged.set(key, order);
    }

    this.filledOrders = Array.from(merged.values()).sort(
      (a, b) => toTimestamp(b.filledAt) - toTimestamp(a.filledAt),
    );

    this.rebuildHistory();
  }

  resetPracticeHistory(): void {
    this.filledOrders = [];
    this.trades = [];
    this.tradeHistory = [];
    this.journalMetadata.clear();
  }

  upsertTrade(trade: TradeObject): void {
    const index = this.trades.findIndex((item) => item.id === trade.id);

    if (index >= 0) {
      this.trades[index] = trade;
    } else {
      this.trades.push(trade);
    }

    this.rebuildHistory();
  }

  removeTrade(tradeId: string): void {
    this.trades = this.trades.filter((trade) => trade.id !== tradeId);
    this.journalMetadata.delete(tradeId);
    this.rebuildHistory();
  }

  addFilledOrder(order: FilledOrderState): void {
    const index = this.filledOrders.findIndex(
      (item) => item.id === order.id || item.orderId === order.orderId,
    );

    if (index >= 0) {
      this.filledOrders[index] = order;
    } else {
      this.filledOrders.unshift(order);
    }

    this.rebuildHistory();
  }

  getFilledOrders(): FilledOrderState[] {
    return [...this.filledOrders];
  }

  getTradeHistory(): TradeHistoryEntry[] {
    return [...this.tradeHistory];
  }

  getJournal(): JournalTradeState[] {
    return this.tradeHistory.map((trade) => {
      const metadata = this.journalMetadata.get(trade.id);

      const [date = "", time = ""] = trade.entryTime.split(" ");

      return {
        id: trade.id,
        date,
        time,
        symbol: trade.symbol,
        strategy: metadata?.strategy ?? "",
        side: trade.side,
        shares: trade.shares,
        entry: trade.entryPrice,
        exit: trade.exitPrice,
        target: metadata?.target ?? 0,
        stop: metadata?.stop ?? 0,
        exitReason: trade.exitReason,
        holdTime: metadata?.holdTime ?? "",
        grossPnl: trade.grossPnl,
        netPnl: trade.netPnl,
        rMultiple: trade.rMultiple,
        notes: trade.notes,
      };
    });
  }

  getPerformance(): PerformanceSnapshot {
    const closed = this.tradeHistory.filter(
      (trade) => trade.status === "closed",
    );

    const wins = closed.filter((trade) => trade.netPnl > 0);
    const losses = closed.filter((trade) => trade.netPnl < 0);

    const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
    const grossLoss = Math.abs(
      losses.reduce((sum, trade) => sum + trade.netPnl, 0),
    );
    const netPnl = closed.reduce((sum, trade) => sum + trade.netPnl, 0);

    return {
      totalTrades: this.tradeHistory.length,
      closedTrades: closed.length,
      openTrades: this.tradeHistory.length - closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate:
        closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      grossProfit,
      grossLoss,
      netPnl,
      profitFactor:
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0,
      expectancy:
        closed.length > 0 ? netPnl / closed.length : 0,
      averageWinner:
        wins.length > 0 ? grossProfit / wins.length : 0,
      averageLoser:
        losses.length > 0 ? grossLoss / losses.length : 0,
      averageR:
        closed.length > 0
          ? closed.reduce((sum, trade) => sum + trade.rMultiple, 0) /
            closed.length
          : 0,
      largestWinner:
        wins.length > 0
          ? Math.max(...wins.map((trade) => trade.netPnl))
          : 0,
      largestLoser:
        losses.length > 0
          ? Math.min(...losses.map((trade) => trade.netPnl))
          : 0,
    };
  }

  private rebuildHistory(): void {
    this.journalMetadata.clear();

    if (this.trades.length === 0) {
      this.tradeHistory = [];
      return;
    }

    this.tradeHistory = this.trades
      .map((trade) => this.buildTradeHistoryEntry(trade))
      .filter((entry): entry is TradeHistoryEntry => entry != null)
      .sort(
        (a, b) =>
          toTimestamp(b.exitTime ?? b.entryTime) -
          toTimestamp(a.exitTime ?? a.entryTime),
      );
  }

  private buildTradeHistoryEntry(
    trade: TradeObject,
  ): TradeHistoryEntry | null {
    const linkedOrderIds = new Set(trade.links.alpacaOrderIds ?? []);

    const externalLinkedFills = this.filledOrders.filter((order) => {
      if (linkedOrderIds.has(order.orderId) || linkedOrderIds.has(order.id)) {
        return true;
      }

      return false;
    });

    const internalTradeFills = tradeFillsToFilledOrders(trade);
    const linkedFills = mergeTradeFills(
      externalLinkedFills,
      internalTradeFills,
    );

    // Journal and Performance are execution records, not submitted-order
    // records. TradeEngine owns the complete Practice fill history, while the
    // execution snapshot may contain only the newest filled order. Using both
    // sources prevents completed Practice trades from disappearing when a
    // later snapshot replaces the filled-order array.
    if (linkedFills.length === 0) {
      return null;
    }

    const entrySide = trade.direction === "long" ? "buy" : "sell";
    const exitSide = trade.direction === "long" ? "sell" : "buy";

    const entryFills = linkedFills.filter((order) => order.side === entrySide);
    const exitFills = linkedFills.filter((order) => order.side === exitSide);

    // Protection legs, cancelled brackets, or unrelated linked orders must not
    // create a journal row without an executed entry.
    if (entryFills.length === 0) {
      return null;
    }

    const entryShares = sumShares(entryFills);
    if (entryShares <= 0) {
      return null;
    }

    const entryPrice = weightedAverage(entryFills, 0);
    if (entryPrice <= 0) {
      return null;
    }
    const exitShares = sumShares(exitFills);
    const closedShares =
      trade.status === "closed"
        ? Math.max(exitShares, entryShares)
        : Math.min(exitShares, entryShares);
    const openShares = Math.max(0, entryShares - exitShares);

    const exitPrice = weightedAverage(exitFills, 0);
    const grossPnl = calculatePnl(
      trade,
      entryPrice,
      exitPrice,
      closedShares,
    );
    const commission = 0;
    const netPnl = grossPnl - commission;
    const rMultiple = calculateRMultiple(
      trade,
      entryPrice,
      netPnl,
      closedShares,
    );

    const firstEntryFill = [...entryFills].sort(
      (a, b) => toTimestamp(a.filledAt) - toTimestamp(b.filledAt),
    )[0];

    const lastExitFill = [...exitFills].sort(
      (a, b) => toTimestamp(b.filledAt) - toTimestamp(a.filledAt),
    )[0];

    const entryTimestamp =
      firstEntryFill?.filledAt ?? trade.createdAt;
    const exitTimestamp =
      lastExitFill?.filledAt ??
      (trade.status === "closed" ? trade.updatedAt : undefined);

    const status: TradeHistoryEntry["status"] =
      trade.status === "closed"
        ? "closed"
        : exitShares > 0
          ? "partial"
          : "open";

    const sourceOrderIds = uniqueStrings([
      ...(trade.links.alpacaOrderIds ?? []),
      ...linkedFills.map((order) => order.orderId),
    ]);

    this.journalMetadata.set(trade.id, {
      target: getPrimaryTarget(trade),
      stop: safeNumber(trade.stop),
      strategy: trade.strategy ?? trade.setup ?? "",
      holdTime: formatHoldTime(entryTimestamp, exitTimestamp),
    });

    return {
      id: trade.id,
      symbol: cleanSymbol(trade.symbol),
      side: entrySide,
      positionSide: trade.direction,
      status,
      shares: entryShares,
      openShares,
      entryPrice,
      exitPrice,
      entryTime: formatDateTime(entryTimestamp),
      exitTime: exitTimestamp
        ? formatDateTime(exitTimestamp)
        : undefined,
      grossPnl,
      netPnl,
      commission,
      rMultiple,
      exitReason:
        status === "closed" && exitPrice > 0
          ? inferExitReason(trade, exitPrice)
          : "unknown",
      sourceOrderIds,
      notes: trade.notes,
      rawOrders: linkedFills
        .map((order) => order.raw)
        .filter(Boolean),
    };
  }
}

let sharedTradeHistoryEngine: TradeHistoryEngine | null = null;

export function getSharedTradeHistoryEngine(): TradeHistoryEngine {
  if (!sharedTradeHistoryEngine) {
    sharedTradeHistoryEngine = new TradeHistoryEngine();
  }

  return sharedTradeHistoryEngine;
}