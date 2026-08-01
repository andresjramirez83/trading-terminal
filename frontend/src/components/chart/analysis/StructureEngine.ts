// src/components/chart/analysis/StructureEngine.ts

import type { CleanBar } from "../ChartTypes";

export type MarketLegDirection = "up" | "down";
export type StructureSide = "high" | "low";
export type StructureLevelRole = "origin" | "extreme";

export interface MarketLeg {
  id: string;
  direction: MarketLegDirection;

  startIndex: number;
  endIndex: number;

  startTime: number;
  endTime: number;

  startPrice: number;
  endPrice: number;

  range: number;
  percentMove: number;
  atrMultiple: number;

  durationBars: number;
  directionalBodyRatio: number;
  relativeVolume: number;

  score: number;
}

export interface StructureZone {
  id: string;

  side: StructureSide;
  role: StructureLevelRole;

  top: number;
  bottom: number;
  midpoint: number;

  startIndex: number;
  startTime: number;

  breakIndex: number | null;
  breakTime: number | null;

  active: boolean;

  legId: string;
  legDirection: MarketLegDirection;
  legScore: number;
  atrMultiple: number;
}

export interface StructureLevel {
  id: string;

  side: StructureSide;
  role: StructureLevelRole;

  // Compatibility price used by the current line renderer.
  // For demand, this is the zone top. For supply, this is the zone bottom.
  price: number;

  zoneTop: number;
  zoneBottom: number;
  zoneMidpoint: number;

  pivotIndex: number;
  pivotTime: number;

  breakIndex: number | null;
  breakTime: number | null;

  active: boolean;

  legId: string;
  legDirection: MarketLegDirection;
  legScore: number;
  atrMultiple: number;
}

export interface StructureSettings {
  atrLength: number;

  minLegBars: number;
  maxLegBars: number;

  minAtrMultiple: number;
  minDirectionalBodyRatio: number;

  reversalAtrMultiple: number;
  mergeDistanceAtr: number;

  minScore: number;
  maxLevels: number;

  originLookbackBars: number;
  maxBaseBars: number;
  maxZoneWidthAtr: number;
  baseRangeAtr: number;
}

export const DEFAULT_STRUCTURE_SETTINGS: StructureSettings = {
  atrLength: 14,

  minLegBars: 3,
  maxLegBars: 30,

  minAtrMultiple: 2.75,
  minDirectionalBodyRatio: 0.54,

  reversalAtrMultiple: 0.9,
  mergeDistanceAtr: 0.55,

  minScore: 52,
  maxLevels: 8,

  originLookbackBars: 8,
  maxBaseBars: 4,
  maxZoneWidthAtr: 1.25,
  baseRangeAtr: 1.15,
};

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizePositiveInteger(
  value: number,
  fallback: number,
  minimum = 1,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
}

function normalizeSettings(
  settings?: Partial<StructureSettings>,
): StructureSettings {
  const merged = {
    ...DEFAULT_STRUCTURE_SETTINGS,
    ...(settings ?? {}),
  };

  return {
    atrLength: normalizePositiveInteger(
      merged.atrLength,
      DEFAULT_STRUCTURE_SETTINGS.atrLength,
      2,
    ),
    minLegBars: normalizePositiveInteger(
      merged.minLegBars,
      DEFAULT_STRUCTURE_SETTINGS.minLegBars,
      1,
    ),
    maxLegBars: normalizePositiveInteger(
      merged.maxLegBars,
      DEFAULT_STRUCTURE_SETTINGS.maxLegBars,
      2,
    ),
    minAtrMultiple: Math.max(0.25, Number(merged.minAtrMultiple)),
    minDirectionalBodyRatio: clamp(
      Number(merged.minDirectionalBodyRatio),
      0,
      1,
    ),
    reversalAtrMultiple: Math.max(
      0.1,
      Number(merged.reversalAtrMultiple),
    ),
    mergeDistanceAtr: Math.max(0, Number(merged.mergeDistanceAtr)),
    minScore: clamp(Number(merged.minScore), 0, 100),
    maxLevels: normalizePositiveInteger(
      merged.maxLevels,
      DEFAULT_STRUCTURE_SETTINGS.maxLevels,
      2,
    ),
    originLookbackBars: normalizePositiveInteger(
      merged.originLookbackBars,
      DEFAULT_STRUCTURE_SETTINGS.originLookbackBars,
      2,
    ),
    maxBaseBars: normalizePositiveInteger(
      merged.maxBaseBars,
      DEFAULT_STRUCTURE_SETTINGS.maxBaseBars,
      1,
    ),
    maxZoneWidthAtr: Math.max(0.2, Number(merged.maxZoneWidthAtr)),
    baseRangeAtr: Math.max(0.2, Number(merged.baseRangeAtr)),
  };
}

