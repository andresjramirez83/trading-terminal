import type { CleanBar } from "../ChartTypes";
import type { LiquidityEvent } from "./LiquiditySweepEngine";
import type {
  MarketStructurePoint,
  MarketStructureResult,
} from "./MarketStructureEngine";

export type SwingFailureDirection = "bullish" | "bearish";
export type SwingFailureGrade = "A" | "A+";
export type SwingFailureLevelType = "HH" | "LL";

export interface SwingFailurePattern {
  id: string;
  direction: SwingFailureDirection;
  levelType: SwingFailureLevelType;
  levelPrice: number;
  swingIndex: number;
  barIndex: number;
  confirmationBarIndex: number;
  confidence: number;
  grade: SwingFailureGrade;
  structureConfidence: number;
  penetrationAtr: number;
  wickFraction: number;
  reclaimAtr: number;
  closeLocation: number;
  confirmationStrength: number;
  volumeRatio: number;
}

/**
 * Smart SFP filter.
 *
 * The LiquiditySweepEngine already does the first, important layer of work:
 * - the level must be a confirmed HH/LL (or a major repeated pool),
 * - price must move away before the level can arm,
 * - the candle must wick through the level and close back inside,
 * - the reclaim must survive the following candle.
 *
 * This engine intentionally accepts ONLY structure-sourced sweeps and then
 * applies a second quality layer. That makes an SFP a high-quality subset of
 * liquidity sweeps instead of another independent pivot detector.
 *
 * Reliability is preferred over speed: a pattern is not emitted until the
 * next candle confirms the reclaim.
 */

const MIN_SFP_CONFIDENCE = 84;
const A_PLUS_CONFIDENCE = 92;

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

function averageTrueRange(
  bars: readonly CleanBar[],
  endIndex: number,
  length = 14,
): number {
  if (!bars.length) return 0;
  const safeEnd = clamp(endIndex, 0, bars.length - 1);
  const start = Math.max(0, safeEnd - length + 1);
  let total = 0;
  let count = 0;

  for (let index = start; index <= safeEnd; index += 1) {
    total += trueRange(bars[index], index > 0 ? bars[index - 1] : undefined);
    count += 1;
  }

  return count > 0 ? total / count : 0;
}

function averageVolume(
  bars: readonly CleanBar[],
  endExclusive: number,
  length = 20,
): number {
  const start = Math.max(0, endExclusive - length);
  let total = 0;
  let count = 0;

  for (let index = start; index < endExclusive; index += 1) {
    const volume = Number(bars[index]?.volume ?? 0);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    total += volume;
    count += 1;
  }

  return count > 0 ? total / count : 0;
}

function idealCloseLocation(
  bar: CleanBar,
  direction: SwingFailureDirection,
): number {
  const range = Math.max(bar.high - bar.low, 0.000001);
  return direction === "bullish"
    ? clamp((bar.close - bar.low) / range, 0, 1)
    : clamp((bar.high - bar.close) / range, 0, 1);
}

function matchingStructurePoint(
  event: LiquidityEvent,
  structure: MarketStructureResult,
  atr: number,
): MarketStructurePoint | undefined {
  const wantedType: SwingFailureLevelType =
    event.side === "buy-side" ? "HH" : "LL";
  const tolerance = Math.max(
    Math.abs(event.price) * 0.0005,
    atr * 0.10,
    0.0001,
  );

  return structure.points
    .filter(
      (point) =>
        point.type === wantedType &&
        point.confirmationIndex < event.barIndex &&
        Math.abs(point.price - event.price) <= tolerance,
    )
    .sort((left, right) => right.confirmationIndex - left.confirmationIndex)[0];
}

function normalizedLinearScore(
  value: number,
  weak: number,
  strong: number,
): number {
  if (strong <= weak) return value >= strong ? 100 : 0;
  return clamp(((value - weak) / (strong - weak)) * 45 + 55, 0, 100);
}

