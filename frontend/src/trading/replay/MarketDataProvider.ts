// src/trading/replay/MarketDataProvider.ts

import type { CleanBar } from "../../components/chart/ChartTypes";
import type {
  MarketDataConnectionHandlers,
  MarketDataMode,
  MarketDataRequest,
  ReplaySpeed,
} from "./ReplayTypes";

export interface MarketDataProvider {
  readonly mode: MarketDataMode;

  loadHistory(request: MarketDataRequest): Promise<CleanBar[]>;

  connect(
    request: MarketDataRequest,
    handlers: MarketDataConnectionHandlers,
  ): () => void;

  disconnect(): void;

  pause(): void;
  resume(): void;

  seek(index: number): void;
  setSpeed(speed: ReplaySpeed): void;

  destroy(): void;
}

export abstract class BaseMarketDataProvider
  implements MarketDataProvider
{
  abstract readonly mode: MarketDataMode;

  abstract loadHistory(request: MarketDataRequest): Promise<CleanBar[]>;

  abstract connect(
    request: MarketDataRequest,
    handlers: MarketDataConnectionHandlers,
  ): () => void;

  abstract disconnect(): void;

  pause(): void {
    // Live providers intentionally ignore replay controls.
  }

  resume(): void {
    // Live providers intentionally ignore replay controls.
  }

  seek(_index: number): void {
    // Live providers intentionally ignore replay controls.
  }

  setSpeed(_speed: ReplaySpeed): void {
    // Live providers intentionally ignore replay controls.
  }

  destroy(): void {
    this.disconnect();
  }
}