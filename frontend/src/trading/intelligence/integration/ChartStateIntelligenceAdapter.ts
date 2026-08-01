// src/trading/intelligence/integration/ChartStateIntelligenceAdapter.ts

/**
 * Converts the existing chart runtime state into the canonical
 * MarketIntelligenceRequest consumed by the Trading OS intelligence pipeline.
 *
 * This adapter is intentionally UI-framework agnostic so Chart, Replay,
 * Practice Center, Scanner, and future consumers can reuse the same mapping.
 */

import type { Time } from "lightweight-charts";

import type { ChartState } from "../../../components/chart/ChartState";
import type { CleanBar } from "../../../components/chart/ChartTypes";
import type {
  IntelligenceConsumer,
  MarketIntelligenceReport,
  MarketIntelligenceRequest,
} from "../core/IntelligenceTypes";
import type {
  MarketContextDirection,
  MarketContextSource,
  MarketSession,
} from "../types/MarketContextTypes";

export type IntelligenceChartMode = "live" | "replay" | "historical";

export interface ChartStateIntelligenceAdapterOptions {
  source?: MarketContextSource;
  consumer?: IntelligenceConsumer;
  mode?: IntelligenceChartMode;
  session?: MarketSession;
  previousReport?: MarketIntelligenceReport | null;
  preferredDirection?: MarketContextDirection;
  includeCoach?: boolean;
  includeNarrative?: boolean;
  minimumConfidence?: number;
  minimumTradeScore?: number;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  now?: () => number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeSymbol(symbol: string | undefined): string {
  const normalized = symbol?.trim().toUpperCase();

  if (!normalized) {
    throw new Error(
      "ChartStateIntelligenceAdapter requires chartState.symbol.",
    );
  }

  return normalized;
}

function normalizeTimeframe(timeframe: string | undefined): string {
  const normalized = timeframe?.trim();

  if (!normalized) {
    throw new Error(
      "ChartStateIntelligenceAdapter requires chartState.timeframe.",
    );
  }

  return normalized;
}

function toEpochMilliseconds(time: Time | undefined): number | undefined {
  if (typeof time === "number" && Number.isFinite(time)) {
    return time > 10_000_000_000 ? time : time * 1_000;
  }

  if (
    time &&
    typeof time === "object" &&
    "year" in time &&
    "month" in time &&
    "day" in time
  ) {
    const businessDay = time as {
      year: number;
      month: number;
      day: number;
    };

    return Date.UTC(
      businessDay.year,
      businessDay.month - 1,
      businessDay.day,
    );
  }

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function inferSession(timestamp: number): MarketSession {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(timestamp));

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  if (values.weekday === "Sat" || values.weekday === "Sun") {
    return "closed";
  }

  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const minutes = hour * 60 + minute;

  if (minutes >= 240 && minutes < 570) {
    return "premarket";
  }

  if (minutes >= 570 && minutes < 960) {
    return "regular";
  }

  if (minutes >= 960 && minutes < 1_200) {
    return "after-hours";
  }

  return "overnight";
}

function tradingDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function previousBar(
  bars: readonly CleanBar[],
  lastBar: CleanBar | undefined,
): CleanBar | undefined {
  if (bars.length < 2) return undefined;

  const finalBar = bars[bars.length - 1];

  if (!lastBar || finalBar === lastBar || finalBar.time === lastBar.time) {
    return bars[bars.length - 2];
  }

  return finalBar;
}

function calculateAverageVolume(
  bars: readonly CleanBar[],
  lookback = 20,
): number | undefined {
  const recent = bars
    .slice(-Math.max(1, lookback))
    .map((bar) => bar.volume)
    .filter(finite);

  if (recent.length === 0) return undefined;

  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function calculateCumulativeVolume(
  bars: readonly CleanBar[],
): number | undefined {
  const values = bars.map((bar) => bar.volume).filter(finite);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}

function calculateAtrPercent(
  atr: number | undefined,
  price: number | undefined,
): number | undefined {
  if (!finite(atr) || !finite(price) || price === 0) return undefined;
  return (atr / price) * 100;
}

function calculateRangePercent(
  bar: CleanBar | undefined,
): number | undefined {
  if (!bar || !finite(bar.close) || bar.close === 0) return undefined;
  return ((bar.high - bar.low) / bar.close) * 100;
}

function numericVwapSlope(
  slope: ChartState["vwap"]["slope"],
): number | undefined {
  if (slope === "rising") return 1;
  if (slope === "falling") return -1;
  if (slope === "flat") return 0;
  return undefined;
}

function normalizeDirection(
  direction: ChartState["structure"]["trend"],
): MarketContextDirection {
  return direction ?? "neutral";
}

export function buildMarketIntelligenceRequestFromChartState(
  chartState: ChartState,
  options: ChartStateIntelligenceAdapterOptions = {},
): MarketIntelligenceRequest {
  const symbol = normalizeSymbol(chartState.symbol);
  const timeframe = normalizeTimeframe(chartState.timeframe);
  const lastBar = chartState.lastBar ?? chartState.bars.at(-1);

  if (!lastBar) {
    throw new Error(
      `Cannot build market intelligence for ${symbol} ${timeframe} without at least one chart bar.`,
    );
  }

  const now = options.now ?? Date.now;
  const timestamp = toEpochMilliseconds(lastBar.time) ?? now();
  const priorBar = previousBar(chartState.bars, lastBar);
  const lastPrice = finite(chartState.price)
    ? chartState.price
    : lastBar.close;
  const averageVolume =
    chartState.volume.average ??
    calculateAverageVolume(chartState.bars);
  const relativeVolume =
    chartState.volume.relative ??
    (finite(lastBar.volume) &&
    finite(averageVolume) &&
    averageVolume > 0
      ? lastBar.volume / averageVolume
      : undefined);

  return {
    contextRequest: {
      input: {
        symbol,
        timeframe,
        timestamp,
        session: options.session ?? inferSession(timestamp),
        tradingDate: tradingDate(timestamp),
        barIndex: Math.max(0, chartState.bars.length - 1),

        bar: {
          time: timestamp,
          open: lastBar.open,
          high: lastBar.high,
          low: lastBar.low,
          close: lastBar.close,
          volume: lastBar.volume,
          barIndex: Math.max(0, chartState.bars.length - 1),
        },

        price: {
          open: lastBar.open,
          high: lastBar.high,
          low: lastBar.low,
          close: lastBar.close,
          last: lastPrice,
          previousClose: priorBar?.close,
          change:
            priorBar && finite(lastPrice)
              ? lastPrice - priorBar.close
              : undefined,
          changePercent:
            priorBar && priorBar.close !== 0 && finite(lastPrice)
              ? ((lastPrice - priorBar.close) / priorBar.close) * 100
              : undefined,
        },

        volume: {
          current: chartState.volume.current ?? lastBar.volume,
          average: averageVolume,
          relative: relativeVolume,
          cumulative: calculateCumulativeVolume(chartState.bars),
        },

        volatility: {
          atr: chartState.atr.value,
          atrPercent: calculateAtrPercent(
            chartState.atr.value,
            lastPrice,
          ),
          range: lastBar.high - lastBar.low,
          rangePercent: calculateRangePercent(lastBar),
          expansionScore: chartState.atr.expanding ? 100 : 50,
          compressionScore: chartState.compression.score,
        },

        structure: {
          direction: normalizeDirection(chartState.structure.trend),
          trend: normalizeDirection(chartState.structure.trend),
          score: chartState.structure.strength,
          confidence: finite(chartState.structure.strength)
            ? Math.min(
                1,
                Math.max(0, chartState.structure.strength / 100),
              )
            : undefined,
          breakOfStructure: chartState.structure.bos,
          changeOfCharacter: chartState.structure.choch,
          higherHighs: chartState.structure.higherHighs,
          higherLows: chartState.structure.higherLows,
          lowerHighs: chartState.structure.lowerHighs,
          lowerLows: chartState.structure.lowerLows,
          swingHigh: chartState.structure.swingHigh,
          swingLow: chartState.structure.swingLow,
          lastSwingHigh: chartState.structure.lastSwingHigh,
          lastSwingLow: chartState.structure.lastSwingLow,
        },

        indicators: {
          ema9: chartState.ema.ema9,
          ema20: chartState.ema.ema20,
          ema50: chartState.ema.ema50,
          ema200: chartState.ema.ema200,
          vwap: chartState.vwap.value,
          vwapSlope: numericVwapSlope(chartState.vwap.slope),
          momentumScore: chartState.momentum.score,
          compressionScore: chartState.compression.score,
          relativeVolume,
          trendStrengthScore: chartState.structure.strength,
          participationScore: finite(relativeVolume)
            ? Math.min(100, Math.max(0, relativeVolume * 50))
            : undefined,
          custom: {
            emaBullish: chartState.ema.bullish ?? null,
            priceAboveVwap: chartState.vwap.above ?? null,
            vwapDistance: chartState.vwap.distance ?? null,
            vwapReclaimed: chartState.vwap.reclaimed ?? null,
            atrExpanding: chartState.atr.expanding ?? null,
            compressionBreaking:
              chartState.compression.breaking ?? null,
            momentumIncreasing:
              chartState.momentum.increasing ?? null,
            momentumFading: chartState.momentum.fading ?? null,
            momentumDirection:
              chartState.momentum.direction ?? null,
            emaMomentum:
              chartState.momentum.emaMomentum ?? null,
            vwapMomentum:
              chartState.momentum.vwapMomentum ?? null,
            candleMomentum:
              chartState.momentum.candleMomentum ?? null,
            volumeMomentum:
              chartState.momentum.volumeMomentum ?? null,
            atrMomentum:
              chartState.momentum.atrMomentum ?? null,
          },
        },

        metadata: {
          barCount: chartState.bars.length,
          adapter: "ChartStateIntelligenceAdapter",
          ...options.metadata,
        },
      },

      source: options.source ?? "decision-center",
      mode: options.mode ?? "live",
      previousSnapshot: options.previousReport?.context ?? null,
      correlationId: options.correlationId,
      metadata: {
        adapter: "ChartStateIntelligenceAdapter",
        ...options.metadata,
      },
    },

    consumer: options.consumer ?? "decision-center",
    preferredDirection: options.preferredDirection,
    previousReport: options.previousReport ?? null,
    includeCoach: options.includeCoach ?? true,
    includeNarrative: options.includeNarrative ?? true,
    minimumConfidence: options.minimumConfidence,
    minimumTradeScore: options.minimumTradeScore,
    correlationId: options.correlationId,
    metadata: {
      adapter: "ChartStateIntelligenceAdapter",
      ...options.metadata,
    },
  };
}

export default buildMarketIntelligenceRequestFromChartState;
