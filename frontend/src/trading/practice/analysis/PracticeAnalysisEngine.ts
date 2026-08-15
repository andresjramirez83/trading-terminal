import {
  PRACTICE_ANALYSIS_STORAGE_VERSION,
  clampPracticeScore,
  createPracticeAnalysisId,
  getPracticeDifficulty,
  getPracticeScoreGrade,
  type PracticeAnalysisBar,
  type PracticeAnalysisRequest,
  type PracticeAnalysisStorage,
  type PracticeAnalyzerContext,
  type PracticeCompressionAnalysis,
  type PracticeDayAnalysis,
  type PracticeGapAnalysis,
  type PracticeGapEvent,
  type PracticeLiquidityAnalysis,
  type PracticeLiquiditySweepEvent,
  type PracticeMarketCondition,
  type PracticeOpeningRangeAnalysis,
  type PracticeReplayRecommendation,
  type PracticeSetupDetection,
  type PracticeStructureAnalysis,
  type PracticeSymbolAnalysis,
  type PracticeTrendAnalysis,
  type PracticeTrendDirection,
  type PracticeVolumeAnalysis,
  type PracticeVolatilityAnalysis,
  type PracticeVwapAnalysis,
  type PracticeVwapInteraction,
} from "./PracticeAnalysisTypes";

const DEFAULT_STORAGE_KEY = "trading.practice.analysis.v1";
const DEFAULT_OPENING_RANGE_MINUTES = 30;
const DEFAULT_PIVOT_STRENGTH = 2;
const DEFAULT_COMPRESSION_LOOKBACK = 8;
const DEFAULT_VOLUME_LOOKBACK = 20;

const MAX_PERSISTED_STORAGE_CHARACTERS = 3_250_000;
const MAX_COMPONENT_REASONS = 6;
const MAX_STRENGTHS = 8;
const MAX_RISKS = 8;
const MAX_TAGS = 12;

interface StorageCompactionProfile {
  maxDays: number;
  maxSymbolsPerDay: number;
  maxEventsPerSection: number;
  maxSetupsPerSymbol: number;
  maxRecommendationsPerSymbol: number;
  maxDayRecommendations: number;
}

const STORAGE_COMPACTION_PROFILES: StorageCompactionProfile[] = [
  {
    maxDays: 7,
    maxSymbolsPerDay: 24,
    maxEventsPerSection: 24,
    maxSetupsPerSymbol: 10,
    maxRecommendationsPerSymbol: 6,
    maxDayRecommendations: 40,
  },
  {
    maxDays: 4,
    maxSymbolsPerDay: 16,
    maxEventsPerSection: 12,
    maxSetupsPerSymbol: 8,
    maxRecommendationsPerSymbol: 5,
    maxDayRecommendations: 28,
  },
  {
    maxDays: 2,
    maxSymbolsPerDay: 10,
    maxEventsPerSection: 6,
    maxSetupsPerSymbol: 6,
    maxRecommendationsPerSymbol: 4,
    maxDayRecommendations: 18,
  },
];

type Listener = () => void;

interface PivotPoint {
  index: number;
  time: number;
  price: number;
  type: "high" | "low";
}

interface PracticeAnalysisEngineOptions {
  storageKey?: string;
  openingRangeMinutes?: number;
  pivotStrength?: number;
}

