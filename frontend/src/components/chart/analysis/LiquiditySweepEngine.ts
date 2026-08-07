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
  validUntilIndex?: number;
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
}

/**
 * Liquidity-sweep rules are intentionally strict.
 *
 * A sweep is NOT a local pivot poke. It must attack meaningful liquidity:
 *   1) the active confirmed HH / LL from market structure, or
 *   2) a major equal-high / equal-low pool built from 3+ well-separated touches.
 *
 * Then the sweep candle itself must WICK beyond that level and CLOSE back on
 * the protected side. Price must also hold the reclaim on the next candle.
 * If price accepts beyond the level, that is a breakout/breakdown, not LS.
 *
 * Demand/supply zones are deliberately NOT standalone LS anchors. They may be
 * important context, but they no longer create LS labels by themselves. This
 * prevents zone-heavy charts from flooding with false sweep labels.
 */

const PIVOT_STRENGTH = 3;
const MAJOR_POOL_MIN_TOUCHES = 3;
const MAJOR_POOL_MIN_TOUCH_SEPARATION = 8;
const MAJOR_POOL_MIN_SPAN_BARS = 24;
const ARM_AWAY_BARS = 2;
const HOLD_CONFIRM_BARS = 1;
const EVENT_PERSISTENCE_BARS = 8;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function trueRange(bar: CleanBar, previous?: CleanBar): number {
  if (!previous) return Math.max(0, bar.high - bar.low);
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - previous.close),
    Math.abs(bar.low - previous.close),
  );
}

function averageTrueRange(bars: readonly CleanBar[], endIndex = bars.length - 1, length = 14): number {
  if (!bars.length) return 0;
  const safeEnd = clamp(endIndex, 0, bars.length - 1);
  const start = Math.max(0, safeEnd - length + 1);
  let total = 0;
  let count = 0;
  for (let index = start; index <= safeEnd; index += 1) {
    total += trueRange(bars[index], index > 0 ? bars[index - 1] : undefined);
    count += 1;
  }
  return count ? total / count : 0;
}

function levelTolerance(bars: readonly CleanBar[]): number {
  const price = Math.abs(bars.at(-1)?.close ?? 0);
  const atr = averageTrueRange(bars);
  return Math.max(0.0001, price * 0.00035, atr * 0.07);
}

function isPivotHigh(bars: readonly CleanBar[], index: number): boolean {
  const high = bars[index].high;
  for (let offset = 1; offset <= PIVOT_STRENGTH; offset += 1) {
    if (bars[index - offset].high >= high || bars[index + offset].high > high) return false;
  }
  return true;
}

function isPivotLow(bars: readonly CleanBar[], index: number): boolean {
  const low = bars[index].low;
  for (let offset = 1; offset <= PIVOT_STRENGTH; offset += 1) {
    if (bars[index - offset].low <= low || bars[index + offset].low < low) return false;
  }
  return true;
}

type Candidate = {
  side: LiquiditySide;
  price: number;
  index: number;
};

type CandidateCluster = {
  side: LiquiditySide;
  anchorPrice: number;
  outsidePrice: number;
  touchIndices: number[];
  touchPrices: number[];
};

