// src/trading/execution/events/ExecutionTradeSynchronizer.ts

import { getSharedTradeEngine } from "../../engine/TradeEngineRuntime";
import type {
  TradeDirection,
  TradeObject,
  TradeStatus,
} from "../../engine/TradeTypes";
import { getSharedTradeHistoryEngine } from "../../history/TradeHistoryEngine";
import { getSharedExecutionEventBus } from "./ExecutionEventBus";
import type {
  ExecutionEvent,
  ExecutionOrderEventPayload,
  ExecutionTradeCompletedPayload,
} from "./ExecutionEventTypes";

const TERMINAL_STATUSES = new Set<TradeStatus>([
  "closed",
  "cancelled",
  "rejected",
]);

function cleanSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function directionForEntrySide(
  side: "buy" | "sell",
): TradeDirection {
  return side === "buy" ? "long" : "short";
}

function entrySideForTrade(
  trade: TradeObject,
): "buy" | "sell" {
  return trade.direction === "long" ? "buy" : "sell";
}

function exitSideForTrade(
  trade: TradeObject,
): "buy" | "sell" {
  return trade.direction === "long" ? "sell" : "buy";
}

function uniqueStrings(
  values: Array<string | null | undefined>,
): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function hasEntryFill(trade: TradeObject): boolean {
  const entrySide = entrySideForTrade(trade);

  return trade.fills.some(
    (fill) =>
      fill.side === entrySide &&
      Number(fill.shares) > 0 &&
      Number(fill.price) > 0,
  );
}

function hasExitFill(trade: TradeObject): boolean {
  const exitSide = exitSideForTrade(trade);

  return trade.fills.some(
    (fill) =>
      fill.side === exitSide &&
      Number(fill.shares) > 0 &&
      Number(fill.price) > 0,
  );
}

function hasCompletedRoundTrip(
  trade: TradeObject,
): boolean {
  return hasEntryFill(trade) && hasExitFill(trade);
}

