// src/trading/execution/providers/AlpacaExecutionProvider.ts

import type { AlpacaMode } from "../../../services/api";
import type {
  QuickOrderEstimate,
  QuickOrderState,
} from "../../../components/chart/right-panel/workspaces/trading/TradingTypes";
import { getSharedTradeExecutionService } from "../../services/TradeExecutionService";
import type {
  ClosePositionOptions,
  FlattenPositionsResult,
  SubmitQuickOrderResult,
  TradeExecutionSnapshot,
} from "../../services/execution/TradeExecutionTypes";
import {
  BaseExecutionProvider,
  type ExecutionOrderPatch,
  type ExecutionProviderId,
} from "./ExecutionProvider";

export class AlpacaExecutionProvider extends BaseExecutionProvider {
  readonly id: ExecutionProviderId;
  private readonly mode: AlpacaMode;

  constructor(mode: AlpacaMode) {
    super();
    this.mode = mode;
    this.id = mode === "live" ? "alpaca-live" : "alpaca-paper";
  }

  async initialize(): Promise<void> {
    getSharedTradeExecutionService(this.mode).startPolling(8000);
  }

  async shutdown(): Promise<void> {
    getSharedTradeExecutionService(this.mode).stopPolling();
  }

  getSnapshot(): TradeExecutionSnapshot {
    return getSharedTradeExecutionService(this.mode).getSnapshot();
  }

  async refresh(): Promise<TradeExecutionSnapshot> {
    return getSharedTradeExecutionService(this.mode).refreshAll();
  }

  async submitQuickOrder(
    order: QuickOrderState,
    estimate: QuickOrderEstimate,
  ): Promise<SubmitQuickOrderResult> {
    return getSharedTradeExecutionService(this.mode).submitQuickOrder(order, estimate);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return getSharedTradeExecutionService(this.mode).cancelOrder(orderId);
  }

  async modifyOrder(
    orderId: string,
    patch: ExecutionOrderPatch,
  ): Promise<unknown | null> {
    return getSharedTradeExecutionService(this.mode).modifyOrder(orderId, patch);
  }

  async closePosition(
    symbol: string,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    return getSharedTradeExecutionService(this.mode).closePosition(symbol, options);
  }

  async closePositionShares(
    symbol: string,
    shares: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    return getSharedTradeExecutionService(this.mode).closePositionShares(symbol, shares, options);
  }

  async closePositionPercent(
    symbol: string,
    percent: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    return getSharedTradeExecutionService(this.mode).closePositionPercent(symbol, percent, options);
  }

  async flattenAllPositions(
    options?: ClosePositionOptions,
  ): Promise<FlattenPositionsResult> {
    return getSharedTradeExecutionService(this.mode).flattenAllPositions(options);
  }
}