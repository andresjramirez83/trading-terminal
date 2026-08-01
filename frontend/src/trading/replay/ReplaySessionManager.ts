// src/trading/replay/ReplaySessionManager.ts

import type { CleanBar } from "../../components/chart/ChartTypes";

export type ReplayStartMode =
  | "previous-close"
  | "after-hours"
  | "overnight"
  | "premarket"
  | "market-open"
  | "seven-am-pacific"
  | "custom";

export interface ReplaySessionRequest {
  tradingDate: string;
  startMode?: ReplayStartMode;
  customStartTime?: string | null;
}

export interface ReplaySessionBoundaries {
  previousTradingDate: string | null;

  previousRegularOpenIndex: number | null;
  previousRegularCloseIndex: number | null;
  previousAfterHoursStartIndex: number | null;

  overnightStartIndex: number | null;
  premarketStartIndex: number | null;

  replayPauseIndex: number | null;
  marketOpenIndex: number | null;
  sevenAmPacificIndex: number | null;

  sessionEndIndex: number | null;
}

export interface ReplaySession {
  tradingDate: string;
  startMode: ReplayStartMode;
  customStartTime: string | null;

  boundaries: ReplaySessionBoundaries;

  loadStartIndex: number;
  replayStartIndex: number;
  nextPlaybackIndex: number;

  marketOpenTime: string;
  pauseTime: string;

  loadedPreviousRegularSession: boolean;
  loadedAfterHours: boolean;
  loadedOvernight: boolean;
  loadedPremarket: boolean;
}

type ZonedBarTime = {
  tradingDate: string;
  minutesAfterMidnight: number;
  weekday: number;
};

const NEW_YORK_TIME_ZONE = "America/New_York";

const REGULAR_OPEN_MINUTES = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTES = 16 * 60;
const AFTER_HOURS_START_MINUTES = 16 * 60;
const OVERNIGHT_START_MINUTES = 20 * 60;
const PREMARKET_START_MINUTES = 4 * 60;
const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const REPLAY_PAUSE_MINUTES = 9 * 60 + 29;
const SEVEN_AM_PACIFIC_MINUTES_ET = 10 * 60;

function normalizeTradingDate(value: string): string {
  const normalized = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(
      "Replay session requires a trading date in YYYY-MM-DD format.",
    );
  }

  return normalized;
}

function normalizeCustomStartTime(
  value: string | null | undefined,
): string | null {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

  if (!/^\d{2}:\d{2}$/.test(normalized)) {
    throw new Error(
      "Custom replay start time must use HH:mm format.",
    );
  }

  const [hourText, minuteText] = normalized.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      "Custom replay start time must be a valid 24-hour time.",
    );
  }

  return normalized;
}

function toEpochMilliseconds(
  time: CleanBar["time"],
): number | null {
  const numeric = Number(time);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric > 10_000_000_000
    ? numeric
    : numeric * 1000;
}

function getZonedBarTime(
  time: CleanBar["time"],
): ZonedBarTime | null {
  const epochMilliseconds = toEpochMilliseconds(time);

  if (epochMilliseconds == null) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMilliseconds));

  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const weekdayText = values.get("weekday");
  const hour = Number(values.get("hour"));
  const minute = Number(values.get("minute"));

  if (
    !year ||
    !month ||
    !day ||
    !weekdayText ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  const weekdayLookup: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    tradingDate: `${year}-${month}-${day}`,
    minutesAfterMidnight: hour * 60 + minute,
    weekday: weekdayLookup[weekdayText] ?? -1,
  };
}

function parseClockMinutes(value: string): number {
  const [hourText, minuteText] = value.split(":");

  return Number(hourText) * 60 + Number(minuteText);
}

function findFirstIndex(
  barTimes: Array<ZonedBarTime | null>,
  predicate: (barTime: ZonedBarTime) => boolean,
): number | null {
  const index = barTimes.findIndex(
    (barTime) => barTime != null && predicate(barTime),
  );

  return index >= 0 ? index : null;
}

