// src/components/chart/studies/StructureStudy.ts

import type { Time } from "lightweight-charts";

import {
  type MarketStructurePointType,
  type PendingMarketStructurePointType,
} from "../analysis/MarketStructureEngine";
import type { CleanBar } from "../ChartTypes";

export type StructureLineSide = "high" | "low";

export type StructureLayer = "external" | "internal";

export type StructureLabel = MarketStructurePointType | PendingMarketStructurePointType | "H" | "L" | "iH" | "iL" | "iHH" | "iHL" | "iLH" | "iLL" | "EQH" | "EQL" | "iEQH" | "iEQL" | "BOS" | "CHoCH" | "iBOS" | "iCHoCH";

export interface StructureStudyLine {
  id: string;
  side: StructureLineSide;
  label: StructureLabel;
  layer?: StructureLayer;
  price: number;
  pointTime: Time;
  confirmationTime: Time;
  startTime: Time;
  endTime: Time;
  color: string;
  lineWidth: number;
  lineStyle: "solid" | "dashed";
  pending: boolean;
}

export interface StructureStudySettings {
  enabled: boolean;
  showHighs: boolean;
  showLows: boolean;
  maxLevels: number;
  swingStrength: number;
  showExternal: boolean;
  showInternal: boolean;
  internalSwingStrength: number;
  maxInternalLevels: number;
  showBOS: boolean;
  showCHoCH: boolean;
  priceSource: "body" | "wick";
  bullishHighColor: string;
  bullishLowColor: string;
  bearishHighColor: string;
  bearishLowColor: string;
  lineWidth: number;
  showPending: boolean;
  pendingColor: string;
}

export const DEFAULT_STRUCTURE_STUDY_SETTINGS: StructureStudySettings = {
  enabled: true,
  showHighs: true,
  showLows: true,
  maxLevels: 100,
  swingStrength: 3,
  showExternal: true,
  showInternal: true,
  internalSwingStrength: 1,
  maxInternalLevels: 150,
  showBOS: true,
  showCHoCH: true,
  priceSource: "body",
  bullishHighColor: "#22c55e",
  bullishLowColor: "#38bdf8",
  bearishHighColor: "#f97316",
  bearishLowColor: "#ef4444",
  lineWidth: 2,
  showPending: true,
  pendingColor: "#facc15",
};

function normalizePositiveInteger(
  value: number,
  fallback: number,
  minimum = 1,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
}

export function normalizeStructureStudySettings(
  settings?: Partial<StructureStudySettings>,
): StructureStudySettings {
  return {
    ...DEFAULT_STRUCTURE_STUDY_SETTINGS,
    ...settings,
    maxLevels: normalizePositiveInteger(
      settings?.maxLevels ?? DEFAULT_STRUCTURE_STUDY_SETTINGS.maxLevels,
      DEFAULT_STRUCTURE_STUDY_SETTINGS.maxLevels,
    ),
    swingStrength: normalizePositiveInteger(
      settings?.swingStrength ?? DEFAULT_STRUCTURE_STUDY_SETTINGS.swingStrength,
      DEFAULT_STRUCTURE_STUDY_SETTINGS.swingStrength,
    ),
    lineWidth: Math.max(
      1,
      Math.min(
        4,
        Math.round(
          settings?.lineWidth ?? DEFAULT_STRUCTURE_STUDY_SETTINGS.lineWidth,
        ),
      ),
    ),
  };
}

interface StructurePivot {
  index: number;
  confirmationIndex: number;
  price: number;
  side: StructureLineSide;
}

function detectStructurePivots(bars: CleanBar[], strength: number, source: "body" | "wick"): StructurePivot[] {
  const n = Math.max(1, Math.round(strength));
  const highs = bars.map(b => source === "body" ? Math.max(b.open, b.close) : b.high);
  const lows = bars.map(b => source === "body" ? Math.min(b.open, b.close) : b.low);
  const result: StructurePivot[] = [];
  for (let i = n; i + n < bars.length - 1; i++) {
    let high = true;
    let low = true;
    for (let j = 1; j <= n; j++) {
      if (highs[i] < highs[i-j] || highs[i] <= highs[i+j]) high = false;
      if (lows[i] > lows[i-j] || lows[i] >= lows[i+j]) low = false;
    }
    if (high) result.push({ index: i, confirmationIndex: i+n, price: highs[i], side: "high" });
    if (low) result.push({ index: i, confirmationIndex: i+n, price: lows[i], side: "low" });
  }
  return result;
}

function classifyStructurePivots(bars: CleanBar[], pivots: StructurePivot[], settings: StructureStudySettings, layer: StructureLayer): StructureStudyLine[] {
  const internal = layer === "internal";
  const prefix = internal ? "i" : "";
  let previousHigh: number | undefined;
  let previousLow: number | undefined;
  const lines: StructureStudyLine[] = [];
  for (const pivot of pivots) {
    const high = pivot.side === "high";
    const previous = high ? previousHigh : previousLow;
    const label = previous === undefined ? (high ? "H" : "L") : Math.abs(pivot.price - previous) <= 1e-9 ? (high ? "EQH" : "EQL") : high ? (pivot.price > previous ? "HH" : "LH") : (pivot.price > previous ? "HL" : "LL");
    if (high) previousHigh = pivot.price;
    else previousLow = pivot.price;
    // Pullback labels require structural breakout confirmation.
    if (label === "HL" || label === "LH") continue;
    if (high ? !settings.showHighs : !settings.showLows) continue;
    const color = label === "HH" ? settings.bullishHighColor : label === "LL" ? settings.bearishLowColor : settings.pendingColor;
    lines.push({ id: layer + "-" + pivot.side + "-" + String(bars[pivot.index].time), layer, side: pivot.side, label: (prefix + label) as StructureLabel, price: pivot.price, pointTime: bars[pivot.index].time as Time, confirmationTime: bars[pivot.confirmationIndex].time as Time, startTime: bars[pivot.index].time as Time, endTime: bars[pivot.confirmationIndex].time as Time, color, lineWidth: internal ? 1 : settings.lineWidth, lineStyle: internal ? "dashed" : "solid", pending: false });
  }
  return lines;
}

