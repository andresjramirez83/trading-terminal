// src/trading/intelligence/integration/PracticeBarsIntelligenceAdapter.ts

/**
 * Converts Practice Center historical bars into the canonical intelligence
 * request used by the shared Trading OS pipeline.
 *
 * The adapter marks the request as replay/practice data and keeps each
 * symbol/timeframe memory stream isolated inside MarketMemoryEngine.
 */

import type {
  IntelligenceConsumer,
  MarketIntelligenceReport,
  MarketIntelligenceRequest,
} from "../core/IntelligenceTypes";
import type {
  MarketContextDirection,
  MarketSession,
} from "../types/MarketContextTypes";
import type { PracticeAnalysisBar } from "../../practice/analysis/PracticeAnalysisTypes";

export interface PracticeBarsIntelligenceAdapterInput {
  symbol: string;
  tradingDate: string;
  timeframe: string;
  bars: readonly PracticeAnalysisBar[];
  previousReport?: MarketIntelligenceReport | null;
  consumer?: IntelligenceConsumer;
  preferredDirection?: MarketContextDirection;
  includeCoach?: boolean;
  includeNarrative?: boolean;
  minimumConfidence?: number;
  minimumTradeScore?: number;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();

  if (!symbol) {
    throw new Error(
      "PracticeBarsIntelligenceAdapter requires a symbol.",
    );
  }

  return symbol;
}

function normalizeTimeframe(value: string): string {
  const timeframe = value.trim().toLowerCase();

  if (!timeframe) {
    throw new Error(
      "PracticeBarsIntelligenceAdapter requires a timeframe.",
    );
  }

  return timeframe;
}

function normalizeTimestamp(value: number): number {
  if (!finite(value) || value <= 0) {
    throw new Error(
      "PracticeBarsIntelligenceAdapter received an invalid bar timestamp.",
    );
  }

  return value > 10_000_000_000 ? value : value * 1_000;
}

function isValidPracticeBar(
  bar: PracticeAnalysisBar,
): boolean {
  return (
    finite(bar.time) &&
    bar.time > 0 &&
    finite(bar.open) &&
    finite(bar.high) &&
    finite(bar.low) &&
    finite(bar.close) &&
    bar.high >= bar.low &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close)
  );
}

function normalizeBars(
  bars: readonly PracticeAnalysisBar[],
): PracticeAnalysisBar[] {
  const sorted = bars
    .filter(isValidPracticeBar)
    .map((bar) => ({
      ...bar,
      time: normalizeTimestamp(bar.time),
    }))
    .sort((left, right) => left.time - right.time);

  const byTimestamp = new Map<number, PracticeAnalysisBar>();

  for (const bar of sorted) {
    byTimestamp.set(bar.time, bar);
  }

  return [...byTimestamp.values()];
}