function buildPattern(
  bars: readonly CleanBar[],
  structure: MarketStructureResult,
  event: LiquidityEvent,
): SwingFailurePattern | null {
  if (event.source !== "structure" || event.confirmationBarIndex == null) {
    return null;
  }

  const sweepBar = bars[event.barIndex];
  const confirmationBar = bars[event.confirmationBarIndex];
  if (!sweepBar || !confirmationBar) return null;

  const atr = Math.max(
    averageTrueRange(bars, Math.max(0, event.barIndex - 1), 14),
    averageTrueRange(bars, event.barIndex, 14),
    0.000001,
  );

  const structurePoint = matchingStructurePoint(event, structure, atr);
  if (!structurePoint) return null;

  const direction: SwingFailureDirection =
    event.side === "sell-side" ? "bullish" : "bearish";
  const levelType: SwingFailureLevelType =
    direction === "bullish" ? "LL" : "HH";

  const range = sweepBar.high - sweepBar.low;
  if (!(range > 0)) return null;

  const bodyHigh = Math.max(sweepBar.open, sweepBar.close);
  const bodyLow = Math.min(sweepBar.open, sweepBar.close);
  const wick = direction === "bullish"
    ? Math.max(0, bodyLow - sweepBar.low)
    : Math.max(0, sweepBar.high - bodyHigh);
  const wickFraction = wick / range;

  const penetration = direction === "bullish"
    ? event.price - sweepBar.low
    : sweepBar.high - event.price;
  const penetrationAtr = Math.max(0, penetration / atr);

  const reclaim = direction === "bullish"
    ? sweepBar.close - event.price
    : event.price - sweepBar.close;
  const reclaimAtr = reclaim / atr;
  const closeLocation = idealCloseLocation(sweepBar, direction);
  const confirmationCloseLocation = idealCloseLocation(confirmationBar, direction);

  const confirmationMoveAtr = direction === "bullish"
    ? (confirmationBar.close - sweepBar.close) / atr
    : (sweepBar.close - confirmationBar.close) / atr;
  const confirmationStrength = clamp(
    confirmationCloseLocation * 0.65 +
      clamp((confirmationMoveAtr + 0.08) / 0.38, 0, 1) * 0.35,
    0,
    1,
  );

  const baselineVolume = averageVolume(bars, event.barIndex, 20);
  const sweepVolume = Number(sweepBar.volume ?? 0);
  const volumeRatio =
    baselineVolume > 0 && sweepVolume > 0
      ? sweepVolume / baselineVolume
      : 1;

  // Hard reliability gates. These deliberately remove marginal wick pokes,
  // weak closes and patterns that fail to stay reclaimed on confirmation.
  if (penetrationAtr < 0.07) return null;
  if (wickFraction < 0.32) return null;
  if (reclaimAtr < 0.04) return null;
  if (closeLocation < 0.55) return null;

  const confirmationHeld = direction === "bullish"
    ? confirmationBar.close >= event.price
    : confirmationBar.close <= event.price;
  if (!confirmationHeld) return null;

  // Extremely large sweep candles are usually event/news volatility. Require
  // a very strong close to keep one; otherwise skip it as unreliable noise.
  const rangeAtr = range / atr;
  if (rangeAtr > 4.5 && closeLocation < 0.78) return null;

  const structureScore = clamp(structurePoint.confidence, 0, 100);
  const wickScore = normalizedLinearScore(wickFraction, 0.32, 0.58);
  let penetrationScore = normalizedLinearScore(penetrationAtr, 0.07, 0.22);
  if (penetrationAtr > 1.0) penetrationScore *= 0.82;
  const reclaimScore = normalizedLinearScore(reclaimAtr, 0.04, 0.20);
  const closeScore = normalizedLinearScore(closeLocation, 0.55, 0.82);
  const confirmationScore = normalizedLinearScore(
    confirmationStrength,
    0.52,
    0.82,
  );
  const volumeScore = baselineVolume > 0
    ? normalizedLinearScore(volumeRatio, 0.70, 1.55)
    : 72;

  const confidence = Math.round(
    clamp(
      structureScore * 0.18 +
        wickScore * 0.18 +
        penetrationScore * 0.12 +
        reclaimScore * 0.18 +
        closeScore * 0.14 +
        confirmationScore * 0.14 +
        volumeScore * 0.06,
      0,
      100,
    ),
  );

  if (confidence < MIN_SFP_CONFIDENCE) return null;

  return {
    id: `sfp:${direction}:${structurePoint.id}:${event.barIndex}`,
    direction,
    levelType,
    levelPrice: event.price,
    swingIndex: structurePoint.index,
    barIndex: event.barIndex,
    confirmationBarIndex: event.confirmationBarIndex,
    confidence,
    grade: confidence >= A_PLUS_CONFIDENCE ? "A+" : "A",
    structureConfidence: Math.round(structureScore),
    penetrationAtr: Number(penetrationAtr.toFixed(2)),
    wickFraction: Number(wickFraction.toFixed(2)),
    reclaimAtr: Number(reclaimAtr.toFixed(2)),
    closeLocation: Number(closeLocation.toFixed(2)),
    confirmationStrength: Number(confirmationStrength.toFixed(2)),
    volumeRatio: Number(volumeRatio.toFixed(2)),
  };
}

export function buildSmartSwingFailures(
  bars: readonly CleanBar[],
  structure: MarketStructureResult,
  liquidityEvents: readonly LiquidityEvent[],
): SwingFailurePattern[] {
  const patterns: SwingFailurePattern[] = [];

  for (const event of liquidityEvents) {
    const pattern = buildPattern(bars, structure, event);
    if (pattern) patterns.push(pattern);
  }

  // One confirmed swing can be tested more than once, but keep the chart from
  // duplicating the same event if overlapping structure data resolves to the
  // same sweep candle.
  const deduplicated = new Map<string, SwingFailurePattern>();
  for (const pattern of patterns) {
    const key = `${pattern.direction}:${pattern.barIndex}`;
    const existing = deduplicated.get(key);
    if (!existing || pattern.confidence > existing.confidence) {
      deduplicated.set(key, pattern);
    }
  }

  return [...deduplicated.values()]
    .sort((left, right) => left.barIndex - right.barIndex)
    .slice(-80);
}
