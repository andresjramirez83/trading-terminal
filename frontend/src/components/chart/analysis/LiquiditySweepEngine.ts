import type { CleanBar } from "../ChartTypes";

export type LiquiditySide = "buy-side" | "sell-side";
export type LiquidityEventType = "sweep" | "break";
export type LiquidityPoolSource =
  | "repeated-touch"
  | "structure"
  | "demand-zone"
  | "supply-zone";

export interface LiquidityPool {
  side: LiquiditySide;
  price: number;
  touches: number;
  firstTouchIndex: number;
  lastTouchIndex: number;
  establishedIndex: number;
  source: LiquidityPoolSource;
  zoneBottom?: number;
  zoneTop?: number;
}

export interface LiquidityEvent {
  type: LiquidityEventType;
  side: LiquiditySide;
  direction: "bullish" | "bearish";
  price: number;
  touches: number;
  barIndex: number;
  confirmationBarIndex?: number;
  reclaimed: boolean;
  source: LiquidityPoolSource;
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

export interface LiquidityStructurePoint {
  type: "HH" | "HL" | "LH" | "LL";
  index: number;
  price: number;
  confirmationIndex?: number;
}

export interface LiquidityZone {
  originIndex: number;
  bottom: number;
  top: number;
  active?: boolean;
  invalidationIndex?: number;
}

export interface LiquidityStructureLevels {
  swingHigh?: number;
  swingLow?: number;
  points?: readonly LiquidityStructurePoint[];
  demandZones?: readonly LiquidityZone[];
  supplyZones?: readonly LiquidityZone[];
}

const MIN_TOUCHES = 2;
const MIN_TOUCH_SEPARATION = 3;
const PIVOT_STRENGTH = 2;
const EVENT_PERSISTENCE_BARS = 6;
const HOLD_CONFIRM_BARS = 2;
const MIN_REENTRY_ATR = 0.04;
const MAX_HOLD_DRIFT_ATR = 0.10;

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

function inferredBarMinutes(bars: readonly CleanBar[]): number {
  const samples: number[] = [];
  const start = Math.max(1, bars.length - 30);
  for (let index = start; index < bars.length; index += 1) {
    const current = Number(bars[index].time);
    const previous = Number(bars[index - 1].time);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;
    const minutes = Math.abs(current - previous) / 60;
    if (minutes > 0 && minutes <= 1440) samples.push(minutes);
  }
  if (!samples.length) return 5;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 5;
}

function reclaimWindowBars(bars: readonly CleanBar[]): number {
  const minutes = Math.max(1, inferredBarMinutes(bars));
  return Math.max(6, Math.min(24, Math.round(90 / minutes)));
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
        matching.side === "buy-side"
          ? Math.max(matching.price, candidate.price)
          : Math.min(matching.price, candidate.price);
      matching.touches += 1;
      matching.lastTouchIndex = candidate.index;
      if (matching.touches === MIN_TOUCHES) matching.establishedIndex = candidate.index;
    } else {
      pools.push({
        side: candidate.side,
        price: candidate.price,
        touches: 1,
        firstTouchIndex: candidate.index,
        lastTouchIndex: candidate.index,
        establishedIndex: candidate.index,
        source: "repeated-touch",
      });
    }
  }
  return pools.filter((pool) => pool.touches >= MIN_TOUCHES);
}

function mergePool(pools: LiquidityPool[], next: LiquidityPool, tolerance: number): void {
  const existing = pools.find(
    (pool) =>
      pool.side === next.side &&
      Math.abs(pool.price - next.price) <= tolerance &&
      Math.abs(pool.establishedIndex - next.establishedIndex) <= 4,
  );
  if (!existing) {
    pools.push(next);
    return;
  }

  const priority: Record<LiquidityPoolSource, number> = {
    "repeated-touch": 1,
    structure: 2,
    "demand-zone": 3,
    "supply-zone": 3,
  };
  if (priority[next.source] >= priority[existing.source]) {
    existing.source = next.source;
    existing.price = next.price;
    existing.zoneBottom = next.zoneBottom;
    existing.zoneTop = next.zoneTop;
    existing.establishedIndex = Math.min(existing.establishedIndex, next.establishedIndex);
  }
  existing.touches = Math.max(existing.touches, next.touches);
}

