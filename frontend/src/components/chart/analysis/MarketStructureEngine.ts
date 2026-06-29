import type { CleanBar } from "../ChartTypes";

export type MarketStructureTrend = "bullish" | "bearish" | "neutral";

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
}

type SwingPoint = {
  index: number;
  price: number;
  type: "high" | "low";
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
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isSwingHigh(bars: CleanBar[], index: number, strength: number): boolean {
  const current = bars[index];

  for (let offset = 1; offset <= strength; offset += 1) {
    const left = bars[index - offset];
    const right = bars[index + offset];

    if (!left || !right) return false;
    if (current.high <= left.high || current.high <= right.high) return false;
  }

  return true;
}

function isSwingLow(bars: CleanBar[], index: number, strength: number): boolean {
  const current = bars[index];

  for (let offset = 1; offset <= strength; offset += 1) {
    const left = bars[index - offset];
    const right = bars[index + offset];

    if (!left || !right) return false;
    if (current.low >= left.low || current.low >= right.low) return false;
  }

  return true;
}

function getSwingPoints(bars: CleanBar[], swingStrength: number): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let index = swingStrength; index < bars.length - swingStrength; index += 1) {
    if (isSwingHigh(bars, index, swingStrength)) {
      swings.push({ index, price: bars[index].high, type: "high" });
    }

    if (isSwingLow(bars, index, swingStrength)) {
      swings.push({ index, price: bars[index].low, type: "low" });
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}

function getRecentSwings(
  swings: SwingPoint[],
  type: "high" | "low",
  count: number,
): SwingPoint[] {
  return swings.filter((swing) => swing.type === type).slice(-count);
}

export function buildMarketStructure(
  bars: CleanBar[],
  swingStrength = 3,
): MarketStructureResult {
  if (!bars.length || bars.length < swingStrength * 2 + 5) {
    return DEFAULT_RESULT;
  }

  const swings = getSwingPoints(bars, swingStrength);
  const highs = getRecentSwings(swings, "high", 3);
  const lows = getRecentSwings(swings, "low", 3);

  const lastBar = bars[bars.length - 1];
  const lastHigh = highs[highs.length - 1];
  const previousHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const previousLow = lows[lows.length - 2];

  const higherHighs =
    lastHigh != null && previousHigh != null && lastHigh.price > previousHigh.price;

  const higherLows =
    lastLow != null && previousLow != null && lastLow.price > previousLow.price;

  const lowerHighs =
    lastHigh != null && previousHigh != null && lastHigh.price < previousHigh.price;

  const lowerLows =
    lastLow != null && previousLow != null && lastLow.price < previousLow.price;

  const bullishCount = [higherHighs, higherLows].filter(Boolean).length;
  const bearishCount = [lowerHighs, lowerLows].filter(Boolean).length;

  let trend: MarketStructureTrend = "neutral";

  if (higherHighs && higherLows) {
    trend = "bullish";
  } else if (lowerHighs && lowerLows) {
    trend = "bearish";
  } else if (bullishCount > bearishCount) {
    trend = "bullish";
  } else if (bearishCount > bullishCount) {
    trend = "bearish";
  }

  const bullishBreak = lastHigh != null && lastBar.close > lastHigh.price;
  const bearishBreak = lastLow != null && lastBar.close < lastLow.price;

  const bos =
    (trend === "bullish" && bullishBreak) ||
    (trend === "bearish" && bearishBreak) ||
    (trend === "neutral" && (bullishBreak || bearishBreak));

  const choch =
    (trend === "bearish" && bullishBreak) ||
    (trend === "bullish" && bearishBreak);

  let strength = 50;

  if (trend === "bullish") strength += 15;
  if (trend === "bearish") strength -= 15;

  if (higherHighs) strength += 10;
  if (higherLows) strength += 10;

  if (lowerHighs) strength -= 10;
  if (lowerLows) strength -= 10;

  if (bullishBreak) strength += 15;
  if (bearishBreak) strength -= 15;

  if (choch) {
    strength += bullishBreak ? 10 : -10;
  }

  strength = clamp(Math.round(strength), 0, 100);

  return {
    trend,
    bos,
    choch,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    swingHigh: lastHigh?.price,
    swingLow: lastLow?.price,
    lastSwingHigh: lastHigh?.price,
    lastSwingLow: lastLow?.price,
    bullishCount,
    bearishCount,
    strength,
  };
}
