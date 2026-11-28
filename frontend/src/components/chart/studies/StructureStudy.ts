import { detectConsolidationRanges } from "./ConsolidationStudy";
// src/components/chart/studies/StructureStudy.ts

import type { Time } from "lightweight-charts";

import {
  type MarketStructurePointType,
  type PendingMarketStructurePointType,
} from "../analysis/MarketStructureEngine";
import type { CleanBar } from "../ChartTypes";

export type StructureLineSide = "high" | "low";

export type StructureLayer = "external" | "internal" | "major";

export type StructureLabel = "HL Break" | "LH Break" | "dHH" | "dLL" | "mdHH" | "mdLL" | "idHH" | "idLL" | "mH" | "mL" | "mHH" | "mHL" | "mLH" | "mLL" | "mEQH" | "mEQL" | "mBOS" | "mCHoCH" | "mpHH" | "mpHL" | "mpLH" | "mpLL" | "ipHH" | "ipHL" | "ipLH" | "ipLL" | "pEQH" | "pEQL" | "mpEQH" | "mpEQL" | "ipEQH" | "ipEQL" | "pHH" | "pLL" | "pHL" | "pLH" | MarketStructurePointType | PendingMarketStructurePointType | "H" | "L" | "iH" | "iL" | "iHH" | "iHL" | "iLH" | "iLL" | "EQH" | "EQL" | "iEQH" | "iEQL" | "BOS" | "CHoCH" | "iBOS" | "iCHoCH";

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
  showMajor: boolean;
  majorSwingStrength: number;
  maxMajorLevels: number;
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
  swingStrength: 5,
  showMajor: true,
  majorSwingStrength: 12,
  maxMajorLevels: 60,
  showExternal: true,
  showInternal: true,
  internalSwingStrength: 1,
  maxInternalLevels: 600,
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
    majorSwingStrength: normalizePositiveInteger(settings?.majorSwingStrength ?? 12, 12),
    internalSwingStrength: normalizePositiveInteger(settings?.internalSwingStrength ?? 1, 1),
    maxMajorLevels: normalizePositiveInteger(settings?.maxMajorLevels ?? 60, 60),
    maxInternalLevels: normalizePositiveInteger(settings?.maxInternalLevels ?? 600, 600),
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

interface StructureState {
  bias: -1 | 0 | 1;
  high?: StructurePivot;
  low?: StructurePivot;
  pendingHigh?: StructurePivot;
  pendingLow?: StructurePivot;
  protectedHigh?: StructurePivot;
  protectedLow?: StructurePivot;
  classifiedHigh?: StructurePivot;
  externalReversalConfirmed?: boolean;
  classifiedLow?: StructurePivot;
  highBroken: boolean;
  lowBroken: boolean;
}

function createStructureState(): StructureState {
  return { bias: 0, highBroken: false, lowBroken: false };
}

function setStructurePoint(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, pivot: StructurePivot, label: StructureLabel, layer: StructureLayer, t: number, pending = false): void {
  const internal = layer === "internal";
  const pointTime = bars[pivot.index].time as Time;
  const id = "structure-" + layer + "-" + pivot.side + "-" + String(pointTime);
  const color = pending ? settings.pendingColor : label.endsWith("HH") ? settings.bullishHighColor : label.endsWith("HL") ? settings.bullishLowColor : label.endsWith("LH") ? settings.bearishHighColor : label.endsWith("LL") ? settings.bearishLowColor : settings.pendingColor;
  const point: StructureStudyLine = { id, layer, side: pivot.side, label, price: pivot.price, pointTime, confirmationTime: bars[t].time as Time, startTime: pointTime, endTime: bars[t].time as Time, color, lineWidth: layer === "major" ? Math.min(4, settings.lineWidth + 1) : internal ? 1 : settings.lineWidth, lineStyle: internal || pending ? "dashed" : "solid", pending };
  const existing = lines.findIndex(line => line.id === id);
  if (existing >= 0) lines[existing] = point;
  else lines.push(point);
}

function revertPendingStructure(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, pivot: StructurePivot, t: number): void {
  const id = "structure-external-" + pivot.side + "-" + String(bars[pivot.index].time);
  const point = lines.find(line => line.id === id && line.pending);
  if (!point) return;
  const label = ("i" + point.label.slice(1)) as StructureLabel;
  setStructurePoint(lines, bars, settings, pivot, label, "internal", t, false);
}

function emitStructureBreak(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, pivot: StructurePivot, layer: StructureLayer, t: number, choch: boolean): void {
  const internal = layer === "internal";
  const label = ((layer === "major" ? "m" : internal ? "i" : "") + (choch ? "CHoCH" : "BOS")) as StructureLabel;
  const pointTime = bars[t].time as Time;
  const id = layer + "-break-" + pivot.side + "-" + String(bars[pivot.index].time);
  if (lines.some(line => line.id === id)) return;
  lines.push({ id, layer, side: pivot.side, label, price: pivot.price, pointTime, confirmationTime: pointTime, startTime: bars[pivot.index].time as Time, endTime: pointTime, color: pivot.side === "high" ? settings.bullishHighColor : settings.bearishLowColor, lineWidth: layer === "major" ? Math.min(4, settings.lineWidth + 1) : internal ? 1 : settings.lineWidth, lineStyle: "dashed", pending: false });
}

function trackInternalPivot(state: StructureState, pivot: StructurePivot): void {
  if (pivot.side === "high") {
    if (!state.high || state.highBroken || (state.bias >= 0 && pivot.price > state.high.price) || (state.bias < 0 && pivot.price < state.high.price)) {
      state.high = pivot;
      state.highBroken = false;
    }
    if (!state.pendingHigh || pivot.price >= state.pendingHigh.price) state.pendingHigh = pivot;
  } else {
    if (!state.low || state.lowBroken || (state.bias <= 0 && pivot.price < state.low.price) || (state.bias > 0 && pivot.price > state.low.price)) {
      state.low = pivot;
      state.lowBroken = false;
    }
    if (!state.pendingLow || pivot.price <= state.pendingLow.price) state.pendingLow = pivot;
  }
}

function getStructureBreakDirection(state: StructureState, close: number): -1 | 0 | 1 {
  const bullish = state.high !== undefined && !state.highBroken && close > state.high.price + 1e-9;
  const bearish = state.low !== undefined && !state.lowBroken && close < state.low.price - 1e-9;
  return bullish && !bearish ? 1 : bearish && !bullish ? -1 : 0;
}

