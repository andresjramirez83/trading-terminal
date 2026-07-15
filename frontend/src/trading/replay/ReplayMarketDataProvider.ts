// src/trading/replay/ReplayMarketDataProvider.ts

import type { CleanBar } from "../../components/chart/ChartTypes";
import { loadHistoricalBars } from "../../components/chart/LiveDataEngine";
import { BaseMarketDataProvider } from "./MarketDataProvider";
import { ReplayClock } from "./ReplayClock";
import type {
  MarketDataConnectionHandlers,
  MarketDataRequest,
  ReplaySpeed,
} from "./ReplayTypes";

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor(index)));
}

export class ReplayMarketDataProvider extends BaseMarketDataProvider {
  readonly mode = "replay" as const;

  private clock = new ReplayClock();
  private bars: CleanBar[] = [];
  private currentIndex = 0;
  private handlers: MarketDataConnectionHandlers | null = null;
  private unsubscribeClock: (() => void) | null = null;
  private connected = false;

  constructor() {
    super();

    this.unsubscribeClock = this.clock.subscribe(() => {
      this.emitNextBar();
    });
  }

  async loadHistory(
    request: MarketDataRequest,
  ): Promise<CleanBar[]> {
    this.bars = await loadHistoricalBars({
      symbol: request.symbol,
      timeframe: request.timeframe,
      lookback: request.lookback,
      limit: request.limit,
    });

    this.currentIndex = 0;

    return this.bars;
  }

  connect(
    _request: MarketDataRequest,
    handlers: MarketDataConnectionHandlers,
  ): () => void {
    this.handlers = handlers;
    this.connected = true;

    handlers.onStatus("live");

    return () => {
      this.disconnect();
    };
  }

  disconnect(): void {
    this.clock.pause();
    this.connected = false;
    this.handlers = null;
  }

  pause(): void {
    this.clock.pause();

    if (this.connected) {
      this.handlers?.onStatus("live");
    }
  }

  resume(): void {
    if (!this.connected || this.bars.length === 0) return;

    this.clock.resume();
    this.handlers?.onStatus("live");
  }

  seek(index: number): void {
    this.currentIndex = clampIndex(index, this.bars.length);

    const bar = this.bars[this.currentIndex];
    if (bar) {
      this.handlers?.onBar(bar);
    }
  }

  setSpeed(speed: ReplaySpeed): void {
    this.clock.setSpeed(speed);
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getBars(): CleanBar[] {
    return this.bars;
  }

  destroy(): void {
    this.disconnect();
    this.unsubscribeClock?.();
    this.unsubscribeClock = null;
    this.clock.destroy();
    this.bars = [];
  }

  private emitNextBar(): void {
    if (!this.connected || !this.handlers) return;

    const bar = this.bars[this.currentIndex];

    if (!bar) {
      this.clock.pause();
      this.handlers.onStatus("disconnected");
      return;
    }

    this.handlers.onBar(bar);
    this.currentIndex += 1;

    if (this.currentIndex >= this.bars.length) {
      this.clock.pause();
      this.handlers.onStatus("disconnected");
    }
  }
}