function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);

  if (valid.length === 0) {
    return 0;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function sum(values: number[]): number {
  return values
    .filter(Number.isFinite)
    .reduce((total, value) => total + value, 0);
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return 0;
  }

  if (Math.abs(denominator) < Number.EPSILON) {
    return 0;
  }

  return numerator / denominator;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeBars(
  bars: PracticeAnalysisBar[],
): PracticeAnalysisBar[] {
  return bars
    .filter((bar) => {
      return (
        Number.isFinite(bar.time) &&
        Number.isFinite(bar.open) &&
        Number.isFinite(bar.high) &&
        Number.isFinite(bar.low) &&
        Number.isFinite(bar.close)
      );
    })
    .map((bar) => ({
      time: Number(bar.time),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number.isFinite(bar.volume)
        ? Number(bar.volume)
        : undefined,
      vwap: Number.isFinite(bar.vwap)
        ? Number(bar.vwap)
        : undefined,
    }))
    .sort((left, right) => left.time - right.time)
    .filter((bar, index, values) => {
      return index === 0 || bar.time !== values[index - 1].time;
    });
}

function trueRange(
  bar: PracticeAnalysisBar,
  previousClose?: number,
): number {
  const intrabar = bar.high - bar.low;

  if (typeof previousClose !== "number" || !Number.isFinite(previousClose)) {
    return Math.max(0, intrabar);
  }

  return Math.max(
    intrabar,
    Math.abs(bar.high - previousClose),
    Math.abs(bar.low - previousClose),
  );
}

function calculateTrueRanges(
  bars: PracticeAnalysisBar[],
): number[] {
  return bars.map((bar, index) =>
    trueRange(bar, index > 0 ? bars[index - 1].close : undefined),
  );
}

function calculateSessionVwap(
  bars: PracticeAnalysisBar[],
): number[] {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;

  return bars.map((bar) => {
    if (Number.isFinite(bar.vwap)) {
      return Number(bar.vwap);
    }

    const volume = Math.max(0, Number(bar.volume ?? 0));
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;

    cumulativePriceVolume += typicalPrice * volume;
    cumulativeVolume += volume;

    if (cumulativeVolume <= 0) {
      return typicalPrice;
    }

    return cumulativePriceVolume / cumulativeVolume;
  });
}

function findPivots(
  bars: PracticeAnalysisBar[],
  strength: number,
): PivotPoint[] {
  const pivots: PivotPoint[] = [];

  for (
    let index = strength;
    index < bars.length - strength;
    index += 1
  ) {
    const bar = bars[index];

    let isHigh = true;
    let isLow = true;

    for (
      let offset = 1;
      offset <= strength;
      offset += 1
    ) {
      if (
        bar.high <= bars[index - offset].high ||
        bar.high < bars[index + offset].high
      ) {
        isHigh = false;
      }

      if (
        bar.low >= bars[index - offset].low ||
        bar.low > bars[index + offset].low
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      pivots.push({
        index,
        time: bar.time,
        price: bar.high,
        type: "high",
      });
    }

    if (isLow) {
      pivots.push({
        index,
        time: bar.time,
        price: bar.low,
        type: "low",
      });
    }
  }

  return pivots.sort(
    (left, right) => left.index - right.index,
  );
}

function classifyTrendDirection(
  higherHighCount: number,
  higherLowCount: number,
  lowerHighCount: number,
  lowerLowCount: number,
): PracticeTrendDirection {
  const bullish = higherHighCount + higherLowCount;
  const bearish = lowerHighCount + lowerLowCount;

  if (bullish >= bearish + 2) {
    return "bullish";
  }

  if (bearish >= bullish + 2) {
    return "bearish";
  }

  return "neutral";
}

function analyzeTrend(
  bars: PracticeAnalysisBar[],
  pivots: PivotPoint[],
): PracticeTrendAnalysis {
  const highs = pivots.filter((pivot) => pivot.type === "high");
  const lows = pivots.filter((pivot) => pivot.type === "low");

  let higherHighCount = 0;
  let higherLowCount = 0;
  let lowerHighCount = 0;
  let lowerLowCount = 0;

  for (let index = 1; index < highs.length; index += 1) {
    if (highs[index].price > highs[index - 1].price) {
      higherHighCount += 1;
    } else if (highs[index].price < highs[index - 1].price) {
      lowerHighCount += 1;
    }
  }

  for (let index = 1; index < lows.length; index += 1) {
    if (lows[index].price > lows[index - 1].price) {
      higherLowCount += 1;
    } else if (lows[index].price < lows[index - 1].price) {
      lowerLowCount += 1;
    }
  }

  const direction = classifyTrendDirection(
    higherHighCount,
    higherLowCount,
    lowerHighCount,
    lowerLowCount,
  );

  const ranges = bars.map((bar) => bar.high - bar.low);
  const totalMovement = sum(
    bars.slice(1).map((bar, index) =>
      Math.abs(bar.close - bars[index].close),
    ),
  );
  const netMovement =
    bars.length > 1
      ? Math.abs(bars[bars.length - 1].close - bars[0].close)
      : 0;

  const directionalConsistency = clampPracticeScore(
    safeRatio(netMovement, totalMovement) * 100,
  );

  const totalComparisons =
    higherHighCount +
    higherLowCount +
    lowerHighCount +
    lowerLowCount;

  const dominantCount =
    direction === "bullish"
      ? higherHighCount + higherLowCount
      : direction === "bearish"
        ? lowerHighCount + lowerLowCount
        : Math.max(
            higherHighCount + higherLowCount,
            lowerHighCount + lowerLowCount,
          );

  const structureConsistency = clampPracticeScore(
    safeRatio(dominantCount, Math.max(1, totalComparisons)) * 100,
  );

  const averageRange = average(ranges);
  const directionalRange = netMovement;
  const trendEfficiency = clampPracticeScore(
    safeRatio(
      directionalRange,
      averageRange * Math.max(1, bars.length / 8),
    ) * 50,
  );

  const trendStrength = clampPracticeScore(
    directionalConsistency * 0.4 +
      structureConsistency * 0.4 +
      trendEfficiency * 0.2,
  );

  const impulseCount = ranges.filter(
    (range) => range >= averageRange * 1.5,
  ).length;

  const pullbackCount = Math.max(
    0,
    Math.min(highs.length, lows.length) - 1,
  );

  let marketCondition: PracticeMarketCondition = "mixed";

  if (trendStrength >= 70 && direction !== "neutral") {
    marketCondition = "trending";
  } else if (direction === "neutral" && trendStrength <= 40) {
    marketCondition = "range";
  }

  const reasons: string[] = [];

  if (direction === "bullish") {
    reasons.push(
      `${higherHighCount} higher highs and ${higherLowCount} higher lows`,
    );
  } else if (direction === "bearish") {
    reasons.push(
      `${lowerHighCount} lower highs and ${lowerLowCount} lower lows`,
    );
  } else {
    reasons.push("No dominant directional structure");
  }

  if (directionalConsistency >= 65) {
    reasons.push("Price moved efficiently in one direction");
  }

  return {
    score: trendStrength,
    confidence: clampPracticeScore(
      Math.min(100, totalComparisons * 12 + bars.length / 2),
    ),
    reasons,
    direction,
    marketCondition,
    higherHighCount,
    higherLowCount,
    lowerHighCount,
    lowerLowCount,
    impulseCount,
    pullbackCount,
    trendStrength,
    trendEfficiency,
    directionalConsistency,
  };
}

function analyzeStructure(
  bars: PracticeAnalysisBar[],
  pivots: PivotPoint[],
): PracticeStructureAnalysis {
  let bullishBreakCount = 0;
  let bearishBreakCount = 0;
  let bullishShiftCount = 0;
  let bearishShiftCount = 0;

  let lastHigh: PivotPoint | undefined;
  let lastLow: PivotPoint | undefined;
  let lastBreakDirection: "bullish" | "bearish" | undefined;

  for (const pivot of pivots) {
    if (pivot.type === "high") {
      lastHigh = pivot;
    } else {
      lastLow = pivot;
    }

    const nextBars = bars.slice(pivot.index + 1);

    if (
      pivot.type === "high" &&
      nextBars.some((bar) => bar.close > pivot.price)
    ) {
      bullishBreakCount += 1;

      if (lastBreakDirection === "bearish") {
        bullishShiftCount += 1;
      }

      lastBreakDirection = "bullish";
    }

    if (
      pivot.type === "low" &&
      nextBars.some((bar) => bar.close < pivot.price)
    ) {
      bearishBreakCount += 1;

      if (lastBreakDirection === "bullish") {
        bearishShiftCount += 1;
      }

      lastBreakDirection = "bearish";
    }
  }

  const confirmedSwingHighCount = pivots.filter(
    (pivot) => pivot.type === "high",
  ).length;
  const confirmedSwingLowCount = pivots.filter(
    (pivot) => pivot.type === "low",
  ).length;

  const totalBreaks = bullishBreakCount + bearishBreakCount;
  const totalShifts = bullishShiftCount + bearishShiftCount;
  const balancePenalty =
    Math.min(bullishBreakCount, bearishBreakCount) * 8;

  const score = clampPracticeScore(
    totalBreaks * 14 +
      totalShifts * 10 +
      Math.min(
        30,
        (confirmedSwingHighCount + confirmedSwingLowCount) * 3,
      ) -
      balancePenalty,
  );

  const cleanStructure =
    totalBreaks >= 2 &&
    totalShifts <= 2 &&
    Math.abs(bullishBreakCount - bearishBreakCount) >= 1;

  const reasons: string[] = [];

  if (bullishBreakCount > 0) {
    reasons.push(`${bullishBreakCount} bullish structure breaks`);
  }

  if (bearishBreakCount > 0) {
    reasons.push(`${bearishBreakCount} bearish structure breaks`);
  }

  if (totalShifts > 0) {
    reasons.push(`${totalShifts} market structure shifts`);
  }

  if (!lastHigh || !lastLow) {
    reasons.push("Limited confirmed swing structure");
  }

  return {
    score,
    confidence: clampPracticeScore(
      (confirmedSwingHighCount + confirmedSwingLowCount) * 10,
    ),
    reasons,
    bullishBreakCount,
    bearishBreakCount,
    bullishShiftCount,
    bearishShiftCount,
    confirmedSwingHighCount,
    confirmedSwingLowCount,
    cleanStructure,
  };
}

function analyzeLiquidity(
  bars: PracticeAnalysisBar[],
  pivots: PivotPoint[],
): PracticeLiquidityAnalysis {
  const events: PracticeLiquiditySweepEvent[] = [];

  for (const pivot of pivots) {
    for (
      let index = pivot.index + 1;
      index < bars.length;
      index += 1
    ) {
      const bar = bars[index];

      if (
        pivot.type === "low" &&
        bar.low < pivot.price &&
        bar.close > pivot.price
      ) {
        const qualityScore = clampPracticeScore(
          55 +
            safeRatio(
              pivot.price - bar.low,
              Math.max(0.000001, bar.high - bar.low),
            ) *
              35,
        );

        events.push({
          direction: "bullish",
          time: bar.time,
          price: bar.close,
          sweptPrice: pivot.price,
          reclaimed: true,
          confirmationTime: bar.time,
          qualityScore,
        });
        break;
      }

      if (
        pivot.type === "high" &&
        bar.high > pivot.price &&
        bar.close < pivot.price
      ) {
        const qualityScore = clampPracticeScore(
          55 +
            safeRatio(
              bar.high - pivot.price,
              Math.max(0.000001, bar.high - bar.low),
            ) *
              35,
        );

        events.push({
          direction: "bearish",
          time: bar.time,
          price: bar.close,
          sweptPrice: pivot.price,
          reclaimed: true,
          confirmationTime: bar.time,
          qualityScore,
        });
        break;
      }
    }
  }

  const bullishSweepCount = events.filter(
    (event) => event.direction === "bullish",
  ).length;
  const bearishSweepCount = events.filter(
    (event) => event.direction === "bearish",
  ).length;
  const reclaimedSweepCount = events.filter(
    (event) => event.reclaimed,
  ).length;

  const score = clampPracticeScore(
    average(events.map((event) => event.qualityScore)) +
      Math.min(20, events.length * 4),
  );

  return {
    score,
    confidence: clampPracticeScore(events.length * 18),
    reasons:
      events.length > 0
        ? [
            `${events.length} liquidity sweeps detected`,
            `${reclaimedSweepCount} sweeps reclaimed`,
          ]
        : ["No clear liquidity sweep detected"],
    sweepCount: events.length,
    bullishSweepCount,
    bearishSweepCount,
    reclaimedSweepCount,
    events,
  };
}

function analyzeGaps(
  bars: PracticeAnalysisBar[],
): PracticeGapAnalysis {
  const events: PracticeGapEvent[] = [];

  for (let index = 2; index < bars.length; index += 1) {
    const first = bars[index - 2];
    const current = bars[index];

    if (current.low > first.high) {
      const low = first.high;
      const high = current.low;
      const midpoint = (low + high) / 2;
      const future = bars.slice(index + 1);
      const invalidation = future.find((bar) => bar.close < low);

      events.push({
        direction: "bullish",
        type: "fvg",
        startTime: current.time,
        invalidationTime: invalidation?.time,
        low,
        high,
        midpoint,
        active: !invalidation,
        qualityScore: clampPracticeScore(
          safeRatio(high - low, current.high - current.low) * 100,
        ),
      });
    }

    if (current.high < first.low) {
      const low = current.high;
      const high = first.low;
      const midpoint = (low + high) / 2;
      const future = bars.slice(index + 1);
      const validation = future.find((bar) => bar.close > high);

      if (validation) {
        const afterValidation = future.filter(
          (bar) => bar.time > validation.time,
        );
        const invalidation = afterValidation.find(
          (bar) => bar.close < low,
        );

        events.push({
          direction: "bullish",
          type: "ifvg",
          startTime: current.time,
          validationTime: validation.time,
          invalidationTime: invalidation?.time,
          low,
          high,
          midpoint,
          active: !invalidation,
          qualityScore: clampPracticeScore(
            60 +
              safeRatio(
                high - low,
                current.high - current.low,
              ) *
                30,
          ),
        });
      } else {
        const invalidation = future.find(
          (bar) => bar.close > high,
        );

        events.push({
          direction: "bearish",
          type: "fvg",
          startTime: current.time,
          invalidationTime: invalidation?.time,
          low,
          high,
          midpoint,
          active: !invalidation,
          qualityScore: clampPracticeScore(
            safeRatio(high - low, current.high - current.low) *
              100,
          ),
        });
      }
    }
  }

  const fvgCount = events.filter(
    (event) => event.type === "fvg",
  ).length;
  const ifvgCount = events.filter(
    (event) => event.type === "ifvg",
  ).length;
  const activeFvgCount = events.filter(
    (event) => event.type === "fvg" && event.active,
  ).length;
  const activeIfvgCount = events.filter(
    (event) => event.type === "ifvg" && event.active,
  ).length;

  const score = clampPracticeScore(
    average(events.map((event) => event.qualityScore)) +
      Math.min(20, ifvgCount * 8),
  );

  return {
    score,
    confidence: clampPracticeScore(events.length * 12),
    reasons:
      events.length > 0
        ? [
            `${fvgCount} fair value gaps detected`,
            `${ifvgCount} inverse fair value gaps detected`,
          ]
        : ["No meaningful gap structure detected"],
    fvgCount,
    ifvgCount,
    activeFvgCount,
    activeIfvgCount,
    events,
  };
}

function analyzeVwap(
  bars: PracticeAnalysisBar[],
): PracticeVwapAnalysis {
  const vwapValues = calculateSessionVwap(bars);
  const interactions: PracticeVwapInteraction[] = [];

  for (let index = 1; index < bars.length; index += 1) {
    const previousBar = bars[index - 1];
    const bar = bars[index];
    const previousVwap = vwapValues[index - 1];
    const currentVwap = vwapValues[index];

    if (
      previousBar.close <= previousVwap &&
      bar.close > currentVwap
    ) {
      interactions.push({
        type: "reclaim",
        direction: "bullish",
        time: bar.time,
        price: bar.close,
        qualityScore: clampPracticeScore(
          60 +
            safeRatio(
              bar.close - currentVwap,
              Math.max(0.000001, bar.high - bar.low),
            ) *
              30,
        ),
      });
    } else if (
      previousBar.close >= previousVwap &&
      bar.close < currentVwap
    ) {
      interactions.push({
        type: "loss",
        direction: "bearish",
        time: bar.time,
        price: bar.close,
        qualityScore: clampPracticeScore(
          60 +
            safeRatio(
              currentVwap - bar.close,
              Math.max(0.000001, bar.high - bar.low),
            ) *
              30,
        ),
      });
    } else if (
      bar.low <= currentVwap &&
      bar.close > currentVwap
    ) {
      interactions.push({
        type: "hold",
        direction: "bullish",
        time: bar.time,
        price: bar.close,
        qualityScore: 65,
      });
    } else if (
      bar.high >= currentVwap &&
      bar.close < currentVwap
    ) {
      interactions.push({
        type: "rejection",
        direction: "bearish",
        time: bar.time,
        price: bar.close,
        qualityScore: 65,
      });
    }
  }

  const reclaimCount = interactions.filter(
    (interaction) => interaction.type === "reclaim",
  ).length;
  const rejectionCount = interactions.filter(
    (interaction) => interaction.type === "rejection",
  ).length;
  const holdCount = interactions.filter(
    (interaction) => interaction.type === "hold",
  ).length;
  const lossCount = interactions.filter(
    (interaction) => interaction.type === "loss",
  ).length;

  const score = clampPracticeScore(
    average(
      interactions.map(
        (interaction) => interaction.qualityScore,
      ),
    ) + Math.min(15, interactions.length * 2),
  );

  return {
    score,
    confidence: clampPracticeScore(interactions.length * 10),
    reasons:
      interactions.length > 0
        ? [
            `${reclaimCount} VWAP reclaims`,
            `${holdCount} VWAP holds`,
            `${rejectionCount} VWAP rejections`,
          ]
        : ["No clear VWAP interaction detected"],
    reclaimCount,
    rejectionCount,
    holdCount,
    lossCount,
    interactionCount: interactions.length,
    interactions,
  };
}

function analyzeOpeningRange(
  bars: PracticeAnalysisBar[],
  openingRangeMinutes: number,
): PracticeOpeningRangeAnalysis {
  if (bars.length === 0) {
    return {
      score: 0,
      confidence: 0,
      reasons: ["No bars available"],
      bullishRetestConfirmed: false,
      bearishRetestConfirmed: false,
      failedBullishBreak: false,
      failedBearishBreak: false,
    };
  }

  const openingRangeEnd =
    bars[0].time + openingRangeMinutes * 60 * 1000;

  const openingBars = bars.filter(
    (bar) => bar.time < openingRangeEnd,
  );
  const laterBars = bars.filter(
    (bar) => bar.time >= openingRangeEnd,
  );

  if (openingBars.length === 0 || laterBars.length === 0) {
    return {
      score: 0,
      confidence: 20,
      reasons: ["Insufficient bars for opening-range analysis"],
      bullishRetestConfirmed: false,
      bearishRetestConfirmed: false,
      failedBullishBreak: false,
      failedBearishBreak: false,
    };
  }

  const rangeHigh = Math.max(
    ...openingBars.map((bar) => bar.high),
  );
  const rangeLow = Math.min(
    ...openingBars.map((bar) => bar.low),
  );
  const rangeSize = rangeHigh - rangeLow;

  const bullishBreak = laterBars.find(
    (bar) => bar.close > rangeHigh,
  );
  const bearishBreak = laterBars.find(
    (bar) => bar.close < rangeLow,
  );

  const barsAfterBullishBreak = bullishBreak
    ? laterBars.filter((bar) => bar.time > bullishBreak.time)
    : [];
  const barsAfterBearishBreak = bearishBreak
    ? laterBars.filter((bar) => bar.time > bearishBreak.time)
    : [];

  const bullishRetestConfirmed = Boolean(
    barsAfterBullishBreak.find(
      (bar) =>
        bar.low <= rangeHigh &&
        bar.close > rangeHigh,
    ),
  );

  const bearishRetestConfirmed = Boolean(
    barsAfterBearishBreak.find(
      (bar) =>
        bar.high >= rangeLow &&
        bar.close < rangeLow,
    ),
  );

  const failedBullishBreak = Boolean(
    bullishBreak &&
      barsAfterBullishBreak.find(
        (bar) => bar.close < rangeHigh,
      ),
  );

  const failedBearishBreak = Boolean(
    bearishBreak &&
      barsAfterBearishBreak.find(
        (bar) => bar.close > rangeLow,
      ),
  );

  const score = clampPracticeScore(
    (bullishBreak || bearishBreak ? 45 : 0) +
      (bullishRetestConfirmed || bearishRetestConfirmed
        ? 35
        : 0) +
      (failedBullishBreak || failedBearishBreak ? 10 : 0),
  );

  const reasons: string[] = [];

  if (bullishBreak) {
    reasons.push("Bullish opening-range break");
  }

  if (bearishBreak) {
    reasons.push("Bearish opening-range break");
  }

  if (bullishRetestConfirmed || bearishRetestConfirmed) {
    reasons.push("Opening-range retest confirmed");
  }

  if (failedBullishBreak || failedBearishBreak) {
    reasons.push("Failed opening-range break detected");
  }

  if (reasons.length === 0) {
    reasons.push("Price remained inside the opening range");
  }

  return {
    score,
    confidence: clampPracticeScore(
      Math.min(100, laterBars.length * 3),
    ),
    reasons,
    rangeHigh,
    rangeLow,
    rangeSize,
    bullishBreakTime: bullishBreak?.time,
    bearishBreakTime: bearishBreak?.time,
    bullishRetestConfirmed,
    bearishRetestConfirmed,
    failedBullishBreak,
    failedBearishBreak,
  };
}

function analyzeCompression(
  bars: PracticeAnalysisBar[],
  trueRanges: number[],
): PracticeCompressionAnalysis {
  if (bars.length < DEFAULT_COMPRESSION_LOOKBACK + 2) {
    return {
      score: 0,
      confidence: 20,
      reasons: ["Insufficient bars for compression analysis"],
      compressionDetected: false,
    };
  }

  const rollingAverage = average(trueRanges);
  let compressionStartIndex = -1;
  let compressionEndIndex = -1;

  for (
    let index = DEFAULT_COMPRESSION_LOOKBACK;
    index < trueRanges.length;
    index += 1
  ) {
    const recent = trueRanges.slice(
      index - DEFAULT_COMPRESSION_LOOKBACK,
      index,
    );
    const recentAverage = average(recent);

    if (recentAverage <= rollingAverage * 0.65) {
      compressionStartIndex =
        index - DEFAULT_COMPRESSION_LOOKBACK;
      compressionEndIndex = index - 1;
      break;
    }
  }

  if (compressionStartIndex < 0) {
    return {
      score: 20,
      confidence: 60,
      reasons: ["No sustained compression detected"],
      compressionDetected: false,
    };
  }

  const compressionBars = bars.slice(
    compressionStartIndex,
    compressionEndIndex + 1,
  );
  const compressionHigh = Math.max(
    ...compressionBars.map((bar) => bar.high),
  );
  const compressionLow = Math.min(
    ...compressionBars.map((bar) => bar.low),
  );

  const laterBars = bars.slice(compressionEndIndex + 1);
  const bullishBreakout = laterBars.find(
    (bar) => bar.close > compressionHigh,
  );
  const bearishBreakout = laterBars.find(
    (bar) => bar.close < compressionLow,
  );

  const breakout =
    bullishBreakout && bearishBreakout
      ? bullishBreakout.time <= bearishBreakout.time
        ? bullishBreakout
        : bearishBreakout
      : bullishBreakout ?? bearishBreakout;

  const breakoutDirection =
    breakout === bullishBreakout
      ? "bullish"
      : breakout === bearishBreakout
        ? "bearish"
        : undefined;

  const breakoutIndex = breakout
    ? bars.findIndex((bar) => bar.time === breakout.time)
    : -1;

  const breakoutExpansionRatio =
    breakoutIndex >= 0
      ? safeRatio(
          trueRanges[breakoutIndex],
          average(
            trueRanges.slice(
              compressionStartIndex,
              compressionEndIndex + 1,
            ),
          ),
        )
      : undefined;

  const score = clampPracticeScore(
    45 +
      (breakout ? 25 : 0) +
      Math.min(
        30,
        Math.max(0, (breakoutExpansionRatio ?? 1) - 1) *
          20,
      ),
  );

  return {
    score,
    confidence: 80,
    reasons: breakout
      ? [
          "Compression detected",
          `${breakoutDirection} expansion breakout`,
        ]
      : ["Compression detected without a confirmed breakout"],
    compressionDetected: true,
    compressionStartTime: bars[compressionStartIndex].time,
    compressionEndTime: bars[compressionEndIndex].time,
    breakoutTime: breakout?.time,
    breakoutDirection,
    breakoutExpansionRatio,
  };
}

function analyzeVolatility(
  bars: PracticeAnalysisBar[],
  trueRanges: number[],
): PracticeVolatilityAnalysis {
  const averageTrueRange = average(trueRanges);
  const sessionHigh =
    bars.length > 0
      ? Math.max(...bars.map((bar) => bar.high))
      : 0;
  const sessionLow =
    bars.length > 0
      ? Math.min(...bars.map((bar) => bar.low))
      : 0;
  const sessionRange = sessionHigh - sessionLow;
  const sessionRangeAtrMultiple = safeRatio(
    sessionRange,
    averageTrueRange,
  );

  const expansionCount = trueRanges.filter(
    (range) => range >= averageTrueRange * 1.5,
  ).length;
  const contractionCount = trueRanges.filter(
    (range) => range <= averageTrueRange * 0.6,
  ).length;

  const score = clampPracticeScore(
    Math.min(100, sessionRangeAtrMultiple * 12) +
      Math.min(25, expansionCount * 3),
  );

  return {
    score,
    confidence: clampPracticeScore(bars.length),
    reasons: [
      `Session range was ${sessionRangeAtrMultiple.toFixed(
        1,
      )} average bars`,
      `${expansionCount} expansion bars`,
    ],
    averageTrueRange,
    sessionRange,
    sessionRangeAtrMultiple,
    expansionCount,
    contractionCount,
  };
}

function analyzeVolume(
  bars: PracticeAnalysisBar[],
): PracticeVolumeAnalysis {
  const volumes = bars.map((bar) =>
    Math.max(0, Number(bar.volume ?? 0)),
  );

  const averageVolume = average(volumes);
  const peakVolume =
    volumes.length > 0 ? Math.max(...volumes) : 0;

  const baseline = average(
    volumes.slice(0, DEFAULT_VOLUME_LOOKBACK),
  );

  const relativeVolume = safeRatio(
    average(volumes),
    baseline,
  );

  const expansionCount = volumes.filter(
    (volume) => volume >= averageVolume * 1.5,
  ).length;
  const climaxCount = volumes.filter(
    (volume) => volume >= averageVolume * 2.5,
  ).length;

  const score = clampPracticeScore(
    relativeVolume * 50 +
      Math.min(30, expansionCount * 3) +
      Math.min(20, climaxCount * 5),
  );

  return {
    score,
    confidence:
      volumes.some((volume) => volume > 0) ? 90 : 10,
    reasons:
      averageVolume > 0
        ? [
            `Relative volume ${relativeVolume.toFixed(2)}x`,
            `${expansionCount} volume expansion bars`,
          ]
        : ["Volume data unavailable"],
    averageVolume,
    peakVolume,
    relativeVolume,
    expansionCount,
    climaxCount,
  };
}

function buildSetups(params: {
  trend: PracticeTrendAnalysis;
  structure: PracticeStructureAnalysis;
  liquidity: PracticeLiquidityAnalysis;
  gaps: PracticeGapAnalysis;
  vwap: PracticeVwapAnalysis;
  openingRange: PracticeOpeningRangeAnalysis;
  compression: PracticeCompressionAnalysis;
  bars: PracticeAnalysisBar[];
}): PracticeSetupDetection[] {
  const setups: PracticeSetupDetection[] = [];

  if (
    params.trend.score >= 65 &&
    params.trend.direction !== "neutral"
  ) {
    setups.push({
      type: "trend",
      direction: params.trend.direction,
      score: params.trend.score,
      confidence: params.trend.confidence,
      detectedAt:
        params.bars[Math.min(10, params.bars.length - 1)]?.time ??
        0,
      reasons: params.trend.reasons,
      tags: ["trend", "structure"],
    });
  }

  const bestSweep = [...params.liquidity.events].sort(
    (left, right) => right.qualityScore - left.qualityScore,
  )[0];

  if (bestSweep) {
    setups.push({
      type: "liquidity_sweep",
      direction:
        bestSweep.direction === "bullish"
          ? "bullish"
          : "bearish",
      score: bestSweep.qualityScore,
      confidence: params.liquidity.confidence,
      detectedAt: bestSweep.time,
      confirmationAt: bestSweep.confirmationTime,
      entryPrice: bestSweep.price,
      reasons: [
        `${bestSweep.direction} liquidity sweep and reclaim`,
      ],
      tags: ["liquidity", "sweep", "reclaim"],
    });
  }

  const bestIfvg = params.gaps.events
    .filter((event) => event.type === "ifvg")
    .sort(
      (left, right) =>
        right.qualityScore - left.qualityScore,
    )[0];

  if (bestIfvg) {
    setups.push({
      type: "ifvg",
      direction: bestIfvg.direction,
      score: bestIfvg.qualityScore,
      confidence: params.gaps.confidence,
      detectedAt: bestIfvg.startTime,
      confirmationAt: bestIfvg.validationTime,
      entryPrice: bestIfvg.midpoint,
      stopPrice: bestIfvg.low,
      reasons: ["Bearish FVG flipped into bullish IFVG"],
      tags: ["ifvg", "imbalance", "reclaim"],
    });
  }

  const bestVwap = params.vwap.interactions
    .filter(
      (interaction) =>
        interaction.type === "reclaim" ||
        interaction.type === "rejection",
    )
    .sort(
      (left, right) =>
        right.qualityScore - left.qualityScore,
    )[0];

  if (bestVwap) {
    setups.push({
      type: "vwap_reclaim",
      direction: bestVwap.direction,
      score: bestVwap.qualityScore,
      confidence: params.vwap.confidence,
      detectedAt: bestVwap.time,
      entryPrice: bestVwap.price,
      reasons: [
        `${bestVwap.direction} VWAP ${bestVwap.type}`,
      ],
      tags: ["vwap", bestVwap.type],
    });
  }

  const orbDirection =
    params.openingRange.bullishBreakTime &&
    (!params.openingRange.bearishBreakTime ||
      params.openingRange.bullishBreakTime <=
        params.openingRange.bearishBreakTime)
      ? "bullish"
      : params.openingRange.bearishBreakTime
        ? "bearish"
        : undefined;

  const orbTime =
    orbDirection === "bullish"
      ? params.openingRange.bullishBreakTime
      : params.openingRange.bearishBreakTime;

  if (orbDirection && orbTime) {
    setups.push({
      type: "opening_range_break",
      direction: orbDirection,
      score: params.openingRange.score,
      confidence: params.openingRange.confidence,
      detectedAt: orbTime,
      reasons: params.openingRange.reasons,
      tags: ["opening-range", "breakout"],
    });
  }

  if (
    params.compression.compressionDetected &&
    params.compression.breakoutTime &&
    params.compression.breakoutDirection
  ) {
    setups.push({
      type: "compression_breakout",
      direction: params.compression.breakoutDirection,
      score: params.compression.score,
      confidence: params.compression.confidence,
      detectedAt: params.compression.breakoutTime,
      reasons: params.compression.reasons,
      tags: ["compression", "expansion", "breakout"],
    });
  }

  if (
    params.structure.bullishShiftCount +
      params.structure.bearishShiftCount >
    0
  ) {
    const bullish =
      params.structure.bullishShiftCount >=
      params.structure.bearishShiftCount;

    setups.push({
      type: "reversal",
      direction: bullish ? "bullish" : "bearish",
      score: clampPracticeScore(
        params.structure.score +
          params.liquidity.score * 0.2,
      ),
      confidence: params.structure.confidence,
      detectedAt:
        bestSweep?.time ??
        params.bars[Math.floor(params.bars.length / 2)]
          ?.time ??
        0,
      reasons: ["Market structure shift after prior direction"],
      tags: ["reversal", "structure-shift"],
    });
  }

  return setups.sort(
    (left, right) => right.score - left.score,
  );
}

function buildRecommendations(params: {
  symbol: string;
  tradingDate: string;
  timeframe: string;
  overallScore: number;
  trend: PracticeTrendAnalysis;
  liquidity: PracticeLiquidityAnalysis;
  gaps: PracticeGapAnalysis;
  openingRange: PracticeOpeningRangeAnalysis;
  setups: PracticeSetupDetection[];
}): PracticeReplayRecommendation[] {
  const recommendations: PracticeReplayRecommendation[] = [];

  const bestSetup = params.setups[0];

  if (bestSetup) {
    recommendations.push({
      category: "best_overall",
      label: "Best Overall",
      score: params.overallScore,
      confidence: bestSetup.confidence,
      symbol: params.symbol,
      tradingDate: params.tradingDate,
      timeframe: params.timeframe,
      jumpToTime:
        bestSetup.confirmationAt ?? bestSetup.detectedAt,
      setupType: bestSetup.type,
      direction: bestSetup.direction,
      reason: bestSetup.reasons[0] ?? "High learning value",
    });
  }

  const trendSetup = params.setups.find(
    (setup) => setup.type === "trend",
  );

  if (trendSetup) {
    recommendations.push({
      category: "best_trend",
      label: "Best Trend",
      score: trendSetup.score,
      confidence: trendSetup.confidence,
      symbol: params.symbol,
      tradingDate: params.tradingDate,
      timeframe: params.timeframe,
      jumpToTime: trendSetup.detectedAt,
      setupType: trendSetup.type,
      direction: trendSetup.direction,
      reason: params.trend.reasons[0] ?? "Clean trend structure",
    });
  }

  const orbSetup = params.setups.find(
    (setup) => setup.type === "opening_range_break",
  );

  if (orbSetup) {
    recommendations.push({
      category: "best_opening_range_break",
      label: "Best ORB",
      score: orbSetup.score,
      confidence: orbSetup.confidence,
      symbol: params.symbol,
      tradingDate: params.tradingDate,
      timeframe: params.timeframe,
      jumpToTime: orbSetup.detectedAt,
      setupType: orbSetup.type,
      direction: orbSetup.direction,
      reason:
        params.openingRange.reasons[0] ??
        "Opening-range break",
    });
  }

  const ifvgSetup = params.setups.find(
    (setup) => setup.type === "ifvg",
  );

  if (ifvgSetup) {
    recommendations.push({
      category: "best_ifvg",
      label: "Best IFVG",
      score: ifvgSetup.score,
      confidence: ifvgSetup.confidence,
      symbol: params.symbol,
      tradingDate: params.tradingDate,
      timeframe: params.timeframe,
      jumpToTime:
        ifvgSetup.confirmationAt ?? ifvgSetup.detectedAt,
      setupType: ifvgSetup.type,
      direction: ifvgSetup.direction,
      reason: ifvgSetup.reasons[0] ?? "IFVG opportunity",
    });
  }

  const sweepSetup = params.setups.find(
    (setup) => setup.type === "liquidity_sweep",
  );

  if (sweepSetup) {
    recommendations.push({
      category: "best_liquidity_sweep",
      label: "Best Liquidity Sweep",
      score: sweepSetup.score,
      confidence: sweepSetup.confidence,
      symbol: params.symbol,
      tradingDate: params.tradingDate,
      timeframe: params.timeframe,
      jumpToTime:
        sweepSetup.confirmationAt ?? sweepSetup.detectedAt,
      setupType: sweepSetup.type,
      direction: sweepSetup.direction,
      reason:
        params.liquidity.reasons[0] ??
        "Liquidity sweep and reclaim",
    });
  }

  return recommendations;
}

function createEmptyStorage(): PracticeAnalysisStorage {
  return {
    version: PRACTICE_ANALYSIS_STORAGE_VERSION,
    updatedAt: Date.now(),
    days: {},
  };
}

function isStorageQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: string;
    code?: number;
  };

  return (
    candidate.name === "QuotaExceededError" ||
    candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    candidate.code === 22 ||
    candidate.code === 1014
  );
}

