// src/trading/overlay/PositionOverlayEngine.ts

import { getSharedTradeEngine } from "../engine/TradeEngineRuntime";
import type { TradeObject } from "../engine/TradeTypes";
import {
  getSharedTradeExecutionService,
  type TradeExecutionSnapshot,
} from "../services/TradeExecutionService";
import {
  EMPTY_POSITION_OVERLAY,
  type PositionOverlayState,
} from "./PositionOverlayTypes";

type PositionOverlayListener = (state: PositionOverlayState) => void;

function cleanSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isClosedStatus(status: TradeObject["status"]): boolean {
  return ["closed", "cancelled", "rejected"].includes(status);
}

function findActiveTrade(symbol: string): TradeObject | null {
  const tradeEngine = getSharedTradeEngine();
  const selected = tradeEngine.getSelectedTrade();

  if (
    selected &&
    cleanSymbol(selected.symbol) === symbol &&
    !isClosedStatus(selected.status)
  ) {
    return selected;
  }

  return (
    tradeEngine
      .getTrades()
      .filter(
        (trade) =>
          cleanSymbol(trade.symbol) === symbol &&
          !isClosedStatus(trade.status),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

export class PositionOverlayEngine {
  private listeners = new Set<PositionOverlayListener>();
  private state: PositionOverlayState = { ...EMPTY_POSITION_OVERLAY };
  private symbol = "";
  private currentPrice = 0;
  private snapshot: TradeExecutionSnapshot;
  private unsubscribeTradeEvents: (() => void) | null = null;
  private unsubscribeExecution: (() => void) | null = null;

  constructor() {
    const tradeEngine = getSharedTradeEngine();
    const executionService = getSharedTradeExecutionService("paper");

    this.snapshot = executionService.getSnapshot();

    this.unsubscribeTradeEvents = tradeEngine.events.subscribe(() => {
      this.refresh();
    });

    this.unsubscribeExecution = executionService.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.refresh();
    });
  }

  subscribe(listener: PositionOverlayListener): () => void {
    this.listeners.add(listener);
    listener(this.state);

    return () => {
      this.listeners.delete(listener);
    };
  }

  setSymbol(symbol?: string): void {
    const nextSymbol = cleanSymbol(symbol);

    if (nextSymbol === this.symbol) return;

    this.symbol = nextSymbol;
    this.refresh();
  }

  updateMarketPrice(price: number): void {
    const nextPrice = safeNumber(price);
    if (nextPrice <= 0) return;

    this.currentPrice = nextPrice;
    this.refresh();
  }

  getState(): PositionOverlayState {
    return this.state;
  }

  destroy(): void {
    this.unsubscribeTradeEvents?.();
    this.unsubscribeExecution?.();
    this.unsubscribeTradeEvents = null;
    this.unsubscribeExecution = null;
    this.listeners.clear();
  }

  private refresh(): void {
    if (!this.symbol) {
      this.publish({ ...EMPTY_POSITION_OVERLAY });
      return;
    }

    const position =
      this.snapshot.positions.find(
        (item) =>
          cleanSymbol(item.symbol) === this.symbol &&
          safeNumber(item.shares) > 0,
      ) ?? null;

    if (!position) {
      this.publish({
        ...EMPTY_POSITION_OVERLAY,
        symbol: this.symbol,
      });
      return;
    }

    const trade = findActiveTrade(this.symbol);
    const entryPrice = safeNumber(position.entry);
    const quantity = Math.max(0, safeNumber(position.shares));
    const currentPrice =
      this.currentPrice > 0 ? this.currentPrice : entryPrice;
    const side = position.side;
    const stopPrice = safeNumber(trade?.stop);
    const pnlPerShare =
      side === "long"
        ? currentPrice - entryPrice
        : entryPrice - currentPrice;
    const riskPerShare =
      side === "long"
        ? Math.max(0, entryPrice - stopPrice)
        : Math.max(0, stopPrice - entryPrice);

    this.publish({
      tradeId: trade?.id ?? null,
      symbol: this.symbol,
      side,
      status: trade?.status ?? "managing",
      visible: entryPrice > 0 && quantity > 0,

      entryPrice,
      stopPrice,
      targets:
        trade?.targets
          .filter((target) => safeNumber(target.price) > 0)
          .map((target, index) => ({
            id: target.id,
            price: safeNumber(target.price),
            label: target.label?.trim() || `Target ${index + 1}`,
          })) ?? [],

      quantity,
      currentPrice,

      unrealizedPnL: pnlPerShare * quantity,
      percentPnL:
        entryPrice > 0 ? (pnlPerShare / entryPrice) * 100 : 0,
      riskPerShare,
      currentR:
        riskPerShare > 0 ? pnlPerShare / riskPerShare : 0,
    });
  }

  private publish(next: PositionOverlayState): void {
    this.state = next;

    for (const listener of this.listeners) {
      listener(next);
    }
  }
}