function markPendingExternal(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, external: StructureState, candidate: StructurePivot, t: number): void {
  const low = candidate.side === "low";
  const previous = low ? external.classifiedLow : external.classifiedHigh;
  const old = low ? external.pendingLow : external.pendingHigh;
  if (old && old.index !== candidate.index) revertPendingStructure(lines, bars, settings, old, t);
  const label = (low ? (!previous || candidate.price < previous.price ? "pLL" : "pHL") : (!previous || candidate.price > previous.price ? "pHH" : "pLH")) as StructureLabel;
  if (low) external.pendingLow = candidate;
  else external.pendingHigh = candidate;
  setStructurePoint(lines, bars, settings, candidate, label, "external", t, true);
}

function confirmPendingExternal(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, external: StructureState, t: number): void {
  const close = bars[t].close;
  const low = external.pendingLow;
  const high = external.pendingHigh;
  if (low && external.high && close > external.high.price + 1e-9) {
    const label = (!external.classifiedLow || low.price < external.classifiedLow.price ? "LL" : low.price > external.classifiedLow.price ? "HL" : "EQL") as StructureLabel;
    setStructurePoint(lines, bars, settings, low, label, "external", t);
    if ((external.externalReversalConfirmed && external.bias === 1) || !external.low || low.price < external.low.price) external.low = low;
    if (label === "LL") external.classifiedLow = low;
    external.protectedLow = low;
    external.pendingLow = undefined;
    external.lowBroken = false;
  }
  if (high && external.low && close < external.low.price - 1e-9) {
    const label = (!external.classifiedHigh || high.price > external.classifiedHigh.price ? "HH" : high.price < external.classifiedHigh.price ? "LH" : "EQH") as StructureLabel;
    setStructurePoint(lines, bars, settings, high, label, "external", t);
    if ((external.externalReversalConfirmed && external.bias === -1) || !external.high || high.price > external.high.price) external.high = high;
    if (label === "HH") external.classifiedHigh = high;
    external.protectedHigh = high;
    external.pendingHigh = undefined;
    external.highBroken = false;
  }
}

function invalidatePendingExternal(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, external: StructureState, t: number): void {
  const close = bars[t].close;
  const low = external.pendingLow;
  const high = external.pendingHigh;
  if (low && close < low.price - 1e-9) {
    revertPendingStructure(lines, bars, settings, low, t);
    external.pendingLow = undefined;
  }
  if (high && close > high.price + 1e-9) {
    revertPendingStructure(lines, bars, settings, high, t);
    external.pendingHigh = undefined;
  }
}

function processInternalBreak(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, internal: StructureState, external: StructureState, t: number): void {
  const direction = getStructureBreakDirection(internal, bars[t].close);
  if (!direction) return;
  const reference = direction === 1 ? internal.high : internal.low;
  if (!reference) return;
  const choch = internal.bias !== 0 && internal.bias !== direction;
  const candidate = direction === 1 ? internal.pendingLow : internal.pendingHigh;
  const previous = direction === 1 ? internal.classifiedLow : internal.classifiedHigh;
  emitStructureBreak(lines, bars, settings, reference, "internal", t, choch);
  if (candidate && candidate.index > reference.index) {
    const label = (direction === 1 ? (!previous || candidate.price < previous.price ? "iLL" : "iHL") : (!previous || candidate.price > previous.price ? "iHH" : "iLH")) as StructureLabel;
    setStructurePoint(lines, bars, settings, candidate, label, "internal", t);
    if (direction === 1) internal.protectedLow = candidate;
    else internal.protectedHigh = candidate;
    const externalReference = direction === 1 ? external.high : external.low;
    if (choch || (externalReference && candidate.index > externalReference.index && direction === external.bias)) {
      markPendingExternal(lines, bars, settings, external, candidate, t);
    }
  }
  if (direction === 1) {
    internal.highBroken = true;
    internal.pendingLow = undefined;
  } else {
    internal.lowBroken = true;
    internal.pendingHigh = undefined;
  }
  if (choch) {
    if (direction === 1) internal.classifiedHigh = reference;
    else internal.classifiedLow = reference;
  }
  internal.bias = direction;
}

function processExternalBreak(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, external: StructureState, t: number): void {
  const direction = getStructureBreakDirection(external, bars[t].close);
  if (!direction) return;
  const reference = direction === 1 ? external.high : external.low;
  if (!reference) return;
  const choch = external.bias !== 0 && external.bias !== direction;
  emitStructureBreak(lines, bars, settings, reference, "external", t, choch);
  confirmPendingExternal(lines, bars, settings, external, t);
  if (direction === 1) external.highBroken = true;
  else external.lowBroken = true;
  if (choch) external.externalReversalConfirmed = true;
  external.bias = direction;
}

function initializeExternalPivot(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, external: StructureState, pivot: StructurePivot, t: number): void {
  if (pivot.side === "high" && !external.high) {
    external.high = pivot;
    external.protectedHigh = pivot;
    external.classifiedHigh = pivot;
    setStructurePoint(lines, bars, settings, pivot, "H", "external", t);
  } else if (pivot.side === "low" && !external.low) {
    external.low = pivot;
    external.protectedLow = pivot;
    external.classifiedLow = pivot;
    setStructurePoint(lines, bars, settings, pivot, "L", "external", t);
  }
}

function processInternalPivot(lines: StructureStudyLine[], bars: CleanBar[], settings: StructureStudySettings, internal: StructureState, pivot: StructurePivot, t: number): void {
  const high = pivot.side === "high";
  const previous = high ? internal.classifiedHigh : internal.classifiedLow;
  const broken = high ? internal.highBroken : internal.lowBroken;
  if (!previous) {
    setStructurePoint(lines, bars, settings, pivot, high ? "iH" : "iL", "internal", t);
  } else if (broken && (high ? pivot.price > previous.price + 1e-9 : pivot.price < previous.price - 1e-9)) {
    setStructurePoint(lines, bars, settings, pivot, high ? "iHH" : "iLL", "internal", t);
  }
  if (!previous || (broken && (high ? pivot.price > previous.price + 1e-9 : pivot.price < previous.price - 1e-9))) {
    if (high) internal.classifiedHigh = pivot;
    else internal.classifiedLow = pivot;
  }
  trackInternalPivot(internal, pivot);
}

