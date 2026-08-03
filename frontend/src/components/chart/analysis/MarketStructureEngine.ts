import type { CleanBar } from "../ChartTypes";

export type MarketStructureTrend = "bullish" | "bearish" | "neutral";
export type MarketStructurePointType = "HH" | "HL" | "LH" | "LL";
export type PendingMarketStructurePointType = "P-HH" | "P-LL";
export type MarketStructureBreakType = "bos" | "choch";

export type MarketStructureLegQuality =
  | "weak"
  | "developing"
  | "strong"
  | "exceptional";

export interface MarketStructureLegMetrics {
  displacementAtr: number;
  breakoutBodyPct: number;
  closeLocationPct: number;
  volumeRatio: number;
  followThroughAtr: number;
}

export interface MarketStructurePoint {
  id: string;
  type: MarketStructurePointType;
  index: number;
  price: number;
  confirmationIndex: number;
  breakType: MarketStructureBreakType;

  /**
   * Confidence belongs to the confirmed structure leg, so the HH/HL or LL/LH
   * created by the same breakout share the same score.
   */
  confidence: number;
  quality: MarketStructureLegQuality;
  metrics: MarketStructureLegMetrics;
}

export interface PendingMarketStructurePoint {
  id: string;
  type: PendingMarketStructurePointType;
  index: number;
  price: number;
  breakConfirmationIndex: number;
  breakType: MarketStructureBreakType;
}

export interface MarketStructureResult {
  trend: MarketStructureTrend;
  bos: boolean;
  choch: boolean;

  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;

  swingHigh?: number;
  swingLow?: number;
  lastSwingHigh?: number;
  lastSwingLow?: number;

  bullishCount: number;
  bearishCount: number;
  strength: number;

  /**
   * Confidence of the latest fully confirmed structure leg.
   */
  latestLegConfidence: number;
  latestLegQuality: MarketStructureLegQuality;

  /**
   * Automatic structure points consumed by StructureStudy/StudyRenderer.
   * Manual market-structure drawings remain independent.
   */
  points: MarketStructurePoint[];

  /**
   * Current unconfirmed breakout-leg extreme.
   * It moves with the highest/lowest wick until the swing is confirmed.
   */
  pendingPoints: PendingMarketStructurePoint[];
}

type SwingPoint = {
  index: number;
  price: number;
  type: "high" | "low";
};

type StructureLevel = {
  index: number;
  price: number;
};

type PendingBullishBreak = {
  confirmationIndex: number;
  intervalStart: number;
  breakType: MarketStructureBreakType;

  /**
   * The first break against an established bearish sequence is a transition
   * seed only. It must not immediately print HH/HL structure.
   */
  transitionOnly: boolean;
};

type PendingBearishBreak = {
  confirmationIndex: number;
  intervalStart: number;
  breakType: MarketStructureBreakType;

  /**
   * The first break against an established bullish sequence is a transition
   * seed only. It must not immediately relabel the prior HH as an LH or print
   * the transition low as an LL.
   */
  transitionOnly: boolean;
};

type StructureState = {
  trend: MarketStructureTrend;

  /**
   * Last genuinely confirmed structural extremes.
   */
  confirmedHigh: StructureLevel;
  confirmedLow: StructureLevel;

  pendingBullishBreak: PendingBullishBreak | null;
  pendingBearishBreak: PendingBearishBreak | null;

  lastEventIndex: number;
  lastEventType: MarketStructureBreakType | null;

  bullishBreakCount: number;
  bearishBreakCount: number;

  points: MarketStructurePoint[];
};