function addStructurePools(
  pools: LiquidityPool[],
  structure: LiquidityStructureLevels,
  lastBarIndex: number,
  tolerance: number,
): void {
  for (const point of structure.points ?? []) {
    const side: LiquiditySide =
      point.type === "HH" || point.type === "LH" ? "buy-side" : "sell-side";
    mergePool(
      pools,
      {
        side,
        price: point.price,
        touches: 1,
        firstTouchIndex: point.index,
        lastTouchIndex: point.index,
        establishedIndex: Math.max(point.index, point.confirmationIndex ?? point.index),
        source: "structure",
      },
      tolerance,
    );
  }

  const fallback = (side: LiquiditySide, price: number | undefined) => {
    if (!finite(price)) return;
    mergePool(
      pools,
      {
        side,
        price,
        touches: 1,
        firstTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        lastTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        establishedIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        source: "structure",
      },
      tolerance,
    );
  };

  fallback("buy-side", structure.swingHigh);
  fallback("sell-side", structure.swingLow);
}

function addZonePools(
  pools: LiquidityPool[],
  zones: readonly LiquidityZone[] | undefined,
  side: LiquiditySide,
  source: "demand-zone" | "supply-zone",
  tolerance: number,
): void {
  for (const zone of zones ?? []) {
    if (!finite(zone.bottom) || !finite(zone.top) || zone.top <= zone.bottom) continue;
    const price = side === "sell-side" ? zone.bottom : zone.top;
    mergePool(
      pools,
      {
        side,
        price,
        touches: 1,
        firstTouchIndex: zone.originIndex,
        lastTouchIndex: zone.originIndex,
        establishedIndex: zone.originIndex,
        source,
        zoneBottom: zone.bottom,
        zoneTop: zone.top,
      },
      tolerance,
    );
  }
}

function significantRejectionWick(
  bar: CleanBar,
  side: LiquiditySide,
  tolerance: number,
  atr: number,
): boolean {
  const range = Math.max(0, bar.high - bar.low);
  if (range <= 0) return false;
  const bodyHigh = Math.max(bar.open, bar.close);
  const bodyLow = Math.min(bar.open, bar.close);
  const body = Math.max(0, bodyHigh - bodyLow);
  const wick =
    side === "sell-side"
      ? Math.max(0, bodyLow - bar.low)
      : Math.max(0, bar.high - bodyHigh);
  const minimumAbsoluteWick = Math.max(tolerance, atr * 0.25);
  return (
    wick >= minimumAbsoluteWick &&
    wick / range >= 0.50 &&
    wick >= Math.max(body * 1.50, tolerance)
  );
}

function returnedInsidePriorArea(
  bar: CleanBar,
  pool: LiquidityPool,
  reentryBuffer: number,
): boolean {
  // A sweep is only valid after price comes BACK THROUGH the swept boundary.
  // Merely getting close to the old support/resistance is not enough.
  //
  // sell-side sweep: trade below support, then CLOSE back above support.
  // buy-side sweep:  trade above resistance, then CLOSE back below resistance.
  //
  // For demand/supply zones, pool.price is already the outside boundary
  // (demand bottom / supply top), so crossing it puts price back into the
  // prior protected area instead of accepting beyond the level.
  return pool.side === "sell-side"
    ? bar.close >= pool.price + reentryBuffer
    : bar.close <= pool.price - reentryBuffer;
}