function advanceExternalReference(external: StructureState, pivot: StructurePivot): void {
  if (pivot.side === "high" && external.highBroken && external.high && pivot.index > external.high.index && pivot.price > external.high.price + 1e-9) {
    external.high = pivot;
    external.highBroken = false;
  } else if (pivot.side === "low" && external.lowBroken && external.low && pivot.index > external.low.index && pivot.price < external.low.price - 1e-9) {
    external.low = pivot;
    external.lowBroken = false;
  }
}

interface DirectionalRun { extreme: StructurePivot; }

function detectSensitiveInternalPivots(bars: CleanBar[], strength: number, source: "body" | "wick"): StructurePivot[] {
  const bodyPivots = detectStructurePivots(bars,strength,source);
  if (source === "wick") return bodyPivots;
  const closeBars = bars.map(bar => ({ ...bar, open:bar.close }));
  const closePivots = detectStructurePivots(closeBars,strength,"body").map(p => ({ ...p, price:p.side === "high" ? Math.max(bars[p.index].open,bars[p.index].close) : Math.min(bars[p.index].open,bars[p.index].close) }));
  const combined = [...bodyPivots,...closePivots].sort((a,b) => a.confirmationIndex-b.confirmationIndex || a.index-b.index);
  const result: StructurePivot[] = [];
  const last = new Map<StructureLineSide,StructurePivot>();
  for (const p of combined) {
    const previous = last.get(p.side);
    if (previous && Math.abs(previous.price-p.price)<=1e-9 && p.index-previous.index<=Math.max(1,Math.round(strength))) continue;
    result.push(p);
    last.set(p.side,p);
  }
  return result;
}

function hasQualifiedStructurePullback(bars: CleanBar[], ref: StructurePivot, t: number, source: "body" | "wick"): boolean {
  if (t-ref.index < 3) return false;
  let atr = 0, count = 0;
  for (let j = Math.max(1,ref.index-13); j <= ref.index; j++) {
    const bar = bars[j];
    const previous = bars[j-1].close;
    atr += Math.max(bar.high-bar.low,Math.abs(bar.high-previous),Math.abs(bar.low-previous));
    count++;
  }
  if (!count || atr <= 1e-9) return false;
  atr /= count;
  let extreme = ref.price, extremeIndex = ref.index;
  for (let j = ref.index+1; j < t; j++) {
    const bar = bars[j];
    const price = ref.side === "high" ? (source === "body" ? Math.min(bar.open,bar.close) : bar.low) : (source === "body" ? Math.max(bar.open,bar.close) : bar.high);
    if (ref.side === "high" ? price < extreme : price > extreme) { extreme = price; extremeIndex = j; }
  }
  return extremeIndex-ref.index >= 2 && Math.abs(extreme-ref.price) >= 0.75*atr;
}

