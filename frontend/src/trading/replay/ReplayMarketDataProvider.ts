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

const MAX_PREVIOUS_DATE_ATTEMPTS = 7;

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;

  return Math.max(
    0,
    Math.min(length - 1, Math.floor(index)),
  );
}

function normalizeTradingDate(
  value: string | undefined,
): string | null {
  const normalized = String(value ?? "").trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : null;
}

function shiftCalendarDate(
  tradingDate: string,
  dayOffset: number,
): string {
  const [year, month, day] = tradingDate
    .split("-")
    .map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day),
  );

  date.setUTCDate(date.getUTCDate() + dayOffset);

  return date.toISOString().slice(0, 10);
}

function getBarTimestamp(bar: CleanBar): number {
  return Number(bar.time);
}

function mergeBars(
  groups: CleanBar[][],
): CleanBar[] {
  const byTimestamp = new Map<number, CleanBar>();

  for (const bars of groups) {
    for (const bar of bars) {
      const timestamp = getBarTimestamp(bar);

      if (!Number.isFinite(timestamp)) {
        continue;
      }

      byTimestamp.set(timestamp, bar);
    }
  }

  return Array.from(byTimestamp.values()).sort(
    (left, right) =>
      getBarTimestamp(left) -
      getBarTimestamp(right),
  );
}

async function loadSessionBars(
  request: MarketDataRequest,
  tradingDate: string,
): Promise<CleanBar[]> {
  return loadHistoricalBars({
    symbol: request.symbol,
    timeframe: request.timeframe,
    date: tradingDate,
    limit: request.limit ?? 5000,
  });
}

async function loadPreviousAvailableSession(
  request: MarketDataRequest,
  selectedTradingDate: string,
): Promise<CleanBar[]> {
  for (
    let dayOffset = -1;
    dayOffset >= -MAX_PREVIOUS_DATE_ATTEMPTS;
    dayOffset -= 1
  ) {
    const candidateDate = shiftCalendarDate(
      selectedTradingDate,
      dayOffset,
    );

    try {
      const bars = await loadSessionBars(
        request,
        candidateDate,
      );

      if (bars.length > 0) {
        return bars;
      }
    } catch (error) {
      console.warn(
        `Replay history unavailable for ${candidateDate}.`,
        error,
      );
    }
  }

  return [];
}

export class ReplayMarketDataProvider
  extends BaseMarketDataProvider {
  readonly mode = "replay" as const;

  private clock = new ReplayClock();
  private bars: CleanBar[] = [];
  private currentIndex = 0;

  private handlers:
    | MarketDataConnectionHandlers
    | null = null;

  private unsubscribeClock:
    | (() => void)
    | null = null;

  private connected = false;

  constructor() {
    super();

    this.unsubscribeClock =
      this.clock.subscribe(() => {
        this.emitNextBar();
      });
  }

  async loadHistory(
    request: MarketDataRequest,
  ): Promise<CleanBar[]> {
    const selectedTradingDate =
      normalizeTradingDate(request.date);

    if (!selectedTradingDate) {
      this.bars = await loadHistoricalBars({
        symbol: request.symbol,
        timeframe: request.timeframe,
        lookback: request.lookback,
        limit: request.limit,
      });

      this.currentIndex = 0;

      return this.bars;
    }

    const [
      previousSessionBars,
      selectedSessionBars,
    ] = await Promise.all([
      loadPreviousAvailableSession(
        request,
        selectedTradingDate,
      ),
      loadSessionBars(
        request,
        selectedTradingDate,
      ),
    ]);

    this.bars = mergeBars([
      previousSessionBars,
      selectedSessionBars,
    ]);

    this.currentIndex = 0;

    if (this.bars.length === 0) {
      throw new Error(
        `No replay candles were found for ${request.symbol.toUpperCase()} on ${selectedTradingDate}.`,
      );
    }

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
    if (
      !this.connected ||
      this.bars.length === 0 ||
      this.currentIndex >= this.bars.length
    ) {
      return;
    }

    this.clock.resume();
    this.handlers?.onStatus("live");
  }

  seek(index: number): void {
    this.currentIndex = clampIndex(
      index,
      this.bars.length,
    );

    const bar = this.bars[this.currentIndex];

    if (bar) {
      this.handlers?.onBar(bar);
    }
  }

  setNextIndex(index: number): void {
    if (this.bars.length === 0) {
      this.currentIndex = 0;
      return;
    }

    this.currentIndex = Math.max(
      0,
      Math.min(
        this.bars.length,
        Math.floor(index),
      ),
    );
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
    this.currentIndex = 0;
  }

  private emitNextBar(): void {
    if (!this.connected || !this.handlers) {
      return;
    }

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