function buildMajorRepeatedPools(
  bars: readonly CleanBar[],
  tolerance: number,
): LiquidityPool[] {
  const candidates: Candidate[] = [];
  for (let index = PIVOT_STRENGTH; index < bars.length - PIVOT_STRENGTH; index += 1) {
    if (isPivotHigh(bars, index)) {
      candidates.push({ side: "buy-side", price: bars[index].high, index });
    }
    if (isPivotLow(bars, index)) {
      candidates.push({ side: "sell-side", price: bars[index].low, index });
    }
  }

  const clusters: CandidateCluster[] = [];

  for (const candidate of candidates) {
    const cluster = clusters.find(
      (item) =>
        item.side === candidate.side &&
        Math.abs(candidate.price - item.anchorPrice) <= tolerance,
    );

    if (!cluster) {
      clusters.push({
        side: candidate.side,
        anchorPrice: candidate.price,
        outsidePrice: candidate.price,
        touchIndices: [candidate.index],
        touchPrices: [candidate.price],
      });
      continue;
    }

    const lastTouchIndex = cluster.touchIndices.at(-1) ?? candidate.index;
    if (candidate.index - lastTouchIndex < MAJOR_POOL_MIN_TOUCH_SEPARATION) continue;

    cluster.touchIndices.push(candidate.index);
    cluster.touchPrices.push(candidate.price);
    cluster.anchorPrice =
      cluster.touchPrices.reduce((sum, price) => sum + price, 0) /
      cluster.touchPrices.length;
    cluster.outsidePrice =
      cluster.side === "buy-side"
        ? Math.max(cluster.outsidePrice, candidate.price)
        : Math.min(cluster.outsidePrice, candidate.price);
  }

  return clusters
    .filter((cluster) => {
      if (cluster.touchIndices.length < MAJOR_POOL_MIN_TOUCHES) return false;
      const first = cluster.touchIndices[0];
      const last = cluster.touchIndices.at(-1) ?? first;
      return last - first >= MAJOR_POOL_MIN_SPAN_BARS;
    })
    .map((cluster) => {
      const first = cluster.touchIndices[0];
      const last = cluster.touchIndices.at(-1) ?? first;
      return {
        side: cluster.side,
        price: cluster.outsidePrice,
        touches: cluster.touchIndices.length,
        firstTouchIndex: first,
        lastTouchIndex: last,
        establishedIndex: cluster.touchIndices[MAJOR_POOL_MIN_TOUCHES - 1],
        source: "repeated-touch" as const,
      };
    });
}

function addStructurePools(
  pools: LiquidityPool[],
  structure: LiquidityStructureLevels,
  lastBarIndex: number,
): void {
  const points = structure.points ?? [];

  const confirmationIndex = (point: LiquidityStructurePoint) =>
    Math.max(point.index, point.confirmationIndex ?? point.index);

  const addType = (type: "HH" | "LL", side: LiquiditySide) => {
    const typed = points
      .filter((point) => point.type === type && finite(point.price))
      .slice()
      .sort((left, right) => confirmationIndex(left) - confirmationIndex(right));

    for (let index = 0; index < typed.length; index += 1) {
      const point = typed[index];
      const next = typed[index + 1];
      const establishedIndex = confirmationIndex(point);
      pools.push({
        side,
        price: point.price,
        touches: 1,
        firstTouchIndex: point.index,
        lastTouchIndex: point.index,
        establishedIndex,
        validUntilIndex: next
          ? Math.max(establishedIndex, confirmationIndex(next) - 1)
          : lastBarIndex,
        source: "structure",
      });
    }
  };

  addType("HH", "buy-side");
  addType("LL", "sell-side");

  // Compatibility fallback when a caller only supplies swingHigh/swingLow.
  // These fallback levels are current-only and intentionally short lived.
  if (!points.length) {
    if (finite(structure.swingHigh)) {
      pools.push({
        side: "buy-side",
        price: structure.swingHigh,
        touches: 1,
        firstTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        lastTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        establishedIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        validUntilIndex: lastBarIndex,
        source: "structure",
      });
    }
    if (finite(structure.swingLow)) {
      pools.push({
        side: "sell-side",
        price: structure.swingLow,
        touches: 1,
        firstTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        lastTouchIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        establishedIndex: Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS),
        validUntilIndex: lastBarIndex,
        source: "structure",
      });
    }
  }
}

function deduplicatePools(pools: readonly LiquidityPool[], tolerance: number): LiquidityPool[] {
  const sorted = pools
    .slice()
    .sort((left, right) => left.establishedIndex - right.establishedIndex);
  const result: LiquidityPool[] = [];

  for (const pool of sorted) {
    const existing = result.find(
      (candidate) =>
        candidate.side === pool.side &&
        Math.abs(candidate.price - pool.price) <= tolerance &&
        Math.abs(candidate.establishedIndex - pool.establishedIndex) <= 3,
    );

    if (!existing) {
      result.push({ ...pool });
      continue;
    }

    // Confirmed HH/LL always wins over an equal-high/equal-low cluster.
    if (pool.source === "structure" && existing.source !== "structure") {
      Object.assign(existing, pool);
    } else {
      existing.touches = Math.max(existing.touches, pool.touches);
    }
  }

  return result;
}

