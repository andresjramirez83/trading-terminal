// src/trading/replay/LiveMarketDataProvider.ts

import type { CleanBar } from "../../components/chart/ChartTypes";
import {
  connectLiveBars,
  loadHistoricalBars,
} from "../../components/chart/LiveDataEngine";
import {
  BaseMarketDataProvider,
} from "./MarketDataProvider";
import type {
  MarketDataConnectionHandlers,
  MarketDataRequest,
} from "./ReplayTypes";

export class LiveMarketDataProvider extends BaseMarketDataProvider {
  readonly mode = "live" as const;

  private disconnectCurrent: (() => void) | null = null;

  async loadHistory(
    request: MarketDataRequest,
  ): Promise<CleanBar[]> {
    return loadHistoricalBars({
      symbol: request.symbol,
      timeframe: request.timeframe,
      lookback: request.lookback,
      limit: request.limit,
    });
  }

  connect(
    request: MarketDataRequest,
    handlers: MarketDataConnectionHandlers,
  ): () => void {
    this.disconnect();

    this.disconnectCurrent = connectLiveBars({
      symbol: request.symbol,
      timeframe: request.timeframe,
      onStatus: handlers.onStatus,
      onBar: handlers.onBar,
    });

    return () => {
      this.disconnect();
    };
  }

  disconnect(): void {
    this.disconnectCurrent?.();
    this.disconnectCurrent = null;
  }
}