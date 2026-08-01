/**
 * RegimeTracker.ts
 *
 * Tracks the current market regime and transitions.
 */

export type MarketRegime =
  | "unknown"
  | "balanced"
  | "uptrend"
  | "downtrend"
  | "compression"
  | "expansion"
  | "accumulation"
  | "distribution";

export interface RegimeObservation {
  timestamp: number;
  regime: MarketRegime;
  confidence: number;
  reason: string;
}

export interface RegimeSnapshot {
  current: MarketRegime;
  previous: MarketRegime;
  confidence: number;
  updatedAt: number;
  history: RegimeObservation[];
}

export class RegimeTracker {
  private current: MarketRegime = "unknown";
  private previous: MarketRegime = "unknown";
  private confidence = 0;
  private updatedAt = 0;
  private history: RegimeObservation[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 500) {
    this.maxHistory = Math.max(10, maxHistory);
  }

  update(
    regime: MarketRegime,
    confidence: number,
    reason: string,
    timestamp = Date.now(),
  ): boolean {
    confidence = Math.max(0, Math.min(1, confidence));

    const changed =
      regime !== this.current || Math.abs(confidence - this.confidence) > 0.001;

    if (!changed) return false;

    this.previous = this.current;
    this.current = regime;
    this.confidence = confidence;
    this.updatedAt = timestamp;

    this.history.push({
      timestamp,
      regime,
      confidence,
      reason,
    });

    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    return true;
  }

  getSnapshot(): RegimeSnapshot {
    return {
      current: this.current,
      previous: this.previous,
      confidence: this.confidence,
      updatedAt: this.updatedAt,
      history: [...this.history],
    };
  }

  reset(): void {
    this.current = "unknown";
    this.previous = "unknown";
    this.confidence = 0;
    this.updatedAt = 0;
    this.history = [];
  }
}

export default RegimeTracker;
