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

const JOURNAL_TIME_ZONE = "America/Los_Angeles";

function formatDatePart(value: string): string {
  const timestamp = toTimestamp(value);
  if (!timestamp) return value;
  return new Date(timestamp).toLocaleDateString("en-US", {
    timeZone: JOURNAL_TIME_ZONE,
  });
}

function formatTimePart(value: string): string {
  const timestamp = toTimestamp(value);
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("en-US", {
    timeZone: JOURNAL_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatDateTime(value: string): string {
  if (!toTimestamp(value)) return value;
  return `${formatDatePart(value)} ${formatTimePart(value)}`;
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


type BrokerHistoryRow = {
  entry: TradeHistoryEntry;
  metadata: TradeJournalMetadata;
};

type BrokerEpisode = {
  symbol: string;
  direction: "long" | "short";
  entryFills: FilledOrderState[];
  exitFills: FilledOrderState[];
  openShares: number;
};

function cloneFillWithShares(
  order: FilledOrderState,
  shares: number,
): FilledOrderState {
  return { ...order, shares };
}

function firstPositive(values: Array<number | undefined>): number {
  for (const value of values) {
    const number = safeNumber(value);
    if (number > 0) return number;
  }
  return 0;
}

function inferBrokerExitReason(
  exitPrice: number,
  target: number,
  stop: number,
): JournalExitReason {
  const tolerance = Math.max(0.01, Math.abs(exitPrice) * 0.0005);
  if (target > 0 && Math.abs(exitPrice - target) <= tolerance) return "target";
  if (stop > 0 && Math.abs(exitPrice - stop) <= tolerance) return "stop";
  return exitPrice > 0 ? "manual" : "unknown";
}

function brokerRMultiple(
  direction: "long" | "short",
  entryPrice: number,
  stop: number,
  pnl: number,
  shares: number,
): number {
  if (shares <= 0 || entryPrice <= 0 || stop <= 0) return 0;
  const riskPerShare =
    direction === "long"
      ? Math.max(0, entryPrice - stop)
      : Math.max(0, stop - entryPrice);
  const totalRisk = riskPerShare * shares;
  return totalRisk > 0 ? pnl / totalRisk : 0;
}

function finalizeBrokerEpisode(
  episode: BrokerEpisode,
  status: TradeHistoryEntry["status"],
): BrokerHistoryRow | null {
  if (episode.entryFills.length === 0) return null;

  const entryShares = sumShares(episode.entryFills);
  const exitShares = sumShares(episode.exitFills);
  const entryPrice = weightedAverage(episode.entryFills, 0);
  const exitPrice = weightedAverage(episode.exitFills, 0);
  if (entryShares <= 0 || entryPrice <= 0) return null;

  const entryTimestamp = [...episode.entryFills]
    .sort((a, b) => toTimestamp(a.filledAt) - toTimestamp(b.filledAt))[0]
    ?.filledAt;
  const exitTimestamp = [...episode.exitFills]
    .sort((a, b) => toTimestamp(b.filledAt) - toTimestamp(a.filledAt))[0]
    ?.filledAt;
  if (!entryTimestamp) return null;

  const allFills = [...episode.entryFills, ...episode.exitFills];
  const target = firstPositive(allFills.map((fill) => fill.targetPrice));
  const stop = firstPositive(allFills.map((fill) => fill.stopPrice));
  const closedShares = Math.min(entryShares, exitShares);
  const grossPnl =
    closedShares > 0 && exitPrice > 0
      ? (episode.direction === "long"
          ? exitPrice - entryPrice
          : entryPrice - exitPrice) * closedShares
      : 0;
  const sourceOrderIds = uniqueStrings(
    allFills.flatMap((fill) => [fill.orderId, fill.id]),
  );
  const firstOrderId = sourceOrderIds[0] || String(toTimestamp(entryTimestamp));
  const id = `alpaca:${episode.symbol}:${firstOrderId}`;
  const shares = status === "closed" ? closedShares || entryShares : entryShares;

  return {
    entry: {
      id,
      symbol: episode.symbol,
      side: episode.direction === "long" ? "buy" : "sell",
      positionSide: episode.direction,
      status,
      shares,
      openShares: Math.max(0, episode.openShares),
      entryPrice,
      exitPrice,
      entryTime: formatDateTime(entryTimestamp),
      exitTime: exitTimestamp ? formatDateTime(exitTimestamp) : undefined,
      entryTimestamp,
      exitTimestamp,
      plannedTarget: target,
      plannedStop: stop,
      strategy: "Alpaca",
      grossPnl,
      netPnl: grossPnl,
      commission: 0,
      rMultiple: brokerRMultiple(
        episode.direction,
        entryPrice,
        stop,
        grossPnl,
        closedShares,
      ),
      exitReason: inferBrokerExitReason(exitPrice, target, stop),
      sourceOrderIds,
      notes: "Reconstructed directly from Alpaca fills.",
      rawOrders: allFills.map((fill) => fill.raw).filter(Boolean),
    },
    metadata: {
      target,
      stop,
      strategy: "Alpaca",
      holdTime: formatHoldTime(entryTimestamp, exitTimestamp),
    },
  };
}

function buildBrokerHistoryRows(orders: FilledOrderState[]): BrokerHistoryRow[] {
  const bySymbol = new Map<string, FilledOrderState[]>();
  for (const order of orders) {
    const symbol = cleanSymbol(order.symbol);
    if (!symbol || safeNumber(order.shares) <= 0 || safeNumber(order.averageFillPrice) <= 0) {
      continue;
    }
    const rows = bySymbol.get(symbol) ?? [];
    rows.push(order);
    bySymbol.set(symbol, rows);
  }

  const output: BrokerHistoryRow[] = [];
  for (const [symbol, symbolOrders] of bySymbol.entries()) {
    const sorted = [...symbolOrders].sort(
      (a, b) => toTimestamp(a.filledAt) - toTimestamp(b.filledAt),
    );
    let episode: BrokerEpisode | null = null;

    const beginEpisode = (
      order: FilledOrderState,
      shares: number,
    ): BrokerEpisode => ({
      symbol,
      direction: order.side === "buy" ? "long" : "short",
      entryFills: [cloneFillWithShares(order, shares)],
      exitFills: [],
      openShares: shares,
    });

    for (const order of sorted) {
      let remaining = Math.max(0, safeNumber(order.shares));
      if (remaining <= 0) continue;

      while (remaining > 0) {
        if (!episode) {
          episode = beginEpisode(order, remaining);
          remaining = 0;
          continue;
        }

        const entrySide = episode.direction === "long" ? "buy" : "sell";
        if (order.side === entrySide) {
          episode.entryFills.push(cloneFillWithShares(order, remaining));
          episode.openShares += remaining;
          remaining = 0;
          continue;
        }

        const closingShares = Math.min(episode.openShares, remaining);
        episode.exitFills.push(cloneFillWithShares(order, closingShares));
        episode.openShares = Math.max(0, episode.openShares - closingShares);
        remaining = Math.max(0, remaining - closingShares);

        if (episode.openShares <= 1e-9) {
          const completed = finalizeBrokerEpisode(episode, "closed");
          if (completed) output.push(completed);
          episode = null;
        }
      }
    }

    if (episode) {
      const status: TradeHistoryEntry["status"] =
        episode.exitFills.length > 0 ? "partial" : "open";
      const open = finalizeBrokerEpisode(episode, status);
      if (open) output.push(open);
    }
  }

  return output;
}

function entriesOverlap(a: TradeHistoryEntry, b: TradeHistoryEntry): boolean {
  const ids = new Set(a.sourceOrderIds);
  return b.sourceOrderIds.some((id) => ids.has(id));
}

function mergeExplicitWithBroker(
  explicit: TradeHistoryEntry,
  broker: TradeHistoryEntry,
): TradeHistoryEntry {
  const brokerHasExit = broker.exitPrice > 0 && Boolean(broker.exitTimestamp);
  const explicitTarget = safeNumber(explicit.plannedTarget);
  const explicitStop = safeNumber(explicit.plannedStop);
  const target = explicitTarget > 0 ? explicitTarget : safeNumber(broker.plannedTarget);
  const stop = explicitStop > 0 ? explicitStop : safeNumber(broker.plannedStop);
  const useBrokerExecution = broker.status === "closed" || explicit.status !== "closed";

  if (!useBrokerExecution) {
    return {
      ...explicit,
      plannedTarget: target,
      plannedStop: stop,
      strategy: explicit.strategy || broker.strategy,
      sourceOrderIds: uniqueStrings([
        ...explicit.sourceOrderIds,
        ...broker.sourceOrderIds,
      ]),
    };
  }

  const merged = {
    ...explicit,
    status: broker.status,
    shares: broker.shares,
    openShares: broker.openShares,
    entryPrice: broker.entryPrice,
    exitPrice: broker.exitPrice,
    entryTime: broker.entryTime,
    exitTime: broker.exitTime,
    entryTimestamp: broker.entryTimestamp,
    exitTimestamp: broker.exitTimestamp,
    grossPnl: broker.grossPnl,
    netPnl: broker.netPnl,
    commission: broker.commission,
    sourceOrderIds: uniqueStrings([
      ...explicit.sourceOrderIds,
      ...broker.sourceOrderIds,
    ]),
    rawOrders: [...(explicit.rawOrders ?? []), ...(broker.rawOrders ?? [])],
    plannedTarget: target,
    plannedStop: stop,
    strategy: explicit.strategy || broker.strategy,
    notes: explicit.notes || broker.notes,
  } as TradeHistoryEntry;

  if (brokerHasExit) {
    merged.exitReason = inferBrokerExitReason(
      broker.exitPrice,
      target,
      stop,
    );
    merged.rMultiple = brokerRMultiple(
      merged.positionSide,
      broker.entryPrice,
      stop,
      broker.netPnl,
      broker.shares,
    );
  }

  return merged;
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
      const displaySource = trade.entryTimestamp ?? trade.entryTime;

      return {
        id: trade.id,
        date: formatDatePart(displaySource),
        time: formatTimePart(displaySource),
        symbol: trade.symbol,
        strategy: metadata?.strategy ?? trade.strategy ?? "",
        side: trade.side,
        shares: trade.shares,
        entry: trade.entryPrice,
        exit: trade.exitPrice,
        target: metadata?.target ?? trade.plannedTarget ?? 0,
        stop: metadata?.stop ?? trade.plannedStop ?? 0,
        exitReason: trade.exitReason,
        holdTime: metadata?.holdTime ?? formatHoldTime(trade.entryTimestamp ?? "", trade.exitTimestamp),
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

    const explicitEntries = this.trades
      .map((trade) => this.buildTradeHistoryEntry(trade))
      .filter((entry): entry is TradeHistoryEntry => entry != null);
    const brokerRows = buildBrokerHistoryRows(this.filledOrders);
    const consumedBrokerIds = new Set<string>();
    const mergedEntries: TradeHistoryEntry[] = [];

    for (const explicit of explicitEntries) {
      const brokerIndex = brokerRows.findIndex(
        (row, index) =>
          !consumedBrokerIds.has(String(index)) &&
          row.entry.symbol === explicit.symbol &&
          entriesOverlap(explicit, row.entry),
      );

      if (brokerIndex >= 0) {
        const brokerRow = brokerRows[brokerIndex];
        const merged = mergeExplicitWithBroker(explicit, brokerRow.entry);
        consumedBrokerIds.add(String(brokerIndex));
        this.journalMetadata.set(merged.id, {
          target: safeNumber(merged.plannedTarget),
          stop: safeNumber(merged.plannedStop),
          strategy: merged.strategy ?? brokerRow.metadata.strategy,
          holdTime: formatHoldTime(
            merged.entryTimestamp ?? "",
            merged.exitTimestamp,
          ),
        });
        mergedEntries.push(merged);
      } else {
        mergedEntries.push(explicit);
      }
    }

    brokerRows.forEach((row, index) => {
      if (consumedBrokerIds.has(String(index))) return;
      this.journalMetadata.set(row.entry.id, row.metadata);
      mergedEntries.push(row.entry);
    });

    this.tradeHistory = mergedEntries.sort(
      (a, b) =>
        toTimestamp(b.exitTimestamp ?? b.entryTimestamp ?? b.exitTime ?? b.entryTime) -
        toTimestamp(a.exitTimestamp ?? a.entryTimestamp ?? a.exitTime ?? a.entryTime),
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
      entryTimestamp,
      exitTimestamp,
      plannedTarget: getPrimaryTarget(trade),
      plannedStop: safeNumber(trade.stop),
      strategy: trade.strategy ?? trade.setup ?? "",
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