function heldReturnedPool(
  bars: readonly CleanBar[],
  pool: LiquidityPool,
  returnBarIndex: number,
  holdTolerance: number,
): number | undefined {
  const confirmationIndex = returnBarIndex + HOLD_CONFIRM_BARS;
  if (confirmationIndex >= bars.length) return undefined;

  for (let index = returnBarIndex + 1; index <= confirmationIndex; index += 1) {
    const close = bars[index].close;

    // After re-entry, allow only a small retest of the swept boundary.
    // If price accepts beyond the old resistance/support again, this was a
    // breakout/breakdown, not the rejection-style liquidity sweep we want.
    if (
      (pool.side === "sell-side" && close < pool.price - holdTolerance) ||
      (pool.side === "buy-side" && close > pool.price + holdTolerance)
    ) {
      return undefined;
    }
  }

  return confirmationIndex;
}

function canUseMultiCandleReclaim(pool: LiquidityPool): boolean {
  // A range edge can be real liquidity even when it comes from repeated
  // touches instead of a formal structure/demand/supply object. The key
  // requirement is still a meaningful excursion AND a confirmed re-entry.
  return (
    pool.source === "repeated-touch" ||
    pool.source === "structure" ||
    pool.source === "demand-zone" ||
    pool.source === "supply-zone"
  );
}

