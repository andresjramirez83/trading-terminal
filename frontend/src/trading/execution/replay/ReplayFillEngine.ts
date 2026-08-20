// src/trading/execution/replay/ReplayFillEngine.ts

import type { CleanBar } from "../../../components/chart/ChartTypes";

export type ReplaySide = "buy" | "sell";
export type ReplayOrderType = "market" | "limit" | "stop";
export type ReplayOrderStatus =
  | "accepted"
  | "filled"
  | "canceled"
  | "rejected";

export type ReplayExitReason =
  | "target"
  | "stop"
  | "manual"
  | "flatten"
  | "unknown";

export type ReplayOrder = {
  id: string;
  symbol: string;
  side: ReplaySide;
  qty: number;
  type: ReplayOrderType;
  status: ReplayOrderStatus;

  limitPrice?: number;
  stopPrice?: number;

  targetPrice?: number;
  bracketStopPrice?: number;

  createdAt: string;
  updatedAt: string;

  submittedBarTime?: number;
  filledAt?: string;
  fillPrice?: number;
  filledQty?: number;

  parentPositionId?: string;
  reduceOnly?: boolean;
};

export type ReplayPosition = {
  id: string;
  symbol: string;
  side: "long" | "short";
  shares: number;
  averageEntry: number;

  targetPrice?: number;
  stopPrice?: number;

  openedAt: string;
  updatedAt: string;

  realizedPnl: number;
  unrealizedPnl: number;
  lastPrice: number;
};

export type ReplayFill = {
  id: string;
  orderId: string;
  positionId: string;
  symbol: string;
  side: ReplaySide;
  qty: number;
  price: number;
  timestamp: string;
  reason: "entry" | ReplayExitReason;
};

export type ReplayClosedTrade = {
  id: string;
  positionId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  openedAt: string;
  closedAt: string;
  grossPnl: number;
  exitReason: ReplayExitReason;
};

export type ReplayFillPolicy = {
  marketFill: "next-open" | "current-close";
  sameBarConflict: "stop-first" | "target-first";
  priceImprovement: boolean;
};

export type ReplayFillEngineState = {
  orders: ReplayOrder[];
  positions: ReplayPosition[];
  fills: ReplayFill[];
  closedTrades: ReplayClosedTrade[];
};

export type ReplayBarProcessResult = {
  changed: boolean;
  filledOrders: ReplayOrder[];
  createdPositions: ReplayPosition[];
  updatedPositions: ReplayPosition[];
  closedPositions: ReplayPosition[];
  fills: ReplayFill[];
  closedTrades: ReplayClosedTrade[];
};

const DEFAULT_POLICY: ReplayFillPolicy = {
  marketFill: "next-open",
  sameBarConflict: "stop-first",
  priceImprovement: true,
};

function cleanSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function safeNumber(value: unknown): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

function positive(value: unknown): number {
  return Math.max(0, safeNumber(value));
}

function barTimestamp(bar: CleanBar): string {
  return new Date(Number(bar.time) * 1000).toISOString();
}

function cloneOrder(order: ReplayOrder): ReplayOrder {
  return { ...order };
}

function clonePosition(position: ReplayPosition): ReplayPosition {
  return { ...position };
}

export class ReplayFillEngine {
  private orders = new Map<string, ReplayOrder>();
  private positions = new Map<string, ReplayPosition>();
  private fills: ReplayFill[] = [];
  private closedTrades: ReplayClosedTrade[] = [];
  private policy: ReplayFillPolicy;

  constructor(policy?: Partial<ReplayFillPolicy>) {
    this.policy = {
      ...DEFAULT_POLICY,
      ...(policy ?? {}),
    };
  }

  setPolicy(policy: Partial<ReplayFillPolicy>): void {
    this.policy = {
      ...this.policy,
      ...policy,
    };
  }

  getPolicy(): ReplayFillPolicy {
    return { ...this.policy };
  }

  getState(): ReplayFillEngineState {
    return {
      orders: Array.from(this.orders.values()).map(cloneOrder),
      positions: Array.from(this.positions.values()).map(clonePosition),
      fills: this.fills.map((fill) => ({ ...fill })),
      closedTrades: this.closedTrades.map((trade) => ({ ...trade })),
    };
  }

  getOrders(): ReplayOrder[] {
    return Array.from(this.orders.values()).map(cloneOrder);
  }

  getWorkingOrders(): ReplayOrder[] {
    return this.getOrders().filter((order) => order.status === "accepted");
  }

  getPositions(): ReplayPosition[] {
    return Array.from(this.positions.values()).map(clonePosition);
  }

  getPosition(symbol: string): ReplayPosition | null {
    const safeSymbol = cleanSymbol(symbol);

    return (
      Array.from(this.positions.values()).find(
        (position) => position.symbol === safeSymbol,
      ) ?? null
    );
  }