function findLastIndex(
  barTimes: Array<ZonedBarTime | null>,
  predicate: (barTime: ZonedBarTime) => boolean,
): number | null {
  for (let index = barTimes.length - 1; index >= 0; index -= 1) {
    const barTime = barTimes[index];

    if (barTime != null && predicate(barTime)) {
      return index;
    }
  }

  return null;
}

function findPreviousTradingDate(
  barTimes: Array<ZonedBarTime | null>,
  tradingDate: string,
): string | null {
  const dates = Array.from(
    new Set(
      barTimes
        .filter(
          (barTime): barTime is ZonedBarTime =>
            barTime != null &&
            barTime.tradingDate < tradingDate &&
            barTime.weekday >= 1 &&
            barTime.weekday <= 5,
        )
        .map((barTime) => barTime.tradingDate),
    ),
  ).sort();

  return dates.at(-1) ?? null;
}

function findFirstAtOrAfter(
  barTimes: Array<ZonedBarTime | null>,
  tradingDate: string,
  minutesAfterMidnight: number,
): number | null {
  return findFirstIndex(
    barTimes,
    (barTime) =>
      barTime.tradingDate === tradingDate &&
      barTime.minutesAfterMidnight >= minutesAfterMidnight,
  );
}

function findLastAtOrBefore(
  barTimes: Array<ZonedBarTime | null>,
  tradingDate: string,
  minutesAfterMidnight: number,
): number | null {
  return findLastIndex(
    barTimes,
    (barTime) =>
      barTime.tradingDate === tradingDate &&
      barTime.minutesAfterMidnight <= minutesAfterMidnight,
  );
}

function firstAvailableIndex(
  indexes: Array<number | null>,
  fallback: number,
): number {
  for (const index of indexes) {
    if (index != null) {
      return index;
    }
  }

  return fallback;
}

function resolveReplayStartIndex(
  request: Required<ReplaySessionRequest>,
  boundaries: ReplaySessionBoundaries,
  barTimes: Array<ZonedBarTime | null>,
  barsLength: number,
): number {
  const fallback = Math.max(0, barsLength - 1);

  switch (request.startMode) {
    case "previous-close":
      return boundaries.previousRegularCloseIndex ?? fallback;

    case "after-hours":
      return firstAvailableIndex(
        [
          boundaries.previousAfterHoursStartIndex,
          boundaries.previousRegularCloseIndex,
        ],
        fallback,
      );

    case "overnight":
      return firstAvailableIndex(
        [
          boundaries.overnightStartIndex,
          boundaries.previousAfterHoursStartIndex,
        ],
        fallback,
      );

    case "premarket":
      return firstAvailableIndex(
        [
          boundaries.premarketStartIndex,
          boundaries.overnightStartIndex,
        ],
        fallback,
      );

    case "seven-am-pacific":
      return firstAvailableIndex(
        [
          boundaries.sevenAmPacificIndex,
          boundaries.marketOpenIndex,
        ],
        fallback,
      );

    case "custom": {
      const customMinutes = request.customStartTime
        ? parseClockMinutes(request.customStartTime)
        : MARKET_OPEN_MINUTES;

      return firstAvailableIndex(
        [
          findFirstAtOrAfter(
            barTimes,
            request.tradingDate,
            customMinutes,
          ),
          boundaries.marketOpenIndex,
        ],
        fallback,
      );
    }

    case "market-open":
    default:
      return firstAvailableIndex(
        [
          boundaries.replayPauseIndex,
          boundaries.marketOpenIndex,
        ],
        fallback,
      );
  }
}