export class ExecutionTradeSynchronizer {
  private readonly eventBus = getSharedExecutionEventBus();
  private readonly tradeEngine = getSharedTradeEngine();
  private readonly historyEngine = getSharedTradeHistoryEngine();
  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = this.eventBus.subscribe(
      this.handleEvent,
      { modes: ["practice"] },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  destroy(): void {
    this.stop();
  }

  private handleEvent = (event: ExecutionEvent): void => {
    switch (event.type) {
      case "order-accepted":
        this.handleOrderAccepted(event.payload);
        break;

      case "order-filled":
        this.handleOrderFilled(event.payload);
        break;

      case "order-canceled":
        this.handleOrderCanceled(event.payload);
        break;

      case "order-rejected":
        this.handleOrderRejected(event.payload);
        break;

      case "position-opened":
      case "position-updated":
        this.handlePositionActive(event.payload.symbol);
        break;

      case "trade-completed":
        this.handleTradeCompleted(event.payload);
        break;

      case "snapshot-updated":
        this.historyEngine.setTrades(
          this.tradeEngine.getTrades(),
        );
        this.historyEngine.setFilledOrders(
          event.payload.snapshot.filledOrders,
        );
        break;
    }
  };

  private handleOrderAccepted(
    payload: ExecutionOrderEventPayload,
  ): void {
    const trade = this.resolveEntryTrade(payload);

    this.tradeEngine.updateTrade(trade.id, {
      status: "accepted",
      shares: payload.quantity,
      sizingMode: "shares",
      links: {
        ...trade.links,
        alpacaOrderIds: uniqueStrings([
          ...(trade.links.alpacaOrderIds ?? []),
          payload.orderId,
        ]),
      },
    });

    this.tradeEngine.selectTrade(trade.id);
    this.refreshHistory();
  }

  private handleOrderFilled(
    payload: ExecutionOrderEventPayload,
  ): void {
    const linkedTrade = this.findTradeByOrderId(
      payload.orderId,
    );

    const trade =
      linkedTrade ??
      this.findActiveTradeForFill(payload) ??
      this.createPracticeTrade(payload);

    const isEntry =
      payload.side === entrySideForTrade(trade);

    const fillPrice =
      Number(payload.averageFillPrice) || 0;

    const fillShares =
      Number(payload.filledQuantity) ||
      Number(payload.quantity) ||
      0;

    const nextFills = [
      ...trade.fills.filter(
        (fill) => fill.orderId !== payload.orderId,
      ),
      {
        id: crypto.randomUUID(),
        orderId: payload.orderId,
        side: payload.side,
        price: fillPrice,
        shares: fillShares,
        timestamp: new Date().toISOString(),
      },
    ];

    this.tradeEngine.updateTrade(trade.id, {
      status: isEntry ? "managing" : trade.status,
      entry:
        isEntry && fillPrice > 0
          ? fillPrice
          : trade.entry,
      shares:
        isEntry && fillShares > 0
          ? fillShares
          : trade.shares,
      sizingMode: "shares",
      fills: nextFills,
      links: {
        ...trade.links,
        alpacaOrderIds: uniqueStrings([
          ...(trade.links.alpacaOrderIds ?? []),
          payload.orderId,
        ]),
      },
    });

    this.tradeEngine.selectTrade(trade.id);
    this.refreshHistory();
  }

  private handleOrderCanceled(
    payload: ExecutionOrderEventPayload,
  ): void {
    const trade =
      this.findTradeByOrderId(payload.orderId) ??
      this.findActiveEntryTrade(payload);

    if (!trade) return;

    this.tradeEngine.updateTrade(trade.id, {
      status: hasEntryFill(trade)
        ? "managing"
        : "cancelled",
      links: {
        ...trade.links,
        alpacaOrderIds: hasEntryFill(trade)
          ? trade.links.alpacaOrderIds
          : [],
      },
    });

    this.tradeEngine.selectTrade(trade.id);
    this.refreshHistory();
  }

  private handleOrderRejected(
    payload: ExecutionOrderEventPayload,
  ): void {
    const trade =
      this.findTradeByOrderId(payload.orderId) ??
      this.findActiveEntryTrade(payload);

    if (!trade) return;

    this.tradeEngine.updateTrade(trade.id, {
      status: "rejected",
      links: {
        ...trade.links,
        alpacaOrderIds: [],
      },
    });

    this.tradeEngine.selectTrade(trade.id);
    this.refreshHistory();
  }

  private handlePositionActive(
    symbol: string,
  ): void {
    const trade = this.findOpenPositionTrade(
      cleanSymbol(symbol),
    );

    if (!trade || trade.status === "managing") {
      return;
    }

    this.tradeEngine.updateStatus(
      trade.id,
      "managing",
    );
    this.tradeEngine.selectTrade(trade.id);
    this.refreshHistory();
  }

  private handleTradeCompleted(
    payload: ExecutionTradeCompletedPayload,
  ): void {
    const symbol = cleanSymbol(payload.symbol);

    const trade =
      this.findOpenPositionTrade(
        symbol,
        payload.side,
      ) ??
      this.findMostRecentNonTerminalTrade(
        symbol,
        payload.side,
      );

    if (!trade) return;

    this.tradeEngine.updateTrade(trade.id, {
      status: "closed",
      entry:
        payload.entryPrice > 0
          ? payload.entryPrice
          : trade.entry,
      shares:
        payload.shares > 0
          ? payload.shares
          : trade.shares,
      links: {
        ...trade.links,
        alpacaOrderIds: uniqueStrings([
          ...(trade.links.alpacaOrderIds ?? []),
          ...(payload.sourceOrderIds ?? []),
        ]),
      },
    });

    this.tradeEngine.selectTrade(trade.id);
    this.refreshHistory();
  }

  /**
   * Resolve a newly accepted entry order.
   *
   * A completed trade must never be reopened and reused. The Plan Trade UI can
   * still have the previously closed trade selected when the next order is
   * submitted. In that case, the UI may temporarily move that old trade back
   * to "submitted". We detect the completed round trip from its fills, restore
   * it to "closed", and create a brand-new Practice trade for the new order.
   */
  private resolveEntryTrade(
    payload: ExecutionOrderEventPayload,
  ): TradeObject {
    const linked = this.findTradeByOrderId(
      payload.orderId,
    );

    if (linked && !hasCompletedRoundTrip(linked)) {
      return linked;
    }

    const candidate = this.findActiveEntryTrade(
      payload,
    );

    if (candidate) {
      if (hasCompletedRoundTrip(candidate)) {
        this.tradeEngine.updateStatus(
          candidate.id,
          "closed",
        );
      } else {
        return candidate;
      }
    }

    return this.createPracticeTrade(payload);
  }

  private createPracticeTrade(
    payload: ExecutionOrderEventPayload,
  ): TradeObject {
    const trade = this.tradeEngine.createTrade({
      symbol: cleanSymbol(payload.symbol),
      direction: directionForEntrySide(
        payload.side,
      ),
      source: "replay",
      mode: "practice",
      status: "accepted",
      entry:
        payload.averageFillPrice &&
        payload.averageFillPrice > 0
          ? payload.averageFillPrice
          : null,
      sizingMode: "shares",
      shares: payload.quantity,
      notes: "Practice Center trade",
      tags: ["practice"],
    });

    this.tradeEngine.updateTrade(trade.id, {
      links: {
        ...trade.links,
        alpacaOrderIds: [payload.orderId],
      },
    });

    return (
      this.tradeEngine.getTrade(trade.id) ??
      trade
    );
  }

  private findTradeByOrderId(
    orderId: string,
  ): TradeObject | null {
    if (!orderId) return null;

    return (
      this.tradeEngine
        .getTrades()
        .find((trade) =>
          (
            trade.links.alpacaOrderIds ?? []
          ).includes(orderId),
        ) ?? null
    );
  }

  private findActiveEntryTrade(
    payload: ExecutionOrderEventPayload,
  ): TradeObject | null {
    const symbol = cleanSymbol(payload.symbol);
    const direction = directionForEntrySide(
      payload.side,
    );

    return (
      this.tradeEngine
        .getTrades()
        .filter(
          (trade) =>
            cleanSymbol(trade.symbol) === symbol &&
            trade.direction === direction &&
            !TERMINAL_STATUSES.has(
              trade.status,
            ),
        )
        .sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )[0] ?? null
    );
  }

