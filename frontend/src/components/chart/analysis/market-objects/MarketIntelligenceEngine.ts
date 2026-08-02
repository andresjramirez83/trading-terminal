// src/components/chart/analysis/market-objects/MarketIntelligenceEngine.ts

import type { Time } from "lightweight-charts";
import {
  marketMemoryService,
  type MarketMemoryService,
} from "./MarketMemoryService";
import {
  marketObjectRegistry,
  type MarketObjectRegistry,
} from "./MarketObjectRegistry";
import type {
  MarketObject,
  MarketObjectInteractionType,
  MarketObjectProximity,
  MarketObjectRegistrySnapshot,
} from "./MarketObjectTypes";

export type MarketIntelligenceBar = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type MarketIntelligenceUpdate = {
  symbol: string;
  timeframe: string;
  bar: MarketIntelligenceBar;
  previousBar?: MarketIntelligenceBar;
  barIndex?: number;
};

export type MarketObjectEvaluation = {
  objectId: string;
  proximity: MarketObjectProximity;
  interactions: MarketObjectInteractionType[];
};

export type MarketIntelligenceResult = {
  symbol: string;
  timeframe: string;
  time: Time;
  price: number;
  evaluations: MarketObjectEvaluation[];
  snapshot: MarketObjectRegistrySnapshot;
};

export type MarketIntelligenceListener = (
  result: MarketIntelligenceResult,
) => void;

type PriceBounds = {
  low: number;
  high: number;
};

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function numericTime(time: Time): number | null {
  if (typeof time === "number") {
    if (!Number.isFinite(time)) return null;

    // Lightweight Charts uses Unix seconds, while persisted drawings may
    // contain JavaScript timestamps in milliseconds. Normalize both sides of
    // the line projection to seconds before calculating its slope.
    return Math.abs(time) >= 100_000_000_000 ? time / 1000 : time;
  }
  if (typeof time === "string") {
    const value = Date.parse(time);
    return Number.isFinite(value) ? value / 1000 : null;
  }

  const value = Date.UTC(time.year, time.month - 1, time.day) / 1000;
  return Number.isFinite(value) ? value : null;
}

function linePriceAtTime(object: MarketObject, time: Time): number | null {
  if (object.geometry.kind !== "line") return null;

  const { start, end } = object.geometry.line;
  const startTime = numericTime(start.time);
  const endTime = numericTime(end.time);
  const currentTime = numericTime(time);

  if (startTime === null || endTime === null || currentTime === null) {
    return end.price;
  }

  const duration = endTime - startTime;
  if (duration === 0) return end.price;

  const progress = (currentTime - startTime) / duration;
  return start.price + (end.price - start.price) * progress;
}

function boundsAtTime(object: MarketObject, time: Time): PriceBounds | null {
  switch (object.geometry.kind) {
    case "zone":
      return {
        low: Math.min(object.geometry.zone.low, object.geometry.zone.high),
        high: Math.max(object.geometry.zone.low, object.geometry.zone.high),
      };
    case "level":
      return {
        low: object.geometry.level.price,
        high: object.geometry.level.price,
      };
    case "line": {
      const price = linePriceAtTime(object, time);
      return price === null ? null : { low: price, high: price };
    }
    case "event":
      return object.geometry.price === undefined
        ? null
        : { low: object.geometry.price, high: object.geometry.price };
  }
}

function calculateProximity(
  object: MarketObject,
  price: number,
  time: Time,
): MarketObjectProximity | null {
  const bounds = boundsAtTime(object, time);
  if (!bounds || !Number.isFinite(price)) return null;

  const isInside = price >= bounds.low && price <= bounds.high;
  const distancePrice = isInside
    ? 0
    : price < bounds.low
      ? bounds.low - price
      : price - bounds.high;
  const distancePercent = price === 0 ? 0 : (distancePrice / Math.abs(price)) * 100;
  const threshold = Math.max(0, object.awareness.threshold);
  const awarenessDistance =
    object.awareness.mode === "percent"
      ? Math.abs(price) * (threshold / 100)
      : threshold;
  const isWithinAwarenessRadius =
    object.awareness.enabled &&
    (isInside || distancePrice <= awarenessDistance);
  const approachProgress = isInside
    ? 100
    : awarenessDistance <= 0
      ? 0
      : clamp((1 - distancePrice / awarenessDistance) * 100, 0, 100);

  return {
    currentPrice: price,
    distancePrice,
    distancePercent,
    isInside,
    isWithinAwarenessRadius,
    approachProgress,
    approachSide: isInside ? "inside" : price > bounds.high ? "above" : "below",
    evaluatedAt: Date.now(),
  };
}

function candleTouches(bounds: PriceBounds, bar: MarketIntelligenceBar): boolean {
  return bar.high >= bounds.low && bar.low <= bounds.high;
}

function invalidationType(
  object: MarketObject,
  bounds: PriceBounds,
  bar: MarketIntelligenceBar,
): MarketObjectInteractionType | null {
  if (object.bias === "bullish" && bar.close < bounds.low) return "invalidated";
  if (object.bias === "bearish" && bar.close > bounds.high) return "invalidated";
  return null;
}

