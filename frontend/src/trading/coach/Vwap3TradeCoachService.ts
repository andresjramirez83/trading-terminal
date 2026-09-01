import {
  fetchBars,
  fetchVwap3CoachStudy,
  reviewVwap3Trade,
  reviewVwap3Trades,
  type Vwap3StudyResponse,
  type Vwap3TradeCoachReview,
} from "../../services/api";
import type { TradeHistoryEntry } from "../../components/chart/right-panel/workspaces/trading/TradingTypes";

const STORAGE_KEY = "trading.vwap3Coach.reviews.v1";
const UPDATE_EVENT = "vwap3-trade-coach-updated";
const COACH_REVIEW_VERSION = 3;
const DEEP_ANALYSIS_VERSION = 1;
const DEEP_BARS_CACHE_MS = 4 * 60_000;
const SESSION_END_HHMM_ET = 2005;

export type Vwap3CoachGrade = {
  score: number;
  grade: string;
  label: string;
  reasons: string[];
};

export type Vwap3CoachStructureSnapshot = {
  trend: "bullish" | "bearish" | "neutral";
  higher_highs: boolean;
  higher_lows: boolean;
  lower_highs: boolean;
  lower_lows: boolean;
  last_swing_high: number | null;
  last_swing_low: number | null;
  bos: boolean;
  choch: boolean;
  last_break_direction: "bullish" | "bearish" | null;
  last_break_time: string | null;
};

export type Vwap3CoachSupportContext = {
  demand_zone?: {
    bottom: number;
    top: number;
    touched: boolean;
    held: boolean;
    reclaimed: boolean;
  } | null;
  bullish_fvg?: {
    bottom: number;
    top: number;
    created_at: string;
    touched: boolean;
    held: boolean;
    reclaimed: boolean;
  } | null;
  overlap: boolean;
  bullish_liquidity_sweep: boolean;
  sweep_level?: number | null;
  sweep_time?: string | null;
};

export type Vwap3DeepTradeAnalysis = {
  version: number;
  generated_at: string;
  display_timezone: "America/Los_Angeles";
  session_complete: boolean;
  session_through_time?: string | null;
  target_price?: number | null;
  target_source: "planned" | "scanner_frozen" | "none";
  stop_price?: number | null;
  stop_source: "planned" | "scanner_displacement" | "none";
  target_hit_before_exit: boolean;
  target_hit_before_exit_time?: string | null;
  target_hit_after_exit: boolean;
  target_hit_after_exit_time?: string | null;
  stop_hit_before_exit: boolean;
  stop_hit_before_exit_time?: string | null;
  stop_hit_after_exit: boolean;
  stop_hit_after_exit_time?: string | null;
  target_after_stop: boolean;
  minutes_stop_to_target?: number | null;
  deepest_pullback_price?: number | null;
  deepest_pullback_time?: string | null;
  adverse_excursion_pct?: number | null;
  max_high_after_exit?: number | null;
  structure_at_entry?: Vwap3CoachStructureSnapshot | null;
  structure_at_exit?: Vwap3CoachStructureSnapshot | null;
  structure_at_deepest_pullback?: Vwap3CoachStructureSnapshot | null;
  structure_at_stop?: Vwap3CoachStructureSnapshot | null;
  structure_at_target?: Vwap3CoachStructureSnapshot | null;
  first_bullish_structure_shift_after_entry?: string | null;
  first_bearish_structure_break_after_entry?: string | null;
  counter_trend_entry: boolean;
  entry_before_bullish_structure_shift: boolean;
  structural_failure_before_stop: boolean;
  support_context: Vwap3CoachSupportContext;
  entry_was_early_into_support: boolean;
  grades: {
    entry: Vwap3CoachGrade;
    stop: Vwap3CoachGrade;
    exit: Vwap3CoachGrade;
    thesis: Vwap3CoachGrade;
  };
  primary_focus: "ENTRY" | "STOP" | "EXIT" | "THESIS" | "EXECUTION";
  summary: string;
  lessons: string[];
};

type CoachReviewWithDeep = Vwap3TradeCoachReview & {
  deep_analysis?: Vwap3DeepTradeAnalysis;
};

type CoachBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Pivot = {
  index: number;
  price: number;
  time: number;
};

type DeepBarsCacheEntry = {
  fetchedAt: number;
  bars1m: CoachBar[];
  bars5m: CoachBar[];
};

export type Vwap3PersonalCoachSummary = {
  reviewedTrades: number;
  scannerMatchedTrades: number;
  likelyEarlyExits: number;
  defensiveExits: number;
  targetExits: number;
  targetHitAfterExit: number;
  entriesAfterInvalidation: number;
  estimatedMissedPnlToTarget: number;
  averageEntryQuality: number | null;
  deepAnalyzedTrades: number;
  stopPlacementIssues: number;
  earlyEntriesIntoSupport: number;
  counterTrendEntries: number;
  averageStopQuality: number | null;
  averageExitQuality: number | null;
  averageThesisQuality: number | null;
};

function loadStored(): Record<string, Vwap3TradeCoachReview> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persist(value: Record<string, Vwap3TradeCoachReview>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Journal/history still works if storage is unavailable.
  }
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatIsoDateInZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function easternClock(value: Date): { date: string; hhmm: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: Number(get("hour")) * 100 + Number(get("minute")),
  };
}

function sessionCompleteForTrade(entryTimestamp: string): boolean {
  const entry = new Date(entryTimestamp);
  if (!Number.isFinite(entry.getTime())) return true;
  const tradeDate = formatIsoDateInZone(entry, "America/New_York");
  const nowEt = easternClock(new Date());
  if (tradeDate < nowEt.date) return true;
  if (tradeDate > nowEt.date) return false;
  return nowEt.hhmm >= SESSION_END_HHMM_ET;
}

