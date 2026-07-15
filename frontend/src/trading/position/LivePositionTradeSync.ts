// src/trading/position/LivePositionTradeSync.ts

import type {
  CurrentPositionState,
  OpenOrderState,
} from "../../components/chart/right-panel/workspaces/trading/TradingTypes";
import { TradeEngine } from "../engine/TradeEngine";
import type {
  TradeObject,
  TradeStatus,
} from "../engine/TradeTypes";
import {
  getSharedTradeExecutionService,
  type TradeExecutionSnapshot,
} from "../services/TradeExecutionService";
import {
  getSharedPositionProtectionEngine,
  type PositionProtectionState,
} from "./PositionProtectionEngine";

function cleanSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveNumber(value: unknown): number | null {
  const parsed = safeNumber(value);
  return parsed > 0 ? parsed : null;
}

function sameNumber(a: unknown, b: unknown): boolean {
  return Math.abs(safeNumber(a) - safeNumber(b)) < 0.0000001;
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function rawOrderId(order: unknown): string {
  if (!order || typeof order !== "object") return "";

  const record = order as Record<string, unknown>;

  return String(
    record.id ?? record.order_id ?? record.orderId ?? "",
  ).trim();
}

function rawOrderStatus(order: unknown): string {
  if (!order || typeof order !== "object") return "";

  const record = order as Record<string, unknown>;

  return String(record.status ?? "")
    .trim()
    .toLowerCase();
}

function rawOrderSymbol(order: unknown): string {
  if (!order || typeof order !== "object") return "";

  const record = order as Record<string, unknown>;
  return cleanSymbol(record.symbol);
}

function rawOrderSide(order: unknown): "buy" | "sell" | "" {
  if (!order || typeof order !== "object") return "";

  const record = order as Record<string, unknown>;
  const side = String(record.side ?? "")
    .trim()
    .toLowerCase();

  return side === "buy" || side === "sell" ? side : "";
}

function isTerminalCancelledStatus(status: string): boolean {
  return [
    "canceled",
    "cancelled",
    "expired",
    "replaced",
    "rejected",
  ].includes(status);
}

function isRawEntryOrderForTrade(
  trade: TradeObject,
  order: unknown,
): boolean {
  const expectedSide = trade.direction === "long" ? "buy" : "sell";

  return (
    rawOrderSymbol(order) === cleanSymbol(trade.symbol) &&
    rawOrderSide(order) === expectedSide
  );
}

function flattenRawOrders(orders: unknown[]): unknown[] {
  const flattened: unknown[] = [];

  const visit = (order: unknown) => {
    if (!order || typeof order !== "object") return;

    flattened.push(order);

    const record = order as Record<string, unknown>;
    const legs = Array.isArray(record.legs) ? record.legs : [];

    for (const leg of legs) {
      visit(leg);
    }
  };

  for (const order of orders) {
    visit(order);
  }

  return flattened;
}

function sameIds(a: string[] | undefined, b: string[]): boolean {
  const left = [...(a ?? [])].sort();
  const right = [...b].sort();

  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isOpenTradeStatus(status: TradeStatus): boolean {
  return !["closed", "cancelled", "rejected"].includes(status);
}

function getPrimaryTarget(trade: TradeObject | null): number {
  return safeNumber(trade?.targets[0]?.price);
}

function findLivePosition(
  snapshot: TradeExecutionSnapshot,
  symbol: string,
): CurrentPositionState | null {
  const safeSymbol = cleanSymbol(symbol);

  return (
    snapshot.positions.find(
      (position) =>
        cleanSymbol(position.symbol) === safeSymbol &&
        safeNumber(position.shares) > 0,
    ) ?? null
  );
}

function isEntrySideForTrade(
  trade: TradeObject,
  order: OpenOrderState,
): boolean {
  const expectedSide = trade.direction === "long" ? "buy" : "sell";

  return (
    cleanSymbol(order.symbol) === cleanSymbol(trade.symbol) &&
    order.side === expectedSide
  );
}

function statusPriority(status: TradeStatus): number {
  switch (status) {
    case "managing":
      return 90;
    case "filled":
      return 80;
    case "partially_filled":
      return 70;
    case "accepted":
      return 60;
    case "submitted":
      return 50;
    case "ready":
      return 30;
    case "draft":
      return 20;
    default:
      return 0;
  }
}

export class LivePositionTradeSync {
  private unsubscribeExecution: (() => void) | null = null;
  private syncing = false;
  private hadLivePosition = false;
  private trackedTradeId: string | null = null;

  constructor(private readonly tradeEngine: TradeEngine) {}

  attach(): void {
    if (this.unsubscribeExecution) return;

    const executionService = getSharedTradeExecutionService("paper");

    this.unsubscribeExecution = executionService.subscribe((snapshot) => {
      this.applySnapshot(snapshot);
    });

    this.applySnapshot(executionService.getSnapshot());
    executionService.queueRefresh();
  }

  detach(): void {
    this.unsubscribeExecution?.();
    this.unsubscribeExecution = null;
    this.hadLivePosition = false;
    this.trackedTradeId = null;
  }

  private applySnapshot(snapshot: TradeExecutionSnapshot): void {
    if (this.syncing) return;

    const workspace = this.tradeEngine.getWorkspace();
    const symbol = cleanSymbol(workspace.symbol);

    if (!symbol || symbol === "—") return;

    this.syncing = true;

    try {
      const livePosition = findLivePosition(snapshot, symbol);

      if (!livePosition) {
        this.syncPendingOrderState(snapshot, symbol);
        this.handlePositionClosed(symbol);
        return;
      }

      this.hadLivePosition = true;

      const trade = this.findTradeForPosition(symbol);
      const protection = this.buildProtection(
        livePosition,
        trade,
        snapshot,
      );

      if (trade) {
        this.updateExistingTrade(trade, livePosition, protection);
      } else {
        this.createTradeFromPosition(livePosition, protection);
      }
    } finally {
      this.syncing = false;
    }
  }

  private findTradeForPosition(symbol: string): TradeObject | null {
    const safeSymbol = cleanSymbol(symbol);

    if (this.trackedTradeId) {
      const tracked = this.tradeEngine.getTrade(this.trackedTradeId);

      if (
        tracked &&
        cleanSymbol(tracked.symbol) === safeSymbol &&
        isOpenTradeStatus(tracked.status)
      ) {
        return tracked;
      }
    }

    const selected = this.tradeEngine.getSelectedTrade();

    const matching = this.tradeEngine
      .getTrades()
      .filter(
        (trade) =>
          cleanSymbol(trade.symbol) === safeSymbol &&
          isOpenTradeStatus(trade.status),
      )
      .sort((a, b) => {
        const statusDifference =
          statusPriority(b.status) - statusPriority(a.status);

        if (statusDifference !== 0) return statusDifference;

        if (selected?.id === a.id) return -1;
        if (selected?.id === b.id) return 1;

        return b.updatedAt.localeCompare(a.updatedAt);
      });

    const trade = matching[0] ?? null;
    this.trackedTradeId = trade?.id ?? null;
    return trade;
  }

  private syncPendingOrderState(
    snapshot: TradeExecutionSnapshot,
    symbol: string,
  ): void {
    const trade = this.findTradeForPosition(symbol);

    if (!trade) return;
    if (!["submitted", "accepted", "partially_filled"].includes(trade.status)) {
      return;
    }

    const existingIds = trade.links.alpacaOrderIds ?? [];

    const matchingOrders = snapshot.openOrders.filter((order) => {
      if (existingIds.includes(order.id)) return true;
      return isEntrySideForTrade(trade, order);
    });

    if (matchingOrders.length === 0) {
      // TradeExecutionService owns terminal lifecycle reconciliation from the
      // atomic Alpaca "all orders" snapshot.
      return;
    }

    const nextOrderIds = uniqueIds([
      ...existingIds,
      ...matchingOrders.map((order) => order.id),
    ]);

    const needsStatusUpdate = trade.status === "submitted";
    const needsLinksUpdate = !sameIds(existingIds, nextOrderIds);

    if (!needsStatusUpdate && !needsLinksUpdate) return;

    this.tradeEngine.updateTrade(trade.id, {
      status: needsStatusUpdate ? "accepted" : trade.status,
      links: {
        ...trade.links,
        alpacaOrderIds: nextOrderIds,
      },
    });

    this.ensureSelected(trade.id);
    this.trackedTradeId = trade.id;
  }

  private buildProtection(
    livePosition: CurrentPositionState,
    trade: TradeObject | null,
    snapshot: TradeExecutionSnapshot,
  ): PositionProtectionState {
    const protectionEngine = getSharedPositionProtectionEngine();

    return protectionEngine.buildProtection(
      {
        ...livePosition,
        stop: safeNumber(trade?.stop),
        target: getPrimaryTarget(trade),
      },
      snapshot.openOrders,
    );
  }

  private updateExistingTrade(
    trade: TradeObject,
    livePosition: CurrentPositionState,
    protection: PositionProtectionState,
  ): void {
    const nextEntry = positiveNumber(livePosition.entry) ?? trade.entry;
    const nextShares = Math.max(0, safeNumber(livePosition.shares));
    const nextStop =
      positiveNumber(protection.stopPrice) ?? trade.stop;
    const nextTarget =
      positiveNumber(protection.targetPrice) ??
      positiveNumber(getPrimaryTarget(trade));

    const protectionOrderIds = uniqueIds([
      protection.stopOrderId,
      protection.targetOrderId,
    ]);

    const nextOrderIds = uniqueIds([
      ...(trade.links.alpacaOrderIds ?? []),
      ...protectionOrderIds,
    ]);

    const needsCoreUpdate =
      trade.status !== "managing" ||
      trade.direction !== livePosition.side ||
      !sameNumber(trade.entry, nextEntry) ||
      !sameNumber(trade.shares, nextShares) ||
      !sameNumber(trade.stop, nextStop) ||
      !sameIds(trade.links.alpacaOrderIds, nextOrderIds);

    if (needsCoreUpdate) {
      this.tradeEngine.updateTrade(trade.id, {
        direction: livePosition.side,
        status: "managing",
        entry: nextEntry,
        stop: nextStop,
        shares: nextShares,
        sizingMode: "shares",
        links: {
          ...trade.links,
          alpacaOrderIds: nextOrderIds,
        },
      });
    }

    if (
      nextTarget != null &&
      !sameNumber(getPrimaryTarget(trade), nextTarget)
    ) {
      this.tradeEngine.updateTarget(trade.id, nextTarget);
    }

    this.ensureSelected(trade.id);
    this.trackedTradeId = trade.id;
  }

  private createTradeFromPosition(
    livePosition: CurrentPositionState,
    protection: PositionProtectionState,
  ): void {
    const workspace = this.tradeEngine.getWorkspace();

    const orderIds = uniqueIds([
      protection.stopOrderId,
      protection.targetOrderId,
    ]);

    const trade = this.tradeEngine.createTrade({
      symbol: cleanSymbol(livePosition.symbol),
      timeframe: workspace.timeframe,
      direction: livePosition.side,
      source: "manual",
      mode: "paper",
      status: "managing",
      entry: positiveNumber(livePosition.entry),
      stop: positiveNumber(protection.stopPrice),
      target: positiveNumber(protection.targetPrice),
      sizingMode: "shares",
      shares: Math.max(0, safeNumber(livePosition.shares)),
    });

    if (orderIds.length > 0) {
      this.tradeEngine.updateTrade(trade.id, {
        links: {
          ...trade.links,
          alpacaOrderIds: orderIds,
        },
      });
    }

    this.ensureSelected(trade.id);
    this.trackedTradeId = trade.id;
  }

  private handlePositionClosed(symbol: string): void {
    if (!this.hadLivePosition) return;

    const trade = this.findTradeForPosition(symbol);

    if (
      trade &&
      ["filled", "managing", "partially_filled"].includes(trade.status)
    ) {
      this.tradeEngine.updateStatus(trade.id, "closed");
    }

    this.hadLivePosition = false;
    this.trackedTradeId = null;
  }

  private ensureSelected(tradeId: string): void {
    if (this.tradeEngine.getSelectedTradeId() !== tradeId) {
      this.tradeEngine.selectTrade(tradeId);
    }
  }
}