function compactSymbolAnalysis(
  analysis: PracticeSymbolAnalysis,
  profile: StorageCompactionProfile,
): PracticeSymbolAnalysis {
  const trimReasons = (reasons: string[]): string[] =>
    reasons.slice(0, MAX_COMPONENT_REASONS);

  return {
    ...analysis,
    trend: {
      ...analysis.trend,
      reasons: trimReasons(analysis.trend.reasons),
    },
    structure: {
      ...analysis.structure,
      reasons: trimReasons(analysis.structure.reasons),
    },
    liquidity: {
      ...analysis.liquidity,
      reasons: trimReasons(analysis.liquidity.reasons),
      events: analysis.liquidity.events.slice(
        -profile.maxEventsPerSection,
      ),
    },
    gaps: {
      ...analysis.gaps,
      reasons: trimReasons(analysis.gaps.reasons),
      events: analysis.gaps.events.slice(
        -profile.maxEventsPerSection,
      ),
    },
    vwap: {
      ...analysis.vwap,
      reasons: trimReasons(analysis.vwap.reasons),
      interactions: analysis.vwap.interactions.slice(
        -profile.maxEventsPerSection,
      ),
    },
    openingRange: {
      ...analysis.openingRange,
      reasons: trimReasons(analysis.openingRange.reasons),
    },
    compression: {
      ...analysis.compression,
      reasons: trimReasons(analysis.compression.reasons),
    },
    volatility: {
      ...analysis.volatility,
      reasons: trimReasons(analysis.volatility.reasons),
    },
    volume: {
      ...analysis.volume,
      reasons: trimReasons(analysis.volume.reasons),
    },
    setups: analysis.setups
      .slice(0, profile.maxSetupsPerSymbol)
      .map((setup) => ({
        ...setup,
        reasons: setup.reasons.slice(0, MAX_COMPONENT_REASONS),
        tags: setup.tags.slice(0, MAX_TAGS),
      })),
    recommendations: analysis.recommendations.slice(
      0,
      profile.maxRecommendationsPerSymbol,
    ),
    strengths: analysis.strengths.slice(0, MAX_STRENGTHS),
    risks: analysis.risks.slice(0, MAX_RISKS),
    tags: analysis.tags.slice(0, MAX_TAGS),
  };
}