const DEFAULT_RESULT: MarketStructureResult = {
  trend: "neutral",
  bos: false,
  choch: false,
  higherHighs: false,
  higherLows: false,
  lowerHighs: false,
  lowerLows: false,
  swingHigh: undefined,
  swingLow: undefined,
  lastSwingHigh: undefined,
  lastSwingLow: undefined,
  bullishCount: 0,
  bearishCount: 0,
  strength: 50,
  latestLegConfidence: 50,
  latestLegQuality: "developing",
  points: [],
  pendingPoints: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function bodyHigh(bar: CleanBar): number {
  return Math.max(bar.open, bar.close);
}

function bodyLow(bar: CleanBar): number {
  return Math.min(bar.open, bar.close);
}

function trueRange(current: CleanBar, previous?: CleanBar): number {
  if (!previous) return Math.max(0, current.high - current.low);

  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

function averageTrueRange(
  bars: CleanBar[],
  endIndex: number,
  length = 14,
): number {
  const safeEnd = clamp(endIndex, 0, bars.length - 1);
  const safeStart = Math.max(0, safeEnd - Math.max(2, length) + 1);

  let total = 0;
  let count = 0;

  for (let index = safeStart; index <= safeEnd; index += 1) {
    const current = bars[index];
    const previous = index > 0 ? bars[index - 1] : undefined;

    if (!isFiniteBar(current)) continue;

    const range = trueRange(current, previous);
    if (!Number.isFinite(range)) continue;

    total += range;
    count += 1;
  }

  return count > 0 ? total / count : 0;
}

type StructureConfirmationProfile = {
  timeframeSeconds: number;
  minimumBarsAfterExtreme: number;
  atrRetracementMultiplier: number;
};

function timeToEpochSeconds(time: CleanBar["time"]): number | undefined {
  if (typeof time === "number" && Number.isFinite(time)) {
    return time;
  }

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed / 1000 : undefined;
  }

  if (
    typeof time === "object" &&
    time !== null &&
    "year" in time &&
    "month" in time &&
    "day" in time
  ) {
    const value = time as {
      year: number;
      month: number;
      day: number;
    };

    return Date.UTC(value.year, value.month - 1, value.day) / 1000;
  }

  return undefined;
}

function inferTimeframeSeconds(bars: CleanBar[]): number {
  const gaps: number[] = [];
  const start = Math.max(1, bars.length - 80);

  for (let index = start; index < bars.length; index += 1) {
    const previous = timeToEpochSeconds(bars[index - 1].time);
    const current = timeToEpochSeconds(bars[index].time);

    if (
      previous == null ||
      current == null ||
      !Number.isFinite(previous) ||
      !Number.isFinite(current)
    ) {
      continue;
    }

    const gap = current - previous;
    if (gap > 0 && gap <= 86_400) gaps.push(gap);
  }

  if (gaps.length === 0) return 60;

  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function getStructureConfirmationProfile(
  bars: CleanBar[],
): StructureConfirmationProfile {
  const timeframeSeconds = inferTimeframeSeconds(bars);

  /**
   * One-minute charts contain many candles and need a stronger hold period so
   * nearby highs inside the same expansion are merged into one true HH.
   *
   * Higher timeframes already compress noise into fewer candles, so they use a
   * lighter confirmation profile and react faster.
   */
  if (timeframeSeconds <= 90) {
    return {
      timeframeSeconds,
      minimumBarsAfterExtreme: 2,
      atrRetracementMultiplier: 0.38,
    };
  }

  if (timeframeSeconds <= 360) {
    return {
      timeframeSeconds,
      minimumBarsAfterExtreme: 1,
      atrRetracementMultiplier: 0.32,
    };
  }

  if (timeframeSeconds <= 1_200) {
    return {
      timeframeSeconds,
      minimumBarsAfterExtreme: 1,
      atrRetracementMultiplier: 0.28,
    };
  }

  return {
    timeframeSeconds,
    minimumBarsAfterExtreme: 1,
    atrRetracementMultiplier: 0.25,
  };
}

function meaningfulReversalDistance(
  bars: CleanBar[],
  index: number,
  atrMultiplier: number,
): number {
  const atr = averageTrueRange(bars, index, 14);
  const price = Math.max(0.000001, Math.abs(bars[index]?.close ?? 0));

  /**
   * ATR adapts the reversal requirement to volatility and timeframe. The price
   * floor prevents extremely quiet symbols from confirming one-tick noise.
   */
  return Math.max(atr * atrMultiplier, price * 0.001);
}

function isFiniteBar(bar: CleanBar | undefined): bar is CleanBar {
  return Boolean(
    bar &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close),
  );
}

function isSwingHigh(
  bars: CleanBar[],
  index: number,
  strength: number,
): boolean {
  const current = bars[index];
  if (!isFiniteBar(current)) return false;

  for (let offset = 1; offset <= strength; offset += 1) {
    const left = bars[index - offset];
    const right = bars[index + offset];

    if (!isFiniteBar(left) || !isFiniteBar(right)) return false;
    if (current.high <= left.high || current.high <= right.high) return false;
  }

  return true;
}

function isSwingLow(
  bars: CleanBar[],
  index: number,
  strength: number,
): boolean {
  const current = bars[index];
  if (!isFiniteBar(current)) return false;

  for (let offset = 1; offset <= strength; offset += 1) {
    const left = bars[index - offset];
    const right = bars[index + offset];

    if (!isFiniteBar(left) || !isFiniteBar(right)) return false;
    if (current.low >= left.low || current.low >= right.low) return false;
  }

  return true;
}

function getSeedSwings(
  bars: CleanBar[],
  swingStrength: number,
): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (
    let index = swingStrength;
    index < bars.length - swingStrength;
    index += 1
  ) {
    if (isSwingHigh(bars, index, swingStrength)) {
      swings.push({
        index,
        price: bars[index].high,
        type: "high",
      });
    }

    if (isSwingLow(bars, index, swingStrength)) {
      swings.push({
        index,
        price: bars[index].low,
        type: "low",
      });
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}

function findInitialStructure(
  swings: SwingPoint[],
): { high: StructureLevel; low: StructureLevel } | null {
  for (let firstIndex = 0; firstIndex < swings.length; firstIndex += 1) {
    const first = swings[firstIndex];

    for (
      let secondIndex = firstIndex + 1;
      secondIndex < swings.length;
      secondIndex += 1
    ) {
      const second = swings[secondIndex];

      if (first.type === second.type) continue;

      const high = first.type === "high" ? first : second;
      const low = first.type === "low" ? first : second;

      return {
        high: {
          index: high.index,
          price: high.price,
        },
        low: {
          index: low.index,
          price: low.price,
        },
      };
    }
  }

  return null;
}

function findHighestHigh(
  bars: CleanBar[],
  startIndex: number,
  endIndex: number,
): StructureLevel {
  const safeStart = clamp(startIndex, 0, bars.length - 1);
  const safeEnd = clamp(endIndex, safeStart, bars.length - 1);

  let best: StructureLevel = {
    index: safeStart,
    price: bars[safeStart].high,
  };

  for (let index = safeStart + 1; index <= safeEnd; index += 1) {
    if (bars[index].high > best.price) {
      best = {
        index,
        price: bars[index].high,
      };
    }
  }

  return best;
}

function findLowestLow(
  bars: CleanBar[],
  startIndex: number,
  endIndex: number,
): StructureLevel {
  const safeStart = clamp(startIndex, 0, bars.length - 1);
  const safeEnd = clamp(endIndex, safeStart, bars.length - 1);

  let best: StructureLevel = {
    index: safeStart,
    price: bars[safeStart].low,
  };

  for (let index = safeStart + 1; index <= safeEnd; index += 1) {
    if (bars[index].low < best.price) {
      best = {
        index,
        price: bars[index].low,
      };
    }
  }

  return best;
}

function addPoint(
  state: StructureState,
  point: Omit<
    MarketStructurePoint,
    "id" | "confidence" | "quality" | "metrics"
  >,
): void {
  const sameSide = (type: MarketStructurePointType): "high" | "low" =>
    type === "HH" || type === "LH" ? "high" : "low";

  const duplicateOrConflict = state.points.some(
    (existing) =>
      (
        existing.type === point.type &&
        existing.index === point.index &&
        existing.price === point.price
      ) ||
      (
        existing.index === point.index &&
        sameSide(existing.type) === sameSide(point.type)
      ),
  );

  if (duplicateOrConflict) return;

  state.points.push({
    ...point,
    confidence: 50,
    quality: "developing",
    metrics: {
      displacementAtr: 0,
      breakoutBodyPct: 0,
      closeLocationPct: 0,
      volumeRatio: 1,
      followThroughAtr: 0,
    },
    id: [
      "auto-structure",
      point.type,
      point.index,
      point.confirmationIndex,
      String(point.price),
    ].join("-"),
  });
}

function armBullishBreak(
  bars: CleanBar[],
  state: StructureState,
  confirmationIndex: number,
): void {
  const transitionOnly = state.trend === "bearish";
  const breakType: MarketStructureBreakType =
    transitionOnly ? "choch" : "bos";

  const intervalStart = state.confirmedHigh.index + 1;

  /**
   * Bullish continuation:
   * A close above the previous HH confirms exactly one HL. That HL is the
   * lowest wick from the previous HH to the confirming breakout candle.
   *
   * Bullish transition from a bearish sequence:
   * The first CHoCH only seeds a possible bullish sequence. It does not print
   * HH/HL labels yet. The following confirmed bullish BOS will do that.
   */
  if (!transitionOnly) {
    const higherLow = findLowestLow(
      bars,
      intervalStart,
      confirmationIndex,
    );

    addPoint(state, {
      type: "HL",
      index: higherLow.index,
      price: higherLow.price,
      confirmationIndex,
      breakType,
    });

    state.confirmedLow = higherLow;
  }

  state.pendingBullishBreak = {
    confirmationIndex,
    intervalStart,
    breakType,
    transitionOnly,
  };

  state.pendingBearishBreak = null;
  state.lastEventIndex = confirmationIndex;
  state.lastEventType = breakType;
  state.trend = "bullish";
  state.bullishBreakCount += 1;
  state.bearishBreakCount = 0;
}

function armBearishBreak(
  bars: CleanBar[],
  state: StructureState,
  confirmationIndex: number,
): void {
  const transitionOnly = state.trend === "bullish";
  const breakType: MarketStructureBreakType =
    transitionOnly ? "choch" : "bos";

  const intervalStart = state.confirmedLow.index + 1;

  /**
   * Bearish continuation:
   * A close below the previous LL confirms exactly one LH. That LH is the
   * highest wick from the previous LL to the confirming breakdown candle.
   *
   * Bearish transition from a bullish sequence:
   * The first CHoCH only seeds a possible bearish sequence. It must not relabel
   * the prior bullish HH as an LH, and it must not print the transition low as
   * an LL. The following confirmed bearish BOS establishes LL/LH structure.
   */
  if (!transitionOnly) {
    const lowerHigh = findHighestHigh(
      bars,
      intervalStart,
      confirmationIndex,
    );

    addPoint(state, {
      type: "LH",
      index: lowerHigh.index,
      price: lowerHigh.price,
      confirmationIndex,
      breakType,
    });

    state.confirmedHigh = lowerHigh;
  }

  state.pendingBearishBreak = {
    confirmationIndex,
    intervalStart,
    breakType,
    transitionOnly,
  };

  state.pendingBullishBreak = null;
  state.lastEventIndex = confirmationIndex;
  state.lastEventType = breakType;
  state.trend = "bearish";
  state.bearishBreakCount += 1;
  state.bullishBreakCount = 0;
}

function tryFinalizeBullishBreak(
  bars: CleanBar[],
  state: StructureState,
  currentIndex: number,
  _swingStrength: number,
): void {
  const pending = state.pendingBullishBreak;
  if (!pending) return;

  const highestWick = findHighestHigh(
    bars,
    pending.confirmationIndex,
    currentIndex,
  );

  /**
   * Follow the breakout leg to its highest wick.
   *
   * The leg-finalization profile is inferred from candle spacing:
   * - 1-minute data waits longer and requires a deeper retracement.
   * - 5-minute data uses a moderate filter.
   * - 15-minute and higher data react faster because candles already compress
   *   much of the lower-timeframe noise.
   */
  const profile = getStructureConfirmationProfile(bars);
  const barsAfterExtreme = currentIndex - highestWick.index;

  if (barsAfterExtreme < profile.minimumBarsAfterExtreme) return;

  const reversalDistance = meaningfulReversalDistance(
    bars,
    highestWick.index,
    profile.atrRetracementMultiplier,
  );
  const current = bars[currentIndex];

  const wickRetracement = highestWick.price - current.low;
  const closeRetracement = highestWick.price - current.close;

  const reversedFromExtreme =
    wickRetracement >= reversalDistance ||
    closeRetracement >= reversalDistance;

  if (!reversedFromExtreme) return;

  if (!pending.transitionOnly) {
    addPoint(state, {
      type: "HH",
      index: highestWick.index,
      price: highestWick.price,
      confirmationIndex: pending.confirmationIndex,
      breakType: pending.breakType,
    });
  }

  /**
   * Even a transition-only break must seed the new reference high. The next
   * close above this level is what confirms the first true bullish HH/HL pair.
   */
  state.confirmedHigh = highestWick;
  state.pendingBullishBreak = null;
}

function tryFinalizeBearishBreak(
  bars: CleanBar[],
  state: StructureState,
  currentIndex: number,
  _swingStrength: number,
): void {
  const pending = state.pendingBearishBreak;
  if (!pending) return;

  const lowestWick = findLowestLow(
    bars,
    pending.confirmationIndex,
    currentIndex,
  );

  /**
   * Bearish leg confirmation uses the same timeframe-aware profile as the
   * bullish side.
   */
  const profile = getStructureConfirmationProfile(bars);
  const barsAfterExtreme = currentIndex - lowestWick.index;

  if (barsAfterExtreme < profile.minimumBarsAfterExtreme) return;

  const reversalDistance = meaningfulReversalDistance(
    bars,
    lowestWick.index,
    profile.atrRetracementMultiplier,
  );
  const current = bars[currentIndex];

  const wickRetracement = current.high - lowestWick.price;
  const closeRetracement = current.close - lowestWick.price;

  const reversedFromExtreme =
    wickRetracement >= reversalDistance ||
    closeRetracement >= reversalDistance;

  if (!reversedFromExtreme) return;

  if (!pending.transitionOnly) {
    addPoint(state, {
      type: "LL",
      index: lowestWick.index,
      price: lowestWick.price,
      confirmationIndex: pending.confirmationIndex,
      breakType: pending.breakType,
    });
  }

  /**
   * The transition low becomes the bearish reference level only. The next
   * close below it confirms the first true bearish LL/LH pair.
   */
  state.confirmedLow = lowestWick;
  state.pendingBearishBreak = null;
}

function buildPendingPoints(
  bars: CleanBar[],
  state: StructureState,
): PendingMarketStructurePoint[] {
  const pending: PendingMarketStructurePoint[] = [];

  if (
    state.pendingBullishBreak &&
    !state.pendingBullishBreak.transitionOnly
  ) {
    const start = state.pendingBullishBreak.confirmationIndex;
    const end = bars.length - 1;

    if (start <= end) {
      const highest = findHighestHigh(bars, start, end);

      pending.push({
        id: `pending-hh-${state.pendingBullishBreak.confirmationIndex}`,
        type: "P-HH",
        index: highest.index,
        price: highest.price,
        breakConfirmationIndex:
          state.pendingBullishBreak.confirmationIndex,
        breakType: state.pendingBullishBreak.breakType,
      });
    }
  }

  if (
    state.pendingBearishBreak &&
    !state.pendingBearishBreak.transitionOnly
  ) {
    const start = state.pendingBearishBreak.confirmationIndex;
    const end = bars.length - 1;

    if (start <= end) {
      const lowest = findLowestLow(bars, start, end);

      pending.push({
        id: `pending-ll-${state.pendingBearishBreak.confirmationIndex}`,
        type: "P-LL",
        index: lowest.index,
        price: lowest.price,
        breakConfirmationIndex:
          state.pendingBearishBreak.confirmationIndex,
        breakType: state.pendingBearishBreak.breakType,
      });
    }
  }

  return pending;
}

function averageVolume(
  bars: CleanBar[],
  endIndex: number,
  length = 20,
): number {
  const start = Math.max(0, endIndex - Math.max(2, length));
  let total = 0;
  let count = 0;

  for (let index = start; index < endIndex; index += 1) {
    const volume = Number(bars[index]?.volume ?? 0);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    total += volume;
    count += 1;
  }

  return count > 0 ? total / count : 0;
}

function qualityFromConfidence(
  confidence: number,
): MarketStructureLegQuality {
  if (confidence >= 88) return "exceptional";
  if (confidence >= 72) return "strong";
  if (confidence >= 55) return "developing";
  return "weak";
}

function scoreConfirmedLeg(
  bars: CleanBar[],
  pair: MarketStructurePoint[],
): {
  confidence: number;
  quality: MarketStructureLegQuality;
  metrics: MarketStructureLegMetrics;
} {
  const confirmationIndex = pair[0]?.confirmationIndex ?? 0;
  const confirmationBar = bars[confirmationIndex];
  const atr = Math.max(
    averageTrueRange(bars, confirmationIndex, 14),
    0.000001,
  );

  const highPoint = pair.find(
    (point) => point.type === "HH" || point.type === "LH",
  );
  const lowPoint = pair.find(
    (point) => point.type === "HL" || point.type === "LL",
  );

  const legRange =
    highPoint && lowPoint
      ? Math.abs(highPoint.price - lowPoint.price)
      : 0;

  const displacementAtr = legRange / atr;

  const candleRange = confirmationBar
    ? Math.max(confirmationBar.high - confirmationBar.low, 0.000001)
    : 0.000001;
  const body = confirmationBar
    ? Math.abs(confirmationBar.close - confirmationBar.open)
    : 0;
  const breakoutBodyPct = clamp(body / candleRange, 0, 1);

  const bullishPair = pair.some((point) => point.type === "HH");
  const bearishPair = pair.some((point) => point.type === "LL");

  const closeLocationPct = confirmationBar
    ? bullishPair
      ? clamp(
          (confirmationBar.close - confirmationBar.low) / candleRange,
          0,
          1,
        )
      : bearishPair
        ? clamp(
            (confirmationBar.high - confirmationBar.close) / candleRange,
            0,
            1,
          )
        : 0.5
    : 0.5;

  const baselineVolume = averageVolume(bars, confirmationIndex, 20);
  const confirmationVolume = Number(confirmationBar?.volume ?? 0);
  const volumeRatio =
    baselineVolume > 0 && confirmationVolume > 0
      ? confirmationVolume / baselineVolume
      : 1;

  const followThroughEnd = Math.min(
    bars.length - 1,
    confirmationIndex + 3,
  );
  let followThrough = 0;

  for (
    let index = confirmationIndex;
    index <= followThroughEnd;
    index += 1
  ) {
    const bar = bars[index];
    if (!bar || !confirmationBar) continue;

    const move = bullishPair
      ? bar.high - confirmationBar.close
      : bearishPair
        ? confirmationBar.close - bar.low
        : 0;

    followThrough = Math.max(followThrough, move);
  }

  const followThroughAtr = Math.max(0, followThrough / atr);

  const displacementScore = clamp(
    ((displacementAtr - 0.5) / 2.5) * 100,
    0,
    100,
  );
  const bodyScore = breakoutBodyPct * 100;
  const closeScore = closeLocationPct * 100;
  const volumeScore = clamp((volumeRatio / 1.8) * 100, 0, 100);
  const followThroughScore = clamp(
    (followThroughAtr / 1.5) * 100,
    0,
    100,
  );

  const confidence = Math.round(
    clamp(
      displacementScore * 0.30 +
        bodyScore * 0.20 +
        closeScore * 0.20 +
        volumeScore * 0.15 +
        followThroughScore * 0.15,
      0,
      100,
    ),
  );

  const metrics: MarketStructureLegMetrics = {
    displacementAtr: Number(displacementAtr.toFixed(2)),
    breakoutBodyPct: Number(breakoutBodyPct.toFixed(2)),
    closeLocationPct: Number(closeLocationPct.toFixed(2)),
    volumeRatio: Number(volumeRatio.toFixed(2)),
    followThroughAtr: Number(followThroughAtr.toFixed(2)),
  };

  return {
    confidence,
    quality: qualityFromConfidence(confidence),
    metrics,
  };
}

function applyLegConfidence(
  bars: CleanBar[],
  points: MarketStructurePoint[],
): MarketStructurePoint[] {
  const groups = new Map<number, MarketStructurePoint[]>();

  for (const point of points) {
    const group = groups.get(point.confirmationIndex) ?? [];
    group.push(point);
    groups.set(point.confirmationIndex, group);
  }

  const scored = new Map<number, ReturnType<typeof scoreConfirmedLeg>>();

  for (const [confirmationIndex, group] of groups) {
    scored.set(confirmationIndex, scoreConfirmedLeg(bars, group));
  }

  return points.map((point) => {
    const legScore = scored.get(point.confirmationIndex);
    if (!legScore) return point;

    return {
      ...point,
      confidence: legScore.confidence,
      quality: legScore.quality,
      metrics: legScore.metrics,
    };
  });
}

function calculateStrength(state: StructureState): number {
  if (state.trend === "neutral") return 50;

  const continuationCount =
    state.trend === "bullish"
      ? state.bullishBreakCount
      : state.bearishBreakCount;

  const directionalBase = state.trend === "bullish" ? 65 : 35;
  const continuationAdjustment = Math.min(20, continuationCount * 5);

  return state.trend === "bullish"
    ? clamp(directionalBase + continuationAdjustment, 0, 100)
    : clamp(directionalBase - continuationAdjustment, 0, 100);
}

/**
 * Automatic close-confirmed market structure.
 *
 * Bullish:
 * - A break is armed when a candle CLOSES above the body high of the previous
 *   HH candle. The wick still anchors the final HH price.
 * - The new HH is not automatically the confirming candle.
 * - The engine keeps following the leg and uses the highest subsequent wick.
 * - The HH is finalized only after price meaningfully reverses from the
 *   highest wick using an ATR-adjusted leg-confirmation threshold.
 * - A bullish continuation close above the previous HH confirms one HL.
 * - That HL is the lowest wick between the previous HH and the new breakout.
 * - No intermediate pullback is labeled before the previous HH is taken out.
 * - The new HH remains pending until the breakout leg reverses.
 * - A first bullish CHoCH from a bearish sequence seeds the new direction but
 *   does not print HH/HL until a later bullish BOS confirms the sequence.
 *
 * Bearish:
 * - A break is armed when a candle CLOSES below the body low of the previous
 *   LL candle. The wick still anchors the final LL price.
 * - The engine keeps following the leg and uses the lowest subsequent wick.
 * - The LL is finalized only after price meaningfully reverses from the
 *   lowest wick using the same ATR-adjusted leg-confirmation threshold.
 * - A bearish continuation close below the previous LL confirms one LH.
 * - That LH is the highest wick between the previous LL and the new breakdown.
 * - No intermediate rally is labeled before the previous LL is taken out.
 * - The new LL remains pending until the breakdown leg reverses.
 * - A first bearish CHoCH from a bullish sequence seeds the new direction but
 *   does not relabel the prior HH as LH or print an LL at the transition low.
 *
 * Manual MarketStructureTool drawings are not modified.
 */
export function buildMarketStructure(
  bars: CleanBar[],
  swingStrength = 3,
): MarketStructureResult {
  const normalizedStrength = Math.max(1, Math.floor(swingStrength));

  if (
    bars.length < normalizedStrength * 2 + 5 ||
    bars.some((bar) => !isFiniteBar(bar))
  ) {
    return {
      ...DEFAULT_RESULT,
      points: [],
      pendingPoints: [],
    };
  }

  const seedStrength = Math.max(1, Math.min(2, normalizedStrength));
  const seedSwings = getSeedSwings(bars, seedStrength);
  const initial = findInitialStructure(seedSwings);

  if (!initial) {
    return {
      ...DEFAULT_RESULT,
      points: [],
      pendingPoints: [],
    };
  }

  const state: StructureState = {
    trend: "neutral",
    confirmedHigh: initial.high,
    confirmedLow: initial.low,
    pendingBullishBreak: null,
    pendingBearishBreak: null,
    lastEventIndex: -1,
    lastEventType: null,
    bullishBreakCount: 0,
    bearishBreakCount: 0,
    points: [],
  };

  const processingStart =
    Math.max(initial.high.index, initial.low.index) + 1;

  for (let index = processingStart; index < bars.length; index += 1) {
    tryFinalizeBullishBreak(
      bars,
      state,
      index,
      normalizedStrength,
    );

    tryFinalizeBearishBreak(
      bars,
      state,
      index,
      normalizedStrength,
    );

    const close = bars[index].close;
    const confirmedHighBar = bars[state.confirmedHigh.index];
    const confirmedLowBar = bars[state.confirmedLow.index];
    const bullishBreakLevel = bodyHigh(confirmedHighBar);
    const bearishBreakLevel = bodyLow(confirmedLowBar);

    /**
     * Do not re-arm the same direction while its breakout leg is still being
     * followed for the final highest/lowest wick.
     */
    if (
      !state.pendingBullishBreak &&
      close > bullishBreakLevel
    ) {
      armBullishBreak(bars, state, index);
      continue;
    }

    if (
      !state.pendingBearishBreak &&
      close < bearishBreakLevel
    ) {
      armBearishBreak(bars, state, index);
    }
  }

  const lastBarIndex = bars.length - 1;
  const currentEvent = state.lastEventIndex === lastBarIndex;
  const bullish = state.trend === "bullish";
  const bearish = state.trend === "bearish";

  const scoredPoints = applyLegConfidence(bars, state.points);
  const latestConfirmedPoint = scoredPoints.at(-1);
  const latestLegConfidence = latestConfirmedPoint?.confidence ?? 50;
  const latestLegQuality =
    latestConfirmedPoint?.quality ?? "developing";

  return {
    trend: state.trend,
    bos: currentEvent && state.lastEventType === "bos",
    choch: currentEvent && state.lastEventType === "choch",

    higherHighs: bullish,
    higherLows: bullish,
    lowerHighs: bearish,
    lowerLows: bearish,

    swingHigh: state.confirmedHigh.price,
    swingLow: state.confirmedLow.price,
    lastSwingHigh: state.confirmedHigh.price,
    lastSwingLow: state.confirmedLow.price,

    bullishCount: bullish ? state.bullishBreakCount : 0,
    bearishCount: bearish ? state.bearishBreakCount : 0,

    strength: calculateStrength(state),

    latestLegConfidence,
    latestLegQuality,

    points: scoredPoints.slice().sort((a, b) => {
      if (a.confirmationIndex !== b.confirmationIndex) {
        return a.confirmationIndex - b.confirmationIndex;
      }

      return a.index - b.index;
    }),

    pendingPoints: buildPendingPoints(bars, state),
  };
}