function awayFromLevel(
  bar: CleanBar,
  pool: LiquidityPool,
  atr: number,
  tolerance: number,
): boolean {
  const distance = Math.max(tolerance * 2, atr * 0.30);
  return pool.side === "buy-side"
    ? bar.close <= pool.price - distance
    : bar.close >= pool.price + distance;
}

function acceptedBeyondLevel(
  bar: CleanBar,
  pool: LiquidityPool,
  atr: number,
  tolerance: number,
): boolean {
  const acceptance = Math.max(tolerance * 1.5, atr * 0.12);
  return pool.side === "buy-side"
    ? bar.close >= pool.price + acceptance
    : bar.close <= pool.price - acceptance;
}

function strictWickSweep(
  bar: CleanBar,
  pool: LiquidityPool,
  atr: number,
  tolerance: number,
): boolean {
  const range = Math.max(0, bar.high - bar.low);
  if (range <= 0) return false;

  const bodyHigh = Math.max(bar.open, bar.close);
  const bodyLow = Math.min(bar.open, bar.close);
  const body = Math.max(0, bodyHigh - bodyLow);
  const minPenetration = Math.max(tolerance, atr * 0.08);
  const reclaimBuffer = Math.max(tolerance * 0.25, atr * 0.02);

  if (pool.side === "buy-side") {
    const upperWick = Math.max(0, bar.high - bodyHigh);
    const penetrated = bar.high >= pool.price + minPenetration;
    const bodyStayedInside = bodyHigh <= pool.price + tolerance;
    const closedBackInside = bar.close <= pool.price - reclaimBuffer;
    const wickIsReal =
      upperWick >= minPenetration &&
      upperWick / range >= 0.28 &&
      upperWick >= Math.max(body * 0.75, tolerance);
    return penetrated && bodyStayedInside && closedBackInside && wickIsReal;
  }

  const lowerWick = Math.max(0, bodyLow - bar.low);
  const penetrated = bar.low <= pool.price - minPenetration;
  const bodyStayedInside = bodyLow >= pool.price - tolerance;
  const closedBackInside = bar.close >= pool.price + reclaimBuffer;
  const wickIsReal =
    lowerWick >= minPenetration &&
    lowerWick / range >= 0.28 &&
    lowerWick >= Math.max(body * 0.75, tolerance);
  return penetrated && bodyStayedInside && closedBackInside && wickIsReal;
}

function reclaimHeld(
  bars: readonly CleanBar[],
  pool: LiquidityPool,
  sweepIndex: number,
  atr: number,
  tolerance: number,
): number | undefined {
  const confirmationIndex = sweepIndex + HOLD_CONFIRM_BARS;
  if (confirmationIndex >= bars.length) return undefined;

  const maxDrift = Math.max(tolerance, atr * 0.06);
  for (let index = sweepIndex + 1; index <= confirmationIndex; index += 1) {
    const close = bars[index].close;
    if (pool.side === "buy-side" && close > pool.price + maxDrift) return undefined;
    if (pool.side === "sell-side" && close < pool.price - maxDrift) return undefined;
  }
  return confirmationIndex;
}

