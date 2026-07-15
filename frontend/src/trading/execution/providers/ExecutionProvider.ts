// src/trading/execution/providers/ExecutionProvider.ts

import type {
  QuickOrderEstimate,
  QuickOrderState,
} from "../../../components/chart/right-panel/workspaces/trading/TradingTypes";
import type {
  ClosePositionOptions,
  FlattenPositionsResult,
  SubmitQuickOrderResult,
  TradeExecutionSnapshot,
} from "../../services/execution/TradeExecutionTypes";

export type ExecutionProviderId = "alpaca-paper" | "alpaca-live" | "replay";

export type ExecutionOrderPatch = {
  qty?: number;
  limit_price?: number;
  stop_price?: number;
  time_in_force?: string;
};

export interface ExecutionProvider {
  readonly id: ExecutionProviderId;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  getSnapshot(): TradeExecutionSnapshot;
  refresh(): Promise<TradeExecutionSnapshot>;

  submitQuickOrder(
    order: QuickOrderState,
    estimate: QuickOrderEstimate,
  ): Promise<SubmitQuickOrderResult>;

  cancelOrder(orderId: string): Promise<boolean>;

  modifyOrder(
    orderId: string,
    patch: ExecutionOrderPatch,
  ): Promise<unknown | null>;

  closePosition(
    symbol: string,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult>;

  closePositionShares(
    symbol: string,
    shares: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult>;

  closePositionPercent(
    symbol: string,
    percent: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult>;

  flattenAllPositions(
    options?: ClosePositionOptions,
  ): Promise<FlattenPositionsResult>;
}

export abstract class BaseExecutionProvider implements ExecutionProvider {
  abstract readonly id: ExecutionProviderId;

  abstract initialize(): Promise<void>;
  abstract shutdown(): Promise<void>;

  abstract getSnapshot(): TradeExecutionSnapshot;
  abstract refresh(): Promise<TradeExecutionSnapshot>;

  abstract submitQuickOrder(
    order: QuickOrderState,
    estimate: QuickOrderEstimate,
  ): Promise<SubmitQuickOrderResult>;

  abstract cancelOrder(orderId: string): Promise<boolean>;

  abstract modifyOrder(
    orderId: string,
    patch: ExecutionOrderPatch,
  ): Promise<unknown | null>;

  abstract closePosition(
    symbol: string,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult>;

  abstract closePositionShares(
    symbol: string,
    shares: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult>;

  abstract closePositionPercent(
    symbol: string,
    percent: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult>;

  abstract flattenAllPositions(
    options?: ClosePositionOptions,
  ): Promise<FlattenPositionsResult>;
}