function computeAtrValues(bars: CleanBar[], length: number): number[] {
  const values = new Array<number>(bars.length).fill(0);
  if (bars.length < 2) return values;

  let smoothed = 0;

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1]?.close ?? bar.close;

    const trueRange = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );

    if (index < length) {
      smoothed =
        (smoothed * Math.max(0, index - 1) + trueRange) /
        Math.max(1, index);
    } else {
      smoothed = (smoothed * (length - 1) + trueRange) / length;
    }

    values[index] = smoothed;
  }

  return values;
}

function computeAverageVolumeValues(
  bars: CleanBar[],
  length = 20,
): number[] {
  const values = new Array<number>(bars.length).fill(0);
  let rollingTotal = 0;

  for (let index = 0; index < bars.length; index += 1) {
    rollingTotal += Math.max(0, bars[index]?.volume ?? 0);

    if (index >= length) {
      rollingTotal -= Math.max(0, bars[index - length]?.volume ?? 0);
    }

    const count = Math.min(index + 1, length);
    values[index] = count > 0 ? rollingTotal / count : 0;
  }

  return values;
}

function getDirectionalBodyRatio(
  bars: CleanBar[],
  startIndex: number,
  endIndex: number,
  direction: MarketLegDirection,
): number {
  let directionalBody = 0;
  let totalBody = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const bar = bars[index];
    if (!bar) continue;

    const body = Math.abs(bar.close - bar.open);
    totalBody += body;

    const directional =
      direction === "up"
        ? bar.close > bar.open
        : bar.close < bar.open;

    if (directional) directionalBody += body;
  }

  return totalBody > 0 ? directionalBody / totalBody : 0;
}

function getRelativeVolume(
  bars: CleanBar[],
  averageVolumes: number[],
  startIndex: number,
  endIndex: number,
): number {
  const ratios: number[] = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    const bar = bars[index];
    const averageVolume = averageVolumes[index];

    if (!bar || averageVolume <= 0) continue;
    ratios.push(Math.max(0, bar.volume) / averageVolume);
  }

  return ratios.length ? average(ratios) : 1;
}

function scoreLeg(input: {
  atrMultiple: number;
  durationBars: number;
  directionalBodyRatio: number;
  relativeVolume: number;
}): number {
  const distanceScore = clamp(input.atrMultiple / 8, 0, 1) * 45;

  const speed = input.atrMultiple / Math.max(1, input.durationBars);
  const speedScore = clamp(speed / 1.2, 0, 1) * 25;

  const bodyScore =
    clamp((input.directionalBodyRatio - 0.45) / 0.45, 0, 1) * 20;

  const volumeScore =
    clamp((input.relativeVolume - 0.85) / 1.15, 0, 1) * 10;

  return Math.round(
    clamp(distanceScore + speedScore + bodyScore + volumeScore, 0, 100),
  );
}