export class ReplaySessionManager {
  createSession(
    bars: CleanBar[],
    request: ReplaySessionRequest,
  ): ReplaySession {
    const tradingDate = normalizeTradingDate(
      request.tradingDate,
    );

    const startMode =
      request.startMode ?? "market-open";

    const customStartTime =
      normalizeCustomStartTime(
        request.customStartTime,
      );

    if (
      startMode === "custom" &&
      customStartTime == null
    ) {
      throw new Error(
        "Custom replay start mode requires a custom start time.",
      );
    }

    const barTimes = bars.map((bar) =>
      getZonedBarTime(bar.time),
    );

    const previousTradingDate =
      findPreviousTradingDate(
        barTimes,
        tradingDate,
      );

    const previousRegularOpenIndex =
      previousTradingDate == null
        ? null
        : findFirstAtOrAfter(
            barTimes,
            previousTradingDate,
            REGULAR_OPEN_MINUTES,
          );

    const previousRegularCloseIndex =
      previousTradingDate == null
        ? null
        : findLastAtOrBefore(
            barTimes,
            previousTradingDate,
            REGULAR_CLOSE_MINUTES,
          );

    const previousAfterHoursStartIndex =
      previousTradingDate == null
        ? null
        : findFirstAtOrAfter(
            barTimes,
            previousTradingDate,
            AFTER_HOURS_START_MINUTES,
          );

    const overnightStartIndex =
      previousTradingDate == null
        ? null
        : findFirstAtOrAfter(
            barTimes,
            previousTradingDate,
            OVERNIGHT_START_MINUTES,
          );

    const premarketStartIndex =
      findFirstAtOrAfter(
        barTimes,
        tradingDate,
        PREMARKET_START_MINUTES,
      );

    const replayPauseIndex =
      findLastAtOrBefore(
        barTimes,
        tradingDate,
        REPLAY_PAUSE_MINUTES,
      );

    const marketOpenIndex =
      findFirstAtOrAfter(
        barTimes,
        tradingDate,
        MARKET_OPEN_MINUTES,
      );

    const sevenAmPacificIndex =
      findFirstAtOrAfter(
        barTimes,
        tradingDate,
        SEVEN_AM_PACIFIC_MINUTES_ET,
      );

    const sessionEndIndex =
      findLastIndex(
        barTimes,
        (barTime) =>
          barTime.tradingDate === tradingDate,
      );

    const boundaries: ReplaySessionBoundaries = {
      previousTradingDate,
      previousRegularOpenIndex,
      previousRegularCloseIndex,
      previousAfterHoursStartIndex,
      overnightStartIndex,
      premarketStartIndex,
      replayPauseIndex,
      marketOpenIndex,
      sevenAmPacificIndex,
      sessionEndIndex,
    };

    const normalizedRequest: Required<ReplaySessionRequest> = {
      tradingDate,
      startMode,
      customStartTime,
    };

    const replayStartIndex = resolveReplayStartIndex(
      normalizedRequest,
      boundaries,
      barTimes,
      bars.length,
    );

    const loadStartIndex = firstAvailableIndex(
      [
        previousRegularOpenIndex,
        previousRegularCloseIndex,
        previousAfterHoursStartIndex,
        overnightStartIndex,
        premarketStartIndex,
        replayStartIndex,
      ],
      0,
    );

    return {
      tradingDate,
      startMode,
      customStartTime,

      boundaries,

      loadStartIndex,
      replayStartIndex,
      nextPlaybackIndex: Math.min(
        replayStartIndex + 1,
        bars.length,
      ),

      marketOpenTime: "09:30",
      pauseTime: "09:29",

      loadedPreviousRegularSession:
        previousRegularOpenIndex != null,
      loadedAfterHours:
        previousAfterHoursStartIndex != null,
      loadedOvernight:
        overnightStartIndex != null,
      loadedPremarket:
        premarketStartIndex != null,
    };
  }
}

let sharedReplaySessionManager:
  | ReplaySessionManager
  | null = null;

export function getSharedReplaySessionManager():
  ReplaySessionManager {
  if (!sharedReplaySessionManager) {
    sharedReplaySessionManager =
      new ReplaySessionManager();
  }

  return sharedReplaySessionManager;
}
