import type { CleanBar } from "../ChartTypes";
import type { LiquidityEvent } from "./LiquiditySweepEngine";
import type {
  MarketStructurePoint,
  MarketStructureResult,
} from "./MarketStructureEngine";

export type SwingFailureDirection = "bullish" | "bearish";
export type SwingFailureGrade = "A" | "A+";
export type SwingFailureLevelType =
  | "HH"
  | "LL"
  | "Internal High"
  | "Internal Low";
export type SwingFailureAnchorSource = "structure" | "internal";

export interface SwingFailurePattern {
  id: string;
  direction: SwingFailureDirection;
  levelType: SwingFailureLevelType;
  anchorSource: SwingFailureAnchorSource;
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
  touches: number;
}

/**
 * Smart Swing Failure Patterns
 * ----------------------------
 *
 * There are deliberately TWO anchor layers:
 *
 * 1) Confirmed market structure HH / LL.
 *    These remain the primary, highest-priority anchors and are supplied by
 *    LiquiditySweepEngine exactly as before. This file does not alter market
 *    structure rules or relabel internal pivots as HH/LL.
 *
 * 2) Invisible internal swing highs / lows.
 *    These fill the timing gap that exists before a new structural HH/LL can
 *    be confirmed. They exist only inside this engine. Nothing is drawn for
 *    them; the chart still shows only real HH/HL/LH/LL plus qualified SFPs.
 *
 * Reliability is preferred over speed. Internal anchors must be confirmed,
 * show meaningful displacement away, survive acceptance/invalidation checks,
 * and then pass the same wick/reclaim/next-candle quality filter as structure
 * SFPs. Structure always wins a same-candle conflict.
 */

const STRUCTURE_MIN_CONFIDENCE = 84;
const INTERNAL_MIN_CONFIDENCE = 86;
const A_PLUS_CONFIDENCE = 92;

const INTERNAL_PIVOT_STRENGTH = 2;
const INTERNAL_MIN_SEPARATION_BARS = 4;
const INTERNAL_ARM_LOOKAHEAD_BARS = 12;
const INTERNAL_MAX_AGE_BARS = 180;
const INTERNAL_ACCEPTANCE_CLOSES = 2;
const INTERNAL_CONFIRMATION_WINDOW_BARS = 2;
const INTERNAL_MIN_LIFETIME_BARS = 5;
const INTERNAL_MIN_AWAY_BARS = 2;
const INTERNAL_MIN_SWEEP_RANGE_ATR = 0.55;
const INTERNAL_MULTI_TOUCH_MIN_EXCURSION_ATR = 0.62;
const INTERNAL_SINGLE_TOUCH_MIN_EXCURSION_ATR = 0.92;

// Internal SFPs support both a classic same-candle reclaim and a controlled
// failed-breakdown / failed-breakout reclaim on candle 1 or 2. The sweep
// candle may close slightly through the level, but not far enough to show
// sustained acceptance.
const INTERNAL_MAX_SWEEP_CLOSE_BEYOND_ATR = 0.38;
const INTERNAL_TEMPORARY_ACCEPTANCE_ATR = 0.24;
const INTERNAL_DELAYED_RECLAIM_TARGET_ATR = 0.08;
const INTERNAL_DELAYED_CONFIRM_MIN_RANGE_ATR = 0.45;
const INTERNAL_DELAYED_CONFIRM_MIN_BODY_FRACTION = 0.34;

interface InternalAnchor {
  id: string;
  direction: SwingFailureDirection;
  price: number;
  swingIndex: number;
  establishedIndex: number;
  quality: number;
  displacementAtr: number;
}

