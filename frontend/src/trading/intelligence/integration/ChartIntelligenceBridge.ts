// src/trading/intelligence/integration/ChartIntelligenceBridge.ts

import type { ChartState } from "../../../components/chart/ChartState";
import {
  evaluateTradingIntelligence,
} from "../core/TradingIntelligenceRuntime";
import type {
  MarketIntelligenceBuildResult,
  MarketIntelligenceReport,
} from "../core/IntelligenceTypes";
import {
  buildMarketIntelligenceRequestFromChartState,
  type IntelligenceChartMode,
} from "./ChartStateIntelligenceAdapter";
import {
  getSharedMarketIntelligenceStore,
  type MarketIntelligenceStore,
} from "./MarketIntelligenceStore";

export interface ChartIntelligenceBridgeOptions {
  mode?: IntelligenceChartMode;
  includeCoach?: boolean;
  includeNarrative?: boolean;
  minimumConfidence?: number;
  minimumTradeScore?: number;
  store?: MarketIntelligenceStore;
  onResult?: (result: MarketIntelligenceBuildResult) => void;
  onError?: (error: unknown) => void;
}

type PendingEvaluation = {
  chartState: ChartState;
  reason: string;
};

function barKey(chartState: ChartState): string {
  const lastBar = chartState.lastBar ?? chartState.bars.at(-1);
  const time = lastBar?.time;
  const normalizedTime =
    typeof time === "object" && time !== null
      ? JSON.stringify(time)
      : String(time ?? "none");

  return [
    chartState.symbol?.trim().toUpperCase() ?? "",
    chartState.timeframe?.trim() ?? "",
    normalizedTime,
    lastBar?.open ?? "",
    lastBar?.high ?? "",
    lastBar?.low ?? "",
    lastBar?.close ?? "",
    lastBar?.volume ?? "",
  ].join("|");
}

/**
 * Runs the Trading Intelligence pipeline from chart updates without allowing
 * rapid live ticks or replay steps to build an unbounded async queue.
 */
export class ChartIntelligenceBridge {
  private options: ChartIntelligenceBridgeOptions;
  private pending: PendingEvaluation | null = null;
  private running = false;
  private destroyed = false;
  private lastEvaluatedKey = "";
  private previousReport: MarketIntelligenceReport | null = null;
  private readonly store: MarketIntelligenceStore;

  constructor(options: ChartIntelligenceBridgeOptions = {}) {
    this.options = options;
    this.store = options.store ?? getSharedMarketIntelligenceStore();
  }

  setOptions(options: Partial<ChartIntelligenceBridgeOptions>): void {
    this.options = { ...this.options, ...options };
  }

  setMode(mode: IntelligenceChartMode): void {
    this.options = { ...this.options, mode };
  }

  reset(): void {
    this.pending = null;
    this.lastEvaluatedKey = "";
    this.previousReport = null;
    this.store.reset();
  }

  update(chartState: ChartState, reason = "chart-state-updated"): void {
    if (this.destroyed || chartState.bars.length === 0) return;

    const key = barKey(chartState);
    if (key === this.lastEvaluatedKey && !this.pending) return;

    this.pending = { chartState, reason };
    void this.drain();
  }

  destroy(): void {
    this.destroyed = true;
    this.pending = null;
    this.previousReport = null;
  }

  private async drain(): Promise<void> {
    if (this.running || this.destroyed) return;

    this.running = true;

    try {
      while (this.pending && !this.destroyed) {
        const next = this.pending;
        this.pending = null;
        const key = barKey(next.chartState);

        if (key === this.lastEvaluatedKey) continue;

        try {
          this.store.begin(key);
          const request = buildMarketIntelligenceRequestFromChartState(
            next.chartState,
            {
              source:
                (this.options.mode ?? "live") === "replay"
                  ? "replay"
                  : "live",
              consumer: "decision-center",
              mode: this.options.mode ?? "live",
              previousReport: this.previousReport,
              includeCoach: this.options.includeCoach ?? true,
              includeNarrative: this.options.includeNarrative ?? true,
              minimumConfidence: this.options.minimumConfidence,
              minimumTradeScore: this.options.minimumTradeScore,
              metadata: {
                reason: next.reason,
                bridge: "ChartIntelligenceBridge",
              },
            },
          );

          const result = await evaluateTradingIntelligence(request);
          if (this.destroyed) return;

          this.lastEvaluatedKey = key;
          this.previousReport = result.report;
          this.store.publish(result, key);
          this.options.onResult?.(result);
        } catch (error) {
          this.store.fail(error, key);
          this.options.onError?.(error);
        }
      }
    } finally {
      this.running = false;

      if (this.pending && !this.destroyed) {
        void this.drain();
      }
    }
  }
}

export default ChartIntelligenceBridge;
