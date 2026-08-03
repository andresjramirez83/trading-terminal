import type { CleanBar } from "../ChartTypes";

export type LiquiditySide = "buy-side" | "sell-side";
export type LiquidityEventType = "sweep" | "break";

export interface LiquidityPool {
  side: LiquiditySide;
  price: number;
  touches: number;
  firstTouchIndex: number;
  lastTouchIndex: number;
  source: "repeated-touch" | "structure";
}

export interface LiquidityEvent {
  type: LiquidityEventType;
  side: LiquiditySide;
  direction: "bullish" | "bearish";
  price: number;
  touches: number;
  barIndex: number;
  reclaimed: boolean;
  source: LiquidityPool["source"];
}

export interface LiquidityAnalysis {
  pools: LiquidityPool[];
  sweepEvents: LiquidityEvent[];
  latestEvent?: LiquidityEvent;
  nearestAbove?: LiquidityPool;
  nearestBelow?: LiquidityPool;
  equalHighs: boolean;
  equalLows: boolean;
  confidence: number;
}

export interface LiquidityStructureLevels {
  swingHigh?: number;
  swingLow?: number;
}

const MIN_TOUCHES = 2;
const MIN_TOUCH_SEPARATION = 3;
const PIVOT_STRENGTH = 2;
const EVENT_PERSISTENCE_BARS = 6;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function averageTrueRange(bars: readonly CleanBar[], length = 14): number {
  if (bars.length < 2) return 0;
  const start = Math.max(1, bars.length - length);
  let total = 0;
  let count = 0;
  for (let index = start; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    total += Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function toleranceFor(bars: readonly CleanBar[]): number {
  const price = Math.abs(bars.at(-1)?.close ?? 0);
  return Math.max(0.0001, price * 0.0005, averageTrueRange(bars) * 0.12);
}

function isPivotHigh(bars: readonly CleanBar[], index: number): boolean {
  const price = bars[index].high;
  for (let offset = 1; offset <= PIVOT_STRENGTH; offset += 1) {
    if (bars[index - offset].high > price || bars[index + offset].high >= price) {
      return false;
    }
  }
  return true;
}

function isPivotLow(bars: readonly CleanBar[], index: number): boolean {
  const price = bars[index].low;
  for (let offset = 1; offset <= PIVOT_STRENGTH; offset += 1) {
    if (bars[index - offset].low < price || bars[index + offset].low <= price) {
      return false;
    }
  }
  return true;
}

type Candidate = { side: LiquiditySide; price: number; index: number };

function clusterCandidates(
  candidates: readonly Candidate[],
  tolerance: number,
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];

  for (const candidate of candidates) {
    const matching = pools.find(
      (pool) =>
        pool.side === candidate.side &&
        Math.abs(pool.price - candidate.price) <= tolerance &&
        candidate.index - pool.lastTouchIndex >= MIN_TOUCH_SEPARATION,
    );

    if (matching) {
      matching.price =
        (matching.price * matching.touches + candidate.price) /
        (matching.touches + 1);
      matching.touches += 1;
      matching.lastTouchIndex = candidate.index;
    } else {
      pools.push({
        side: candidate.side,
        price: candidate.price,
        touches: 1,
        firstTouchIndex: candidate.index,
        lastTouchIndex: candidate.index,
        source: "repeated-touch",
      });
    }
  }

  return pools.filter((pool) => pool.touches >= MIN_TOUCHES);
}

function addStructurePool(
  pools: LiquidityPool[],
  side: LiquiditySide,
  price: number | undefined,
  lastBarIndex: number,
  tolerance: number,
): void {
  if (!finite(price)) return;
  const existing = pools.find(
    (pool) => pool.side === side && Math.abs(pool.price - price) <= tolerance,
  );
  if (existing) {
    existing.source = "structure";
    return;
  }
  pools.push({
    side,
    price,
    touches: 1,
    firstTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
    lastTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
    source: "structure",
  });
}

function eventForBar(
  pool: LiquidityPool,
  bar: CleanBar,
  barIndex: number,
  tolerance: number,
): LiquidityEvent | undefined {
  if (barIndex <= pool.lastTouchIndex) return undefined;

  if (pool.side === "buy-side" && bar.high > pool.price + tolerance) {
    const reclaimed = bar.close <= pool.price;
    return {
      type: reclaimed ? "sweep" : "break",
      side: pool.side,
      direction: reclaimed ? "bearish" : "bullish",
      price: pool.price,
      touches: pool.touches,
      barIndex,
      reclaimed,
      source: pool.source,
    };
  }

  if (pool.side === "sell-side" && bar.low < pool.price - tolerance) {
    const reclaimed = bar.close >= pool.price;
    return {
      type: reclaimed ? "sweep" : "break",
      side: pool.side,
      direction: reclaimed ? "bullish" : "bearish",
      price: pool.price,
      touches: pool.touches,
      barIndex,
      reclaimed,
      source: pool.source,
    };
  }

  return undefined;
}

export function analyzeLiquidity(
  bars: readonly CleanBar[],
  structure: LiquidityStructureLevels = {},
): LiquidityAnalysis {
  if (bars.length < PIVOT_STRENGTH * 2 + 3) {
    return {
      pools: [],
      sweepEvents: [],
      equalHighs: false,
      equalLows: false,
      confidence: 0,
    };
  }

  const tolerance = toleranceFor(bars);
  const candidates: Candidate[] = [];
  for (
    let index = PIVOT_STRENGTH;
    index < bars.length - PIVOT_STRENGTH;
    index += 1
  ) {
    if (isPivotHigh(bars, index)) {
      candidates.push({ side: "buy-side", price: bars[index].high, index });
    }
    if (isPivotLow(bars, index)) {
      candidates.push({ side: "sell-side", price: bars[index].low, index });
    }
  }

  const pools = clusterCandidates(candidates, tolerance);
  const lastBarIndex = bars.length - 1;
  addStructurePool(pools, "buy-side", structure.swingHigh, lastBarIndex, tolerance);
  addStructurePool(pools, "sell-side", structure.swingLow, lastBarIndex, tolerance);

  let latestEvent: LiquidityEvent | undefined;
  const eventStart = Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS + 1);
  for (let index = eventStart; index <= lastBarIndex; index += 1) {
    for (const pool of pools) {
      const event = eventForBar(pool, bars[index], index, tolerance);
      if (event && (!latestEvent || event.barIndex >= latestEvent.barIndex)) {
        latestEvent = event;
      }
    }
  }

  const sweepEvents: LiquidityEvent[] = [];
  for (const pool of pools) {
    for (let index = pool.lastTouchIndex + 1; index <= lastBarIndex; index += 1) {
      const event = eventForBar(pool, bars[index], index, tolerance);
      if (event?.type === "sweep") sweepEvents.push(event);
    }
  }

  sweepEvents.sort((left, right) => left.barIndex - right.barIndex);

  const currentPrice = bars[lastBarIndex].close;
  const above = pools
    .filter((pool) => pool.price > currentPrice)
    .sort((left, right) => left.price - right.price);
  const below = pools
    .filter((pool) => pool.price < currentPrice)
    .sort((left, right) => right.price - left.price);
  const strongestTouches = pools.reduce(
    (maximum, pool) => Math.max(maximum, pool.touches),
    0,
  );

  return {
    pools,
    sweepEvents,
    latestEvent,
    nearestAbove: above[0],
    nearestBelow: below[0],
    equalHighs: pools.some(
      (pool) => pool.side === "buy-side" && pool.touches >= MIN_TOUCHES,
    ),
    equalLows: pools.some(
      (pool) => pool.side === "sell-side" && pool.touches >= MIN_TOUCHES,
    ),
    confidence: Math.min(0.95, 0.55 + Math.max(0, strongestTouches - 2) * 0.1),
  };
}
