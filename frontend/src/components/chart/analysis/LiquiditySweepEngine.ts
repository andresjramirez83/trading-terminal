import type { CleanBar } from "../ChartTypes";

export type LiquiditySide = "buy-side" | "sell-side";
export type LiquidityEventType = "sweep" | "break";

export interface LiquidityPool {
  side: LiquiditySide;
  price: number;
  touches: number;
  firstTouchIndex: number;
  lastTouchIndex: number;
  establishedIndex: number;
  source: "repeated-touch" | "structure";
}

export interface LiquidityEvent {
  type: LiquidityEventType;
  side: LiquiditySide;
  direction: "bullish" | "bearish";
  price: number;
  touches: number;
  /** Bar where the actual sweep extreme happened. */
  barIndex: number;
  /** Bar where the return/hold was confirmed. */
  confirmationBarIndex?: number;
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
const HOLD_CONFIRM_BARS = 2;

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

    // Lightweight Charts time values are normally epoch seconds here.
    const minutes = Math.abs(current - previous) / 60;
    if (minutes > 0 && minutes <= 1440) samples.push(minutes);
  }

  if (samples.length === 0) return 5;
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 5;
}

function reclaimWindowBars(bars: readonly CleanBar[]): number {
  // Give a 5-minute chart roughly 90 minutes to return to the swept support/
  // resistance, while keeping very fast and slow timeframes bounded.
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
      // Keep the true outside edge of the support/resistance cluster so a
      // sweep must actually take liquidity beyond the protected area.
      matching.price =
        matching.side === "buy-side"
          ? Math.max(matching.price, candidate.price)
          : Math.min(matching.price, candidate.price);
      matching.touches += 1;
      matching.lastTouchIndex = candidate.index;
      if (matching.touches === MIN_TOUCHES) {
        matching.establishedIndex = candidate.index;
      }
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

  const establishedIndex = Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS);
  pools.push({
    side,
    price,
    touches: 1,
    firstTouchIndex: establishedIndex,
    lastTouchIndex: establishedIndex,
    establishedIndex,
    source: "structure",
  });
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

  const minimumAbsoluteWick = Math.max(tolerance, atr * 0.12);

  return (
    wick >= minimumAbsoluteWick &&
    wick / range >= 0.4 &&
    wick >= Math.max(body * 1.2, tolerance)
  );
}

function returnedNearPool(
  bar: CleanBar,
  pool: LiquidityPool,
  returnTolerance: number,
): boolean {
  return pool.side === "sell-side"
    ? bar.close >= pool.price - returnTolerance
    : bar.close <= pool.price + returnTolerance;
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
    if (
      (pool.side === "sell-side" && close < pool.price - holdTolerance) ||
      (pool.side === "buy-side" && close > pool.price + holdTolerance)
    ) {
      return undefined;
    }
  }

  return confirmationIndex;
}

function eventsForPool(
  pool: LiquidityPool,
  bars: readonly CleanBar[],
  lastBarIndex: number,
  tolerance: number,
  atr: number,
): LiquidityEvent[] {
  const events: LiquidityEvent[] = [];
  const minimumPenetration = Math.max(tolerance, atr * 0.08);
  const returnTolerance = Math.max(tolerance * 1.5, atr * 0.25);
  const holdTolerance = Math.max(tolerance * 2, atr * 0.35);
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
        (pool.side === "sell-side" &&
          current.low < bars[extremeIndex].low) ||
        (pool.side === "buy-side" &&
          current.high > bars[extremeIndex].high)
      ) {
        extremeIndex = cursor;
      }

      if (!returnedNearPool(current, pool, returnTolerance)) continue;

      // A one-candle sweep is valid only when the wick itself is obvious.
      // Multi-candle sweeps do not need a giant wick; the reclaim back to the
      // prior support/resistance and subsequent hold is the confirmation.
      if (
        cursor === excursionStart &&
        !significantRejectionWick(current, pool.side, tolerance, atr)
      ) {
        continue;
      }

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

      // The same support/resistance can produce another later sweep after the
      // first reclaim has held. Resume scanning after the hold confirmation.
      index = confirmationBarIndex + 1;
      confirmedSweep = true;
      break;
    }

    if (confirmedSweep) continue;

    // Do not call a fresh penetration a break immediately. Give price the
    // reclaim window first. If the window completes with no return/hold, then
    // the level was accepted through rather than swept.
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

    // Current data ends before the reclaim window is complete. Leave this as
    // an unconfirmed candidate instead of printing a false LS/break.
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

  const allEvents = pools.flatMap((pool) =>
    eventsForPool(pool, bars, lastBarIndex, tolerance, atr),
  );

  const eventStart = Math.max(0, lastBarIndex - EVENT_PERSISTENCE_BARS + 1);
  const latestEvent = allEvents
    .filter(
      (event) =>
        (event.confirmationBarIndex ?? event.barIndex) >= eventStart,
    )
    .sort(
      (left, right) =>
        (right.confirmationBarIndex ?? right.barIndex) -
        (left.confirmationBarIndex ?? left.barIndex),
    )[0];

  // Nearby pools can describe the same liquidity move. Keep only the strongest
  // LS for each actual sweep candle and side while still allowing a later,
  // separate sweep of the same support/resistance.
  const deduplicatedSweeps = new Map<string, LiquidityEvent>();
  for (const event of allEvents) {
    if (event.type !== "sweep") continue;
    const key = `${event.barIndex}:${event.side}`;
    const existing = deduplicatedSweeps.get(key);
    if (
      !existing ||
      event.touches > existing.touches ||
      (event.touches === existing.touches &&
        event.source === "structure" &&
        existing.source !== "structure")
    ) {
      deduplicatedSweeps.set(key, event);
    }
  }

  const sweepEvents = [...deduplicatedSweeps.values()];
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
