import type { CleanBar } from "../ChartTypes";

export interface CompressionResult {
  score: number;

  atrCompression: number;
  rangeCompression: number;
  volumeCompression: number;
  emaCompression: number;

  breaking: boolean;
}

const DEFAULT_RESULT: CompressionResult = {
  score: 0,
  atrCompression: 0,
  rangeCompression: 0,
  volumeCompression: 0,
  emaCompression: 0,
  breaking: false,
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

function compressionFromRatio(current: number, baseline: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) {
    return 0;
  }

  const ratio = current / baseline;

  return clamp(Math.round((1 - ratio) * 100), 0, 100);
}

export function buildCompression(
  bars: CleanBar[],
  lookback = 20,
): CompressionResult {
  if (!bars.length || bars.length < lookback * 2) {
    return DEFAULT_RESULT;
  }

  const recentBars = bars.slice(-lookback);
  const priorBars = bars.slice(-(lookback * 2), -lookback);

  const recentRanges = recentBars.map((bar) => bar.high - bar.low);
  const priorRanges = priorBars.map((bar) => bar.high - bar.low);

  const recentVolumes = recentBars.map((bar) => bar.volume ?? 0);
  const priorVolumes = priorBars.map((bar) => bar.volume ?? 0);

  const currentRangeAverage = average(recentRanges);
  const priorRangeAverage = average(priorRanges);

  const currentVolumeAverage = average(recentVolumes);
  const priorVolumeAverage = average(priorVolumes);

  const atrValues = calcAtrValues(bars, lookback);
  const recentAtr = average(atrValues.slice(-lookback));
  const priorAtr = average(atrValues.slice(-(lookback * 2), -lookback));

  const closes = bars.map((bar) => bar.close);
  const ema9 = calcEma(closes, 9);
  const ema20 = calcEma(closes, 20);

  const lastClose = closes[closes.length - 1];
  const lastEma9 = ema9[ema9.length - 1];
  const lastEma20 = ema20[ema20.length - 1];

  const emaSpread =
    lastClose > 0 ? Math.abs(lastEma9 - lastEma20) / lastClose : 0;

  const atrCompression = compressionFromRatio(recentAtr, priorAtr);
  const rangeCompression = compressionFromRatio(
    currentRangeAverage,
    priorRangeAverage,
  );
  const volumeCompression = compressionFromRatio(
    currentVolumeAverage,
    priorVolumeAverage,
  );

  const emaCompression = clamp(Math.round((1 - emaSpread * 25) * 100), 0, 100);

  const score = clamp(
    Math.round(
      atrCompression * 0.35 +
        rangeCompression * 0.3 +
        volumeCompression * 0.2 +
        emaCompression * 0.15,
    ),
    0,
    100,
  );

  const previousScore = clamp(
    Math.round(
      compressionFromRatio(average(atrValues.slice(-lookback - 5, -5)), priorAtr) *
        0.35 +
        compressionFromRatio(
          average(recentRanges.slice(0, Math.max(1, lookback - 5))),
          priorRangeAverage,
        ) *
          0.3 +
        volumeCompression * 0.2 +
        emaCompression * 0.15,
    ),
    0,
    100,
  );

  const breaking = previousScore >= 65 && score <= previousScore - 12;

  return {
    score,

    atrCompression,
    rangeCompression,
    volumeCompression,
    emaCompression,

    breaking,
  };
}