function extractBars(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const row = payload as Record<string, unknown>;
  for (const key of ["bars", "data", "rows", "items"]) {
    if (Array.isArray(row[key])) return row[key] as unknown[];
  }
  return [];
}

function normalizeBar(raw: unknown): CoachBar | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const rawTime = row.time ?? row.t ?? row.timestamp ?? row.dt_et;
  let time = 0;
  if (typeof rawTime === "string" && !/^\d+$/.test(rawTime.trim())) {
    time = Date.parse(rawTime);
  } else {
    const numeric = Number(rawTime);
    if (Number.isFinite(numeric)) {
      time = numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
  }
  const open = Number(row.open ?? row.o);
  const high = Number(row.high ?? row.h);
  const low = Number(row.low ?? row.l);
  const close = Number(row.close ?? row.c);
  const volume = Number(row.volume ?? row.v ?? 0);
  if (
    !Number.isFinite(time) ||
    time <= 0 ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {
    return null;
  }
  return {
    time,
    open: Number.isFinite(open) ? open : close,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? Math.max(0, volume) : 0,
  };
}

function normalizeBars(payload: unknown): CoachBar[] {
  const deduped = new Map<number, CoachBar>();
  for (const raw of extractBars(payload)) {
    const bar = normalizeBar(raw);
    if (bar) deduped.set(bar.time, bar);
  }
  return Array.from(deduped.values()).sort((a, b) => a.time - b.time);
}

function pctMove(value: number, base: number): number {
  if (base <= 0) return 0;
  return ((value / base) - 1) * 100;
}

function toPtIso(time: number | null | undefined): string | null {
  if (!time || !Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function pivots(bars: CoachBar[], strength = 3): {
  highs: Pivot[];
  lows: Pivot[];
} {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  if (bars.length < strength * 2 + 1) return { highs, lows };

  for (let index = strength; index < bars.length - strength; index += 1) {
    const row = bars[index];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= strength; offset += 1) {
      if (!(row.high > bars[index - offset].high && row.high >= bars[index + offset].high)) {
        isHigh = false;
      }
      if (!(row.low < bars[index - offset].low && row.low <= bars[index + offset].low)) {
        isLow = false;
      }
    }
    if (isHigh) highs.push({ index, price: row.high, time: row.time });
    if (isLow) lows.push({ index, price: row.low, time: row.time });
  }
  return { highs, lows };
}

function structureSnapshot(
  sourceBars: CoachBar[],
  throughTime: number,
): Vwap3CoachStructureSnapshot | null {
  const bars = sourceBars.filter((bar) => bar.time <= throughTime);
  if (bars.length < 7) return null;
  const { highs, lows } = pivots(bars, 3);
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const prevHigh = highs.length >= 2 ? highs[highs.length - 2] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  const prevLow = lows.length >= 2 ? lows[lows.length - 2] : null;

  const higherHighs = Boolean(lastHigh && prevHigh && lastHigh.price > prevHigh.price);
  const lowerHighs = Boolean(lastHigh && prevHigh && lastHigh.price < prevHigh.price);
  const higherLows = Boolean(lastLow && prevLow && lastLow.price > prevLow.price);
  const lowerLows = Boolean(lastLow && prevLow && lastLow.price < prevLow.price);

  const trend: "bullish" | "bearish" | "neutral" =
    higherHighs && higherLows
      ? "bullish"
      : lowerHighs && lowerLows
        ? "bearish"
        : "neutral";

  const lookbackStart = Math.max(0, bars.length - 12);
  const priorHighs = highs.filter((point) => point.index < lookbackStart);
  const priorLows = lows.filter((point) => point.index < lookbackStart);
  const referenceHigh = (priorHighs.length ? priorHighs[priorHighs.length - 1] : null) ?? prevHigh ?? lastHigh;
  const referenceLow = (priorLows.length ? priorLows[priorLows.length - 1] : null) ?? prevLow ?? lastLow;
  let previousClose = lookbackStart > 0 ? bars[lookbackStart - 1].close : 0;
  let breakDirection: "bullish" | "bearish" | null = null;
  let breakTime: number | null = null;

  for (let index = lookbackStart; index < bars.length; index += 1) {
    const close = bars[index].close;
    if (referenceHigh && previousClose <= referenceHigh.price && close > referenceHigh.price) {
      breakDirection = "bullish";
      breakTime = bars[index].time;
    }
    if (referenceLow && previousClose >= referenceLow.price && close < referenceLow.price) {
      breakDirection = "bearish";
      breakTime = bars[index].time;
    }
    previousClose = close;
  }

  return {
    trend,
    higher_highs: higherHighs,
    higher_lows: higherLows,
    lower_highs: lowerHighs,
    lower_lows: lowerLows,
    last_swing_high: lastHigh?.price ?? null,
    last_swing_low: lastLow?.price ?? null,
    bos: Boolean(breakDirection && (trend === breakDirection || trend === "neutral")),
    choch: Boolean(breakDirection && trend !== "neutral" && trend !== breakDirection),
    last_break_direction: breakDirection,
    last_break_time: toPtIso(breakTime),
  };
}

function firstStructureBreakAfterEntry(
  bars: CoachBar[],
  entryTime: number,
  direction: "bullish" | "bearish",
): number | null {
  const before = bars.filter((bar) => bar.time < entryTime);
  const { highs, lows } = pivots(before, 3);
  const reference = direction === "bullish"
    ? (highs.length ? highs[highs.length - 1] : undefined)
    : (lows.length ? lows[lows.length - 1] : undefined);
  if (!reference) return null;

  let previousClose = before.length ? before[before.length - 1].close : 0;
  for (const bar of bars) {
    if (bar.time < entryTime) continue;
    if (direction === "bullish") {
      if (previousClose <= reference.price && bar.close > reference.price) return bar.time;
    } else if (previousClose >= reference.price && bar.close < reference.price) {
      return bar.time;
    }
    previousClose = bar.close;
  }
  return null;
}

function firstTouch(
  bars: CoachBar[],
  startTime: number,
  level: number,
  side: "target" | "stop",
  isShort: boolean,
): number | null {
  if (!(level > 0)) return null;
  for (const bar of bars) {
    if (bar.time < startTime) continue;
    const touched = side === "target"
      ? (isShort ? bar.low <= level : bar.high >= level)
      : (isShort ? bar.high >= level : bar.low <= level);
    if (touched) return bar.time;
  }
  return null;
}

function findDeepestAdverseBar(
  bars: CoachBar[],
  entryTime: number,
  isShort: boolean,
  endTime?: number | null,
): CoachBar | null {
  const sample = bars.filter(
    (bar) => bar.time >= entryTime && (!endTime || bar.time <= endTime),
  );
  if (!sample.length) return null;
  return sample.reduce((best, bar) => {
    if (isShort) return bar.high > best.high ? bar : best;
    return bar.low < best.low ? bar : best;
  });
}

function firstBullishFvgNearPullback(
  bars5m: CoachBar[],
  entryTime: number,
  pullbackTime: number,
  pullbackPrice: number,
): Vwap3CoachSupportContext["bullish_fvg"] {
  const fvgs: Array<{ bottom: number; top: number; createdAt: number; index: number }> = [];
  for (let index = 2; index < bars5m.length; index += 1) {
    const first = bars5m[index - 2];
    const third = bars5m[index];
    if (third.time > pullbackTime) break;
    if (third.low > first.high) {
      fvgs.push({
        bottom: first.high,
        top: third.low,
        createdAt: third.time,
        index,
      });
    }
  }
  if (!fvgs.length) return null;

  const candidate = [...fvgs]
    .reverse()
    .find((fvg) => {
      const distance = pullbackPrice < fvg.bottom
        ? (fvg.bottom - pullbackPrice) / Math.max(pullbackPrice, 0.000001)
        : pullbackPrice > fvg.top
          ? (pullbackPrice - fvg.top) / Math.max(pullbackPrice, 0.000001)
          : 0;
      return distance <= 0.03;
    });
  if (!candidate) return null;

  const afterCreation = bars5m.filter(
    (bar) => bar.time >= Math.max(candidate.createdAt, entryTime) && bar.time <= pullbackTime,
  );
  const touched = afterCreation.some(
    (bar) => bar.low <= candidate.top && bar.high >= candidate.bottom,
  );
  const held = !afterCreation.some((bar) => bar.close < candidate.bottom);
  const touchIndex = bars5m.findIndex(
    (bar) =>
      bar.time >= Math.max(candidate.createdAt, entryTime) &&
      bar.time <= pullbackTime &&
      bar.low <= candidate.top &&
      bar.high >= candidate.bottom,
  );
  const reclaimed = touchIndex >= 0 && bars5m
    .slice(touchIndex, touchIndex + 4)
    .some((bar) => bar.close >= candidate.top);

  return {
    bottom: candidate.bottom,
    top: candidate.top,
    created_at: toPtIso(candidate.createdAt) ?? "",
    touched,
    held,
    reclaimed,
  };
}

function demandSupportFromReview(
  review: Vwap3TradeCoachReview,
  bars5m: CoachBar[],
  entryTime: number,
  pullbackTime: number,
): Vwap3CoachSupportContext["demand_zone"] {
  const zone = review.demand_context?.zone;
  const bottom = finite(zone?.bottom);
  const top = finite(zone?.top);
  if (bottom == null || top == null || bottom <= 0 || top <= 0 || top < bottom) return null;

  const sample = bars5m.filter((bar) => bar.time >= entryTime && bar.time <= pullbackTime);
  const touched = sample.some((bar) => bar.low <= top && bar.high >= bottom);
  const held = !sample.some((bar) => bar.close < bottom);
  const touchIndex = bars5m.findIndex(
    (bar) => bar.time >= entryTime && bar.time <= pullbackTime && bar.low <= top && bar.high >= bottom,
  );
  const reclaimed = touchIndex >= 0 && bars5m
    .slice(touchIndex, touchIndex + 4)
    .some((bar) => bar.close >= top);
  return { bottom, top, touched, held, reclaimed };
}

function bullishSweepAround(
  bars1m: CoachBar[],
  eventTime: number,
): { swept: boolean; level: number | null; time: number | null } {
  const history = bars1m.filter((bar) => bar.time < eventTime);
  const { lows } = pivots(history, 2);
  const reference = lows.length ? lows[lows.length - 1] : undefined;
  if (!reference) return { swept: false, level: null, time: null };
  const windowStart = eventTime - 10 * 60_000;
  const windowEnd = eventTime + 10 * 60_000;
  for (const bar of bars1m) {
    if (bar.time < windowStart || bar.time > windowEnd) continue;
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const body = Math.max(Math.abs(bar.close - bar.open), 0.000001);
    if (bar.low < reference.price && bar.close > reference.price && lowerWick >= body * 0.75) {
      return { swept: true, level: reference.price, time: bar.time };
    }
  }
  return { swept: false, level: reference.price, time: null };
}

function gradeLetter(score: number): string {
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

function makeGrade(score: number, label: string, reasons: string[]): Vwap3CoachGrade {
  const clean = Math.max(0, Math.min(100, Math.round(score)));
  return { score: clean, grade: gradeLetter(clean), label, reasons: reasons.slice(0, 6) };
}

function minutesBetween(later: number | null, earlier: number | null): number | null {
  if (!later || !earlier) return null;
  return Math.max(0, Math.round(((later - earlier) / 60_000) * 10) / 10);
}

function isBearishFailure(snapshot: Vwap3CoachStructureSnapshot | null): boolean {
  if (!snapshot) return false;
  return (
    snapshot.last_break_direction === "bearish" ||
    snapshot.trend === "bearish" ||
    snapshot.lower_lows
  );
}

function targetWasEventuallyHit(targetTime: number | null): boolean {
  return Boolean(targetTime && Number.isFinite(targetTime));
}

function getDeep(review: Vwap3TradeCoachReview | undefined): Vwap3DeepTradeAnalysis | null {
  return (review as CoachReviewWithDeep | undefined)?.deep_analysis ?? null;
}

export class Vwap3TradeCoachService {
  private reviews: Record<string, Vwap3TradeCoachReview> = loadStored();
  private inflight = new Set<string>();
  private study: Vwap3StudyResponse | null = null;
  private studyInflight: Promise<Vwap3StudyResponse | null> | null = null;
  private studyFetchedAt = 0;
  private lastRequestedAt = new Map<string, number>();
  private batchInflight = false;
  private deepBarsCache = new Map<string, DeepBarsCacheEntry>();

  getReviews(): Record<string, Vwap3TradeCoachReview> {
    return { ...this.reviews };
  }

  getReview(tradeId: string): Vwap3TradeCoachReview | undefined {
    return this.reviews[tradeId];
  }

  getStudy(): Vwap3StudyResponse | null {
    return this.study;
  }

  getPersonalSummary(): Vwap3PersonalCoachSummary {
    const rows = Object.values(this.reviews);
    const matched = rows.filter((row) => row.scanner_match);
    const entryScores = matched
      .map((row) => row.entry_quality?.score)
      .filter((value): value is number => Number.isFinite(value));
    const deep = rows
      .map((row) => getDeep(row))
      .filter((value): value is Vwap3DeepTradeAnalysis => Boolean(value));

    const average = (values: number[]): number | null =>
      values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;

    return {
      reviewedTrades: rows.length,
      scannerMatchedTrades: matched.length,
      likelyEarlyExits: matched.filter((row) => row.classification === "likely_early_exit").length,
      defensiveExits: matched.filter((row) => row.classification === "defensive_exit").length,
      targetExits: matched.filter((row) => row.classification === "target_exit").length,
      targetHitAfterExit: deep.filter((row) => row.target_hit_after_exit).length,
      entriesAfterInvalidation: matched.filter((row) => row.entry_after_invalidation).length,
      estimatedMissedPnlToTarget: matched
        .filter((row) => row.classification === "likely_early_exit")
        .reduce(
          (sum, row) => sum + (Number(row.estimated_missed_pnl_to_target) || 0),
          0,
        ),
      averageEntryQuality:
        entryScores.length > 0
          ? entryScores.reduce((sum, value) => sum + value, 0) / entryScores.length
          : null,
      deepAnalyzedTrades: deep.length,
      stopPlacementIssues: deep.filter((row) => row.grades.stop.score < 65).length,
      earlyEntriesIntoSupport: deep.filter((row) => row.entry_was_early_into_support).length,
      counterTrendEntries: deep.filter((row) => row.counter_trend_entry).length,
      averageStopQuality: average(deep.map((row) => row.grades.stop.score)),
      averageExitQuality: average(deep.map((row) => row.grades.exit.score)),
      averageThesisQuality: average(deep.map((row) => row.grades.thesis.score)),
    };
  }

  async refreshStudy(days = 30, force = false): Promise<Vwap3StudyResponse | null> {
    if (this.studyInflight) return this.studyInflight;
    if (!force && this.study && Date.now() - this.studyFetchedAt < 15 * 60_000) {
      return this.study;
    }
    this.studyInflight = fetchVwap3CoachStudy(days)
      .then((study) => {
        this.study = study;
        this.studyFetchedAt = Date.now();
        this.emit();
        return study;
      })
      .catch((error) => {
        console.warn("[vwap3-coach] study refresh failed", error);
        return null;
      })
      .finally(() => {
        this.studyInflight = null;
      });
    return this.studyInflight;
  }

  private deepNeedsFollowUp(
    trade: TradeHistoryEntry,
    existing?: Vwap3TradeCoachReview,
  ): boolean {
    const deep = getDeep(existing);
    if (!deep || deep.version < DEEP_ANALYSIS_VERSION) return true;
    if (deep.session_complete) return false;
    if (!trade.entryTimestamp) return false;
    return !sessionCompleteForTrade(trade.entryTimestamp);
  }

  private async loadDeepBars(
    symbol: string,
    entryTimestamp: string,
  ): Promise<{ bars1m: CoachBar[]; bars5m: CoachBar[]; sessionComplete: boolean }> {
    const entry = new Date(entryTimestamp);
    const tradeDate = formatIsoDateInZone(entry, "America/New_York");
    const sessionComplete = sessionCompleteForTrade(entryTimestamp);
    const key = `${symbol.trim().toUpperCase()}|${tradeDate}`;
    const cached = this.deepBarsCache.get(key);
    const now = Date.now();
    if (
      cached &&
      (sessionComplete || now - cached.fetchedAt < DEEP_BARS_CACHE_MS)
    ) {
      return { bars1m: cached.bars1m, bars5m: cached.bars5m, sessionComplete };
    }

    const [raw1m, raw5m] = await Promise.all([
      fetchBars(symbol, "1m", {
        date: tradeDate,
        session: "extended",
        limit: 5000,
        forceRefresh: !sessionComplete,
      }),
      fetchBars(symbol, "5m", {
        date: tradeDate,
        session: "extended",
        limit: 5000,
        forceRefresh: !sessionComplete,
      }),
    ]);

    const bars1m = normalizeBars(raw1m);
    const bars5m = normalizeBars(raw5m);
    this.deepBarsCache.set(key, { fetchedAt: now, bars1m, bars5m });
    if (this.deepBarsCache.size > 80) {
      const oldestKey = this.deepBarsCache.keys().next().value;
      if (oldestKey) this.deepBarsCache.delete(oldestKey);
    }
    return { bars1m, bars5m, sessionComplete };
  }

  private async buildDeepAnalysis(
    review: Vwap3TradeCoachReview,
    trade: TradeHistoryEntry,
  ): Promise<Vwap3DeepTradeAnalysis | null> {
    if (!trade.entryTimestamp || !trade.exitTimestamp || trade.entryPrice <= 0) return null;
    const entryTime = Date.parse(trade.entryTimestamp);
    const exitTime = Date.parse(trade.exitTimestamp);
    if (!Number.isFinite(entryTime) || !Number.isFinite(exitTime)) return null;

    const { bars1m, bars5m, sessionComplete } = await this.loadDeepBars(
      trade.symbol,
      trade.entryTimestamp,
    );
    if (!bars1m.length || !bars5m.length) return null;

    const isShort = ["short", "sell"].includes(String(trade.side || "").toLowerCase());
    const plannedTarget = finite(trade.plannedTarget);
    const scannerTarget = finite(review.frozen_target);
    const target = plannedTarget && plannedTarget > 0 ? plannedTarget : scannerTarget;
    const targetSource: Vwap3DeepTradeAnalysis["target_source"] =
      plannedTarget && plannedTarget > 0
        ? "planned"
        : scannerTarget && scannerTarget > 0
          ? "scanner_frozen"
          : "none";

    const plannedStop = finite(trade.plannedStop);
    const scannerStop = finite(review.displacement_low);
    const stop = plannedStop && plannedStop > 0 ? plannedStop : scannerStop;
    const stopSource: Vwap3DeepTradeAnalysis["stop_source"] =
      plannedStop && plannedStop > 0
        ? "planned"
        : scannerStop && scannerStop > 0
          ? "scanner_displacement"
          : "none";

    const targetTime = target && target > 0
      ? firstTouch(bars1m, entryTime, target, "target", isShort)
      : null;
    const stopTime = stop && stop > 0
      ? firstTouch(bars1m, entryTime, stop, "stop", isShort)
      : null;

    const targetBeforeExit = Boolean(targetTime && targetTime <= exitTime);
    const targetAfterExit = Boolean(targetTime && targetTime > exitTime);
    const stopBeforeExit = Boolean(stopTime && stopTime <= exitTime);
    const stopAfterExit = Boolean(stopTime && stopTime > exitTime);
    const targetAfterStop = Boolean(targetTime && stopTime && targetTime > stopTime);

    const deepest = findDeepestAdverseBar(bars1m, entryTime, isShort, targetTime);
    const deepestPrice = deepest ? (isShort ? deepest.high : deepest.low) : null;
    const adverseExcursion = deepestPrice && trade.entryPrice > 0
      ? Math.max(
          0,
          isShort
            ? pctMove(deepestPrice, trade.entryPrice)
            : -pctMove(deepestPrice, trade.entryPrice),
        )
      : null;

    const structureEntry = structureSnapshot(bars5m, entryTime);
    const structureExit = structureSnapshot(bars5m, exitTime);
    const structureDeep = deepest ? structureSnapshot(bars5m, deepest.time) : null;
    const structureStop = stopTime ? structureSnapshot(bars5m, stopTime) : null;
    const structureTarget = targetTime ? structureSnapshot(bars5m, targetTime) : null;
    const bullishShift = firstStructureBreakAfterEntry(bars5m, entryTime, "bullish");
    const bearishBreak = firstStructureBreakAfterEntry(bars5m, entryTime, "bearish");

    const counterTrendEntry = Boolean(
      !isShort &&
      structureEntry &&
      (structureEntry.trend === "bearish" || structureEntry.lower_lows) &&
      structureEntry.last_break_direction !== "bullish",
    );
    const entryBeforeBullishShift = Boolean(
      !isShort &&
      bullishShift &&
      bullishShift > entryTime,
    );
    const structuralFailureBeforeStop = Boolean(
      stopTime &&
      bearishBreak &&
      bearishBreak <= stopTime,
    ) || isBearishFailure(structureStop);

    const pullbackTime = deepest?.time ?? exitTime;
    const pullbackPrice = deepestPrice ?? trade.entryPrice;
    const fvg = !isShort
      ? firstBullishFvgNearPullback(bars5m, entryTime, pullbackTime, pullbackPrice)
      : null;
    const demand = !isShort
      ? demandSupportFromReview(review, bars5m, entryTime, pullbackTime)
      : null;
    const overlap = Boolean(
      fvg &&
      demand &&
      Math.max(fvg.bottom, demand.bottom) <= Math.min(fvg.top, demand.top),
    );
    const sweep = !isShort
      ? bullishSweepAround(bars1m, stopTime ?? pullbackTime)
      : { swept: false, level: null, time: null };

    const supportHeld = Boolean(
      (fvg?.touched && fvg.held && fvg.reclaimed) ||
      (demand?.touched && demand.held && demand.reclaimed),
    );
    const supportTouched = Boolean(fvg?.touched || demand?.touched);
    const entryWasEarlyIntoSupport = Boolean(
      !isShort &&
      targetWasEventuallyHit(targetTime) &&
      deepest &&
      deepest.time > entryTime &&
      (adverseExcursion ?? 0) >= 2.5 &&
      supportTouched &&
      supportHeld,
    );

    const entryReasons: string[] = [];
    let entryScore = finite(review.entry_quality?.score) ?? 70;
    if (counterTrendEntry) {
      entryScore -= 18;
      entryReasons.push("Bullish entry was taken while 5-minute structure was still bearish/counter-trend.");
    }
    if (entryBeforeBullishShift) {
      entryScore -= 10;
      entryReasons.push("The bullish structure break/shift occurred after the entry rather than before it.");
    }
    if (entryWasEarlyIntoSupport) {
      entryScore -= 16;
      entryReasons.push("Price first pulled deeper into a support/FVG area and then rallied, suggesting the entry was early.");
    }
    if (supportTouched && supportHeld && !entryWasEarlyIntoSupport) {
      entryScore += 6;
      entryReasons.push("The trade had identifiable support/FVG context that held.");
    }
    if (structureEntry?.last_break_direction === "bullish") {
      entryScore += 6;
      entryReasons.push("Entry followed a bullish structure break.");
    }
    const entryGrade = makeGrade(
      entryScore,
      counterTrendEntry
        ? "Counter-trend / early"
        : entryWasEarlyIntoSupport
          ? "Direction right, location early"
          : "Entry timing",
      entryReasons,
    );

    const stopReasons: string[] = [];
    let stopScore = stop && stop > 0 ? 78 : 50;
    let stopLabel = stop && stop > 0 ? "Stop placement" : "No planned stop";
    const stopInsideDemand = Boolean(
      stop && demand && stop >= demand.bottom && stop <= demand.top,
    );
    const stopInsideFvg = Boolean(
      stop && fvg && stop >= fvg.bottom && stop <= fvg.top,
    );

    if (!stop || stop <= 0) {
      stopReasons.push("No planned stop was available for placement analysis.");
    } else if (!stopTime) {
      stopScore = 86;
      stopLabel = "Stop not tested";
      stopReasons.push("The planned stop was never reached during the available session.");
    } else {
      if (structuralFailureBeforeStop) {
        stopScore += 14;
        stopLabel = "Technically justified";
        stopReasons.push("Bearish structure failure occurred by the time the stop was reached.");
      }
      if (targetAfterStop && supportHeld && !structuralFailureBeforeStop) {
        stopScore -= 34;
        stopLabel = "Likely too tight";
        stopReasons.push("The stop was hit during a support test that reclaimed, and the planned target was reached later.");
      }
      if (stopInsideDemand || stopInsideFvg) {
        stopScore -= 14;
        stopReasons.push("The stop sat inside an identified demand/FVG support area rather than beyond it.");
      }
      if (sweep.swept && !structuralFailureBeforeStop) {
        stopScore -= 10;
        stopReasons.push("The stop event coincided with a sell-side liquidity sweep/reclaim instead of a confirmed breakdown.");
      }
      if (targetAfterStop && structuralFailureBeforeStop) {
        stopReasons.push("The target hit later, but the original structure had already failed; that does not automatically make the stop wrong.");
      }
    }
    const stopGrade = makeGrade(stopScore, stopLabel, stopReasons);

    const exitReasons: string[] = [];
    let exitScore = 70;
    let exitLabel = "Trade exit";
    const exitNearStop = Boolean(
      stop && stop > 0 && Math.abs(trade.exitPrice - stop) / stop <= 0.015,
    );
    const exitNearTarget = Boolean(
      target && target > 0 && Math.abs(trade.exitPrice - target) / target <= 0.01,
    );

    if (targetBeforeExit || exitNearTarget) {
      exitScore = 95;
      exitLabel = "Target/plan captured";
      exitReasons.push("The exit captured the planned target area.");
    } else if (stopBeforeExit && exitNearStop) {
      exitScore = 90;
      exitLabel = "Disciplined stop execution";
      exitReasons.push("You respected the planned stop; placement quality is graded separately.");
    } else if (targetAfterExit) {
      if (isBearishFailure(structureExit) || (bearishBreak && bearishBreak <= exitTime)) {
        exitScore = 84;
        exitLabel = "Defensive exit";
        exitReasons.push("The target hit later, but bearish structure evidence existed by the time you exited.");
      } else {
        exitScore = 48;
        exitLabel = "Likely early exit";
        exitReasons.push("The planned target hit after your exit while 5-minute structure had not clearly failed.");
      }
    } else if (isBearishFailure(structureExit)) {
      exitScore = 82;
      exitLabel = "Structure-based exit";
      exitReasons.push("The exit occurred with bearish market-structure deterioration.");
    } else {
      exitReasons.push("The session had not yet produced a clear target/stop verdict at the analyzed point.");
    }
    const exitGrade = makeGrade(exitScore, exitLabel, exitReasons);

    const thesisReasons: string[] = [];
    let thesisScore = 60;
    let thesisLabel = "Directional thesis";
    if (targetTime) {
      thesisScore += 28;
      thesisLabel = "Direction validated";
      thesisReasons.push("The planned target was eventually reached during the session.");
    }
    if (review.entry_after_invalidation) {
      thesisScore = Math.min(thesisScore, 55);
      thesisLabel = "Old setup already invalid";
      thesisReasons.push("The original VWAP +3 scanner setup was already invalid before entry.");
    }
    const scannerInvalidation = review.setup_invalidation_time
      ? Date.parse(review.setup_invalidation_time)
      : Number.NaN;
    if (targetTime && Number.isFinite(scannerInvalidation) && scannerInvalidation < targetTime) {
      thesisScore = Math.min(thesisScore, 68);
      thesisLabel = "Target later, original thesis failed first";
      thesisReasons.push("Price reached the target only after the scanner setup had already invalidated.");
    } else if (targetTime && (!bearishBreak || targetTime <= bearishBreak)) {
      thesisScore += 7;
      thesisReasons.push("The target was reached before a confirmed bearish structure break after entry.");
    }
    if (!targetTime && bearishBreak) {
      thesisScore -= 18;
      thesisLabel = "Thesis deteriorated";
      thesisReasons.push("Bearish structure broke and the target was not reached in the available session.");
    }
    if (counterTrendEntry && targetTime) {
      thesisScore -= 6;
      thesisReasons.push("The direction eventually worked, but the entry initially fought the 5-minute trend.");
    }
    const thesisGrade = makeGrade(thesisScore, thesisLabel, thesisReasons);

    const graded = [
      ["ENTRY", entryGrade.score] as const,
      ["STOP", stopGrade.score] as const,
      ["EXIT", exitGrade.score] as const,
      ["THESIS", thesisGrade.score] as const,
    ].sort((a, b) => a[1] - b[1]);
    const primaryFocus = graded[0][1] >= 80 ? "EXECUTION" : graded[0][0];

    const lessons: string[] = [];
    if (counterTrendEntry) {
      lessons.push("For bullish entries, wait for the 5-minute downtrend to shift or clearly treat the trade as a counter-trend reversal.");
    }
    if (entryWasEarlyIntoSupport) {
      lessons.push("Consider waiting for the demand/FVG test and reclaim before entering instead of buying ahead of the likely pullback destination.");
    }
    if (stopGrade.score < 65) {
      lessons.push("Review stop placement relative to demand/FVG and the structural low; avoid placing the stop inside the area price is likely to test.");
    }
    if (exitGrade.label === "Likely early exit") {
      lessons.push("Before exiting early, check whether the setup has actually broken structure rather than reacting only to a temporary pullback.");
    }
    if (targetAfterStop && structuralFailureBeforeStop) {
      lessons.push("Do not move a stop wider just because the target eventually hit later; the original structure had already failed when the stop was triggered.");
    }
    if (!sessionComplete) {
      lessons.push("This trade is still being followed through the end of the extended session; the Coach will update as new bars arrive.");
    }

    let summary = "The Coach reconstructed the trade through the available session and graded entry, stop, exit, and thesis separately.";
    if (targetAfterExit && targetTime) {
      summary = `Your planned target was reached ${minutesBetween(targetTime, exitTime) ?? 0} minutes after you exited.`;
      if (!isBearishFailure(structureExit)) {
        summary += " Market structure had not clearly failed at the exit, so holding discipline is the main review point.";
      } else {
        summary += " Structure had already weakened, so the exit can still be technically justified despite the later target.";
      }
    }
    if (targetAfterStop && stopTime && targetTime) {
      summary = `Your stop was reached first, and the planned target was reached ${minutesBetween(targetTime, stopTime) ?? 0} minutes later.`;
      if (supportHeld && !structuralFailureBeforeStop) {
        summary += " The stop occurred during a support/sweep-reclaim sequence without a confirmed bearish break, so stop placement deserves review.";
      } else if (structuralFailureBeforeStop) {
        summary += " Bearish structure had already failed by the stop, so the later target does not automatically mean the stop was wrong.";
      }
    } else if (entryWasEarlyIntoSupport && targetTime) {
      summary = "The directional idea worked, but price first pulled into support/FVG and then rallied to target, pointing to entry timing as the main improvement area.";
    }

    const maxHighAfterExit = bars1m
      .filter((bar) => bar.time > exitTime)
      .reduce((max, bar) => Math.max(max, bar.high), 0);

    return {
      version: DEEP_ANALYSIS_VERSION,
      generated_at: new Date().toISOString(),
      display_timezone: "America/Los_Angeles",
      session_complete: sessionComplete,
      session_through_time: toPtIso(bars1m.length ? bars1m[bars1m.length - 1].time : null),
      target_price: target ?? null,
      target_source: targetSource,
      stop_price: stop ?? null,
      stop_source: stopSource,
      target_hit_before_exit: targetBeforeExit,
      target_hit_before_exit_time: targetBeforeExit ? toPtIso(targetTime) : null,
      target_hit_after_exit: targetAfterExit,
      target_hit_after_exit_time: targetAfterExit ? toPtIso(targetTime) : null,
      stop_hit_before_exit: stopBeforeExit,
      stop_hit_before_exit_time: stopBeforeExit ? toPtIso(stopTime) : null,
      stop_hit_after_exit: stopAfterExit,
      stop_hit_after_exit_time: stopAfterExit ? toPtIso(stopTime) : null,
      target_after_stop: targetAfterStop,
      minutes_stop_to_target: targetAfterStop ? minutesBetween(targetTime, stopTime) : null,
      deepest_pullback_price: deepestPrice,
      deepest_pullback_time: toPtIso(deepest?.time ?? null),
      adverse_excursion_pct: adverseExcursion == null ? null : Math.round(adverseExcursion * 1000) / 1000,
      max_high_after_exit: maxHighAfterExit > 0 ? maxHighAfterExit : null,
      structure_at_entry: structureEntry,
      structure_at_exit: structureExit,
      structure_at_deepest_pullback: structureDeep,
      structure_at_stop: structureStop,
      structure_at_target: structureTarget,
      first_bullish_structure_shift_after_entry: toPtIso(bullishShift),
      first_bearish_structure_break_after_entry: toPtIso(bearishBreak),
      counter_trend_entry: counterTrendEntry,
      entry_before_bullish_structure_shift: entryBeforeBullishShift,
      structural_failure_before_stop: structuralFailureBeforeStop,
      support_context: {
        demand_zone: demand,
        bullish_fvg: fvg,
        overlap,
        bullish_liquidity_sweep: sweep.swept,
        sweep_level: sweep.level,
        sweep_time: toPtIso(sweep.time),
      },
      entry_was_early_into_support: entryWasEarlyIntoSupport,
      grades: {
        entry: entryGrade,
        stop: stopGrade,
        exit: exitGrade,
        thesis: thesisGrade,
      },
      primary_focus: primaryFocus,
      summary,
      lessons: lessons.slice(0, 6),
    };
  }

  private async enrichReviews(
    reviews: Vwap3TradeCoachReview[],
    tradesById: Map<string, TradeHistoryEntry>,
  ): Promise<Vwap3TradeCoachReview[]> {
    return Promise.all(
      reviews.map(async (review) => {
        const trade = tradesById.get(review.trade_id);
        if (!trade) return review;
        try {
          const deep = await this.buildDeepAnalysis(review, trade);
          if (!deep) return review;
          return { ...review, deep_analysis: deep } as Vwap3TradeCoachReview;
        } catch (error) {
          console.warn("[vwap3-coach] deep session analysis failed", review.trade_id, error);
          return review;
        }
      }),
    );
  }

  syncClosedTrades(trades: TradeHistoryEntry[]): void {
    if (this.batchInflight) return;

    const now = Date.now();
    const candidates: TradeHistoryEntry[] = [];

    for (const trade of trades) {
      if (trade.status !== "closed") continue;
      if (!trade.entryTimestamp || !trade.exitTimestamp) continue;
      if (trade.entryPrice <= 0 || trade.exitPrice <= 0) continue;

      const existing = this.reviews[trade.id];
      const lastRequest = this.lastRequestedAt.get(trade.id) ?? 0;
      const reviewedAt = existing?.reviewed_at ? Date.parse(existing.reviewed_at) : 0;
      const reviewAge = reviewedAt > 0 ? now - reviewedAt : Number.POSITIVE_INFINITY;
      const needsVersionRefresh = Boolean(
        existing && Number(existing.review_version ?? 0) < COACH_REVIEW_VERSION,
      );
      const needsDeepFollowUp = this.deepNeedsFollowUp(trade, existing);
      const needsFollowUp = Boolean(
        existing &&
          (needsVersionRefresh ||
            needsDeepFollowUp ||
            existing.classification === "early_exit_unresolved" ||
            (!existing.scanner_match && reviewAge < 24 * 60 * 60_000)),
      );

      if (existing && !needsFollowUp) continue;
      if (needsFollowUp && !needsVersionRefresh && reviewAge < 5 * 60_000) continue;
      if (now - lastRequest < 60_000 || this.inflight.has(trade.id)) continue;

      candidates.push(trade);
      if (candidates.length >= 24) break;
    }

    if (candidates.length === 0) return;

    const payloads = candidates.map((trade) => ({
      trade_id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      shares: trade.shares,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      entry_time: trade.entryTimestamp!,
      exit_time: trade.exitTimestamp!,
      planned_target: trade.plannedTarget,
      planned_stop: trade.plannedStop,
      strategy: trade.strategy,
      realized_pnl: trade.netPnl,
      r_multiple: trade.rMultiple,
    }));
    const tradesById = new Map(candidates.map((trade) => [trade.id, trade]));

    this.batchInflight = true;
    for (const trade of candidates) {
      this.inflight.add(trade.id);
      this.lastRequestedAt.set(trade.id, now);
    }

    const applyReviews = (reviews: Vwap3TradeCoachReview[]) => {
      if (reviews.length === 0) return;
      let changed = false;
      const next = { ...this.reviews };

      for (const review of reviews) {
        if (!review?.trade_id) continue;
        next[review.trade_id] = review;
        changed = true;
      }

      if (!changed) return;
      this.reviews = next;
      persist(this.reviews);
      this.emit();
    };

    void reviewVwap3Trades(payloads)
      .then((reviews) => this.enrichReviews(reviews, tradesById))
      .then(applyReviews)
      .catch(async (batchError) => {
        // During a rolling deployment an older backend may not have the batch
        // route yet. Fall back to the original per-trade endpoint so journal
        // coaching remains available.
        console.warn("[vwap3-coach] batch review failed; using fallback", batchError);
        const settled = await Promise.allSettled(
          payloads.map((payload) => reviewVwap3Trade(payload)),
        );
        const reviews = settled
          .filter(
            (item): item is PromiseFulfilledResult<Vwap3TradeCoachReview> =>
              item.status === "fulfilled",
          )
          .map((item) => item.value);
        applyReviews(await this.enrichReviews(reviews, tradesById));
      })
      .finally(() => {
        for (const trade of candidates) {
          this.inflight.delete(trade.id);
        }
        this.batchInflight = false;
      });
  }

  subscribe(listener: () => void): () => void {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener(UPDATE_EVENT, listener);
    return () => window.removeEventListener(UPDATE_EVENT, listener);
  }

  private emit(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
  }
}

let shared: Vwap3TradeCoachService | null = null;

export function getSharedVwap3TradeCoachService(): Vwap3TradeCoachService {
  if (!shared) shared = new Vwap3TradeCoachService();
  return shared;
}