function calculateLocalInternalStructure(bars: CleanBar[], settings: StructureStudySettings, strength: number): StructureStudyLine[] {
  const lines: StructureStudyLine[] = [];
  const pivots = detectSensitiveInternalPivots(bars, strength, settings.priceSource);
  const bodyPivots = detectStructurePivots(bars,strength,settings.priceSource);
  let bodyCursor=0;
  let bodyHigh: StructurePivot | undefined, bodyLow: StructurePivot | undefined;
  const eps = 1e-9;
  let hi: StructurePivot | undefined, lo: StructurePivot | undefined;
  let prevHi: StructurePivot | undefined, prevLo: StructurePivot | undefined;
  let active: DirectionalRun | undefined;
  let developingLow: StructurePivot | undefined;
  let bias: -1 | 0 | 1 = 0;
  let protectedRef: StructurePivot | undefined;
  let protectedArmed = false;
  let protectedLocked = false;
  let lastReversalIndex = -1;
  const consolidationRanges = detectConsolidationRanges(bars);
  let i = 0;
  let lastConfirmedIHH: StructurePivot | undefined;
  let lastConfirmedILL: StructurePivot | undefined;
  const used = new Set<string>();
  const emitted = new Set<string>();
  const key = (p: StructurePivot) => p.side + ":" + p.index;
  const at = (j: number, side: StructureLineSide): StructurePivot => {
    const b = bars[j];
    const price = side === "high" ? (settings.priceSource === "body" ? Math.max(b.open,b.close) : b.high) : (settings.priceSource === "body" ? Math.min(b.open,b.close) : b.low);
    return { index:j, confirmationIndex:j, price, side };
  };
  const put = (p: StructurePivot, label: StructureLabel, t: number, pending = false) => {
    if (emitted.has(key(p))) return;
    setStructurePoint(lines,bars,settings,p,label,"internal",t,pending);
    if (!pending) {
      emitted.add(key(p));
      if (label === "iHH") lastConfirmedIHH = p;
      if (label === "iLL") lastConfirmedILL = p;
    }
  };
  const validSequence = (pull: StructurePivot, bullish: boolean): boolean => {
    if (!lastConfirmedIHH || pull.index <= lastConfirmedIHH.index) return false;
    if (bullish) return pull.side === "low" && pull.price < lastConfirmedIHH.price-eps;
    return !!lastConfirmedILL && lastConfirmedILL.index < lastConfirmedIHH.index && pull.side === "high" && pull.price < lastConfirmedIHH.price-eps;
  };
  for (let t = 0; t < bars.length - 1; t++) {
    if (protectedRef && protectedArmed) {
      const protectedId="structure-internal-"+protectedRef.side+"-"+String(bars[protectedRef.index].time);
      const protectedLine=lines.find(line=>line.id===protectedId && !line.pending);
      if (protectedLine) protectedLine.endTime=bars[t].time as Time;
    }
    while (bodyCursor<bodyPivots.length && bodyPivots[bodyCursor].confirmationIndex<=t) {
      const p=bodyPivots[bodyCursor++];
      if (p.side==="high") bodyHigh=p;
      else bodyLow=p;
    }
    if (developingLow) {
      const candidate = at(t,"low");
      if (candidate.price < developingLow.price-eps) developingLow = candidate;
    }
    if (active) {
      const p = at(t,active.extreme.side);
      if (p.side === "high" ? p.price >= active.extreme.price : p.price <= active.extreme.price) active.extreme = p;
    }
    while (i < pivots.length && pivots[i].confirmationIndex === t) {
      const p = pivots[i++];
      if (active && p.side === active.extreme.side && (p.index === active.extreme.index || (settings.priceSource === "body" && Math.abs(p.price-active.extreme.price)<=eps && Math.abs(p.index-active.extreme.index)<=Math.max(1,Math.round(strength)) && (p.side === "high" ? bars[t].close < p.price-eps : bars[t].close > p.price+eps)))) {
        if (p.side === "high" && (!lastConfirmedIHH || (p.index>lastConfirmedIHH.index && p.price>lastConfirmedIHH.price+eps))) put(p,"iHH",t);
        active = undefined;
      }
      if (p.side === "high") {
        if (!hi) put(p,"iH",t);
        prevHi = hi; hi = p;
      } else {
        if (!lo) put(p,"iL",t);
        prevLo = lo; lo = p;
      }
    }
    if (!hi || !lo) continue;
    const close = bars[t].close;
    let atr=0,count=0;
    for (let j=Math.max(1,t-14);j<t;j++) {
      const bar=bars[j],previous=bars[j-1].close;
      atr+=Math.max(bar.high-bar.low,Math.abs(bar.high-previous),Math.abs(bar.low-previous));
      count++;
    }
    atr=count ? atr/count : 0;
    const bodyRanges=bars.slice(Math.max(0,t-14),t).map(bar=>Math.abs(bar.close-bar.open)).sort((a,b)=>a-b);
    const medianBody=bodyRanges.length ? bodyRanges[Math.floor(bodyRanges.length/2)] : atr;
    const recovery=Math.max(eps,0.25*medianBody);
    const range=consolidationRanges.find(r=>t>=r.confirmationIndex && t<=(r.breakout ? r.endIndex-1 : r.endIndex));
    if (bias===-1 && developingLow && bodyLow && !range) {
      const recoveryLow: StructurePivot = bodyLow;
      const base: StructurePivot = developingLow;
      let recoveryHigh: StructurePivot | undefined;
      for (let j=bodyCursor-1;j>=0;j--) {
        const p=bodyPivots[j];
        if (p.index<=base.index) break;
        if (p.side==="high" && p.index<recoveryLow.index && (!recoveryHigh || p.price>recoveryHigh.price+eps)) recoveryHigh=p;
      }
      const intact=bars.slice(recoveryLow.index+1,t+1).every(bar=>bar.close>=recoveryLow.price-eps);
      const actualReversal=protectedRef && protectedArmed && !used.has(key(protectedRef)) && close>protectedRef.price+eps;
      if (!actualReversal && recoveryHigh && recoveryLow.index>lastReversalIndex && recoveryLow.index<t && recoveryLow.price>base.price+eps && !used.has(key(recoveryLow)) && intact && close-recoveryLow.price>=recovery && recoveryHigh.price-base.price>=Math.max(0.75*atr,2*medianBody,eps) && recoveryHigh.price-recoveryLow.price>=Math.max(0.15*atr,recovery)) {
        put(recoveryHigh,"iH",t);
        put(recoveryLow,"iL",t);
        protectedRef=recoveryLow;
        protectedArmed=true;
        protectedLocked=true;
        developingLow=undefined;
        active=undefined;
        bias=1;
      }
    }
    if (bias!==0) {
      const actualCandidate: StructurePivot | undefined = bias===1 ? bodyLow : bodyHigh;
      const candidate: StructurePivot = actualCandidate ?? (bias===1 ? lo : hi);
      const distance=bias===1 ? close-candidate.price : candidate.price-close;
      let continuationBreak=false;
      if (protectedRef && protectedLocked && candidate.index>protectedRef.index+1) {
        const referenceSide: StructureLineSide=bias===1 ? "high" : "low";
        let reference: StructurePivot | undefined;
        for (let j=bodyCursor-1;j>=0;j--) {
          const pivot=bodyPivots[j];
          if (pivot.index<=protectedRef.index) break;
          if (pivot.index<candidate.index && pivot.side===referenceSide) {
            reference=pivot;
            break;
          }
        }
        continuationBreak=!!reference && (bias===1 ? close>reference.price+eps : close<reference.price-eps);
      }
      const advances=!protectedRef || !protectedLocked || (continuationBreak && candidate.index>protectedRef.index && (bias===1 ? candidate.price>protectedRef.price+eps : candidate.price<protectedRef.price-eps));
      const rangeNoise=range && candidate.index>=range.startIndex && candidate.price>range.low+eps && candidate.price<range.high-eps;
      const intact=bars.slice(candidate.index+1,t+1).every(bar=>bias===1 ? bar.close>=candidate.price-eps : bar.close<=candidate.price+eps);
      if (actualCandidate && advances && candidate.index>lastReversalIndex && candidate.index<t && candidate.confirmationIndex<=t && !used.has(key(candidate)) && !rangeNoise && intact && atr>eps && distance>=recovery) {
        protectedRef=candidate;
        protectedArmed=true;
        protectedLocked=true;
        if (!emitted.has(key(candidate))) {
          const previous=lastConfirmedILL ?? prevLo;
          if (bias===1 && previous && candidate.price<previous.price-eps) put(candidate,"iLL",t);


        }
      }
      if (protectedRef && !protectedArmed && t>lastReversalIndex && atr>eps && (bias===1 ? close-protectedRef.price : protectedRef.price-close)>=recovery) protectedArmed=true;
    }
    let up=close>hi.price+eps && !used.has(key(hi));
    let down=close<lo.price-eps && !used.has(key(lo));
    let reversalRef: StructurePivot | undefined;
    if (bias!==0) {
      if (protectedRef && protectedArmed && !used.has(key(protectedRef)) && (bias===1 ? close<protectedRef.price-eps : close>protectedRef.price+eps)) {
        reversalRef=protectedRef;
        up=bias===-1;
        down=bias===1;
      } else {
        up=bias===1 && up && (!protectedRef || close>protectedRef.price+eps);
        down=bias===-1 && down && (!protectedRef || close<protectedRef.price-eps);
      }
    }
    if (up===down) continue;
    const direction: -1 | 1=up ? 1 : -1;
    const choch=!!reversalRef;
    if (down && !developingLow) developingLow=at(t,"low");
    if (up && !choch && developingLow && (developingLow.index<t || settings.priceSource==="body")) {
      const previous=lastConfirmedILL ?? prevLo;
      if (!previous || developingLow.price<previous.price-eps) put(developingLow,"iLL",t);
      developingLow=undefined;
    }
    const ref=reversalRef ?? (up ? hi : lo);
    const pull=up ? lo : hi;
    const prior=up ? prevLo : prevHi;
    const qualified=hasQualifiedStructurePullback(bars,ref,t,settings.priceSource);
    if (!choch && qualified && validSequence(pull,up) && prior && pull.index>ref.index && (up ? pull.price>prior.price+eps : pull.price<prior.price-eps)) put(pull,up ? "iHL" : "iLH",t);
    if (choch) {
      const referenceId="structure-internal-"+ref.side+"-"+String(bars[ref.index].time);
      const existingReference=lines.find(line=>line.id===referenceId && !line.pending);
      if (!existingReference) put(ref,ref.side==="low" ? "iL" : "iH",t);
    }
    if (choch || bias===0 || qualified) emitStructureBreak(lines,bars,settings,ref,"internal",t,choch);
    used.add(key(ref));
    if (choch) {
      const oppositeSide: StructureLineSide=up ? "low" : "high";
      let initialExtreme: StructurePivot | undefined;
      for (let j=bodyCursor-1;j>=0;j--) {
        const p=bodyPivots[j];
        if (p.index<ref.index && p.index>=Math.max(0,lastReversalIndex) && p.side===oppositeSide) {
          initialExtreme=p;
          break;
        }
      }
      if (initialExtreme) put(initialExtreme,up ? "iL" : "iH",t);
      let reversalExtreme: StructurePivot | undefined;
      const firstIndex=initialExtreme?.index ?? ref.index+1;
      for (let j=firstIndex;j<t;j++) {
        const p=at(j,oppositeSide);
        if (!reversalExtreme || (up ? p.price<reversalExtreme.price-eps : p.price>reversalExtreme.price+eps)) reversalExtreme=p;
      }
      if (reversalExtreme) {
        const previous=initialExtreme ?? (up ? lastConfirmedILL : lastConfirmedIHH);
        const exceeded=previous && (up ? reversalExtreme.price<previous.price-eps : reversalExtreme.price>previous.price+eps);
        const label: StructureLabel=up ? (exceeded ? "iLL" : "iL") : (exceeded && (!lastConfirmedIHH || reversalExtreme.price>lastConfirmedIHH.price+eps) ? "iHH" : "iH");
        put(reversalExtreme,label,t);
        protectedRef={...reversalExtreme,confirmationIndex:t};
        protectedArmed=!used.has(key(reversalExtreme));
        protectedLocked=true;
      } else {
        protectedRef=undefined;
        protectedArmed=false;
        protectedLocked=false;
      }
      developingLow=undefined;
      lastReversalIndex=t;
    }
    if (bias===0) {
      const seedSide: StructureLineSide=up ? "low" : "high";
      let seed: StructurePivot=pull;
      for (let j=ref.index+1;j<t;j++) {
        const p=at(j,seedSide);
        if (seed.index<=ref.index || (up ? p.price<seed.price-eps : p.price>seed.price+eps)) seed=p;
      }
      protectedRef=seed.index<t && !used.has(key(seed)) ? {...seed,confirmationIndex:t} : undefined;
      protectedArmed=false;
      protectedLocked=false;
      if (choch) lastReversalIndex=t;
    }
    bias=direction;
    const side=up ? "high" : "low";
    if (!active || active.extreme.side!==side) {
      active=up && lastConfirmedIHH && close<=lastConfirmedIHH.price+eps ? undefined : {extreme:at(t,side)};
    }
  }
  const t = bars.length - 2;
  if (settings.showPending && t >= 0) {
    if (active?.extreme.side === "high") put(active.extreme,"idHH",t,true);
    if (developingLow) put(developingLow,"idLL",t,true);
    if (!active && hi && lo && bias !== 0) {
      const pull = bias === 1 ? lo : hi;
      const prior = bias === 1 ? prevLo : prevHi;
      const ref = bias === 1 ? hi : lo;
      if (validSequence(pull,bias === 1) && prior && pull.index > ref.index && (bias === 1 ? pull.price > prior.price + eps : pull.price < prior.price - eps)) put(pull,bias === 1 ? "ipHL" : "ipLH",t,true);
    }
  }
  return lines;
}