interface PatternInputs {
  direction: SwingFailureDirection;
  levelType: SwingFailureLevelType;
  anchorSource: SwingFailureAnchorSource;
  levelPrice: number;
  swingIndex: number;
  barIndex: number;
  confirmationBarIndex: number;
  anchorQuality: number;
  touches: number;
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

function normalizedLinearScore(
  value: number,
  weak: number,
  strong: number,
): number {
  if (strong <= weak) return value >= strong ? 100 : 0;
  return clamp(((value - weak) / (strong - weak)) * 45 + 55, 0, 100);
}

function levelTolerance(price: number, atr: number): number {
  return Math.max(Math.abs(price) * 0.0005, atr * 0.10, 0.0001);
}

function isInternalPivotHigh(
  bars: readonly CleanBar[],
  index: number,
  strength: number,
): boolean {
  const high = bars[index]?.high;
  if (!Number.isFinite(high)) return false;

  for (let offset = 1; offset <= strength; offset += 1) {
    const left = bars[index - offset];
    const right = bars[index + offset];
    if (!left || !right) return false;
    if (left.high >= high || right.high > high) return false;
  }
  return true;
}

function isInternalPivotLow(
  bars: readonly CleanBar[],
  index: number,
  strength: number,
): boolean {
  const low = bars[index]?.low;
  if (!Number.isFinite(low)) return false;

  for (let offset = 1; offset <= strength; offset += 1) {
    const left = bars[index - offset];
    const right = bars[index + offset];
    if (!left || !right) return false;
    if (left.low <= low || right.low < low) return false;
  }
  return true;
}

function overlapsConfirmedStructure(
  structure: MarketStructureResult,
  direction: SwingFailureDirection,
  price: number,
  pivotIndex: number,
  confirmedByIndex: number,
  atr: number,
): boolean {
  const wantedType = direction === "bullish" ? "LL" : "HH";
  const tolerance = Math.max(levelTolerance(price, atr), atr * 0.14);

  // Never let a structure point that was confirmed later in the chart erase
  // an internal level that was genuinely available in real time. This avoids
  // hindsight/look-ahead suppression of valid SFP anchors.
  return structure.points.some(
    (point) =>
      point.type === wantedType &&
      point.index <= pivotIndex + INTERNAL_PIVOT_STRENGTH &&
      point.confirmationIndex <= confirmedByIndex &&
      Math.abs(point.price - price) <= tolerance,
  );
}

function findInternalArmedIndex(
  bars: readonly CleanBar[],
  pivotIndex: number,
  direction: SwingFailureDirection,
  levelPrice: number,
  atr: number,
): { index: number; displacementAtr: number } | null {
  const confirmationIndex = pivotIndex + INTERNAL_PIVOT_STRENGTH;
  const end = Math.min(
    bars.length - 2,
    confirmationIndex + INTERNAL_ARM_LOOKAHEAD_BARS,
  );
  const minDistance = Math.max(atr * 0.34, Math.abs(levelPrice) * 0.0012);

  let bestDistance = 0;
  for (let index = confirmationIndex; index <= end; index += 1) {
    const bar = bars[index];
    const distance = direction === "bullish"
      ? Math.max(bar.high, bar.close) - levelPrice
      : levelPrice - Math.min(bar.low, bar.close);
    bestDistance = Math.max(bestDistance, distance);

    if (distance >= minDistance) {
      return {
        index,
        displacementAtr: bestDistance / Math.max(atr, 0.000001),
      };
    }
  }

  return null;
}

function internalPivotQuality(
  bars: readonly CleanBar[],
  pivotIndex: number,
  direction: SwingFailureDirection,
  displacementAtr: number,
  atr: number,
): number {
  const bar = bars[pivotIndex];
  const strength = INTERNAL_PIVOT_STRENGTH;
  const leftStart = Math.max(0, pivotIndex - strength - 2);
  const rightEnd = Math.min(bars.length - 1, pivotIndex + strength + 2);

  let prominence = 0;
  if (direction === "bullish") {
    let surroundingHigh = bar.high;
    for (let index = leftStart; index <= rightEnd; index += 1) {
      if (index === pivotIndex) continue;
      surroundingHigh = Math.max(surroundingHigh, bars[index].high);
    }
    prominence = (surroundingHigh - bar.low) / Math.max(atr, 0.000001);
  } else {
    let surroundingLow = bar.low;
    for (let index = leftStart; index <= rightEnd; index += 1) {
      if (index === pivotIndex) continue;
      surroundingLow = Math.min(surroundingLow, bars[index].low);
    }
    prominence = (bar.high - surroundingLow) / Math.max(atr, 0.000001);
  }

  const displacementScore = normalizedLinearScore(displacementAtr, 0.34, 1.05);
  const prominenceScore = normalizedLinearScore(prominence, 0.45, 1.40);

  return clamp(displacementScore * 0.62 + prominenceScore * 0.38, 0, 100);
}

function buildQualifiedInternalAnchors(
  bars: readonly CleanBar[],
  structure: MarketStructureResult,
): InternalAnchor[] {
  if (bars.length < INTERNAL_PIVOT_STRENGTH * 2 + 8) return [];

  const anchors: InternalAnchor[] = [];
  let lastHighIndex = -Infinity;
  let lastLowIndex = -Infinity;

  for (
    let index = INTERNAL_PIVOT_STRENGTH;
    index < bars.length - INTERNAL_PIVOT_STRENGTH - 1;
    index += 1
  ) {
    const atr = Math.max(averageTrueRange(bars, index, 14), 0.000001);

    if (
      isInternalPivotHigh(bars, index, INTERNAL_PIVOT_STRENGTH) &&
      index - lastHighIndex >= INTERNAL_MIN_SEPARATION_BARS
    ) {
      lastHighIndex = index;
      const price = bars[index].high;
      if (!overlapsConfirmedStructure(
          structure,
          "bearish",
          price,
          index,
          index + INTERNAL_PIVOT_STRENGTH,
          atr,
        )) {
        const armed = findInternalArmedIndex(
          bars,
          index,
          "bearish",
          price,
          atr,
        );
        if (armed) {
          const quality = internalPivotQuality(
            bars,
            index,
            "bearish",
            armed.displacementAtr,
            atr,
          );
          if (quality >= 66) {
            anchors.push({
              id: `internal-high:${index}:${price.toFixed(6)}`,
              direction: "bearish",
              price,
              swingIndex: index,
              establishedIndex: armed.index,
              quality,
              displacementAtr: armed.displacementAtr,
            });
          }
        }
      }
    }

    if (
      isInternalPivotLow(bars, index, INTERNAL_PIVOT_STRENGTH) &&
      index - lastLowIndex >= INTERNAL_MIN_SEPARATION_BARS
    ) {
      lastLowIndex = index;
      const price = bars[index].low;
      if (!overlapsConfirmedStructure(
          structure,
          "bullish",
          price,
          index,
          index + INTERNAL_PIVOT_STRENGTH,
          atr,
        )) {
        const armed = findInternalArmedIndex(
          bars,
          index,
          "bullish",
          price,
          atr,
        );
        if (armed) {
          const quality = internalPivotQuality(
            bars,
            index,
            "bullish",
            armed.displacementAtr,
            atr,
          );
          if (quality >= 66) {
            anchors.push({
              id: `internal-low:${index}:${price.toFixed(6)}`,
              direction: "bullish",
              price,
              swingIndex: index,
              establishedIndex: armed.index,
              quality,
              displacementAtr: armed.displacementAtr,
            });
          }
        }
      }
    }
  }

  return anchors;
}

function matchingStructurePoint(
  event: LiquidityEvent,
  structure: MarketStructureResult,
  atr: number,
): MarketStructurePoint | undefined {
  const wantedType = event.side === "buy-side" ? "HH" : "LL";
  const tolerance = levelTolerance(event.price, atr);

  return structure.points
    .filter(
      (point) =>
        point.type === wantedType &&
        point.confirmationIndex < event.barIndex &&
        Math.abs(point.price - event.price) <= tolerance,
    )
    .sort((left, right) => right.confirmationIndex - left.confirmationIndex)[0];
}

function priorInternalTouches(
  anchors: readonly InternalAnchor[],
  anchor: InternalAnchor,
  sweepIndex: number,
  atr: number,
): number {
  const tolerance = Math.max(levelTolerance(anchor.price, atr), atr * 0.12);
  const nearby = anchors.filter(
    (candidate) =>
      candidate.direction === anchor.direction &&
      candidate.swingIndex <= sweepIndex &&
      candidate.establishedIndex < sweepIndex &&
      Math.abs(candidate.price - anchor.price) <= tolerance,
  );

  const separated: number[] = [];
  for (const candidate of nearby.sort((a, b) => a.swingIndex - b.swingIndex)) {
    const last = separated.at(-1);
    if (last == null || candidate.swingIndex - last >= INTERNAL_MIN_SEPARATION_BARS) {
      separated.push(candidate.swingIndex);
    }
  }

  return Math.max(1, separated.length);
}

function internalAnchorStillValid(
  bars: readonly CleanBar[],
  anchor: InternalAnchor,
  endIndex: number,
): boolean {
  let acceptanceCount = 0;

  for (let index = anchor.establishedIndex + 1; index <= endIndex; index += 1) {
    const atr = Math.max(averageTrueRange(bars, index, 14), 0.000001);
    const buffer = Math.max(levelTolerance(anchor.price, atr), atr * 0.12);
    const close = bars[index].close;
    const acceptedBeyond = anchor.direction === "bullish"
      ? close <= anchor.price - buffer
      : close >= anchor.price + buffer;

    if (acceptedBeyond) {
      acceptanceCount += 1;
      if (acceptanceCount >= INTERNAL_ACCEPTANCE_CLOSES) return false;
    } else {
      acceptanceCount = 0;
    }
  }

  return true;
}

function internalSweepCandidate(
  bars: readonly CleanBar[],
  anchor: InternalAnchor,
  barIndex: number,
): boolean {
  const bar = bars[barIndex];
  const atr = Math.max(averageTrueRange(bars, barIndex, 14), 0.000001);
  const tolerance = levelTolerance(anchor.price, atr);
  const minPenetration = Math.max(tolerance, atr * 0.08);
  const maxCloseBeyond = Math.max(
    tolerance * 1.5,
    atr * INTERNAL_MAX_SWEEP_CLOSE_BEYOND_ATR,
  );

  // Do NOT require the sweep candle itself to reclaim the level. A legitimate
  // failed breakdown / breakout can close slightly through the level and then
  // reclaim it decisively on candle 1 or 2. We only reject a sweep candle that
  // already closes too far through the level, which is more consistent with
  // acceptance than a liquidity grab.
  if (anchor.direction === "bullish") {
    return (
      bar.low <= anchor.price - minPenetration &&
      bar.close >= anchor.price - maxCloseBeyond
    );
  }

  return (
    bar.high >= anchor.price + minPenetration &&
    bar.close <= anchor.price + maxCloseBeyond
  );
}

interface InternalSweepContext {
  ageBars: number;
  maxExcursionAtr: number;
  awayBars: number;
  sweepRangeAtr: number;
}

function internalSweepContext(
  bars: readonly CleanBar[],
  anchor: InternalAnchor,
  sweepIndex: number,
): InternalSweepContext {
  const atr = Math.max(
    averageTrueRange(bars, Math.max(0, sweepIndex - 1), 14),
    averageTrueRange(bars, sweepIndex, 14),
    0.000001,
  );
  const awayThreshold = atr * 0.35;
  let maxExcursion = 0;
  let awayBars = 0;

  for (
    let index = anchor.establishedIndex;
    index < sweepIndex;
    index += 1
  ) {
    const bar = bars[index];
    const distance = anchor.direction === "bullish"
      ? Math.max(bar.high, bar.close) - anchor.price
      : anchor.price - Math.min(bar.low, bar.close);

    maxExcursion = Math.max(maxExcursion, distance);
    if (distance >= awayThreshold) awayBars += 1;
  }

  const sweepBar = bars[sweepIndex];
  return {
    ageBars: Math.max(0, sweepIndex - anchor.establishedIndex),
    maxExcursionAtr: maxExcursion / atr,
    awayBars,
    sweepRangeAtr: Math.max(0, sweepBar.high - sweepBar.low) / atr,
  };
}

function internalContextIsMeaningful(
  context: InternalSweepContext,
  touches: number,
): boolean {
  if (context.ageBars < INTERNAL_MIN_LIFETIME_BARS) return false;
  if (context.awayBars < INTERNAL_MIN_AWAY_BARS) return false;
  if (context.sweepRangeAtr < INTERNAL_MIN_SWEEP_RANGE_ATR) return false;

  const requiredExcursion = touches >= 2
    ? INTERNAL_MULTI_TOUCH_MIN_EXCURSION_ATR
    : INTERNAL_SINGLE_TOUCH_MIN_EXCURSION_ATR;

  return context.maxExcursionAtr >= requiredExcursion;
}

function confirmationHeld(
  bars: readonly CleanBar[],
  direction: SwingFailureDirection,
  levelPrice: number,
  sweepIndex: number,
): number | undefined {
  const sweepBar = bars[sweepIndex];
  if (!sweepBar) return undefined;

  const atr = Math.max(
    averageTrueRange(bars, Math.max(0, sweepIndex - 1), 14),
    averageTrueRange(bars, sweepIndex, 14),
    0.000001,
  );
  const tolerance = levelTolerance(levelPrice, atr);
  const temporaryAcceptanceBuffer = Math.max(
    tolerance,
    atr * INTERNAL_TEMPORARY_ACCEPTANCE_ATR,
  );
  const hardAcceptanceBuffer = Math.max(
    tolerance * 1.5,
    atr * INTERNAL_MAX_SWEEP_CLOSE_BEYOND_ATR,
  );
  const directionalTarget = atr * INTERNAL_DELAYED_RECLAIM_TARGET_ATR;
  const sweepMidpoint = (sweepBar.high + sweepBar.low) / 2;

  for (
    let offset = 1;
    offset <= INTERNAL_CONFIRMATION_WINDOW_BARS;
    offset += 1
  ) {
    const index = sweepIndex + offset;
    if (index >= bars.length) break;
    const bar = bars[index];

    const closeBeyond = direction === "bullish"
      ? levelPrice - bar.close
      : bar.close - levelPrice;

    // One temporary close slightly beyond the swept level is allowed. A deep
    // close through the level, or a second close still accepting beyond it,
    // is treated as a real break rather than an SFP.
    if (closeBeyond > hardAcceptanceBuffer) return undefined;
    if (closeBeyond > temporaryAcceptanceBuffer) return undefined;
    if (offset === INTERNAL_CONFIRMATION_WINDOW_BARS && closeBeyond > 0) {
      return undefined;
    }

    const range = Math.max(bar.high - bar.low, 0.000001);
    const body = Math.abs(bar.close - bar.open);
    const bodyFraction = body / range;
    const rangeAtr = range / atr;
    const directionalBody = direction === "bullish"
      ? bar.close > bar.open
      : bar.close < bar.open;
    const directionalClose = direction === "bullish"
      ? bar.close >= levelPrice + directionalTarget
      : bar.close <= levelPrice - directionalTarget;
    const regainedSweepBody = direction === "bullish"
      ? bar.close >= sweepMidpoint - atr * 0.03
      : bar.close <= sweepMidpoint + atr * 0.03;
    const meaningfulReclaimCandle =
      rangeAtr >= INTERNAL_DELAYED_CONFIRM_MIN_RANGE_ATR &&
      directionalBody &&
      bodyFraction >= INTERNAL_DELAYED_CONFIRM_MIN_BODY_FRACTION;

    if (directionalClose && regainedSweepBody && meaningfulReclaimCandle) {
      return index;
    }
  }

  return undefined;
}

function scorePattern(
  bars: readonly CleanBar[],
  inputs: PatternInputs,
): SwingFailurePattern | null {
  const sweepBar = bars[inputs.barIndex];
  const confirmationBar = bars[inputs.confirmationBarIndex];
  if (!sweepBar || !confirmationBar) return null;

  const atr = Math.max(
    averageTrueRange(bars, Math.max(0, inputs.barIndex - 1), 14),
    averageTrueRange(bars, inputs.barIndex, 14),
    0.000001,
  );

  const range = sweepBar.high - sweepBar.low;
  if (!(range > 0)) return null;

  const bodyHigh = Math.max(sweepBar.open, sweepBar.close);
  const bodyLow = Math.min(sweepBar.open, sweepBar.close);
  const wick = inputs.direction === "bullish"
    ? Math.max(0, bodyLow - sweepBar.low)
    : Math.max(0, sweepBar.high - bodyHigh);
  const wickFraction = wick / range;

  const penetration = inputs.direction === "bullish"
    ? inputs.levelPrice - sweepBar.low
    : sweepBar.high - inputs.levelPrice;
  const penetrationAtr = Math.max(0, penetration / atr);

  const reclaim = inputs.direction === "bullish"
    ? sweepBar.close - inputs.levelPrice
    : inputs.levelPrice - sweepBar.close;
  const reclaimAtr = reclaim / atr;
  const closeLocation = idealCloseLocation(sweepBar, inputs.direction);
  const confirmationCloseLocation = idealCloseLocation(
    confirmationBar,
    inputs.direction,
  );
  const confirmationReclaimAtr = inputs.direction === "bullish"
    ? (confirmationBar.close - inputs.levelPrice) / atr
    : (inputs.levelPrice - confirmationBar.close) / atr;
  const confirmationRange = Math.max(
    confirmationBar.high - confirmationBar.low,
    0.000001,
  );
  const confirmationRangeAtr = confirmationRange / atr;
  const confirmationBodyFraction =
    Math.abs(confirmationBar.close - confirmationBar.open) / confirmationRange;
  const confirmationDirectionalBody = inputs.direction === "bullish"
    ? confirmationBar.close > confirmationBar.open
    : confirmationBar.close < confirmationBar.open;

  const confirmationMoveAtr = inputs.direction === "bullish"
    ? (confirmationBar.close - sweepBar.close) / atr
    : (sweepBar.close - confirmationBar.close) / atr;
  const confirmationStrength = clamp(
    confirmationCloseLocation * 0.65 +
      clamp((confirmationMoveAtr + 0.08) / 0.38, 0, 1) * 0.35,
    0,
    1,
  );

  const baselineVolume = averageVolume(bars, inputs.barIndex, 20);
  const sweepVolume = Number(sweepBar.volume ?? 0);
  const volumeRatio = baselineVolume > 0 && sweepVolume > 0
    ? sweepVolume / baselineVolume
    : 1;

  const internal = inputs.anchorSource === "internal";
  const minPenetration = 0.07;
  const minWickFraction = internal ? 0.26 : 0.32;
  const minReclaim = internal ? 0.02 : 0.04;
  const minCloseLocation = internal ? 0.46 : 0.55;
  const delayedInternalReclaim = internal && reclaimAtr < minReclaim;

  if (penetrationAtr < minPenetration) return null;

  if (delayedInternalReclaim) {
    // Failed-breakdown / failed-breakout SFP: the sweep candle is allowed to
    // close slightly through the level, but the following candle(s) must do
    // the real reclaim with directional body and displacement.
    if (reclaimAtr < -INTERNAL_MAX_SWEEP_CLOSE_BEYOND_ATR) return null;
    if (wickFraction < 0.08) return null;
    if (confirmationReclaimAtr < INTERNAL_DELAYED_RECLAIM_TARGET_ATR) return null;
    if (confirmationCloseLocation < 0.58) return null;
    if (confirmationRangeAtr < INTERNAL_DELAYED_CONFIRM_MIN_RANGE_ATR) return null;
    if (!confirmationDirectionalBody) return null;
    if (confirmationBodyFraction < INTERNAL_DELAYED_CONFIRM_MIN_BODY_FRACTION) {
      return null;
    }
  } else {
    if (wickFraction < minWickFraction) return null;
    if (reclaimAtr < minReclaim) return null;
    if (closeLocation < minCloseLocation) return null;
  }

  const held = inputs.direction === "bullish"
    ? confirmationBar.close >= inputs.levelPrice + atr * 0.02
    : confirmationBar.close <= inputs.levelPrice - atr * 0.02;
  if (!held) return null;

  const rangeAtr = range / atr;
  if (!delayedInternalReclaim && rangeAtr > 4.5 && closeLocation < 0.78) {
    return null;
  }

  const anchorScore = clamp(inputs.anchorQuality, 0, 100);
  const wickScore = delayedInternalReclaim
    ? normalizedLinearScore(wickFraction, 0.08, 0.36)
    : normalizedLinearScore(
        wickFraction,
        minWickFraction,
        internal ? 0.54 : 0.58,
      );
  let penetrationScore = normalizedLinearScore(
    penetrationAtr,
    minPenetration,
    0.22,
  );
  if (penetrationAtr > 1.0) penetrationScore *= 0.82;
  const reclaimScore = delayedInternalReclaim
    ? normalizedLinearScore(
        confirmationReclaimAtr,
        INTERNAL_DELAYED_RECLAIM_TARGET_ATR,
        0.28,
      )
    : normalizedLinearScore(reclaimAtr, minReclaim, 0.20);
  const closeScore = delayedInternalReclaim
    ? normalizedLinearScore(confirmationCloseLocation, 0.58, 0.86)
    : normalizedLinearScore(closeLocation, minCloseLocation, 0.82);
  const confirmationScore = normalizedLinearScore(
    confirmationStrength,
    delayedInternalReclaim ? 0.62 : internal ? 0.58 : 0.52,
    0.84,
  );
  const volumeScore = baselineVolume > 0
    ? normalizedLinearScore(volumeRatio, 0.70, 1.55)
    : 72;
  const touchScore = clamp(72 + Math.max(0, inputs.touches - 1) * 9, 72, 99);

  let confidence = Math.round(
    clamp(
      anchorScore * 0.18 +
        wickScore * 0.17 +
        penetrationScore * 0.11 +
        reclaimScore * 0.17 +
        closeScore * 0.13 +
        confirmationScore * 0.13 +
        volumeScore * 0.05 +
        touchScore * 0.06,
      0,
      100,
    ),
  );

  // A delayed reclaim is valid, but it carries a small uncertainty penalty
  // versus a classic same-candle SFP. Strong confirmation can still earn A+.
  if (delayedInternalReclaim) confidence = Math.max(0, confidence - 2);

  const minimumConfidence = internal
    ? INTERNAL_MIN_CONFIDENCE
    : STRUCTURE_MIN_CONFIDENCE;
  if (confidence < minimumConfidence) return null;

  return {
    id: `sfp:${inputs.anchorSource}:${inputs.direction}:${inputs.swingIndex}:${inputs.barIndex}`,
    direction: inputs.direction,
    levelType: inputs.levelType,
    anchorSource: inputs.anchorSource,
    levelPrice: inputs.levelPrice,
    swingIndex: inputs.swingIndex,
    barIndex: inputs.barIndex,
    confirmationBarIndex: inputs.confirmationBarIndex,
    confidence,
    grade: confidence >= A_PLUS_CONFIDENCE ? "A+" : "A",
    structureConfidence: Math.round(anchorScore),
    penetrationAtr: Number(penetrationAtr.toFixed(2)),
    wickFraction: Number(wickFraction.toFixed(2)),
    reclaimAtr: Number(reclaimAtr.toFixed(2)),
    closeLocation: Number(closeLocation.toFixed(2)),
    confirmationStrength: Number(confirmationStrength.toFixed(2)),
    volumeRatio: Number(volumeRatio.toFixed(2)),
    touches: inputs.touches,
  };
}

function buildStructurePattern(
  bars: readonly CleanBar[],
  structure: MarketStructureResult,
  event: LiquidityEvent,
): SwingFailurePattern | null {
  if (event.source !== "structure" || event.confirmationBarIndex == null) {
    return null;
  }

  const atr = Math.max(
    averageTrueRange(bars, Math.max(0, event.barIndex - 1), 14),
    0.000001,
  );
  const structurePoint = matchingStructurePoint(event, structure, atr);
  if (!structurePoint) return null;

  const direction: SwingFailureDirection =
    event.side === "sell-side" ? "bullish" : "bearish";

  return scorePattern(bars, {
    direction,
    levelType: direction === "bullish" ? "LL" : "HH",
    anchorSource: "structure",
    levelPrice: event.price,
    swingIndex: structurePoint.index,
    barIndex: event.barIndex,
    confirmationBarIndex: event.confirmationBarIndex,
    anchorQuality: clamp(structurePoint.confidence, 0, 100),
    touches: Math.max(1, event.touches),
  });
}

function buildInternalPatterns(
  bars: readonly CleanBar[],
  structure: MarketStructureResult,
): SwingFailurePattern[] {
  const anchors = buildQualifiedInternalAnchors(bars, structure);
  const patterns: SwingFailurePattern[] = [];

  for (const anchor of anchors) {
    const lastSweepIndex = Math.min(
      bars.length - 2,
      anchor.swingIndex + INTERNAL_MAX_AGE_BARS,
    );

    for (
      let barIndex = anchor.establishedIndex + 1;
      barIndex <= lastSweepIndex;
      barIndex += 1
    ) {
      // If the level was already accepted through before this candle, retire it.
      if (!internalAnchorStillValid(bars, anchor, barIndex - 1)) break;
      if (!internalSweepCandidate(bars, anchor, barIndex)) continue;

      const atr = Math.max(averageTrueRange(bars, barIndex, 14), 0.000001);
      const touches = priorInternalTouches(anchors, anchor, barIndex, atr);
      const context = internalSweepContext(bars, anchor, barIndex);
      if (!internalContextIsMeaningful(context, touches)) continue;

      const confirmationBarIndex = confirmationHeld(
        bars,
        anchor.direction,
        anchor.price,
        barIndex,
      );
      if (confirmationBarIndex == null) continue;

      const touchBonus = Math.min(9, Math.max(0, touches - 1) * 4.5);
      const ageBars = Math.max(0, barIndex - anchor.establishedIndex);
      const freshnessPenalty = Math.min(12, (ageBars / INTERNAL_MAX_AGE_BARS) * 12);
      const anchorQuality = clamp(anchor.quality + touchBonus - freshnessPenalty, 0, 100);

      const pattern = scorePattern(bars, {
        direction: anchor.direction,
        levelType: anchor.direction === "bullish" ? "Internal Low" : "Internal High",
        anchorSource: "internal",
        levelPrice: anchor.price,
        swingIndex: anchor.swingIndex,
        barIndex,
        confirmationBarIndex,
        anchorQuality,
        touches,
      });

      if (pattern) {
        patterns.push(pattern);
        // A successful SFP consumes this internal liquidity anchor. This keeps
        // the chart clean and prevents repeated labels from the same pivot.
        break;
      }
    }
  }

  return patterns;
}

export function buildSmartSwingFailures(
  bars: readonly CleanBar[],
  structure: MarketStructureResult,
  liquidityEvents: readonly LiquidityEvent[],
): SwingFailurePattern[] {
  const structurePatterns: SwingFailurePattern[] = [];

  for (const event of liquidityEvents) {
    const pattern = buildStructurePattern(bars, structure, event);
    if (pattern) structurePatterns.push(pattern);
  }

  const internalPatterns = buildInternalPatterns(bars, structure);

  // One candle may sweep more than one nearby level. Keep exactly one SFP per
  // direction/candle. Confirmed HH/LL ALWAYS wins over an internal swing. If
  // two internal anchors qualify, keep the higher-confidence one.
  const deduplicated = new Map<string, SwingFailurePattern>();
  const allPatterns = [...internalPatterns, ...structurePatterns];

  for (const pattern of allPatterns) {
    const key = `${pattern.direction}:${pattern.barIndex}`;
    const existing = deduplicated.get(key);

    if (!existing) {
      deduplicated.set(key, pattern);
      continue;
    }

    if (
      pattern.anchorSource === "structure" &&
      existing.anchorSource !== "structure"
    ) {
      deduplicated.set(key, pattern);
      continue;
    }

    if (
      pattern.anchorSource === existing.anchorSource &&
      pattern.confidence > existing.confidence
    ) {
      deduplicated.set(key, pattern);
    }
  }

  return [...deduplicated.values()]
    .sort((left, right) => left.barIndex - right.barIndex)
    .slice(-80);
}
