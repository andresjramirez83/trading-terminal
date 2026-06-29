import type { ChartState } from "../../../ChartState";
import type { CleanBar } from "../../../ChartTypes";
import type { StudySnapshot } from "./StudySnapshotTypes";

function calculateEma(values: number[], length: number): number | undefined {
  if (values.length === 0) return undefined;

  const multiplier = 2 / (length + 1);
  let ema = values[0];

  for (let index = 1; index < values.length; index += 1) {
    ema = values[index] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

function calculateVwap(bars: CleanBar[]): { value?: number; slope: number } {
  if (!bars.length) return { value: undefined, slope: 0 };

  let cumulativePV = 0;
  let cumulativeVolume = 0;
  const values: number[] = [];

  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativePV += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;

    if (cumulativeVolume > 0) {
      values.push(cumulativePV / cumulativeVolume);
    }
  }

  const value = values[values.length - 1];
  const previous = values.length > 1 ? values[values.length - 2] : value;

  return {
    value,
    slope: value != null && previous != null ? value - previous : 0,
  };
}

function calculateAtr(bars: CleanBar[], length = 14): { value?: number; expanding: boolean } {
  if (bars.length < 2) return { value: undefined, expanding: false };

  const trueRanges: number[] = [];

  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];

    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recent = trueRanges.slice(-length);
  const value =
    recent.reduce((sum, item) => sum + item, 0) / Math.max(1, recent.length);

  const currentRange =
    bars.length > 0
      ? bars[bars.length - 1].high - bars[bars.length - 1].low
      : 0;

  return {
    value,
    expanding: value > 0 ? currentRange >= value * 1.2 : false,
  };
}

function calculateVolume(bars: CleanBar[]): {
  current?: number;
  average?: number;
  relative?: number;
} {
  const lastBar = bars[bars.length - 1];
  if (!lastBar) return {};

  const sample = bars.slice(-20);
  const average =
    sample.reduce((sum, bar) => sum + bar.volume, 0) / Math.max(1, sample.length);

  return {
    current: lastBar.volume,
    average,
    relative: average > 0 ? lastBar.volume / average : undefined,
  };
}

export function buildDemoStudySnapshot(): StudySnapshot {
  return buildStudySnapshot(null);
}

export function buildStudySnapshot(chartState?: ChartState | null): StudySnapshot {
  const bars = chartState?.bars ?? [];
  const lastBar = chartState?.lastBar ?? bars[bars.length - 1];
  const closes = bars.map((bar) => bar.close);
  const vwap = calculateVwap(bars);
  const atr = calculateAtr(bars);
  const volume = chartState?.volume?.current != null
    ? {
        ...calculateVolume(bars),
        ...chartState.volume,
      }
    : calculateVolume(bars);

  return {
    symbol: chartState?.symbol ?? "DEMO",
    timeframe: chartState?.timeframe ?? "--",
    price: chartState?.price ?? lastBar?.close ?? 0,

    ema: {
      ema9: chartState?.ema?.ema9 ?? 0,
      ema20: chartState?.ema?.ema20 ?? 0,
      ema50: chartState?.ema?.ema50 ?? 0,
    },

    vwap: {
      value: chartState?.vwap?.value ?? vwap.value ?? 0,
      slope: vwap.slope,
    },

    atr: {
      value: chartState?.atr?.value ?? 0,
      expanding: chartState?.atr?.expanding ?? false,
    },

    volume: {
      current: volume.current ?? 0,
      average: volume.average ?? 0,
      relative: volume.relative ?? 0,
    },

    structure: {
      trend: chartState?.structure?.trend ?? "neutral",

      bos: chartState?.structure?.bos ?? false,
      choch: chartState?.structure?.choch ?? false,

      higherHighs: chartState?.structure?.higherHighs ?? false,
      higherLows: chartState?.structure?.higherLows ?? false,

      lowerHighs: chartState?.structure?.lowerHighs ?? false,
      lowerLows: chartState?.structure?.lowerLows ?? false,

      swingHigh: chartState?.structure?.swingHigh,
      swingLow: chartState?.structure?.swingLow,

      lastSwingHigh: chartState?.structure?.lastSwingHigh,
      lastSwingLow: chartState?.structure?.lastSwingLow,

      bullishCount: chartState?.structure?.bullishCount ?? 0,
      bearishCount: chartState?.structure?.bearishCount ?? 0,

      strength: chartState?.structure?.strength ?? 50,
    },

    compression: {
      score: chartState?.compression?.score ?? 0,
      breaking: chartState?.compression?.breaking ?? false,
    },
        momentum: {
      score: chartState?.momentum?.score ?? 50,

      direction: chartState?.momentum?.direction ?? "neutral",
      status: chartState?.momentum?.status ?? "Neutral",

      emaMomentum: chartState?.momentum?.emaMomentum ?? 50,
      vwapMomentum: chartState?.momentum?.vwapMomentum ?? 50,
      candleMomentum: chartState?.momentum?.candleMomentum ?? 50,
      volumeMomentum: chartState?.momentum?.volumeMomentum ?? 50,
      atrMomentum: chartState?.momentum?.atrMomentum ?? 50,

      increasing: chartState?.momentum?.increasing ?? false,
      fading: chartState?.momentum?.fading ?? false,
    },
  };
}
