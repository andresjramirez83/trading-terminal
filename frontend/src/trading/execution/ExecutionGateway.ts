// src/trading/execution/ExecutionGateway.ts

import type { AlpacaMode } from "../../services/api";
import type {
  QuickOrderEstimate,
  QuickOrderState,
} from "../../components/chart/right-panel/workspaces/trading/TradingTypes";
import {
  getSharedTradeExecutionService,
  type TradeExecutionListener,
  type TradeExecutionSnapshot,
} from "../services/TradeExecutionService";
import type {
  ClosePositionOptions,
  FlattenPositionsResult,
  SubmitQuickOrderResult,
} from "../services/execution/TradeExecutionTypes";
import {
  getConfiguredExecutionRouter,
  getReplayExecutionProvider,
} from "./router/ExecutionProviderRuntime";
import {
  getSharedExecutionModeRuntime,
  type ExecutionMode,
} from "./router/ExecutionModeRuntime";
import type { ExecutionOrderPatch } from "./providers/ExecutionProvider";
import { getSharedExecutionEventBus } from "./events/ExecutionEventBus";
import { getSharedExecutionTradeSynchronizer } from "./events/ExecutionTradeSynchronizer";

export class ExecutionGateway {
  private modeRuntime = getSharedExecutionModeRuntime();
  private router = getConfiguredExecutionRouter();
  private eventBus = getSharedExecutionEventBus();
  private tradeSynchronizer = getSharedExecutionTradeSynchronizer();
  private listeners = new Set<TradeExecutionListener>();
  private unsubscribeMode: (() => void) | null = null;
  private unsubscribeAlpaca: (() => void) | null = null;
  private unsubscribePracticeEvents: (() => void) | null = null;
  private pollTimer: number | null = null;
  private alpacaMode: AlpacaMode = "paper";

  constructor() {
    this.tradeSynchronizer.start();

    this.unsubscribeMode = this.modeRuntime.subscribe(() => {
      this.bindActiveSource();
      this.emitSnapshot();
    });

    this.bindActiveSource();
  }

  getMode(): ExecutionMode {
    return this.modeRuntime.getMode();
  }

  getSnapshot(): TradeExecutionSnapshot {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().getSnapshot();
    }

    return getSharedTradeExecutionService(
      this.getMode() === "live" ? "live" : "paper",
    ).getSnapshot();
  }

  subscribe(listener: TradeExecutionListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  startPolling(intervalMs = 8000): void {
    this.stopPolling();

    if (this.getMode() !== "practice") {
      getSharedTradeExecutionService(this.getAlpacaMode()).startPolling(
        intervalMs,
      );
      return;
    }

    void getReplayExecutionProvider().initialize();
    this.emitSnapshot();
  }

  stopPolling(): void {
    if (this.pollTimer != null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    getSharedTradeExecutionService(this.alpacaMode).stopPolling();
  }

  queueRefresh(forceRefresh = false): void {
    if (this.getMode() === "practice") {
      void this.refreshAll();
      return;
    }

    getSharedTradeExecutionService(this.getAlpacaMode()).queueRefresh(
      forceRefresh,
    );
  }

  async refreshAll(forceRefresh = false): Promise<TradeExecutionSnapshot> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().refresh();
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).refreshAll(forceRefresh);
  }

  async submitQuickOrder(
    order: QuickOrderState,
    estimate: QuickOrderEstimate,
  ): Promise<SubmitQuickOrderResult> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().submitQuickOrder(
        order,
        estimate,
      );
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).submitQuickOrder(order, estimate);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().cancelOrder(orderId);
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).cancelOrder(orderId);
  }

  async modifyOrder(
    orderId: string,
    patch: ExecutionOrderPatch,
  ): Promise<unknown | null> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().modifyOrder(orderId, patch);
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).modifyOrder(orderId, patch);
  }

  async modifyPositionProtection(
    symbol: string,
    patch: { targetPrice?: number; stopPrice?: number },
  ): Promise<unknown | null> {
    if (this.getMode() !== "practice") return null;
    return getReplayExecutionProvider().modifyPositionProtection(symbol, patch);
  }

  async closePosition(
    symbol: string,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().closePosition(symbol, options);
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).closePosition(symbol, options);
  }

  async closePositionShares(
    symbol: string,
    shares: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().closePositionShares(
        symbol,
        shares,
        options,
      );
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).closePositionShares(symbol, shares, options);
  }

  async closePositionPercent(
    symbol: string,
    percent: number,
    options?: ClosePositionOptions,
  ): Promise<SubmitQuickOrderResult> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().closePositionPercent(
        symbol,
        percent,
        options,
      );
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).closePositionPercent(symbol, percent, options);
  }

  async flattenAllPositions(
    options?: ClosePositionOptions,
  ): Promise<FlattenPositionsResult> {
    if (this.getMode() === "practice") {
      return getReplayExecutionProvider().flattenAllPositions(options);
    }

    return getSharedTradeExecutionService(
      this.getAlpacaMode(),
    ).flattenAllPositions(options);
  }

  async switchMode(mode: ExecutionMode): Promise<void> {
    await this.router.switchMode(mode);
    this.bindActiveSource();
    this.emitSnapshot();
  }

  destroy(): void {
    this.stopPolling();
    this.unsubscribeMode?.();
    this.unsubscribeMode = null;
    this.unsubscribeAlpaca?.();
    this.unsubscribeAlpaca = null;
    this.unsubscribePracticeEvents?.();
    this.unsubscribePracticeEvents = null;
    this.listeners.clear();
    this.tradeSynchronizer.stop();
  }

  private getAlpacaMode(): AlpacaMode {
    this.alpacaMode =
      this.getMode() === "live" ? "live" : "paper";

    return this.alpacaMode;
  }

  private bindActiveSource(): void {
    this.unsubscribeAlpaca?.();
    this.unsubscribeAlpaca = null;
    this.unsubscribePracticeEvents?.();
    this.unsubscribePracticeEvents = null;

    if (this.getMode() === "practice") {
      this.unsubscribePracticeEvents = this.eventBus.subscribe(
        () => {
          this.emitSnapshot();
        },
        {
          modes: ["practice"],
          types: [
            "snapshot-updated",
            "execution-error",
          ],
        },
      );

      return;
    }

    const service = getSharedTradeExecutionService(
      this.getAlpacaMode(),
    );

    this.unsubscribeAlpaca = service.subscribe(() => {
      this.emitSnapshot();
    });
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

let sharedExecutionGateway: ExecutionGateway | null = null;

export function getSharedExecutionGateway(): ExecutionGateway {
  if (!sharedExecutionGateway) {
    sharedExecutionGateway = new ExecutionGateway();
  }

  return sharedExecutionGateway;
}

export function resetSharedExecutionGateway(): void {
  sharedExecutionGateway?.destroy();
  sharedExecutionGateway = null;
}