function compactDayAnalysis(
  day: PracticeDayAnalysis,
  profile: StorageCompactionProfile,
): PracticeDayAnalysis {
  const symbols = day.symbols
    .slice(0, profile.maxSymbolsPerDay)
    .map((analysis) =>
      compactSymbolAnalysis(analysis, profile),
    );

  const recommendations = symbols
    .flatMap((analysis) => analysis.recommendations)
    .sort((left, right) => right.score - left.score)
    .slice(0, profile.maxDayRecommendations);

  const findTopSymbol = (
    category: PracticeReplayRecommendation["category"],
  ): string | undefined => {
    return recommendations.find(
      (recommendation) =>
        recommendation.category === category,
    )?.symbol;
  };

  return {
    ...day,
    symbolCount: symbols.length,
    analyzedSymbolCount: symbols.length,
    symbols,
    recommendations,
    topOverallSymbol:
      findTopSymbol("best_overall") ?? symbols[0]?.symbol,
    topTrendSymbol: findTopSymbol("best_trend"),
    topOpeningRangeBreakSymbol: findTopSymbol(
      "best_opening_range_break",
    ),
    topIfvgSymbol: findTopSymbol("best_ifvg"),
    topLiquiditySweepSymbol: findTopSymbol(
      "best_liquidity_sweep",
    ),
    topReversalSymbol: findTopSymbol("best_reversal"),
    topMomentumSymbol: findTopSymbol("best_momentum"),
  };
}