// Require both body-close and wick confirmation.
export function qualifiesHybridExtreme(
  current: CleanBar,
  previous: CleanBar,
  side: "high" | "low"
): boolean {
  const eps = 1e-9;

  if (side === "high") {
    return (
      current.close > Math.max(previous.open, previous.close) + eps &&
      current.high > previous.high + eps
    );
  }

  return (
    current.close < Math.min(previous.open, previous.close) - eps &&
    current.low < previous.low - eps
  );
}

function calculateExternalSwings(bars: CleanBar[], settings: StructureStudySettings, strength: number): StructureStudyLine[] {
  let rejectedHighIndex = -1;
  let rejectedLowIndex = -1;

  const blockedByRejectedExtreme = (
    rejectedIndex: number,
    candidateIndex: number
  ): boolean => {
    if (rejectedIndex < 0 || candidateIndex <= rejectedIndex)
      return false;

    // A confirmed reversal releases the previous restriction.
    return !lines.some(line =>
      line.layer === "external" &&
      !line.pending &&
      line.label.endsWith("CHoCH") &&
      Number(line.pointTime) >= Number(bars[rejectedIndex].time)
    );
  };

  const lines: StructureStudyLine[] = [];
  const swingBars = settings.priceSource === "body" ? bars.map(bar => ({...bar, open: bar.close})) : bars;
  const fastPivots = detectStructurePivots(swingBars, 1, settings.priceSource);
  const normalPivots = strength > 1 ? detectStructurePivots(swingBars, strength, settings.priceSource) : [];
  const pivots = [...fastPivots, ...normalPivots].sort((a,b) => a.confirmationIndex-b.confirmationIndex || a.index-b.index);
  let localHigh: StructurePivot | undefined;
  let localLow: StructurePivot | undefined;
  const meaningfulSwing = (p: StructurePivot, opposite: StructurePivot | undefined): boolean => {
    if (!opposite || opposite.index >= p.index) return false;
    const ranges: number[] = [];
    for (let j=Math.max(1,p.index-12); j<p.index; j++) {
      const bar=bars[j];
      const hi=Math.max(bar.open,bar.close);
      const lo=Math.min(bar.open,bar.close);
      const prev=bars[j-1].close;
      ranges.push(Math.max(hi-lo,Math.abs(hi-prev),Math.abs(lo-prev)));
    }
    ranges.sort((a,b)=>a-b);
    const typical=ranges[Math.floor(ranges.length/2)] || 0;
    const minimum=Math.max(typical*0.65,Math.abs(p.price)*0.005);
    const distance=p.side==="high" ? p.price-opposite.price : opposite.price-p.price;
    return distance >= minimum;
  };
  const eps = 1e-9;
  let high: StructurePivot | undefined;
  let low: StructurePivot | undefined;
  let bias: -1 | 0 | 1 = 0;
  let protectedPivot: StructurePivot | undefined;
  let continuation: StructurePivot | undefined;
  let continuationBroken = false;
  let i = 0;
  for (let t = 0; t < bars.length - 1; t++) {
    while (i < pivots.length && pivots[i].confirmationIndex === t) {
      let p = pivots[i++];
      const previous=p.side==="high" ? high : low;
      if (p.confirmationIndex-p.index===1) {
        const opposite=p.side==="high" ? localLow : localHigh;
        if (p.side==="high") localHigh=p;
        else localLow=p;
        const externalOpposite=p.side==="high" ? low : high;
        const validPullback=externalOpposite && (!previous || externalOpposite.index>previous.index) && meaningfulSwing(p,externalOpposite);
        const pairedPullback = externalOpposite && p.index > externalOpposite.index && (!previous || externalOpposite.index > previous.index) && (p.side === "low" ? p.price < externalOpposite.price-eps : p.price > externalOpposite.price+eps);
        if (strength>1 && !meaningfulSwing(p,opposite) && !validPullback && !pairedPullback) continue;
      }
      if (settings.priceSource==="body" && Math.abs(bars[p.index].close-p.price)>eps) {
        for (let j=p.index-1; j>=0; j--) {
          const bar=bars[j];
          const edge=p.side==="high" ? Math.max(bar.open,bar.close) : Math.min(bar.open,bar.close);
          if (Math.abs(edge-p.price)>eps) break;
          if (Math.abs(bar.close-p.price)<=eps) {
            p={...p,index:j};
            break;
          }
        }
      }
      if (previous && p.index<=previous.index) continue;
      if (p.side === "high") {
        const label: StructureLabel = !high ? "H" : Math.abs(p.price-high.price)<=eps ? "EQH" : p.price>high.price ? "HH" : "LH";

        if (label === "HH" && high) {
          if (p.index >= bars.length - 1) continue;

          let previousIndex = high.index;

          for (let k = lines.length - 1; k >= 0; k--) {
            const prior = lines[k];
            if (prior.layer !== "external" || prior.pending) continue;
            if (prior.label.endsWith("CHoCH")) break;

            if (prior.label === "HH") {
              const index = bars.findIndex(
                bar => Number(bar.time) === Number(prior.pointTime)
              );
              if (index >= 0) previousIndex = index;
              break;
            }
          }

          if (!qualifiesHybridExtreme(
            bars[p.index], bars[previousIndex], "high"
          )) {
            rejectedHighIndex = p.index;
            continue;
          }
        }
        if (label === "LH" && blockedByRejectedExtreme(rejectedLowIndex, p.index)) continue;
        if (label === "HH") rejectedHighIndex = -1;
        setStructurePoint(lines,bars,settings,p,label,"external",t);
        high=p;
      } else {
        const label: StructureLabel = !low ? "L" : Math.abs(p.price-low.price)<=eps ? "EQL" : p.price>low.price ? "HL" : "LL";

        if (label === "LL" && low) {
          if (p.index >= bars.length - 1) continue;

          let previousIndex = low.index;

          for (let k = lines.length - 1; k >= 0; k--) {
            const prior = lines[k];
            if (prior.layer !== "external" || prior.pending) continue;
            if (prior.label.endsWith("CHoCH")) break;

            if (prior.label === "LL") {
              const index = bars.findIndex(
                bar => Number(bar.time) === Number(prior.pointTime)
              );
              if (index >= 0) previousIndex = index;
              break;
            }
          }

          if (!qualifiesHybridExtreme(
            bars[p.index], bars[previousIndex], "low"
          )) {
            rejectedLowIndex = p.index;
            continue;
          }
        }
        if (label === "HL" && blockedByRejectedExtreme(rejectedHighIndex, p.index)) continue;
        if (label === "LL") rejectedLowIndex = -1;
        setStructurePoint(lines,bars,settings,p,label,"external",t);
        low=p;
      }
    }
    const close=bars[t].close;
    if (!high || !low) continue;
    if (bias===0) {
      const up=close>high.price+eps;
      const down=close<low.price-eps;
      if (up===down) continue;
      bias=up ? 1 : -1;
      continuation=up ? high : low;
      protectedPivot=up ? low : high;
      emitStructureBreak(lines,bars,settings,continuation,"external",t,false);
      continuationBroken=true;
      continue;
    }
    if (protectedPivot && (bias===1 ? close<protectedPivot.price-eps : close>protectedPivot.price+eps)) {
      emitStructureBreak(lines,bars,settings,protectedPivot,"external",t,true);
      bias=bias===1 ? -1 : 1;
      protectedPivot=bias===1 ? low : high;
      continuation=bias===1 ? high : low;
      continuationBroken=bias===1 ? close>continuation.price+eps : close<continuation.price-eps;
      continue;
    }
    const directional=bias===1 ? high : low;
    const oppositeSwing=bias===1 ? low : high;
    const newerExtreme=continuation && (bias===1 ? directional.price>continuation.price+eps : directional.price<continuation.price-eps);
    const completedLocalSwing=continuation && oppositeSwing.index>continuation.index && oppositeSwing.index<directional.index;
    if (!continuation || (directional.index>continuation.index && (newerExtreme || completedLocalSwing))) {
      continuation=directional;
      continuationBroken=false;
    }
    const reference=continuation;
    if (!reference || continuationBroken) continue;
    const broke=bias===1 ? close>reference.price+eps : close<reference.price-eps;
    if (!broke) continue;
    const pullback=bias===1 ? low : high;
    if (pullback.index>reference.index && (!protectedPivot || (bias===1 ? pullback.price>protectedPivot.price+eps : pullback.price<protectedPivot.price-eps))) {
      protectedPivot=pullback;
    }
    emitStructureBreak(lines,bars,settings,reference,"external",t,false);
    continuationBroken=true;
  }
  return lines;
}