function buildLeg(input: {
  bars: CleanBar[];
  atrValues: number[];
  averageVolumes: number[];
  startIndex: number;
  endIndex: number;
  direction: MarketLegDirection;
}): MarketLeg | null {
  const {
    bars,
    atrValues,
    averageVolumes,
    startIndex,
    endIndex,
    direction,
  } = input;

  const startBar = bars[startIndex];
  const endBar = bars[endIndex];

  if (!startBar || !endBar || endIndex <= startIndex) return null;

  const startPrice = direction === "up" ? startBar.low : startBar.high;
  const endPrice = direction === "up" ? endBar.high : endBar.low;

  const range = Math.abs(endPrice - startPrice);
  const atr = Math.max(
    atrValues[startIndex] || 0,
    atrValues[endIndex] || 0,
  );

  if (!Number.isFinite(range) || range <= 0 || atr <= 0) return null;

  const durationBars = endIndex - startIndex + 1;
  const atrMultiple = range / atr;
  const percentMove =
    startPrice !== 0
      ? ((endPrice - startPrice) / Math.abs(startPrice)) * 100
      : 0;

  const directionalBodyRatio = getDirectionalBodyRatio(
    bars,
    startIndex,
    endIndex,
    direction,
  );

  const relativeVolume = getRelativeVolume(
    bars,
    averageVolumes,
    startIndex,
    endIndex,
  );

  const score = scoreLeg({
    atrMultiple,
    durationBars,
    directionalBodyRatio,
    relativeVolume,
  });

  return {
    id: `${direction}-${Number(startBar.time)}-${Number(endBar.time)}`,
    direction,
    startIndex,
    endIndex,
    startTime: Number(startBar.time),
    endTime: Number(endBar.time),
    startPrice,
    endPrice,
    range,
    percentMove,
    atrMultiple,
    durationBars,
    directionalBodyRatio,
    relativeVolume,
    score,
  };
}

function passesLegFilters(
  leg: MarketLeg | null,
  settings: StructureSettings,
): leg is MarketLeg {
  return (
    leg != null &&
    leg.atrMultiple >= settings.minAtrMultiple &&
    leg.directionalBodyRatio >= settings.minDirectionalBodyRatio &&
    leg.score >= settings.minScore
  );
}

function chooseStrongerLeg(
  upLeg: MarketLeg | null,
  downLeg: MarketLeg | null,
): MarketLeg | null {
  if (!upLeg) return downLeg;
  if (!downLeg) return upLeg;

  if (upLeg.score !== downLeg.score) {
    return upLeg.score > downLeg.score ? upLeg : downLeg;
  }

  return upLeg.atrMultiple >= downLeg.atrMultiple ? upLeg : downLeg;
}

function findCandidateLegs(
  bars: CleanBar[],
  settings: StructureSettings,
  atrValues: number[],
  averageVolumes: number[],
): MarketLeg[] {
  const legs: MarketLeg[] = [];

  for (
    let startIndex = 1;
    startIndex < bars.length - settings.minLegBars;
    startIndex += 1
  ) {
    const startBar = bars[startIndex];
    const atr = atrValues[startIndex];

    if (!startBar || atr <= 0) continue;

    let highestIndex = startIndex;
    let lowestIndex = startIndex;
    let highestPrice = startBar.high;
    let lowestPrice = startBar.low;

    const limit = Math.min(
      bars.length - 1,
      startIndex + settings.maxLegBars - 1,
    );

    for (
      let scanIndex = startIndex + 1;
      scanIndex <= limit;
      scanIndex += 1
    ) {
      const bar = bars[scanIndex];
      if (!bar) continue;

      if (bar.high > highestPrice) {
        highestPrice = bar.high;
        highestIndex = scanIndex;
      }

      if (bar.low < lowestPrice) {
        lowestPrice = bar.low;
        lowestIndex = scanIndex;
      }

      const enoughBars =
        scanIndex - startIndex + 1 >= settings.minLegBars;

      if (!enoughBars) continue;

      const upRange = highestPrice - startBar.low;
      const downRange = startBar.high - lowestPrice;

      const upConfirmed =
        upRange >= atr * settings.minAtrMultiple &&
        highestPrice - bar.low >=
          atr * settings.reversalAtrMultiple;

      const downConfirmed =
        downRange >= atr * settings.minAtrMultiple &&
        bar.high - lowestPrice >=
          atr * settings.reversalAtrMultiple;

      if (!upConfirmed && !downConfirmed) continue;

      const upLeg = upConfirmed
        ? buildLeg({
            bars,
            atrValues,
            averageVolumes,
            startIndex,
            endIndex: highestIndex,
            direction: "up",
          })
        : null;

      const downLeg = downConfirmed
        ? buildLeg({
            bars,
            atrValues,
            averageVolumes,
            startIndex,
            endIndex: lowestIndex,
            direction: "down",
          })
        : null;

      const acceptedUp = passesLegFilters(upLeg, settings) ? upLeg : null;
      const acceptedDown = passesLegFilters(downLeg, settings)
        ? downLeg
        : null;

      const winner = chooseStrongerLeg(acceptedUp, acceptedDown);

      if (winner) {
        legs.push(winner);
        break;
      }
    }
  }

  return legs;
}