  private findActiveTradeForFill(
    payload: ExecutionOrderEventPayload,
  ): TradeObject | null {
    const symbol = cleanSymbol(payload.symbol);

    const candidates = this.tradeEngine
      .getTrades()
      .filter(
        (trade) =>
          cleanSymbol(trade.symbol) === symbol &&
          !TERMINAL_STATUSES.has(
            trade.status,
          ),
      )
      .sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );

    const exitMatch = candidates.find(
      (trade) =>
        payload.side ===
          exitSideForTrade(trade) &&
        hasEntryFill(trade),
    );

    if (exitMatch) return exitMatch;

    return (
      candidates.find(
        (trade) =>
          payload.side ===
          entrySideForTrade(trade),
      ) ??
      null
    );
  }

  private findOpenPositionTrade(
    symbol: string,
    direction?: TradeDirection,
  ): TradeObject | null {
    return (
      this.tradeEngine
        .getTrades()
        .filter(
          (trade) =>
            cleanSymbol(trade.symbol) ===
              symbol &&
            !TERMINAL_STATUSES.has(
              trade.status,
            ) &&
            hasEntryFill(trade) &&
            !hasExitFill(trade) &&
            (
              direction == null ||
              trade.direction === direction
            ),
        )
        .sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )[0] ?? null
    );
  }

  private findMostRecentNonTerminalTrade(
    symbol: string,
    direction?: TradeDirection,
  ): TradeObject | null {
    return (
      this.tradeEngine
        .getTrades()
        .filter(
          (trade) =>
            cleanSymbol(trade.symbol) ===
              symbol &&
            !TERMINAL_STATUSES.has(
              trade.status,
            ) &&
            (
              direction == null ||
              trade.direction === direction
            ),
        )
        .sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )[0] ?? null
    );
  }

  private refreshHistory(): void {
    const trades = this.tradeEngine.getTrades();

    console.log("================================");
    console.log("[ExecutionTradeSynchronizer]");
    console.log("Trade Count:", trades.length);
    console.table(
      trades.map((trade) => ({
        id: trade.id,
        symbol: trade.symbol,
        status: trade.status,
        direction: trade.direction,
        source: trade.source,
        mode: trade.mode,
        fillCount: trade.fills.length,
        linkedOrderCount: trade.links.alpacaOrderIds?.length ?? 0,
      })),
    );
    console.log("================================");

    this.historyEngine.setTrades(trades);
  }
}

let sharedExecutionTradeSynchronizer:
  | ExecutionTradeSynchronizer
  | null = null;

export function getSharedExecutionTradeSynchronizer():
  ExecutionTradeSynchronizer {
  if (!sharedExecutionTradeSynchronizer) {
    sharedExecutionTradeSynchronizer =
      new ExecutionTradeSynchronizer();
  }

  return sharedExecutionTradeSynchronizer;
}

export function resetSharedExecutionTradeSynchronizer(): void {
  sharedExecutionTradeSynchronizer?.destroy();
  sharedExecutionTradeSynchronizer = null;
}