function calculateIndependentStructure(bars: CleanBar[], settings: StructureStudySettings, layer: StructureLayer, strength: number): StructureStudyLine[] {
  if (layer === "internal") return calculateLocalInternalStructure(bars, settings, strength);
  if (layer === "external") return calculateExternalSwings(bars, settings, strength);
  const lines: StructureStudyLine[] = [];
  const pivots = detectStructurePivots(bars, strength, settings.priceSource);
  const prefix = layer === "major" ? "m" : "";
  const eps = 1e-9;
  let high: StructurePivot | undefined;
  let low: StructurePivot | undefined;
  let protectedPivot: StructurePivot | undefined;
  let run: StructurePivot | undefined;
  let bias: -1 | 0 | 1 = 0;
  let awaitingBOS = false;
  let i = 0;
  const emitted = new Set<string>();
  const confirmed = new Set<string>();
  const key = (p: StructurePivot) => p.side + ":" + p.index;
  const classify = (p: StructurePivot) => {
    const previous = p.side === "high" ? high : low;
    if (!previous) return p.side === "high" ? "H" : "L";
    if (Math.abs(p.price - previous.price) <= eps) return p.side === "high" ? "EQH" : "EQL";
    return p.side === "high" ? (p.price > previous.price ? "HH" : "LH") : (p.price > previous.price ? "HL" : "LL");
  };
  const put = (p: StructurePivot, label: string, t: number, pending = false) => {
    if (emitted.has(key(p))) return;
    setStructurePoint(lines, bars, settings, p, (prefix + label) as StructureLabel, layer, t, pending);
    if (!pending) emitted.add(key(p));
  };
  const commit = (p: StructurePivot, t: number) => {
    put(p, classify(p), t);
    if (p.side === "high") high = p;
    else low = p;
  };
  const at = (j: number, side: StructureLineSide): StructurePivot => {
    const bar = bars[j];
    const price = side === "high" ? (settings.priceSource === "body" ? Math.max(bar.open, bar.close) : bar.high) : (settings.priceSource === "body" ? Math.min(bar.open, bar.close) : bar.low);
    return { index: j, confirmationIndex: j, side, price };
  };
  const farther = (a: StructurePivot, b: StructurePivot) => a.side === "high" ? a.price >= b.price : a.price <= b.price;
  const extreme = (start: number, end: number, side: StructureLineSide) => {
    let best: StructurePivot | undefined;
    for (let j = Math.max(0,start); j <= end; j++) {
      const p = at(j,side);
      if (!best || farther(p,best)) best = p;
    }
    return best;
  };
  const turned = (p: StructurePivot, t: number) => {
    if (p.index < 1 || p.index >= t) return false;
    const left = at(p.index-1,p.side).price;
    const right = at(p.index+1,p.side).price;
    return p.side === "high" ? p.price >= left && p.price > right : p.price <= left && p.price < right;
  };
  for (let t=0; t<bars.length-1; t++) {
    while (i<pivots.length && pivots[i].confirmationIndex===t) {
      const p=pivots[i++];
      confirmed.add(key(p));
      if (p.side==="high" && !high) { put(p,"H",t); high=p; }
      if (p.side==="low" && !low) { put(p,"L",t); low=p; }
    }
    if (!high || !low) continue;
    const close=bars[t].close;
    if (bias===0) {
      if (close>high.price+eps) {
        emitStructureBreak(lines,bars,settings,high,layer,t,false);
        bias=1; protectedPivot=low; run=at(t,"high");
      } else if (close<low.price-eps) {
        emitStructureBreak(lines,bars,settings,low,layer,t,false);
        bias=-1; protectedPivot=high; run=at(t,"low");
      }
      continue;
    }
    if (protectedPivot && (bias===1 ? close<protectedPivot.price-eps : close>protectedPivot.price+eps)) {
      emitStructureBreak(lines,bars,settings,protectedPivot,layer,t,true);
      const side: StructureLineSide=bias===1 ? "high" : "low";
      const origin=extreme(protectedPivot.index,t-1,side) || (bias===1 ? high : low);
      commit(origin,t);
      protectedPivot=origin;
      bias=bias===1 ? -1 : 1;
      run=at(t,bias===1 ? "high" : "low");
      awaitingBOS=true;
      continue;
    }
    const side: StructureLineSide=bias===1 ? "high" : "low";
    const opposite: StructureLineSide=bias===1 ? "low" : "high";
    const reference=bias===1 ? high : low;
    if (!run && (bias===1 ? close>reference.price+eps : close<reference.price-eps)) {
      const pullback=extreme(reference.index+1,t-1,opposite);
      const qualified=hasQualifiedStructurePullback(bars,reference,t,settings.priceSource);
      if (pullback && (confirmed.has(key(pullback)) || (qualified && turned(pullback,t)))) {
        if (!protectedPivot || (bias===1 ? pullback.price>protectedPivot.price+eps : pullback.price<protectedPivot.price-eps)) {
          commit(pullback,t);
          protectedPivot=pullback;
        }
      }
      if (qualified || awaitingBOS) {
        emitStructureBreak(lines,bars,settings,reference,layer,t,false);
        awaitingBOS=false;
      }
      run=at(t,side);
    }
    if (run) {
      const candidate=at(t,side);
      if (farther(candidate,run)) run=candidate;
      if (confirmed.has(key(run))) {
        commit(run,t);
        run=undefined;
      }
    }
  }
  const t=bars.length-2;
  if (settings.showPending && t>=0 && high && low && bias!==0) {
    if (run) {
      const label=classify(run);
      put(run,(label==="HH" || label==="LL" ? "d" : "p")+label,t,true);
    } else {
      const reference=bias===1 ? high : low;
      const candidate=extreme(reference.index+1,t,bias===1 ? "low" : "high");
      if (candidate && confirmed.has(key(candidate))) put(candidate,"p"+classify(candidate),t,true);
    }
  }
  return lines;
}