function inferSession(timestamp: number): MarketSession {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  if (values.weekday === "Sat" || values.weekday === "Sun") {
    return "closed";
  }

  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const totalMinutes = hour * 60 + minute;

  if (totalMinutes >= 240 && totalMinutes < 570) {
    return "premarket";
  }

  if (totalMinutes >= 570 && totalMinutes < 960) {
    return "regular";
  }

  if (totalMinutes >= 960 && totalMinutes < 1_200) {
    return "after-hours";
  }

  return "overnight";
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trueRange(
  current: PracticeAnalysisBar,
  previous: PracticeAnalysisBar | undefined,
): number {
  if (!previous) {
    return current.high - current.low;
  }

  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

function calculateAtr(
  bars: readonly PracticeAnalysisBar[],
  length = 14,
): number | undefined {
  if (bars.length === 0) return undefined;

  const recent = bars.slice(-Math.max(1, length));
  const ranges = recent.map((bar, index) => {
    const globalIndex = bars.length - recent.length + index;
    return trueRange(bar, bars[globalIndex - 1]);
  });

  return average(ranges);
}

function calculateAverageVolume(
  bars: readonly PracticeAnalysisBar[],
  length = 20,
): number | undefined {
  const values = bars
    .slice(-Math.max(1, length))
    .map((bar) => bar.volume)
    .filter(finite);

  return average(values);
}

function calculateCumulativeVolume(
  bars: readonly PracticeAnalysisBar[],
): number | undefined {
  const values = bars.map((bar) => bar.volume).filter(finite);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}

function calculateEma(
  bars: readonly PracticeAnalysisBar[],
  length: number,
): number | undefined {
  if (bars.length === 0) return undefined;

  const multiplier = 2 / (length + 1);
  let ema = bars[0].close;

  for (let index = 1; index < bars.length; index += 1) {
    ema = bars[index].close * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

function calculateVwap(
  bars: readonly PracticeAnalysisBar[],
): number | undefined {
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const barVwap = bars[index].vwap;

    if (finite(barVwap) && barVwap > 0) {
      return barVwap;
    }
  }

  let priceVolume = 0;
  let volume = 0;

  for (const bar of bars) {
    if (!finite(bar.volume) || bar.volume <= 0) continue;

    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    priceVolume += typicalPrice * bar.volume;
    volume += bar.volume;
  }

  return volume > 0 ? priceVolume / volume : undefined;
}

function directionFromBars(
  bars: readonly PracticeAnalysisBar[],
): MarketContextDirection {
  if (bars.length < 2) return "neutral";

  const recent = bars.slice(-Math.min(20, bars.length));
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;

  if (last > first) return "bullish";
  if (last < first) return "bearish";
  return "neutral";
}

function calculateMomentumScore(
  bars: readonly PracticeAnalysisBar[],
): number {
  if (bars.length < 2) return 50;

  const recent = bars.slice(-Math.min(10, bars.length));
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;

  if (first === 0) return 50;

  const percentChange = ((last - first) / first) * 100;
  return clamp(50 + percentChange * 10, 0, 100);
}

function calculateTrendStrength(
  bars: readonly PracticeAnalysisBar[],
): number {
  if (bars.length < 3) return 0;

  const recent = bars.slice(-Math.min(20, bars.length));
  let directionalMoves = 0;
  let totalMoves = 0;
  const direction = directionFromBars(recent);

  for (let index = 1; index < recent.length; index += 1) {
    const change = recent[index].close - recent[index - 1].close;
    totalMoves += Math.abs(change);

    if (
      (direction === "bullish" && change > 0) ||
      (direction === "bearish" && change < 0)
    ) {
      directionalMoves += Math.abs(change);
    }
  }

  if (totalMoves === 0) return 0;
  return clamp((directionalMoves / totalMoves) * 100, 0, 100);
}

function calculateCompressionScore(
  bars: readonly PracticeAnalysisBar[],
): number {
  if (bars.length < 6) return 50;

  const recent = bars.slice(-5);
  const prior = bars.slice(-10, -5);

  const recentRange = average(
    recent.map((bar) => bar.high - bar.low),
  );
  const priorRange = average(
    prior.map((bar) => bar.high - bar.low),
  );

  if (!finite(recentRange) || !finite(priorRange) || priorRange <= 0) {
    return 50;
  }

  const ratio = recentRange / priorRange;
  return clamp((1 - ratio) * 100 + 50, 0, 100);
}

function calculateSwingHigh(
  bars: readonly PracticeAnalysisBar[],
): number | undefined {
  if (bars.length === 0) return undefined;
  return Math.max(...bars.slice(-20).map((bar) => bar.high));
}

function calculateSwingLow(
  bars: readonly PracticeAnalysisBar[],
): number | undefined {
  if (bars.length === 0) return undefined;
  return Math.min(...bars.slice(-20).map((bar) => bar.low));
}

export function buildMarketIntelligenceRequestFromPracticeBars(
  input: PracticeBarsIntelligenceAdapterInput,
): MarketIntelligenceRequest {
  const symbol = normalizeSymbol(input.symbol);
  const timeframe = normalizeTimeframe(input.timeframe);
  const tradingDate = input.tradingDate.trim();
  const bars = normalizeBars(input.bars);

  if (!tradingDate) {
    throw new Error(
      "PracticeBarsIntelligenceAdapter requires a trading date.",
    );
  }

  if (bars.length === 0) {
    throw new Error(
      `Cannot evaluate practice intelligence for ${symbol} ${timeframe} without valid bars.`,
    );
  }

  const lastBar = bars[bars.length - 1];
  const previousBar = bars[bars.length - 2];
  const timestamp = lastBar.time;
  const atr = calculateAtr(bars);
  const averageVolume = calculateAverageVolume(bars);
  const currentVolume = finite(lastBar.volume) ? lastBar.volume : undefined;
  const relativeVolume =
    finite(currentVolume) &&
    finite(averageVolume) &&
    averageVolume > 0
      ? currentVolume / averageVolume
      : undefined;
  const direction = directionFromBars(bars);
  const trendStrength = calculateTrendStrength(bars);
  const momentumScore = calculateMomentumScore(bars);
  const compressionScore = calculateCompressionScore(bars);
  const vwap = calculateVwap(bars);
  const previousClose = previousBar?.close;

  return {
    contextRequest: {
      input: {
        symbol,
        timeframe,
        timestamp,
        session: inferSession(timestamp),
        tradingDate,
        barIndex: bars.length - 1,

        bar: {
          time: timestamp,
          open: lastBar.open,
          high: lastBar.high,
          low: lastBar.low,
          close: lastBar.close,
          volume: lastBar.volume,
          barIndex: bars.length - 1,
        },

        price: {
          open: lastBar.open,
          high: lastBar.high,
          low: lastBar.low,
          close: lastBar.close,
          last: lastBar.close,
          previousClose,
          change: finite(previousClose)
            ? lastBar.close - previousClose
            : undefined,
          changePercent:
            finite(previousClose) && previousClose !== 0
              ? ((lastBar.close - previousClose) / previousClose) * 100
              : undefined,
        },

        volume: {
          current: currentVolume,
          average: averageVolume,
          relative: relativeVolume,
          cumulative: calculateCumulativeVolume(bars),
        },

        volatility: {
          atr,
          atrPercent:
            finite(atr) && lastBar.close !== 0
              ? (atr / lastBar.close) * 100
              : undefined,
          range: lastBar.high - lastBar.low,
          rangePercent:
            lastBar.close !== 0
              ? ((lastBar.high - lastBar.low) / lastBar.close) * 100
              : undefined,
          compressionScore,
        },

        structure: {
          direction,
          trend: direction,
          score: trendStrength,
          confidence: trendStrength / 100,
          swingHigh: calculateSwingHigh(bars),
          swingLow: calculateSwingLow(bars),
          higherHighs:
            bars.length >= 2 ? lastBar.high > previousBar.high : undefined,
          higherLows:
            bars.length >= 2 ? lastBar.low > previousBar.low : undefined,
          lowerHighs:
            bars.length >= 2 ? lastBar.high < previousBar.high : undefined,
          lowerLows:
            bars.length >= 2 ? lastBar.low < previousBar.low : undefined,
        },

        indicators: {
          ema9: calculateEma(bars, 9),
          ema20: calculateEma(bars, 20),
          ema50: calculateEma(bars, 50),
          ema200: calculateEma(bars, 200),
          vwap,
          momentumScore,
          compressionScore,
          trendStrengthScore: trendStrength,
          participationScore: finite(relativeVolume)
            ? clamp(relativeVolume * 50, 0, 100)
            : undefined,
          relativeVolume,
          custom: {
            practiceBarCount: bars.length,
            practiceTradingDate: tradingDate,
            latestBarVolume: currentVolume ?? null,
          },
        },

        metadata: {
          adapter: "PracticeBarsIntelligenceAdapter",
          practiceMode: true,
          barCount: bars.length,
          ...input.metadata,
        },
      },

      source: "replay",
      mode: "replay",
      previousSnapshot: input.previousReport?.context ?? null,
      correlationId: input.correlationId,
      metadata: {
        adapter: "PracticeBarsIntelligenceAdapter",
        practiceMode: true,
        ...input.metadata,
      },
    },

    consumer: input.consumer ?? "practice-center",
    preferredDirection: input.preferredDirection,
    previousReport: input.previousReport ?? null,
    includeCoach: input.includeCoach ?? true,
    includeNarrative: input.includeNarrative ?? true,
    minimumConfidence: input.minimumConfidence,
    minimumTradeScore: input.minimumTradeScore,
    correlationId: input.correlationId,
    metadata: {
      adapter: "PracticeBarsIntelligenceAdapter",
      practiceMode: true,
      tradingDate,
      ...input.metadata,
    },
  };
}

export default buildMarketIntelligenceRequestFromPracticeBars;
