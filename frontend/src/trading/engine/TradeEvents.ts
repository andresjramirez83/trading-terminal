// src/trading/engine/TradeEvents.ts

import type { TradeObject } from "./TradeTypes";

export type TradeEventType =
  | "trade-created"
  | "trade-updated"
  | "trade-deleted"
  | "trade-selected"
  | "trade-status-changed"
  | "registry-reset";

export type TradeEvent = {
  type: TradeEventType;
  tradeId?: string | null;
  trade?: TradeObject | null;
  previousTrade?: TradeObject | null;
  timestamp: string;
};

export type TradeEventListener = (event: TradeEvent) => void;

export class TradeEvents {
  private listeners = new Set<TradeEventListener>();

  subscribe(listener: TradeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: Omit<TradeEvent, "timestamp">): void {
    const nextEvent: TradeEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    for (const listener of this.listeners) {
      listener(nextEvent);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
