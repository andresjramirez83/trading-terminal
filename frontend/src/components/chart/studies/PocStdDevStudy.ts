// src/components/chart/studies/PocStdDevStudy.ts
//
// Fast bar-volume approximation of a volume-profile Point of Control (POC)
// with volume-weighted standard-deviation bands around that POC.
//
// Historical chart bars expose OHLCV, not true volume-at-price. We therefore
// place each candle's volume into a price bin at HLC3. This keeps the study
// deterministic and inexpensive while preserving the key idea: identify the
// price bin that accumulated the most volume, then measure dispersion around
// that price. Intraday charts reset by Pacific calendar session; higher
// timeframes remain cumulative across the loaded chart history.

import type { LineData, Time } from "lightweight-charts";
import type { CleanBar } from "../ChartTypes";

export type PocStdDevLines = {
  poc: LineData<Time>[];
  upper1: LineData<Time>[];
  lower1: LineData<Time>[];
  upper2: LineData<Time>[];
  lower2: LineData<Time>[];
  upper3: LineData<Time>[];
  lower3: LineData<Time>[];
};

type PocProfileState = {
  sessionKey: string;
  binSize: number;
  totalVolume: number;
  sumPriceVolume: number;
  sumPriceSquaredVolume: number;
  volumeByBin: Map<number, number>;
  pocBin: number | null;
  pocBinVolume: number;
};

const PACIFIC_SESSION_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const EMPTY_LINES = (): PocStdDevLines => ({
  poc: [],
  upper1: [],
  lower1: [],
  upper2: [],
  lower2: [],
  upper3: [],
  lower3: [],
});

function timeToTimestampMs(time: Time): number | null {
  if (typeof time === "number") return time * 1000;

  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (time && typeof time === "object" && "year" in time) {
    return Date.UTC(time.year, time.month - 1, time.day);
  }

  return null;
}

function getPacificSessionKey(time: Time): string {
  const timestamp = timeToTimestampMs(time);
  if (timestamp == null) return "unknown";
  return PACIFIC_SESSION_FORMATTER.format(new Date(timestamp));
}

function chooseProfileBinSize(price: number): number {
  const target = Math.max(0.001, Math.abs(price) * 0.0002);
  const ladder = [
    0.001,
    0.002,
    0.005,
    0.01,
    0.02,
    0.05,
    0.1,
    0.25,
    0.5,
    1,
    2,
    5,
    10,
  ];

  for (const size of ladder) {
    if (size >= target) return size;
  }

  return Math.pow(10, Math.ceil(Math.log10(target)));
}

function createProfileState(sessionKey: string, seedPrice: number): PocProfileState {
  return {
    sessionKey,
    binSize: chooseProfileBinSize(seedPrice),
    totalVolume: 0,
    sumPriceVolume: 0,
    sumPriceSquaredVolume: 0,
    volumeByBin: new Map<number, number>(),
    pocBin: null,
    pocBinVolume: 0,
  };
}

function addBarToProfile(state: PocProfileState, bar: CleanBar): void {
  const volume = Number(bar.volume ?? 0);
  const typicalPrice = (Number(bar.high) + Number(bar.low) + Number(bar.close)) / 3;

  if (
    !Number.isFinite(volume) ||
    volume <= 0 ||
    !Number.isFinite(typicalPrice) ||
    typicalPrice <= 0
  ) {
    return;
  }

  const bin = Math.round(typicalPrice / state.binSize);
  const nextBinVolume = (state.volumeByBin.get(bin) ?? 0) + volume;
  state.volumeByBin.set(bin, nextBinVolume);

  if (state.pocBin == null || nextBinVolume > state.pocBinVolume) {
    state.pocBin = bin;
    state.pocBinVolume = nextBinVolume;
  }

  state.totalVolume += volume;
  state.sumPriceVolume += typicalPrice * volume;
  state.sumPriceSquaredVolume += typicalPrice * typicalPrice * volume;
}

function appendCurrentBands(
  lines: PocStdDevLines,
  state: PocProfileState,
  time: Time,
): void {
  if (
    state.pocBin == null ||
    state.totalVolume <= 0 ||
    !Number.isFinite(state.totalVolume)
  ) {
    return;
  }

  const poc = state.pocBin * state.binSize;
  const mean = state.sumPriceVolume / state.totalVolume;
  const secondMoment = state.sumPriceSquaredVolume / state.totalVolume;
  const varianceAroundPoc = Math.max(
    0,
    secondMoment - 2 * poc * mean + poc * poc,
  );
  const sigma = Math.sqrt(varianceAroundPoc);

  lines.poc.push({ time, value: poc });
  lines.upper1.push({ time, value: poc + sigma });
  lines.lower1.push({ time, value: poc - sigma });
  lines.upper2.push({ time, value: poc + sigma * 2 });
  lines.lower2.push({ time, value: poc - sigma * 2 });
  lines.upper3.push({ time, value: poc + sigma * 3 });
  lines.lower3.push({ time, value: poc - sigma * 3 });
}

export function shouldResetPocEachSession(timeframe?: string): boolean {
  const value = String(timeframe ?? "").trim().toLowerCase();
  return /^\d+m$/.test(value) || /^\d+h$/.test(value);
}

export function buildPocStdDevLines(
  bars: CleanBar[],
  options?: { resetEachSession?: boolean },
): PocStdDevLines {
  const lines = EMPTY_LINES();
  if (!bars.length) return lines;

  const resetEachSession = options?.resetEachSession ?? true;
  let profile: PocProfileState | null = null;

  for (const bar of bars) {
    const seedPrice = (Number(bar.high) + Number(bar.low) + Number(bar.close)) / 3;
    if (!Number.isFinite(seedPrice) || seedPrice <= 0) continue;

    const sessionKey = resetEachSession
      ? getPacificSessionKey(bar.time)
      : "loaded-history";

    if (!profile || profile.sessionKey !== sessionKey) {
      profile = createProfileState(sessionKey, seedPrice);
    }

    addBarToProfile(profile, bar);
    appendCurrentBands(lines, profile, bar.time);
  }

  return lines;
}