function removeOverlappingLegs(legs: MarketLeg[]): MarketLeg[] {
  const strongestFirst = [...legs].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.atrMultiple - a.atrMultiple;
  });

  const accepted: MarketLeg[] = [];

  for (const candidate of strongestFirst) {
    const overlapsSameDirection = accepted.some((existing) => {
      if (existing.direction !== candidate.direction) return false;

      const overlapStart = Math.max(
        candidate.startIndex,
        existing.startIndex,
      );
      const overlapEnd = Math.min(candidate.endIndex, existing.endIndex);

      if (overlapEnd < overlapStart) return false;

      const candidateLength =
        candidate.endIndex - candidate.startIndex + 1;
      const overlapLength = overlapEnd - overlapStart + 1;

      return overlapLength / candidateLength >= 0.55;
    });

    if (!overlapsSameDirection) accepted.push(candidate);
  }

  return accepted.sort((a, b) => a.startIndex - b.startIndex);
}

export function buildMarketLegs(
  bars: CleanBar[],
  settingsInput?: Partial<StructureSettings>,
): MarketLeg[] {
  if (bars.length < 10) return [];

  const settings = normalizeSettings(settingsInput);
  const atrValues = computeAtrValues(bars, settings.atrLength);
  const averageVolumes = computeAverageVolumeValues(bars);

  return removeOverlappingLegs(
    findCandidateLegs(
      bars,
      settings,
      atrValues,
      averageVolumes,
    ),
  );
}

function isOpposingCandle(
  bar: CleanBar,
  direction: MarketLegDirection,
): boolean {
  return direction === "up"
    ? bar.close < bar.open
    : bar.close > bar.open;
}

function isCompactBaseCandle(
  bar: CleanBar,
  atr: number,
  settings: StructureSettings,
): boolean {
  if (atr <= 0) return false;
  return bar.high - bar.low <= atr * settings.baseRangeAtr;
}

