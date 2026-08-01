// src/trading/execution/events/ExecutionEventTypes.ts

import type { TradeExecutionSnapshot } from "../../services/execution/TradeExecutionTypes";
import type { ExecutionMode } from "../router/ExecutionModeRuntime";

export type ExecutionEventSource =
  | "alpaca-paper"
  | "alpaca-live"
  | "replay";

export type ExecutionEventType =
  | "order-submitted"
  | "order-accepted"
  | "order-partially-filled"
  | "order-filled"
  | "order-canceled"
  | "order-rejected"
  | "position-opened"
  | "position-updated"
  | "position-closed"
  | "account-updated"
  | "snapshot-updated"
  | "trade-completed"
  | "execution-error";

export type ExecutionOrderEventPayload = {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  filledQuantity?: number;
  averageFillPrice?: number;
  status?: string;
  rawOrder?: unknown;
};

export type ExecutionPositionEventPayload = {
  symbol: string;
  side: "long" | "short";
  shares: number;
  entryPrice: number;
  currentPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  targetPrice?: number;
  stopPrice?: number;
  rawPosition?: unknown;
};

export type ExecutionTradeCompletedPayload = {
  tradeId?: string;
  symbol: string;
  side: "long" | "short";
  shares: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  netPnl?: number;
  exitReason?: "target" | "stop" | "manual" | "flatten" | "unknown";
  openedAt?: string;
  closedAt?: string;
  sourceOrderIds?: string[];
  rawTrade?: unknown;
};

export type ExecutionErrorPayload = {
  message: string;
  code?: string;
  operation?: string;
  rawError?: unknown;
};

export type ExecutionEventPayloadMap = {
  "order-submitted": ExecutionOrderEventPayload;
  "order-accepted": ExecutionOrderEventPayload;
  "order-partially-filled": ExecutionOrderEventPayload;
  "order-filled": ExecutionOrderEventPayload;
  "order-canceled": ExecutionOrderEventPayload;
  "order-rejected": ExecutionOrderEventPayload;
  "position-opened": ExecutionPositionEventPayload;
  "position-updated": ExecutionPositionEventPayload;
  "position-closed": ExecutionPositionEventPayload;
  "account-updated": { snapshot: TradeExecutionSnapshot };
  "snapshot-updated": { snapshot: TradeExecutionSnapshot };
  "trade-completed": ExecutionTradeCompletedPayload;
  "execution-error": ExecutionErrorPayload;
};

export type ExecutionEvent<
  TType extends ExecutionEventType = ExecutionEventType,
> = TType extends ExecutionEventType
  ? {
      id: string;
      type: TType;
      source: ExecutionEventSource;
      mode: ExecutionMode;
      timestamp: number;
      payload: ExecutionEventPayloadMap[TType];
    }
  : never;

export type ExecutionEventListener<
  TType extends ExecutionEventType = ExecutionEventType,
> = (event: ExecutionEvent<TType>) => void;

export type ExecutionEventFilter = {
  types?: ExecutionEventType[];
  sources?: ExecutionEventSource[];
  modes?: ExecutionMode[];
};

export function createExecutionEvent<
  TType extends ExecutionEventType,
>(
  type: TType,
  source: ExecutionEventSource,
  mode: ExecutionMode,
  payload: ExecutionEventPayloadMap[TType],
): ExecutionEvent<TType> {
  return {
    id: crypto.randomUUID(),
    type,
    source,
    mode,
    timestamp: Date.now(),
    payload,
  } as ExecutionEvent<TType>;
}