  getFills(): ReplayFill[] {
    return this.fills.map((fill) => ({ ...fill }));
  }

  getClosedTrades(): ReplayClosedTrade[] {
    return this.closedTrades.map((trade) => ({ ...trade }));
  }

  submitOrder(order: ReplayOrder): ReplayOrder {
    const normalized: ReplayOrder = {
      ...order,
      symbol: cleanSymbol(order.symbol),
      qty: Math.max(0, Math.floor(positive(order.qty))),
      status: order.status ?? "accepted",
      createdAt: order.createdAt || new Date().toISOString(),
      updatedAt: order.updatedAt || new Date().toISOString(),
    };

    if (!normalized.symbol || normalized.qty <= 0) {
      normalized.status = "rejected";
    }

    this.orders.set(normalized.id, normalized);

    return cloneOrder(normalized);
  }

  cancelOrder(orderId: string): ReplayOrder | null {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "accepted") return null;

    order.status = "canceled";
    order.updatedAt = new Date().toISOString();
    this.orders.set(order.id, order);

    return cloneOrder(order);
  }

  replaceOrder(
    orderId: string,
    patch: Partial<
      Pick<
        ReplayOrder,
        | "qty"
        | "limitPrice"
        | "stopPrice"
        | "targetPrice"
        | "bracketStopPrice"
      >
    >,
  ): ReplayOrder | null {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "accepted") return null;

    if (patch.qty !== undefined) {
      const qty = Math.max(0, Math.floor(positive(patch.qty)));
      if (qty <= 0) return null;
      order.qty = qty;
    }

    if (patch.limitPrice !== undefined) {
      order.limitPrice = positive(patch.limitPrice);
    }

    if (patch.stopPrice !== undefined) {
      order.stopPrice = positive(patch.stopPrice);
    }

    if (patch.targetPrice !== undefined) {
      order.targetPrice = positive(patch.targetPrice);
    }

    if (patch.bracketStopPrice !== undefined) {
      order.bracketStopPrice = positive(patch.bracketStopPrice);
    }

    order.updatedAt = new Date().toISOString();
    this.orders.set(order.id, order);

    return cloneOrder(order);
  }

  replacePositionProtection(
    symbol: string,
    patch: { targetPrice?: number; stopPrice?: number },
  ): ReplayPosition | null {
    const position = this.getPosition(symbol);
    if (!position || position.shares <= 0) return null;

    if (patch.targetPrice !== undefined) {
      const targetPrice = positive(patch.targetPrice);
      if (targetPrice <= 0) return null;
      position.targetPrice = targetPrice;
    }

    if (patch.stopPrice !== undefined) {
      const stopPrice = positive(patch.stopPrice);
      if (stopPrice <= 0) return null;
      position.stopPrice = stopPrice;
    }

    position.updatedAt = new Date().toISOString();
    this.positions.set(position.id, position);
    return clonePosition(position);
  }

  processBar(symbol: string, bar: CleanBar): ReplayBarProcessResult {
    const safeSymbol = cleanSymbol(symbol);
    const result: ReplayBarProcessResult = {
      changed: false,
      filledOrders: [],
      createdPositions: [],
      updatedPositions: [],
      closedPositions: [],
      fills: [],
      closedTrades: [],
    };

    if (!safeSymbol) return result;

    this.processWorkingOrders(safeSymbol, bar, result);
    this.processPositionProtection(safeSymbol, bar, result);
    this.markToMarket(safeSymbol, bar, result);

    result.changed =
      result.filledOrders.length > 0 ||
      result.createdPositions.length > 0 ||
      result.updatedPositions.length > 0 ||
      result.closedPositions.length > 0 ||
      result.fills.length > 0 ||
      result.closedTrades.length > 0;

    return result;
  }

  reset(): void {
    this.orders.clear();
    this.positions.clear();
    this.fills = [];
    this.closedTrades = [];
  }

  private processWorkingOrders(
    symbol: string,
    bar: CleanBar,
    result: ReplayBarProcessResult,
  ): void {
    const working = Array.from(this.orders.values()).filter(
      (order) =>
        order.symbol === symbol &&
        order.status === "accepted",
    );

    for (const order of working) {
      if (!this.shouldFillOrder(order, bar)) continue;

      const fillPrice = this.resolveOrderFillPrice(order, bar);
      this.fillOrder(order, fillPrice, bar, result);
    }
  }

  private shouldFillOrder(order: ReplayOrder, bar: CleanBar): boolean {
    if (order.type === "market") {
      if (this.policy.marketFill === "current-close") return true;

      if (order.submittedBarTime == null) return true;

      return Number(bar.time) > order.submittedBarTime;
    }

    if (order.type === "limit") {
      const limit = positive(order.limitPrice);
      if (limit <= 0) return false;

      return order.side === "buy"
        ? Number(bar.low) <= limit
        : Number(bar.high) >= limit;
    }

    const stop = positive(order.stopPrice);
    if (stop <= 0) return false;

    return order.side === "buy"
      ? Number(bar.high) >= stop
      : Number(bar.low) <= stop;
  }

  private resolveOrderFillPrice(
    order: ReplayOrder,
    bar: CleanBar,
  ): number {
    if (order.type === "market") {
      return this.policy.marketFill === "next-open"
        ? Number(bar.open)
        : Number(bar.close);
    }

    if (order.type === "limit") {
      const limit = positive(order.limitPrice);

      if (!this.policy.priceImprovement) return limit;

      if (order.side === "buy") {
        return Number(bar.open) < limit
          ? Number(bar.open)
          : limit;
      }

      return Number(bar.open) > limit
        ? Number(bar.open)
        : limit;
    }

    const stop = positive(order.stopPrice);

    if (!this.policy.priceImprovement) return stop;

    if (order.side === "buy") {
      return Number(bar.open) > stop
        ? Number(bar.open)
        : stop;
    }

    return Number(bar.open) < stop
      ? Number(bar.open)
      : stop;
  }

  private fillOrder(
    order: ReplayOrder,
    fillPrice: number,
    bar: CleanBar,
    result: ReplayBarProcessResult,
  ): void {
    const timestamp = barTimestamp(bar);

    order.status = "filled";
    order.fillPrice = fillPrice;
    order.filledQty = order.qty;
    order.filledAt = timestamp;
    order.updatedAt = timestamp;
    this.orders.set(order.id, order);

    const existing = this.getPosition(order.symbol);
    const isClosingOrder =
      existing != null &&
      ((existing.side === "long" && order.side === "sell") ||
        (existing.side === "short" && order.side === "buy"));

    if (isClosingOrder && existing) {
      this.applyExitFill(
        existing,
        order,
        fillPrice,
        timestamp,
        "manual",
        result,
      );
      return;
    }

    const position = this.applyEntryFill(
      existing,
      order,
      fillPrice,
      timestamp,
    );

    const fill: ReplayFill = {
      id: crypto.randomUUID(),
      orderId: order.id,
      positionId: position.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: fillPrice,
      timestamp,
      reason: "entry",
    };

    this.fills.push(fill);

    result.filledOrders.push(cloneOrder(order));
    result.fills.push({ ...fill });

    if (existing) {
      result.updatedPositions.push(clonePosition(position));
    } else {
      result.createdPositions.push(clonePosition(position));
    }
  }

  private applyEntryFill(
    existing: ReplayPosition | null,
    order: ReplayOrder,
    fillPrice: number,
    timestamp: string,
  ): ReplayPosition {
    const side = order.side === "buy" ? "long" : "short";

    if (!existing) {
      const position: ReplayPosition = {
        id: crypto.randomUUID(),
        symbol: order.symbol,
        side,
        shares: order.qty,
        averageEntry: fillPrice,
        targetPrice: order.targetPrice,
        stopPrice: order.bracketStopPrice,
        openedAt: timestamp,
        updatedAt: timestamp,
        realizedPnl: 0,
        unrealizedPnl: 0,
        lastPrice: fillPrice,
      };

      this.positions.set(position.id, position);
      return position;
    }

    if (existing.side !== side) {
      return existing;
    }

    const combinedShares = existing.shares + order.qty;
    const combinedCost =
      existing.averageEntry * existing.shares +
      fillPrice * order.qty;

    existing.averageEntry =
      combinedShares > 0
        ? combinedCost / combinedShares
        : fillPrice;
    existing.shares = combinedShares;
    existing.targetPrice =
      order.targetPrice ?? existing.targetPrice;
    existing.stopPrice =
      order.bracketStopPrice ?? existing.stopPrice;
    existing.updatedAt = timestamp;
    existing.lastPrice = fillPrice;

    this.positions.set(existing.id, existing);

    return existing;
  }

  private processPositionProtection(
    symbol: string,
    bar: CleanBar,
    result: ReplayBarProcessResult,
  ): void {
    const position = this.getPosition(symbol);
    if (!position || position.shares <= 0) return;

    const targetTouched = this.isTargetTouched(position, bar);
    const stopTouched = this.isStopTouched(position, bar);

    if (!targetTouched && !stopTouched) return;

    let reason: ReplayExitReason;

    if (targetTouched && stopTouched) {
      reason =
        this.policy.sameBarConflict === "target-first"
          ? "target"
          : "stop";
    } else {
      reason = targetTouched ? "target" : "stop";
    }

    const exitPrice =
      reason === "target"
        ? positive(position.targetPrice)
        : positive(position.stopPrice);

    const side: ReplaySide =
      position.side === "long" ? "sell" : "buy";

    const syntheticOrder: ReplayOrder = {
      id: crypto.randomUUID(),
      symbol: position.symbol,
      side,
      qty: position.shares,
      type: reason === "target" ? "limit" : "stop",
      status: "filled",
      limitPrice:
        reason === "target" ? exitPrice : undefined,
      stopPrice:
        reason === "stop" ? exitPrice : undefined,
      createdAt: barTimestamp(bar),
      updatedAt: barTimestamp(bar),
      filledAt: barTimestamp(bar),
      fillPrice: exitPrice,
      filledQty: position.shares,
      reduceOnly: true,
      parentPositionId: position.id,
    };

    this.orders.set(syntheticOrder.id, syntheticOrder);

    this.applyExitFill(
      position,
      syntheticOrder,
      exitPrice,
      barTimestamp(bar),
      reason,
      result,
    );
  }

  private isTargetTouched(
    position: ReplayPosition,
    bar: CleanBar,
  ): boolean {
    const target = positive(position.targetPrice);
    if (target <= 0) return false;

    return position.side === "long"
      ? Number(bar.high) >= target
      : Number(bar.low) <= target;
  }

  private isStopTouched(
    position: ReplayPosition,
    bar: CleanBar,
  ): boolean {
    const stop = positive(position.stopPrice);
    if (stop <= 0) return false;

    return position.side === "long"
      ? Number(bar.low) <= stop
      : Number(bar.high) >= stop;
  }

  private applyExitFill(
    position: ReplayPosition,
    order: ReplayOrder,
    fillPrice: number,
    timestamp: string,
    reason: ReplayExitReason,
    result: ReplayBarProcessResult,
  ): void {
    const closeQty = Math.min(
      position.shares,
      Math.max(0, Math.floor(order.qty)),
    );

    if (closeQty <= 0) return;

    const grossPnl =
      position.side === "long"
        ? (fillPrice - position.averageEntry) * closeQty
        : (position.averageEntry - fillPrice) * closeQty;

    const fill: ReplayFill = {
      id: crypto.randomUUID(),
      orderId: order.id,
      positionId: position.id,
      symbol: position.symbol,
      side: order.side,
      qty: closeQty,
      price: fillPrice,
      timestamp,
      reason,
    };

    this.fills.push(fill);

    const remainingShares = position.shares - closeQty;
    position.realizedPnl += grossPnl;
    position.shares = remainingShares;
    position.lastPrice = fillPrice;
    position.updatedAt = timestamp;
    position.unrealizedPnl = 0;

    order.status = "filled";
    order.fillPrice = fillPrice;
    order.filledQty = closeQty;
    order.filledAt = timestamp;
    order.updatedAt = timestamp;
    this.orders.set(order.id, order);

    result.filledOrders.push(cloneOrder(order));
    result.fills.push({ ...fill });

    if (remainingShares > 0) {
      this.positions.set(position.id, position);
      result.updatedPositions.push(clonePosition(position));
      return;
    }

    const closedTrade: ReplayClosedTrade = {
      id: crypto.randomUUID(),
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.averageEntry,
      exitPrice: fillPrice,
      shares: closeQty,
      openedAt: position.openedAt,
      closedAt: timestamp,
      grossPnl,
      exitReason: reason,
    };

    this.closedTrades.push(closedTrade);

    console.log("================================");
    console.log("[ReplayFillEngine]");
    console.log("Closed Trades:", this.closedTrades.length);
    console.table(
      this.closedTrades.map((trade) => ({
        id: trade.id,
        positionId: trade.positionId,
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        shares: trade.shares,
        grossPnl: trade.grossPnl,
        exitReason: trade.exitReason,
      })),
    );
    console.log("================================");
    this.positions.delete(position.id);

    result.closedPositions.push(clonePosition(position));
    result.closedTrades.push({ ...closedTrade });
  }

  private markToMarket(
    symbol: string,
    bar: CleanBar,
    result: ReplayBarProcessResult,
  ): void {
    const position = this.getPosition(symbol);
    if (!position) return;

    const lastPrice = Number(bar.close);

    position.lastPrice = lastPrice;
    position.unrealizedPnl =
      position.side === "long"
        ? (lastPrice - position.averageEntry) * position.shares
        : (position.averageEntry - lastPrice) * position.shares;
    position.updatedAt = barTimestamp(bar);

    this.positions.set(position.id, position);

    if (
      !result.updatedPositions.some(
        (candidate) => candidate.id === position.id,
      )
    ) {
      result.updatedPositions.push(clonePosition(position));
    }
  }
}