function findOriginBase(
  bars: CleanBar[],
  atrValues: number[],
  leg: MarketLeg,
  settings: StructureSettings,
): {
  startIndex: number;
  endIndex: number;
  top: number;
  bottom: number;
} {
  const searchStart = Math.max(
    0,
    leg.startIndex - settings.originLookbackBars,
  );
  const searchEnd = Math.min(leg.endIndex, leg.startIndex + 2);

  let anchorIndex = leg.startIndex;

  // Prefer the final opposing candle immediately before displacement.
  for (let index = searchEnd; index >= searchStart; index -= 1) {
    const bar = bars[index];
    if (!bar) continue;

    if (isOpposingCandle(bar, leg.direction)) {
      anchorIndex = index;
      break;
    }
  }

  let startIndex = anchorIndex;
  let endIndex = anchorIndex;

  // Expand backward through a small compact base.
  for (
    let index = anchorIndex - 1;
    index >= searchStart &&
    endIndex - index + 1 <= settings.maxBaseBars;
    index -= 1
  ) {
    const bar = bars[index];
    const atr = atrValues[index] || atrValues[anchorIndex] || 0;

    if (!bar || !isCompactBaseCandle(bar, atr, settings)) break;
    startIndex = index;
  }

  // Expand forward only through compact candles before the impulse.
  for (
    let index = anchorIndex + 1;
    index <= Math.min(leg.startIndex + 1, leg.endIndex) &&
    index - startIndex + 1 <= settings.maxBaseBars;
    index += 1
  ) {
    const bar = bars[index];
    const atr = atrValues[index] || atrValues[anchorIndex] || 0;

    if (!bar || !isCompactBaseCandle(bar, atr, settings)) break;
    endIndex = index;
  }

  const baseBars = bars.slice(startIndex, endIndex + 1);
  const rawTop = Math.max(...baseBars.map((bar) => bar.high));
  const rawBottom = Math.min(...baseBars.map((bar) => bar.low));

  const anchorAtr =
    atrValues[anchorIndex] ||
    atrValues[leg.startIndex] ||
    Math.max(rawTop - rawBottom, 0.000001);

  const maxWidth = anchorAtr * settings.maxZoneWidthAtr;

  if (rawTop - rawBottom <= maxWidth) {
    return {
      startIndex,
      endIndex,
      top: rawTop,
      bottom: rawBottom,
    };
  }

  const anchor = bars[anchorIndex];

  if (leg.direction === "up") {
    const bodyTop = Math.max(anchor.open, anchor.close);

    return {
      startIndex: anchorIndex,
      endIndex: anchorIndex,
      top: bodyTop,
      bottom: Math.max(anchor.low, bodyTop - maxWidth),
    };
  }

  const bodyBottom = Math.min(anchor.open, anchor.close);

  return {
    startIndex: anchorIndex,
    endIndex: anchorIndex,
    top: Math.min(anchor.high, bodyBottom + maxWidth),
    bottom: bodyBottom,
  };
}

function findZoneBreak(
  bars: CleanBar[],
  side: StructureSide,
  top: number,
  bottom: number,
  startIndex: number,
): {
  breakIndex: number | null;
  breakTime: number | null;
} {
  for (let index = startIndex + 1; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!bar) continue;

    const broken =
      side === "high"
        ? bar.close > top
        : bar.close < bottom;

    if (broken) {
      return {
        breakIndex: index,
        breakTime: Number(bar.time),
      };
    }
  }

  return {
    breakIndex: null,
    breakTime: null,
  };
}

function makeOriginZone(
  bars: CleanBar[],
  atrValues: number[],
  leg: MarketLeg,
  settings: StructureSettings,
): StructureZone {
  const base = findOriginBase(bars, atrValues, leg, settings);
  const side: StructureSide = leg.direction === "up" ? "low" : "high";
  const broken = findZoneBreak(
    bars,
    side,
    base.top,
    base.bottom,
    base.endIndex,
  );

  return {
    id: `origin-${side}-${leg.id}`,
    side,
    role: "origin",
    top: base.top,
    bottom: base.bottom,
    midpoint: (base.top + base.bottom) / 2,
    startIndex: base.startIndex,
    startTime: Number(bars[base.startIndex]?.time ?? leg.startTime),
    breakIndex: broken.breakIndex,
    breakTime: broken.breakTime,
    active: broken.breakIndex == null,
    legId: leg.id,
    legDirection: leg.direction,
    legScore: leg.score,
    atrMultiple: leg.atrMultiple,
  };
}

