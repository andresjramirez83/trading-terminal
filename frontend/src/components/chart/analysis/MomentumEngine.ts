import type { CleanBar } from "../ChartTypes";

export interface MomentumResult {
  score: number;

  direction: "bullish" | "bearish" | "neutral";
  status: "Strong Bullish" | "Bullish" | "Neutral" | "Bearish" | "Strong Bearish";

  emaMomentum: number;
  vwapMomentum: number;
  candleMomentum: number;
  volumeMomentum: number;
  atrMomentum: number;

  increasing: boolean;
  fading: boolean;
}

const DEFAULT_RESULT: MomentumResult = {
  score: 50,

  direction: "neutral",
  status: "Neutral",

  emaMomentum: 50,
  vwapMomentum: 50,
  candleMomentum: 50,
  volumeMomentum: 50,
  atrMomentum: 50,

  increasing: false,
  fading: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calcEma(values: number[], length: number): number[] {
  if (!values.length) return [];

  const multiplier = 2 / (length + 1);
  const output: number[] = [];

  let ema = values[0];

  for (const value of values) {
    ema = value * multiplier + ema * (1 - multiplier);
    output.push(ema);
  }

  return output;
}

function calcAtrValues(bars: CleanBar[], length: number): number[] {
  const atrValues: number[] = [];

  if (bars.length < 2) return atrValues;

  const trueRanges: number[] = [];

  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );

    trueRanges.push(trueRange);

    const window = trueRanges.slice(-length);
    atrValues.push(average(window));
  }

  return atrValues;
}

function calcVwap(bars: CleanBar[]): number[] {
  const output: number[] = [];

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    const volume = bar.volume ?? 0;

    cumulativePV += typicalPrice * volume;
    cumulativeVolume += volume;

    output.push(cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : typicalPrice);
  }

  return output;
}

function getStatus(score: number): MomentumResult["status"] {
  if (score >= 75) return "Strong Bullish";
  if (score >= 60) return "Bullish";
  if (score <= 25) return "Strong Bearish";
  if (score <= 40) return "Bearish";
  return "Neutral";
}

function getDirection(score: number): MomentumResult["direction"] {
  if (score >= 60) return "bullish";
  if (score <= 40) return "bearish";
  return "neutral";
}

export function buildMomentum(
  bars: CleanBar[],
  lookback = 20,
): MomentumResult {
  if (!bars.length || bars.length < lookback + 10) {
    return DEFAULT_RESULT;
  }

  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume ?? 0);

  const ema9 = calcEma(closes, 9);
  const ema20 = calcEma(closes, 20);

  const vwap = calcVwap(bars);
  const atrValues = calcAtrValues(bars, 14);

  const lastBar = bars[bars.length - 1];
  const previousBar = bars[bars.length - 2];

  const lastClose = lastBar.close;
  const lastEma9 = ema9[ema9.length - 1];
  const lastEma20 = ema20[ema20.length - 1];
  const previousEma9 = ema9[ema9.length - 2];
  const previousEma20 = ema20[ema20.length - 2];

  const lastVwap = vwap[vwap.length - 1];
  const previousVwap = vwap[vwap.length - 2];

  const recentVolumeAverage = average(volumes.slice(-lookback));
  const priorVolumeAverage = average(volumes.slice(-(lookback * 2), -lookback));

  const recentAtr = average(atrValues.slice(-lookback));
  const priorAtr = average(atrValues.slice(-(lookback * 2), -lookback));

  const candleRange = lastBar.high - lastBar.low;
  const candleBody = Math.abs(lastBar.close - lastBar.open);
  const bodyPercent = candleRange > 0 ? candleBody / candleRange : 0;

  const candleBullish = lastBar.close > lastBar.open;
  const candleBearish = lastBar.close < lastBar.open;

  let emaMomentum = 50;

  if (lastEma9 > lastEma20) emaMomentum += 20;
  if (lastEma9 < lastEma20) emaMomentum -= 20;
  if (lastEma9 > previousEma9) emaMomentum += 10;
  if (lastEma9 < previousEma9) emaMomentum -= 10;
  if (lastEma20 > previousEma20) emaMomentum += 5;
  if (lastEma20 < previousEma20) emaMomentum -= 5;

  emaMomentum = clamp(Math.round(emaMomentum), 0, 100);

  let vwapMomentum = 50;

  if (lastClose > lastVwap) vwapMomentum += 25;
  if (lastClose < lastVwap) vwapMomentum -= 25;
  if (lastVwap > previousVwap) vwapMomentum += 10;
  if (lastVwap < previousVwap) vwapMomentum -= 10;

  vwapMomentum = clamp(Math.round(vwapMomentum), 0, 100);

  let candleMomentum = 50;

  if (candleBullish) candleMomentum += 20;
  if (candleBearish) candleMomentum -= 20;

  candleMomentum += Math.round(bodyPercent * 20);

  if (lastBar.close > previousBar.high) candleMomentum += 10;
  if (lastBar.close < previousBar.low) candleMomentum -= 10;

  candleMomentum = clamp(Math.round(candleMomentum), 0, 100);

  let volumeMomentum = 50;

  if (priorVolumeAverage > 0) {
    const relativeVolume = recentVolumeAverage / priorVolumeAverage;

    if (relativeVolume >= 1.5) volumeMomentum += 25;
    else if (relativeVolume >= 1.2) volumeMomentum += 15;
    else if (relativeVolume < 0.75) volumeMomentum -= 10;
  }

  volumeMomentum = clamp(Math.round(volumeMomentum), 0, 100);

  let atrMomentum = 50;

  if (priorAtr > 0) {
    const atrRatio = recentAtr / priorAtr;

    if (atrRatio >= 1.4) atrMomentum += 25;
    else if (atrRatio >= 1.15) atrMomentum += 15;
    else if (atrRatio < 0.85) atrMomentum -= 15;
  }

  atrMomentum = clamp(Math.round(atrMomentum), 0, 100);

  const score = clamp(
    Math.round(
      emaMomentum * 0.3 +
        vwapMomentum * 0.25 +
        candleMomentum * 0.2 +
        volumeMomentum * 0.15 +
        atrMomentum * 0.1,
    ),
    0,
    100,
  );

  const priorScore = clamp(
    Math.round(
      emaMomentum * 0.3 +
        vwapMomentum * 0.25 +
        50 * 0.2 +
        volumeMomentum * 0.15 +
        atrMomentum * 0.1,
    ),
    0,
    100,
  );

  return {
    score,

    direction: getDirection(score),
    status: getStatus(score),

    emaMomentum,
    vwapMomentum,
    candleMomentum,
    volumeMomentum,
    atrMomentum,

    increasing: score >= priorScore + 8,
    fading: score <= priorScore - 8,
  };
}