function eventsForPool(
  pool: LiquidityPool,
  bars: readonly CleanBar[],
  tolerance: number,
): LiquidityEvent[] {
  const events: LiquidityEvent[] = [];
  const end = Math.min(bars.length - 1, pool.validUntilIndex ?? bars.length - 1);
  let armed = false;
  let awayCount = 0;
  let acceptanceCount = 0;

  for (let index = Math.max(0, pool.establishedIndex + 1); index <= end; index += 1) {
    const atr = averageTrueRange(bars, index);
    const bar = bars[index];

    if (acceptedBeyondLevel(bar, pool, atr, tolerance)) {
      acceptanceCount += 1;
      if (acceptanceCount >= 2) {
        // Two closes accepting beyond the level means the liquidity was broken,
        // not swept. Stop using this old level until structure gives us a new one.
        break;
      }
    } else {
      acceptanceCount = 0;
    }

    if (!armed) {
      if (awayFromLevel(bar, pool, atr, tolerance)) {
        awayCount += 1;
        if (awayCount >= ARM_AWAY_BARS) armed = true;
      } else {
        awayCount = 0;
      }
      continue;
    }

    if (!strictWickSweep(bar, pool, atr, tolerance)) continue;

    const confirmationBarIndex = reclaimHeld(
      bars,
      pool,
      index,
      atr,
      tolerance,
    );
    if (confirmationBarIndex == null) continue;

    events.push({
      type: "sweep",
      side: pool.side,
      direction: pool.side === "sell-side" ? "bullish" : "bearish",
      price: pool.price,
      touches: pool.touches,
      barIndex: index,
      confirmationBarIndex,
      reclaimed: true,
      source: pool.source,
    });

    // A level can be swept again later, but only after price first leaves the
    // level meaningfully and then comes back. This prevents repeated labels in
    // the same chop/consolidation.
    armed = false;
    awayCount = 0;
    acceptanceCount = 0;
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

  const tolerance = levelTolerance(bars);
  const repeatedPools = buildMajorRepeatedPools(bars, tolerance);
  const rawPools: LiquidityPool[] = [...repeatedPools];
  addStructurePools(rawPools, structure, bars.length - 1);

  // IMPORTANT: demand/supply zones are no longer added as standalone sweep
  // anchors. A valid LS must sweep confirmed HH/LL structure or a major
  // repeated liquidity pool. Zone context can still be consumed elsewhere.
  const pools = deduplicatePools(rawPools, tolerance);

  const sweepEvents = pools
    .flatMap((pool) => eventsForPool(pool, bars, tolerance))
    .sort((left, right) => left.barIndex - right.barIndex);

  // If the same candle swept overlapping structure + repeated pools, keep the
  // structure event and emit only one chart label.
  const deduplicated = new Map<string, LiquidityEvent>();
  for (const event of sweepEvents) {
    const key = `${event.side}:${event.barIndex}`;
    const existing = deduplicated.get(key);
    if (!existing || (event.source === "structure" && existing.source !== "structure")) {
      deduplicated.set(key, event);
    }
  }
  const finalSweepEvents = [...deduplicated.values()].sort(
    (left, right) => left.barIndex - right.barIndex,
  );

  const lastBarIndex = bars.length - 1;
  const recentCutoff = Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS + 1);
  const latestEvent = finalSweepEvents
    .filter((event) => (event.confirmationBarIndex ?? event.barIndex) >= recentCutoff)
    .sort(
      (left, right) =>
        (right.confirmationBarIndex ?? right.barIndex) -
        (left.confirmationBarIndex ?? left.barIndex),
    )[0];

  const currentPrice = bars[lastBarIndex].close;
  const currentPools = pools.filter(
    (pool) => (pool.validUntilIndex ?? lastBarIndex) >= lastBarIndex,
  );
  const nearestAbove = currentPools
    .filter((pool) => pool.price > currentPrice)
    .sort((left, right) => left.price - right.price)[0];
  const nearestBelow = currentPools
    .filter((pool) => pool.price < currentPrice)
    .sort((left, right) => right.price - left.price)[0];

  const strongestTouches = repeatedPools.reduce(
    (max, pool) => Math.max(max, pool.touches),
    0,
  );

  return {
    pools,
    sweepEvents: finalSweepEvents,
    latestEvent,
    nearestAbove,
    nearestBelow,
    equalHighs: repeatedPools.some((pool) => pool.side === "buy-side"),
    equalLows: repeatedPools.some((pool) => pool.side === "sell-side"),
    confidence: repeatedPools.length
      ? Math.min(0.95, 0.70 + Math.max(0, strongestTouches - 3) * 0.05)
      : 0.70,
  };
}