function detectStructureBreaks(bars: CleanBar[], pivots: StructurePivot[], settings: StructureStudySettings, layer: StructureLayer): StructureStudyLine[] {
  const internal = layer === "internal";
  const lines: StructureStudyLine[] = [];
  let high: StructurePivot | undefined;
  let low: StructurePivot | undefined;
  let highBroken = false;
  let lowBroken = false;
  let bias = 0;
  let cursor = 0;
  const pullbackPivots = internal ? pivots : detectStructurePivots(bars, Math.min(settings.internalSwingStrength, settings.swingStrength), settings.priceSource);
  for (let t = 0; t < bars.length - 1; t++) {
    const close = bars[t].close;
    const bullish = high !== undefined && !highBroken && close > high.price + 1e-9;
    const bearish = low !== undefined && !lowBroken && close < low.price - 1e-9;
    const direction = bullish && !bearish ? 1 : bearish && !bullish ? -1 : 0;
    if (direction !== 0) {
      const pivot = direction === 1 ? high : low;
      const choch = bias !== 0 && bias !== direction;
      if (pivot && !choch) {
        const side = direction === 1 ? "low" : "high";
        const candidates = pullbackPivots.filter(p => p.side === side && p.index > pivot.index && p.confirmationIndex <= t);
        const previous = direction === 1 ? low : high;
        const candidate = candidates.reduce<StructurePivot | undefined>((best, p) => !best || (direction === 1 ? p.price <= best.price : p.price >= best.price) ? p : best, undefined);
        if (candidate && previous && (direction === 1 ? candidate.price > previous.price + 1e-9 : candidate.price < previous.price - 1e-9)) {
          const label = ((internal ? "i" : "") + (direction === 1 ? "HL" : "LH")) as StructureLabel;
          if (direction === 1) {
            low = candidate;
            lowBroken = false;
          } else {
            high = candidate;
            highBroken = false;
          }
          const pointTime = bars[candidate.index].time as Time;
          const id = layer + "-confirmed-pullback-" + side + "-" + String(pointTime);
          if ((direction === 1 ? settings.showLows : settings.showHighs) && !lines.some(line => line.id === id)) lines.push({ id, layer, side, label, price: candidate.price, pointTime, confirmationTime: bars[t].time as Time, startTime: pointTime, endTime: bars[t].time as Time, color: direction === 1 ? settings.bullishLowColor : settings.bearishHighColor, lineWidth: internal ? 1 : settings.lineWidth, lineStyle: internal ? "dashed" : "solid", pending: false });
        }
      }
      bias = direction;
      if (direction === 1) highBroken = true;
      else lowBroken = true;
      if (pivot && (choch ? settings.showCHoCH : settings.showBOS) && (direction === 1 ? settings.showHighs : settings.showLows)) {
        const label = ((internal ? "i" : "") + (choch ? "CHoCH" : "BOS")) as StructureLabel;
        lines.push({ id: layer + "-break-" + pivot.side + "-" + String(bars[pivot.index].time) + "-" + String(bars[t].time), layer, side: pivot.side, label, price: pivot.price, pointTime: bars[t].time as Time, confirmationTime: bars[t].time as Time, startTime: bars[pivot.index].time as Time, endTime: bars[t].time as Time, color: direction === 1 ? settings.bullishHighColor : settings.bearishLowColor, lineWidth: internal ? 1 : settings.lineWidth, lineStyle: "dashed", pending: false });
      }
    }
    while (cursor < pivots.length && pivots[cursor].confirmationIndex === t) {
      const pivot = pivots[cursor++];
      if (pivot.side === "high") {
        if (!high || highBroken || (bias >= 0 && pivot.price > high.price + 1e-9)) {
          high = pivot;
          highBroken = false;
        }
      } else {
        if (!low || lowBroken || (bias <= 0 && pivot.price < low.price - 1e-9)) {
          low = pivot;
          lowBroken = false;
        }
      }
    }
  }
  return lines;
}

export function buildStructureStudyLines(
  bars: CleanBar[],
  settingsInput?: Partial<StructureStudySettings>,
): StructureStudyLine[] {
  const settings = normalizeStructureStudySettings(settingsInput);
  if (!settings.enabled || bars.length < 4) return [];
  function buildLayer(layer: StructureLayer): StructureStudyLine[] {
    const internal = layer === "internal";
    const strength = internal ? settings.internalSwingStrength : settings.swingStrength;
    const limit = Math.max(1, Math.round(internal ? settings.maxInternalLevels : settings.maxLevels));
    const pivots = detectStructurePivots(bars, strength, settings.priceSource);
    const swings = classifyStructurePivots(bars, pivots, settings, layer).slice(-limit);
    const breaks = detectStructureBreaks(bars, pivots, settings, layer).slice(-limit);
    return [...swings, ...breaks];
  }
  const external = settings.showExternal ? buildLayer("external") : [];
  const internal = settings.showInternal ? buildLayer("internal") : [];
  const isBreak = (line: StructureStudyLine) => line.label.endsWith("BOS") || line.label.endsWith("CHoCH");
  const key = (line: StructureStudyLine) => [isBreak(line), line.side, line.pointTime, line.price].join("|");
  const externalKeys = new Set(external.map(key));
  return [...internal.filter(line => !externalKeys.has(key(line))), ...external];
}
