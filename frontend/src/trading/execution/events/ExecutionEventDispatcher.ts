// src/trading/execution/events/ExecutionEventDispatcher.ts

import type { TradeExecutionSnapshot } from "../../services/execution/TradeExecutionTypes";
import type {
  ReplayBarProcessResult,
  ReplayClosedTrade,
  ReplayFill,
  ReplayOrder,
  ReplayPosition,
} from "../replay/ReplayFillEngine";
import {
  createExecutionEvent,
  type ExecutionEventSource,
  type ExecutionEventType,
  type ExecutionOrderEventPayload,
  type ExecutionPositionEventPayload,
} from "./ExecutionEventTypes";
import {
  getSharedExecutionEventBus,
  type ExecutionEventBus,
} from "./ExecutionEventBus";

function toOrderPayload(
  order: ReplayOrder,
): ExecutionOrderEventPayload {
  return {
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    quantity: order.qty,
    filledQuantity: order.filledQty,
    averageFillPrice: order.fillPrice,
    status: order.status,
    rawOrder: order,
  };
}

function toPositionPayload(
  position: ReplayPosition,
): ExecutionPositionEventPayload {
  return {
    symbol: position.symbol,
    side: position.side,
    shares: position.shares,
    entryPrice: position.averageEntry,
    currentPrice: position.lastPrice,
    realizedPnl: position.realizedPnl,
    unrealizedPnl: position.unrealizedPnl,
    targetPrice: position.targetPrice,
    stopPrice: position.stopPrice,
    rawPosition: position,
  };
}

function findExitFill(
  trade: ReplayClosedTrade,
  fills: ReplayFill[],
): ReplayFill | undefined {
  return [...fills]
    .reverse()
    .find(
      (fill) =>
        fill.positionId === trade.positionId &&
        fill.reason !== "entry",
    );
}

export class ExecutionEventDispatcher {
  constructor(
    private readonly source: ExecutionEventSource,
    private readonly bus: ExecutionEventBus =
      getSharedExecutionEventBus(),
  ) {}

  orderAccepted(order: ReplayOrder): void {
    this.emit("order-accepted", toOrderPayload(order));
  }

  orderCanceled(order: ReplayOrder): void {
    this.emit("order-canceled", toOrderPayload(order));
  }

  orderRejected(order: ReplayOrder): void {
    this.emit("order-rejected", toOrderPayload(order));
  }

  snapshotUpdated(snapshot: TradeExecutionSnapshot): void {
    this.emit("snapshot-updated", { snapshot });
    this.emit("account-updated", { snapshot });
  }

  executionError(
    message: string,
    operation?: string,
    rawError?: unknown,
  ): void {
    this.emit("execution-error", {
      message,
      operation,
      rawError,
    });
  }

  replayBarProcessed(
    result: ReplayBarProcessResult,
    snapshot: TradeExecutionSnapshot,
  ): void {
    for (const order of result.filledOrders) {
      this.emit("order-filled", toOrderPayload(order));
    }

    for (const position of result.createdPositions) {
      this.emit("position-opened", toPositionPayload(position));
    }

    for (const position of result.updatedPositions) {
      this.emit("position-updated", toPositionPayload(position));
    }

    for (const position of result.closedPositions) {
      this.emit("position-closed", toPositionPayload(position));
    }

    for (const trade of result.closedTrades) {
      const exitFill = findExitFill(trade, result.fills);

      this.emit("trade-completed", {
        tradeId: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        shares: trade.shares,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        grossPnl: trade.grossPnl,
        netPnl: trade.grossPnl,
        exitReason: trade.exitReason,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        sourceOrderIds: exitFill ? [exitFill.orderId] : [],
        rawTrade: trade,
      });
    }

    this.snapshotUpdated(snapshot);
  }

  private emit<TType extends ExecutionEventType>(
    type: TType,
    payload: Parameters<typeof createExecutionEvent<TType>>[3],
  ): void {
    this.bus.emit(
      createExecutionEvent(
        type,
        this.source,
        "practice",
        payload,
      ),
    );
  }
}