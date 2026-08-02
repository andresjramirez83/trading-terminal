// src/trading/intelligence/integration/MarketIntelligenceStore.ts

import type {
  MarketIntelligenceBuildResult,
  MarketIntelligenceReport,
} from "../core/IntelligenceTypes";

export type MarketIntelligenceStoreStatus =
  | "idle"
  | "evaluating"
  | "ready"
  | "error";

export interface MarketIntelligenceStoreSnapshot {
  status: MarketIntelligenceStoreStatus;
  result: MarketIntelligenceBuildResult | null;
  report: MarketIntelligenceReport | null;
  previousReport: MarketIntelligenceReport | null;
  error: string | null;
  evaluatedAt: number | null;
  requestKey: string | null;
}

export type MarketIntelligenceStoreListener = (
  snapshot: MarketIntelligenceStoreSnapshot,
) => void;

function freezeSnapshot(
  snapshot: MarketIntelligenceStoreSnapshot,
): MarketIntelligenceStoreSnapshot {
  return Object.freeze({ ...snapshot });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string"
    ? error
    : "Unable to evaluate trading intelligence.";
}

const EMPTY_SNAPSHOT = freezeSnapshot({
  status: "idle",
  result: null,
  report: null,
  previousReport: null,
  error: null,
  evaluatedAt: null,
  requestKey: null,
});

/**
 * Shared result store for chart intelligence consumers.
 *
 * ChartIntelligenceBridge is the single pipeline runner. The Decision Center,
 * coach, and other UI surfaces subscribe here so they all display the same
 * completed report without independently evaluating the same chart update.
 */
export class MarketIntelligenceStore {
  private current: MarketIntelligenceStoreSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<MarketIntelligenceStoreListener>();

  getSnapshot(): MarketIntelligenceStoreSnapshot {
    return this.current;
  }

  begin(requestKey: string): void {
    this.setSnapshot({
      ...this.current,
      status: "evaluating",
      error: null,
      requestKey,
    });
  }

  publish(
    result: MarketIntelligenceBuildResult,
    requestKey: string,
  ): void {
    const previousReport = this.current.report;

    this.setSnapshot({
      status: "ready",
      result,
      report: result.report,
      previousReport,
      error: null,
      evaluatedAt: Date.now(),
      requestKey,
    });
  }

  fail(error: unknown, requestKey: string): void {
    this.setSnapshot({
      ...this.current,
      status: "error",
      error: errorMessage(error),
      requestKey,
    });
  }

  reset(): void {
    this.setSnapshot(EMPTY_SNAPSHOT);
  }

  subscribe(listener: MarketIntelligenceStoreListener): () => void {
    this.listeners.add(listener);
    listener(this.current);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSnapshot(snapshot: MarketIntelligenceStoreSnapshot): void {
    this.current = freezeSnapshot(snapshot);

    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch {
        // A UI subscriber must never interrupt the intelligence pipeline.
      }
    }
  }
}

let sharedMarketIntelligenceStore: MarketIntelligenceStore | null = null;

export function getSharedMarketIntelligenceStore(): MarketIntelligenceStore {
  if (!sharedMarketIntelligenceStore) {
    sharedMarketIntelligenceStore = new MarketIntelligenceStore();
  }

  return sharedMarketIntelligenceStore;
}

export default MarketIntelligenceStore;