function eventsForPool(
  pool: LiquidityPool,
  bars: readonly CleanBar[],
  lastBarIndex: number,
  tolerance: number,
  atr: number,
): LiquidityEvent[] {
  const events: LiquidityEvent[] = [];
  const minimumPenetration = Math.max(tolerance, atr * 0.12);
  const minimumExcursion = Math.max(tolerance * 1.5, atr * 0.20);
  const reentryBuffer = Math.max(tolerance * 0.25, atr * MIN_REENTRY_ATR);
  const holdTolerance = Math.max(tolerance, atr * MAX_HOLD_DRIFT_ATR);
  const maxReclaimBars = reclaimWindowBars(bars);
  let index = Math.max(pool.establishedIndex + 1, 0);

  while (index <= lastBarIndex) {
    const bar = bars[index];
    const penetrated =
      pool.side === "sell-side"
        ? bar.low <= pool.price - minimumPenetration
        : bar.high >= pool.price + minimumPenetration;
    if (!penetrated) {
      index += 1;
      continue;
    }

    const excursionStart = index;
    let extremeIndex = index;
    let confirmedSweep = false;
    const searchEnd = Math.min(lastBarIndex, excursionStart + maxReclaimBars);

    for (let cursor = excursionStart; cursor <= searchEnd; cursor += 1) {
      const current = bars[cursor];
      if (
        (pool.side === "sell-side" && current.low < bars[extremeIndex].low) ||
        (pool.side === "buy-side" && current.high > bars[extremeIndex].high)
      ) {
        extremeIndex = cursor;
      }
      if (!returnedInsidePriorArea(current, pool, reentryBuffer)) continue;

      const excursionDepth =
        pool.side === "sell-side"
          ? pool.price - bars[extremeIndex].low
          : bars[extremeIndex].high - pool.price;
      const wickSweep = significantRejectionWick(
        bars[extremeIndex],
        pool.side,
        tolerance,
        atr,
      );
      const multiCandle = cursor > excursionStart;
      const meaningfulMultiCandleSweep =
        multiCandle &&
        excursionDepth >= minimumExcursion &&
        canUseMultiCandleReclaim(pool);

      // Valid LS:
      // 1) significant rejection wick, OR
      // 2) meaningful multi-candle excursion beyond the range edge;
      // AND in both cases price must CLOSE back through the swept boundary.
      // This rejects the repeated orange labels inside a range and rejects
      // breakouts that sweep resistance but continue accepting above it.
      if (!wickSweep && !meaningfulMultiCandleSweep) continue;

      const confirmationBarIndex = heldReturnedPool(
        bars,
        pool,
        cursor,
        holdTolerance,
      );
      if (confirmationBarIndex == null) continue;

      events.push({
        type: "sweep",
        side: pool.side,
        direction: pool.side === "sell-side" ? "bullish" : "bearish",
        price: pool.price,
        touches: pool.touches,
        barIndex: extremeIndex,
        confirmationBarIndex,
        reclaimed: true,
        source: pool.source,
      });
      index = confirmationBarIndex + 1;
      confirmedSweep = true;
      break;
    }

    if (confirmedSweep) continue;

    if (excursionStart + maxReclaimBars <= lastBarIndex) {
      events.push({
        type: "break",
        side: pool.side,
        direction: pool.side === "sell-side" ? "bearish" : "bullish",
        price: pool.price,
        touches: pool.touches,
        barIndex: extremeIndex,
        confirmationBarIndex: excursionStart + maxReclaimBars,
        reclaimed: false,
        source: pool.source,
      });
      break;
    }
    break;
  }

  return events;
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
  const atr = averageTrueRange(bars);
  const candidates: Candidate[] = [];
  for (let index = PIVOT_STRENGTH; index < bars.length - PIVOT_STRENGTH; index += 1) {
    if (isPivotHigh(bars, index)) candidates.push({ side: "buy-side", price: bars[index].high, index });
    if (isPivotLow(bars, index)) candidates.push({ side: "sell-side", price: bars[index].low, index });
  }

  const repeatedPools = clusterCandidates(candidates, tolerance);
  const pools = [...repeatedPools];
  const lastBarIndex = bars.length - 1;
  addStructurePools(pools, structure, lastBarIndex, tolerance);
  addZonePools(pools, structure.demandZones, "sell-side", "demand-zone", tolerance);
  addZonePools(pools, structure.supplyZones, "buy-side", "supply-zone", tolerance);

  const allEvents = pools.flatMap((pool) =>
    eventsForPool(pool, bars, lastBarIndex, tolerance, atr),
  );

  const eventStart = Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS + 1);
  const latestEvent = allEvents
    .filter((event) => (event.confirmationBarIndex ?? event.barIndex) >= eventStart)
    .sort(
      (left, right) =>
        (right.confirmationBarIndex ?? right.barIndex) -
        (left.confirmationBarIndex ?? left.barIndex),
    )[0];

  const priority: Record<LiquidityPoolSource, number> = {
    "repeated-touch": 1,
    structure: 2,
    "demand-zone": 3,
    "supply-zone": 3,
  };
  const deduplicatedSweeps = new Map<string, LiquidityEvent>();
  for (const event of allEvents) {
    if (event.type !== "sweep") continue;
    const key = `${event.barIndex}:${event.side}`;
    const existing = deduplicatedSweeps.get(key);
    if (!existing || priority[event.source] > priority[existing.source]) {
      deduplicatedSweeps.set(key, event);
    }
  }

  const sweepEvents = [...deduplicatedSweeps.values()].sort(
    (left, right) => left.barIndex - right.barIndex,
  );

  const currentPrice = bars[lastBarIndex].close;
  const meaningfulPools = pools.filter((pool) => pool.source !== "repeated-touch");
  const above = meaningfulPools
    .filter((pool) => pool.price > currentPrice)
    .sort((left, right) => left.price - right.price);
  const below = meaningfulPools
    .filter((pool) => pool.price < currentPrice)
    .sort((left, right) => right.price - left.price);
  const strongestTouches = repeatedPools.reduce(
    (maximum, pool) => Math.max(maximum, pool.touches),
    0,
  );

  return {
    pools,
    sweepEvents,
    latestEvent,
    nearestAbove: above[0],
    nearestBelow: below[0],
    equalHighs: repeatedPools.some((pool) => pool.side === "buy-side"),
    equalLows: repeatedPools.some((pool) => pool.side === "sell-side"),
    confidence: Math.min(0.95, 0.62 + Math.max(0, strongestTouches - 2) * 0.08),
  };
}