function rejectionType(
  object: MarketObject,
  bounds: PriceBounds,
  bar: MarketIntelligenceBar,
): MarketObjectInteractionType | null {
  if (!candleTouches(bounds, bar)) return null;

  if (object.bias === "bullish" && bar.close > bounds.high) {
    return bar.open <= bounds.high ? "bodyRejected" : "wickRejected";
  }

  if (object.bias === "bearish" && bar.close < bounds.low) {
    return bar.open >= bounds.low ? "bodyRejected" : "wickRejected";
  }

  return null;
}

function closeCrossingType(
  object: MarketObject,
  update: MarketIntelligenceUpdate,
): MarketObjectInteractionType | null {
  const previousBar = update.previousBar;
  if (!previousBar) return null;

  const previousBounds = boundsAtTime(object, previousBar.time);
  const currentBounds = boundsAtTime(object, update.bar.time);
  if (!previousBounds || !currentBounds) return null;

  const wasAtOrBelow = previousBar.close <= previousBounds.high;
  const wasAtOrAbove = previousBar.close >= previousBounds.low;
  const isAbove = update.bar.close > currentBounds.high;
  const isBelow = update.bar.close < currentBounds.low;

  if (wasAtOrBelow && isAbove) return "closedAbove";
  if (wasAtOrAbove && isBelow) return "closedBelow";
  return null;
}

export class MarketIntelligenceEngine {
  private readonly listeners = new Set<MarketIntelligenceListener>();
  private lastResult: MarketIntelligenceResult | null = null;

  constructor(
    private readonly registry: MarketObjectRegistry = marketObjectRegistry,
    private readonly memory: MarketMemoryService = marketMemoryService,
  ) {}

  subscribe(listener: MarketIntelligenceListener, emitCurrent = false): () => void {
    this.listeners.add(listener);
    if (emitCurrent && this.lastResult) listener(this.lastResult);
    return () => this.listeners.delete(listener);
  }

  getLastResult(): MarketIntelligenceResult | null {
    return this.lastResult;
  }

  evaluate(update: MarketIntelligenceUpdate): MarketIntelligenceResult {
    const symbol = normalizedSymbol(update.symbol);
    const timeframe = update.timeframe.trim();
    const objects = this.registry.find({ symbol, timeframe, active: true });
    const evaluations: MarketObjectEvaluation[] = [];

    for (const object of objects) {
      const proximity = calculateProximity(object, update.bar.close, update.bar.time);
      const bounds = boundsAtTime(object, update.bar.time);
      if (!proximity || !bounds) continue;

      const previousProximity = object.awareness.proximity;
      const interactions: MarketObjectInteractionType[] = [];

      this.registry.update(object.id, {
        awareness: { ...object.awareness, proximity },
        updatedTime: update.bar.time,
        updatedBarIndex: update.barIndex ?? object.updatedBarIndex,
      });

      const invalidation = invalidationType(object, bounds, update.bar);
      if (invalidation) {
        this.record(object.id, invalidation, update, interactions);
        evaluations.push({ objectId: object.id, proximity, interactions });
        continue;
      }

      if (
        proximity.isWithinAwarenessRadius &&
        !previousProximity?.isWithinAwarenessRadius &&
        !proximity.isInside
      ) {
        this.record(object.id, "approachStarted", update, interactions);
      } else if (
        proximity.isWithinAwarenessRadius &&
        previousProximity?.isWithinAwarenessRadius &&
        !proximity.isInside &&
        Math.abs(proximity.approachProgress - previousProximity.approachProgress) >= 10
      ) {
        this.record(object.id, "approachUpdated", update, interactions);
      }

      const touched = candleTouches(bounds, update.bar);
      const wasInside = previousProximity?.isInside ?? false;
      if (touched && !wasInside) {
        this.record(
          object.id,
          update.bar.close >= bounds.low && update.bar.close <= bounds.high
            ? "entered"
            : "touched",
          update,
          interactions,
        );
      }

      const rejection = rejectionType(object, bounds, update.bar);
      if (rejection) this.record(object.id, rejection, update, interactions);

      if (!proximity.isInside && wasInside && !rejection) {
        this.record(object.id, "leftObject", update, interactions);
      }

      const closeCrossing = closeCrossingType(object, update);
      if (closeCrossing) {
        this.record(object.id, closeCrossing, update, interactions);
      }

      evaluations.push({ objectId: object.id, proximity, interactions });
    }

    const result: MarketIntelligenceResult = {
      symbol,
      timeframe,
      time: update.bar.time,
      price: update.bar.close,
      evaluations,
      snapshot: this.registry.getSnapshot(symbol, timeframe),
    };

    this.lastResult = result;
    for (const listener of this.listeners) listener(result);
    return result;
  }

  private record(
    objectId: string,
    type: MarketObjectInteractionType,
    update: MarketIntelligenceUpdate,
    interactions: MarketObjectInteractionType[],
  ): void {
    this.memory.recordInteraction(objectId, {
      type,
      time: update.bar.time,
      price: update.bar.close,
      barIndex: update.barIndex,
      metadata: {
        open: update.bar.open,
        high: update.bar.high,
        low: update.bar.low,
        close: update.bar.close,
        volume: update.bar.volume,
      },
    });
    interactions.push(type);
  }
}

export const marketIntelligenceEngine = new MarketIntelligenceEngine();