function makeExtremeZone(
  bars: CleanBar[],
  atrValues: number[],
  leg: MarketLeg,
  settings: StructureSettings,
): StructureZone {
  const side: StructureSide = leg.direction === "up" ? "high" : "low";
  const bar = bars[leg.endIndex];
  const atr = atrValues[leg.endIndex] || 0;
  const maxWidth = Math.max(
    atr * Math.min(settings.maxZoneWidthAtr, 0.75),
    Math.abs(bar.close - bar.open),
  );

  let top: number;
  let bottom: number;

  if (side === "high") {
    top = bar.high;
    bottom = Math.max(
      Math.min(bar.open, bar.close),
      top - maxWidth,
    );
  } else {
    bottom = bar.low;
    top = Math.min(
      Math.max(bar.open, bar.close),
      bottom + maxWidth,
    );
  }

  const broken = findZoneBreak(
    bars,
    side,
    top,
    bottom,
    leg.endIndex,
  );

  return {
    id: `extreme-${side}-${leg.id}`,
    side,
    role: "extreme",
    top,
    bottom,
    midpoint: (top + bottom) / 2,
    startIndex: leg.endIndex,
    startTime: leg.endTime,
    breakIndex: broken.breakIndex,
    breakTime: broken.breakTime,
    active: broken.breakIndex == null,
    legId: leg.id,
    legDirection: leg.direction,
    legScore: leg.score,
    atrMultiple: leg.atrMultiple,
  };
}

function mergeNearbyZones(
  zones: StructureZone[],
  atrValues: number[],
  mergeDistanceAtr: number,
): StructureZone[] {
  const strongestFirst = [...zones].sort((a, b) => {
    if (b.legScore !== a.legScore) return b.legScore - a.legScore;
    return b.atrMultiple - a.atrMultiple;
  });

  const accepted: StructureZone[] = [];

  for (const candidate of strongestFirst) {
    const atr = atrValues[candidate.startIndex] || 0;
    const threshold = atr * mergeDistanceAtr;

    const duplicate = accepted.some((existing) => {
      if (existing.side !== candidate.side) return false;

      const overlap =
        candidate.bottom <= existing.top + threshold &&
        candidate.top >= existing.bottom - threshold;

      return overlap;
    });

    if (!duplicate) accepted.push(candidate);
  }

  return accepted;
}

function takeBalancedZones(
  zones: StructureZone[],
  maxLevels: number,
): StructureZone[] {
  const perSide = Math.max(1, Math.floor(maxLevels / 2));

  const rank = (side: StructureSide) =>
    zones
      .filter((zone) => zone.side === side)
      .sort((a, b) => {
        if (b.legScore !== a.legScore) return b.legScore - a.legScore;
        return b.startIndex - a.startIndex;
      })
      .slice(0, perSide);

  return [...rank("high"), ...rank("low")]
    .sort((a, b) => a.startIndex - b.startIndex);
}

export function buildStructureZones(
  bars: CleanBar[],
  settingsInput?: Partial<StructureSettings>,
): StructureZone[] {
  const settings = normalizeSettings(settingsInput);
  const atrValues = computeAtrValues(bars, settings.atrLength);
  const legs = buildMarketLegs(bars, settings);

  const rawZones = legs.flatMap((leg) => [
    makeOriginZone(bars, atrValues, leg, settings),
    makeExtremeZone(bars, atrValues, leg, settings),
  ]);

  const merged = mergeNearbyZones(
    rawZones,
    atrValues,
    settings.mergeDistanceAtr,
  );

  return takeBalancedZones(merged, settings.maxLevels);
}

/**
 * Compatibility output for the existing line-based StructureStudy.
 * The next renderer update will use zoneTop and zoneBottom directly.
 */
export function buildStructureLevels(
  bars: CleanBar[],
  settingsInput?: Partial<StructureSettings>,
): StructureLevel[] {
  return buildStructureZones(bars, settingsInput).map((zone) => ({
    id: zone.id,
    side: zone.side,
    role: zone.role,

    price: zone.side === "low" ? zone.top : zone.bottom,

    zoneTop: zone.top,
    zoneBottom: zone.bottom,
    zoneMidpoint: zone.midpoint,

    pivotIndex: zone.startIndex,
    pivotTime: zone.startTime,

    breakIndex: zone.breakIndex,
    breakTime: zone.breakTime,

    active: zone.active,

    legId: zone.legId,
    legDirection: zone.legDirection,
    legScore: zone.legScore,
    atrMultiple: zone.atrMultiple,
  }));
}