function compactPracticeStorage(
  storage: PracticeAnalysisStorage,
  profile: StorageCompactionProfile,
): PracticeAnalysisStorage {
  const orderedDays = Object.values(storage.days).sort(
    (left, right) => {
      const byDate = right.tradingDate.localeCompare(
        left.tradingDate,
      );

      if (byDate !== 0) {
        return byDate;
      }

      return right.analyzedAt - left.analyzedAt;
    },
  );

  const days: Record<string, PracticeDayAnalysis> = {};

  for (const day of orderedDays.slice(0, profile.maxDays)) {
    days[day.tradingDate] = compactDayAnalysis(day, profile);
  }

  return {
    version: PRACTICE_ANALYSIS_STORAGE_VERSION,
    updatedAt: storage.updatedAt,
    days,
  };
}

export class PracticeAnalysisEngine {
  private readonly storageKey: string;

  private readonly openingRangeMinutes: number;

  private readonly pivotStrength: number;

  private storage: PracticeAnalysisStorage;

  private listeners = new Set<Listener>();

  private persistenceDisabled = false;

  private persistenceWarningShown = false;

  public constructor(
    options: PracticeAnalysisEngineOptions = {},
  ) {
    this.storageKey =
      options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.openingRangeMinutes =
      options.openingRangeMinutes ??
      DEFAULT_OPENING_RANGE_MINUTES;
    this.pivotStrength =
      options.pivotStrength ?? DEFAULT_PIVOT_STRENGTH;

    this.storage = compactPracticeStorage(
      this.loadStorage(),
      STORAGE_COMPACTION_PROFILES[0],
    );
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  public getStorageSnapshot(): PracticeAnalysisStorage {
    return this.storage;
  }

  public getDay(
    tradingDate: string,
  ): PracticeDayAnalysis | undefined {
    return this.storage.days[tradingDate];
  }

  public getSymbolAnalysis(params: {
    tradingDate: string;
    symbol: string;
    timeframe: string;
  }): PracticeSymbolAnalysis | undefined {
    const id = createPracticeAnalysisId(params);

    return this.storage.days[params.tradingDate]?.symbols.find(
      (analysis) => analysis.id === id,
    );
  }

  public analyzeSymbol(
    request: PracticeAnalysisRequest,
  ): PracticeSymbolAnalysis {
    const symbol = request.symbol.trim().toUpperCase();
    const timeframe = request.timeframe.trim().toLowerCase();
    const bars = normalizeBars(request.bars);

    if (!symbol) {
      throw new Error(
        "PracticeAnalysisEngine requires a symbol.",
      );
    }

    if (!request.tradingDate) {
      throw new Error(
        "PracticeAnalysisEngine requires a trading date.",
      );
    }

    if (!timeframe) {
      throw new Error(
        "PracticeAnalysisEngine requires a timeframe.",
      );
    }

    if (bars.length < 5) {
      throw new Error(
        `PracticeAnalysisEngine requires at least 5 bars for ${symbol}.`,
      );
    }

    const existing = this.getSymbolAnalysis({
      tradingDate: request.tradingDate,
      symbol,
      timeframe,
    });

    if (existing && !request.forceRefresh) {
      return existing;
    }

    const context: PracticeAnalyzerContext = {
      symbol,
      tradingDate: request.tradingDate,
      timeframe,
      bars,
      scannerNames: uniqueStrings(
        request.scannerNames ?? [],
      ),
      scannerHitTimes: [
        ...new Set(request.scannerHitTimes ?? []),
      ].sort((left, right) => left - right),
    };

    const trueRanges = calculateTrueRanges(bars);
    const pivots = findPivots(
      bars,
      this.pivotStrength,
    );

    const trend = analyzeTrend(bars, pivots);
    const structure = analyzeStructure(bars, pivots);
    const liquidity = analyzeLiquidity(bars, pivots);
    const gaps = analyzeGaps(bars);
    const vwap = analyzeVwap(bars);
    const openingRange = analyzeOpeningRange(
      bars,
      this.openingRangeMinutes,
    );
    const compression = analyzeCompression(
      bars,
      trueRanges,
    );
    const volatility = analyzeVolatility(
      bars,
      trueRanges,
    );
    const volume = analyzeVolume(bars);

    const setups = buildSetups({
      trend,
      structure,
      liquidity,
      gaps,
      vwap,
      openingRange,
      compression,
      bars,
    });

    const setupQualityScore = clampPracticeScore(
      average(setups.slice(0, 3).map((setup) => setup.score)),
    );

    const executionClarityScore = clampPracticeScore(
      trend.score * 0.25 +
        structure.score * 0.25 +
        openingRange.score * 0.15 +
        liquidity.score * 0.15 +
        vwap.score * 0.1 +
        compression.score * 0.1,
    );

    const learningValueScore = clampPracticeScore(
      setupQualityScore * 0.45 +
        volatility.score * 0.15 +
        structure.score * 0.15 +
        liquidity.score * 0.15 +
        gaps.score * 0.1,
    );

    const replayScore = clampPracticeScore(
      learningValueScore * 0.55 +
        executionClarityScore * 0.45,
    );

    const overallScore = clampPracticeScore(
      setupQualityScore * 0.35 +
        replayScore * 0.3 +
        trend.score * 0.1 +
        structure.score * 0.1 +
        volume.score * 0.075 +
        volatility.score * 0.075,
    );

    let primaryCondition = trend.marketCondition;

    if (compression.score >= 70) {
      primaryCondition = "compression";
    } else if (
      structure.bullishShiftCount +
        structure.bearishShiftCount >
      0
    ) {
      primaryCondition = "reversal";
    } else if (
      trend.direction === "neutral" &&
      executionClarityScore < 45
    ) {
      primaryCondition = "choppy";
    }

    const strengths = uniqueStrings([
      trend.score >= 70 ? "Clean directional trend" : "",
      structure.cleanStructure
        ? "Readable market structure"
        : "",
      liquidity.score >= 70
        ? "High-quality liquidity event"
        : "",
      gaps.ifvgCount > 0
        ? "Tradable IFVG opportunity"
        : "",
      openingRange.score >= 70
        ? "Clear opening-range setup"
        : "",
      compression.score >= 70
        ? "Compression-to-expansion sequence"
        : "",
      volume.score >= 70
        ? "Strong volume participation"
        : "",
    ]);

    const risks = uniqueStrings([
      primaryCondition === "choppy"
        ? "Choppy price action"
        : "",
      structure.score < 40
        ? "Weak or inconsistent structure"
        : "",
      volatility.score >= 85
        ? "High volatility and execution risk"
        : "",
      setupQualityScore < 50
        ? "Limited high-quality setups"
        : "",
      volume.confidence < 50
        ? "Incomplete volume data"
        : "",
    ]);

    const tags = uniqueStrings([
      primaryCondition,
      trend.direction,
      ...context.scannerNames,
      ...setups.flatMap((setup) => setup.tags),
    ]);

    const recommendations = buildRecommendations({
      symbol,
      tradingDate: request.tradingDate,
      timeframe,
      overallScore,
      trend,
      liquidity,
      gaps,
      openingRange,
      setups,
    });

    const analysis: PracticeSymbolAnalysis = {
      id: createPracticeAnalysisId({
        tradingDate: request.tradingDate,
        symbol,
        timeframe,
      }),
      symbol,
      tradingDate: request.tradingDate,
      timeframe,
      analyzedAt: Date.now(),
      firstBarTime: bars[0]?.time,
      lastBarTime: bars[bars.length - 1]?.time,
      barCount: bars.length,
      overallScore,
      replayScore,
      setupQualityScore,
      learningValueScore,
      executionClarityScore,
      grade: getPracticeScoreGrade(overallScore),
      difficulty: getPracticeDifficulty(
        overallScore,
        volatility.score,
        structure.score,
      ),
      primaryCondition,
      primaryDirection: trend.direction,
      trend,
      structure,
      liquidity,
      gaps,
      vwap,
      openingRange,
      compression,
      volatility,
      volume,
      setups,
      recommendations,
      strengths,
      risks,
      tags,
    };

    this.saveSymbolAnalysis(analysis);

    return analysis;
  }

  public analyzeMany(
    requests: PracticeAnalysisRequest[],
  ): PracticeSymbolAnalysis[] {
    const results: PracticeSymbolAnalysis[] = [];

    for (const request of requests) {
      try {
        results.push(this.analyzeSymbol(request));
      } catch (error) {
        console.error(
          "[PracticeAnalysisEngine] Failed to analyze symbol",
          request.symbol,
          error,
        );
      }
    }

    return results;
  }

  public removeDay(tradingDate: string): void {
    if (!this.storage.days[tradingDate]) {
      return;
    }

    const days = { ...this.storage.days };
    delete days[tradingDate];

    this.storage = {
      ...this.storage,
      updatedAt: Date.now(),
      days,
    };

    this.persist();
    this.emit();
  }

  public clear(): void {
    this.storage = createEmptyStorage();
    this.persistenceDisabled = false;
    this.persistenceWarningShown = false;
    this.persist();
    this.emit();
  }

  private saveSymbolAnalysis(
    analysis: PracticeSymbolAnalysis,
  ): void {
    const existingDay =
      this.storage.days[analysis.tradingDate];

    const symbols = [
      ...(existingDay?.symbols ?? []).filter(
        (item) => item.id !== analysis.id,
      ),
      analysis,
    ].sort(
      (left, right) =>
        right.overallScore - left.overallScore,
    );

    const recommendations = symbols
      .flatMap((item) => item.recommendations)
      .sort((left, right) => right.score - left.score);

    const findTopSymbol = (
      category:
        | "best_overall"
        | "best_trend"
        | "best_opening_range_break"
        | "best_ifvg"
        | "best_liquidity_sweep"
        | "best_reversal"
        | "best_momentum",
    ): string | undefined => {
      return recommendations.find(
        (recommendation) =>
          recommendation.category === category,
      )?.symbol;
    };

    const day: PracticeDayAnalysis = {
      tradingDate: analysis.tradingDate,
      analyzedAt: Date.now(),
      symbolCount: symbols.length,
      analyzedSymbolCount: symbols.length,
      symbols,
      recommendations,
      topOverallSymbol:
        findTopSymbol("best_overall") ??
        symbols[0]?.symbol,
      topTrendSymbol: findTopSymbol("best_trend"),
      topOpeningRangeBreakSymbol: findTopSymbol(
        "best_opening_range_break",
      ),
      topIfvgSymbol: findTopSymbol("best_ifvg"),
      topLiquiditySweepSymbol: findTopSymbol(
        "best_liquidity_sweep",
      ),
      topReversalSymbol: findTopSymbol("best_reversal"),
      topMomentumSymbol: findTopSymbol("best_momentum"),
    };

    this.storage = {
      ...this.storage,
      version: PRACTICE_ANALYSIS_STORAGE_VERSION,
      updatedAt: Date.now(),
      days: {
        ...this.storage.days,
        [analysis.tradingDate]: day,
      },
    };

    this.persist();
    this.emit();
  }

  private loadStorage(): PracticeAnalysisStorage {
    if (typeof window === "undefined") {
      return createEmptyStorage();
    }

    try {
      const raw = window.localStorage.getItem(
        this.storageKey,
      );

      if (!raw) {
        return createEmptyStorage();
      }

      const parsed = JSON.parse(
        raw,
      ) as PracticeAnalysisStorage;

      if (
        !parsed ||
        parsed.version !==
          PRACTICE_ANALYSIS_STORAGE_VERSION ||
        !parsed.days
      ) {
        return createEmptyStorage();
      }

      return parsed;
    } catch (error) {
      console.warn(
        "[PracticeAnalysisEngine] Failed to load storage",
        error,
      );

      return createEmptyStorage();
    }
  }

  private persist(): void {
    if (
      typeof window === "undefined" ||
      this.persistenceDisabled
    ) {
      return;
    }

    let lastError: unknown;

    for (const profile of STORAGE_COMPACTION_PROFILES) {
      const candidate = compactPracticeStorage(
        this.storage,
        profile,
      );
      const serialized = JSON.stringify(candidate);

      if (
        serialized.length >
        MAX_PERSISTED_STORAGE_CHARACTERS
      ) {
        continue;
      }

      try {
        window.localStorage.setItem(
          this.storageKey,
          serialized,
        );

        this.storage = candidate;
        return;
      } catch (error) {
        lastError = error;

        if (!isStorageQuotaError(error)) {
          this.persistenceDisabled = true;
          break;
        }
      }
    }

    const smallestProfile =
      STORAGE_COMPACTION_PROFILES[
        STORAGE_COMPACTION_PROFILES.length - 1
      ];
    const smallestCandidate = compactPracticeStorage(
      this.storage,
      smallestProfile,
    );

    try {
      window.localStorage.removeItem(this.storageKey);
      window.localStorage.setItem(
        this.storageKey,
        JSON.stringify(smallestCandidate),
      );

      this.storage = smallestCandidate;
      return;
    } catch (error) {
      lastError = error;
      this.persistenceDisabled = true;
    }

    if (!this.persistenceWarningShown) {
      this.persistenceWarningShown = true;

      console.warn(
        "[PracticeAnalysisEngine] Practice cache storage is full; " +
          "continuing with in-memory analysis only until reload.",
        lastError,
      );
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const practiceAnalysisEngine =
  new PracticeAnalysisEngine();