function calculateUnifiedStructure(bars: CleanBar[], settings: StructureStudySettings): StructureStudyLine[] {
  const lines: StructureStudyLine[] = [];
  const internal = createStructureState();
  const external = createStructureState();
  const internalPivots = detectStructurePivots(bars, settings.internalSwingStrength, settings.priceSource);
  const externalPivots = detectStructurePivots(bars, settings.swingStrength, settings.priceSource);
  let i = 0;
  let e = 0;
  for (let t = 0; t < bars.length - 1; t++) {
    invalidatePendingExternal(lines, bars, settings, external, t);
    processInternalBreak(lines, bars, settings, internal, external, t);
    processExternalBreak(lines, bars, settings, external, t);
    while (i < internalPivots.length && internalPivots[i].confirmationIndex === t) {
      processInternalPivot(lines, bars, settings, internal, internalPivots[i++], t);
    }
    while (e < externalPivots.length && externalPivots[e].confirmationIndex === t) {
      const pivot = externalPivots[e++];
      initializeExternalPivot(lines, bars, settings, external, pivot, t);
      advanceExternalReference(external, pivot);
    }
  }
  return lines;
}

export function buildStructureStudyLines(bars: CleanBar[], settingsInput?: Partial<StructureStudySettings>): StructureStudyLine[] {
  const settings = normalizeStructureStudySettings(settingsInput);
  if (!settings.enabled || bars.length < 4) return [];
  const lines = [...calculateIndependentStructure(bars, settings, "major", settings.majorSwingStrength), ...calculateIndependentStructure(bars, settings, "external", settings.swingStrength), ...calculateIndependentStructure(bars, settings, "internal", settings.internalSwingStrength)];
  const externalPivots = lines.filter(line => line.layer === "external" && !line.pending && !line.label.endsWith("BOS") && !line.label.endsWith("CHoCH")).sort((a,b) => Number(a.pointTime)-Number(b.pointTime));
  for (let i=0; i<externalPivots.length-1; i++) {
    const current=externalPivots[i];
    const next=externalPivots[i+1];
    if ((current.label==="HL" && next.label==="HH") || (current.label==="LH" && next.label==="LL")) {
      current.endTime=next.pointTime;
    }
  }
  const barIndices = new Map(bars.map((bar,i)=>[Number(bar.time),i]));
  for (const pivot of externalPivots) {
    if (pivot.label!=="HL" && pivot.label!=="LH") continue;
    const start=barIndices.get(Number(pivot.confirmationTime));
    if (start===undefined) continue;
    const low=pivot.label==="HL";
    for (let j=start;j<bars.length-1;j++) {
      if (!(low ? bars[j].close<pivot.price-1e-9 : bars[j].close>pivot.price+1e-9)) continue;
      pivot.color=low ? settings.bearishLowColor : settings.bullishHighColor;
      break;
    }
  }
  const visible = lines.filter(line => {
    if (line.layer === "major" && !settings.showMajor) return false;
    if (line.layer === "internal" && !settings.showInternal) return false;
    if (line.layer === "external" && !settings.showExternal) return false;
    if (line.pending && !settings.showPending) return false;
    if (line.side === "high" && !settings.showHighs) return false;
    if (line.side === "low" && !settings.showLows) return false;
    if (line.label.endsWith("CHoCH") && !settings.showCHoCH) return false;
    if (line.label.endsWith("BOS") && !settings.showBOS) return false;
    if (line.label.endsWith(" Break") && !settings.showBOS) return false;
    return true;
  });
  const positions = new Map(
    bars.map((bar,i) => [Number(bar.time),i])
  );

  // Preserve meaningful structure throughout loaded history.
  const selectHistoricalLevels = (
    candidates: StructureStudyLine[],
    limit: number
  ): StructureStudyLine[] => {
    const blockSize = 250;
    const groups = new Map<number,StructureStudyLine[]>();

    for (const line of candidates) {
      const index = positions.get(Number(line.pointTime));
      if (index === undefined) continue;

      const block = Math.floor(index/blockSize);
      const group = groups.get(block) ?? [];

      group.push(line);
      groups.set(block,group);
    }

    return Array.from(groups.values()).flatMap(group =>
      group.slice(-limit)
    );
  };

  const selected = [
    ...selectHistoricalLevels(
      visible.filter(line => line.layer === "major"),
      settings.maxMajorLevels
    ),
    ...visible.filter(
      line => line.layer === "internal"
    ).slice(-settings.maxInternalLevels),
    ...selectHistoricalLevels(
      visible.filter(line =>
        line.layer === "external" &&
        !line.label.endsWith(" Break")
      ),
      settings.maxLevels
    ),
    ...selectHistoricalLevels(
      visible.filter(line =>
        line.layer === "external" &&
        line.label.endsWith(" Break")
      ),
      settings.maxLevels
    )
  ];
  const isPivot = (line: StructureStudyLine) => !line.label.endsWith("BOS") && !line.label.endsWith("CHoCH") && !line.label.endsWith(" Break");
  const rank = (line: StructureStudyLine) => line.layer === "major" ? 3 : line.layer === "external" ? 2 : 1;
  return selected.filter(line => {
    if (line.layer!=="internal" || !isPivot(line)) return true;
    const time=Number(line.pointTime);
    return !externalPivots.some((pivot,i)=>{
      const next=externalPivots[i+1];
      return next && pivot.side===line.side && next.side!==line.side && time>=Number(pivot.pointTime) && time<=Number(next.pointTime);
    });
  }).filter(line => !isPivot(line) || !selected.some(other => {
    if (other.pending || !isPivot(other) || rank(other)<=rank(line) || other.side!==line.side) return false;
    const sameCandle = Number(other.pointTime)===Number(line.pointTime);
    const distance = Math.abs((positions.get(Number(other.pointTime)) ?? -100) - (positions.get(Number(line.pointTime)) ?? -200));
    return sameCandle || (distance<=1 && (line.layer === "internal" || Math.abs(other.price-line.price)<=1e-9));
  }));
}
