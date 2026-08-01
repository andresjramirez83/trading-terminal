import type { ReplayStartMode } from "../replay/ReplaySessionManager";

export const PRACTICE_REPLAY_REQUEST_EVENT =
  "practice-replay-request";

export const PRACTICE_SELECTED_DATE_CHANGE_EVENT =
  "practice-trading-date-change";

export const PRACTICE_SELECTED_DATE_STORAGE_KEY =
  "practice.selectedTradingDate";

export const PRACTICE_SELECTED_SYMBOL_STORAGE_KEY =
  "practice.selectedSymbol";

export const PRACTICE_SELECTED_TIMEFRAME_STORAGE_KEY =
  "practice.selectedTimeframe";

export const PRACTICE_REPLAY_JUMP_TIME_STORAGE_KEY =
  "practice.replayJumpTime";

export const PRACTICE_REPLAY_START_MODE_STORAGE_KEY =
  "practice.replayStartMode";

export const PRACTICE_REPLAY_CUSTOM_START_TIME_STORAGE_KEY =
  "practice.replayCustomStartTime";

export interface PracticeReplayRequest {
  symbol: string;
  tradingDate: string;
  timeframe: string;
  jumpToTime?: number;
  startMode?: ReplayStartMode;
  customStartTime?: string | null;
  source?: "analysis" | "universe" | "manual";
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeTimeframe(value: string): string {
  return value.trim().toLowerCase();
}

const VALID_REPLAY_START_MODES =
  new Set<ReplayStartMode>([
    "previous-close",
    "after-hours",
    "overnight",
    "premarket",
    "market-open",
    "seven-am-pacific",
    "custom",
  ]);

function normalizeReplayStartMode(
  value: ReplayStartMode | string | undefined,
): ReplayStartMode {
  const normalized = String(
    value ?? "market-open",
  ).trim() as ReplayStartMode;

  return VALID_REPLAY_START_MODES.has(normalized)
    ? normalized
    : "market-open";
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

  const [hourText, minuteText] =
    normalized.split(":");

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
      "Custom replay start time must be valid.",
    );
  }

  return normalized;
}

export function normalizePracticeTradingDate(
  value: string,
): string {
  const normalized = value.trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : "";
}

function normalizeJumpToTime(
  value: number | undefined,
): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const numeric = Number(value);

  return numeric > 10_000_000_000
    ? Math.floor(numeric)
    : Math.floor(numeric * 1000);
}

export function readSelectedPracticeTradingDate(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return normalizePracticeTradingDate(
    window.localStorage.getItem(
      PRACTICE_SELECTED_DATE_STORAGE_KEY,
    ) ?? "",
  );
}

export function saveSelectedPracticeTradingDate(
  tradingDate: string,
): string {
  const normalized =
    normalizePracticeTradingDate(tradingDate);

  if (!normalized) {
    throw new Error(
      "Practice replay requires a trading date in YYYY-MM-DD format.",
    );
  }

  if (typeof window === "undefined") {
    return normalized;
  }

  window.localStorage.setItem(
    PRACTICE_SELECTED_DATE_STORAGE_KEY,
    normalized,
  );

  window.dispatchEvent(
    new CustomEvent<string>(
      PRACTICE_SELECTED_DATE_CHANGE_EVENT,
      {
        detail: normalized,
      },
    ),
  );

  return normalized;
}

export function subscribeToSelectedPracticeTradingDate(
  listener: (tradingDate: string) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleDateChange = (event: Event) => {
    const customEvent = event as CustomEvent<string>;
    const normalized = normalizePracticeTradingDate(
      String(customEvent.detail ?? ""),
    );

    if (normalized) {
      listener(normalized);
    }
  };

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key !== PRACTICE_SELECTED_DATE_STORAGE_KEY
    ) {
      return;
    }

    const normalized = normalizePracticeTradingDate(
      String(event.newValue ?? ""),
    );

    if (normalized) {
      listener(normalized);
    }
  };

  window.addEventListener(
    PRACTICE_SELECTED_DATE_CHANGE_EVENT,
    handleDateChange,
  );
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(
      PRACTICE_SELECTED_DATE_CHANGE_EVENT,
      handleDateChange,
    );
    window.removeEventListener("storage", handleStorage);
  };
}

export function createPracticeReplayRequest(
  request: PracticeReplayRequest,
): PracticeReplayRequest {
  const symbol = normalizeSymbol(request.symbol);
  const tradingDate = normalizePracticeTradingDate(
    request.tradingDate,
  );
  const timeframe = normalizeTimeframe(
    request.timeframe,
  );

  if (!symbol) {
    throw new Error(
      "Practice replay requires a symbol.",
    );
  }

  if (!tradingDate) {
    throw new Error(
      "Practice replay requires a trading date.",
    );
  }

  if (!timeframe) {
    throw new Error(
      "Practice replay requires a timeframe.",
    );
  }

  const startMode = normalizeReplayStartMode(
    request.startMode,
  );

  const customStartTime =
    normalizeCustomStartTime(
      request.customStartTime,
    );

  if (
    startMode === "custom" &&
    customStartTime == null
  ) {
    throw new Error(
      "Custom replay mode requires a start time.",
    );
  }

  return {
    symbol,
    tradingDate,
    timeframe,
    jumpToTime: normalizeJumpToTime(
      request.jumpToTime,
    ),
    startMode,
    customStartTime,
    source: request.source ?? "manual",
  };
}

export function savePracticeReplayRequest(
  request: PracticeReplayRequest,
): PracticeReplayRequest {
  const normalized =
    createPracticeReplayRequest(request);

  if (typeof window === "undefined") {
    return normalized;
  }

  saveSelectedPracticeTradingDate(
    normalized.tradingDate,
  );

  window.localStorage.setItem(
    PRACTICE_SELECTED_SYMBOL_STORAGE_KEY,
    normalized.symbol,
  );

  window.localStorage.setItem(
    PRACTICE_SELECTED_TIMEFRAME_STORAGE_KEY,
    normalized.timeframe,
  );

  window.localStorage.setItem(
    PRACTICE_REPLAY_START_MODE_STORAGE_KEY,
    normalized.startMode ?? "market-open",
  );

  if (normalized.customStartTime) {
    window.localStorage.setItem(
      PRACTICE_REPLAY_CUSTOM_START_TIME_STORAGE_KEY,
      normalized.customStartTime,
    );
  } else {
    window.localStorage.removeItem(
      PRACTICE_REPLAY_CUSTOM_START_TIME_STORAGE_KEY,
    );
  }

  if (
    Number.isFinite(normalized.jumpToTime)
  ) {
    window.localStorage.setItem(
      PRACTICE_REPLAY_JUMP_TIME_STORAGE_KEY,
      String(normalized.jumpToTime),
    );
  } else {
    window.localStorage.removeItem(
      PRACTICE_REPLAY_JUMP_TIME_STORAGE_KEY,
    );
  }

  return normalized;
}

export function launchPracticeReplay(
  request: PracticeReplayRequest,
): PracticeReplayRequest {
  const normalized =
    savePracticeReplayRequest(request);

  if (typeof window === "undefined") {
    return normalized;
  }

  window.dispatchEvent(
    new CustomEvent<PracticeReplayRequest>(
      PRACTICE_REPLAY_REQUEST_EVENT,
      {
        detail: normalized,
      },
    ),
  );

  return normalized;
}

export function readSavedPracticeReplayRequest():
  | PracticeReplayRequest
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const symbol =
    window.localStorage.getItem(
      PRACTICE_SELECTED_SYMBOL_STORAGE_KEY,
    ) ?? "";

  const tradingDate =
    readSelectedPracticeTradingDate();

  const timeframe =
    window.localStorage.getItem(
      PRACTICE_SELECTED_TIMEFRAME_STORAGE_KEY,
    ) ?? "";

  if (!symbol || !tradingDate || !timeframe) {
    return undefined;
  }

  const storedStartMode =
    window.localStorage.getItem(
      PRACTICE_REPLAY_START_MODE_STORAGE_KEY,
    );

  const storedCustomStartTime =
    window.localStorage.getItem(
      PRACTICE_REPLAY_CUSTOM_START_TIME_STORAGE_KEY,
    );

  const storedJumpTime =
    window.localStorage.getItem(
      PRACTICE_REPLAY_JUMP_TIME_STORAGE_KEY,
    );

  const parsedJumpTime =
    storedJumpTime == null
      ? undefined
      : Number(storedJumpTime);

  return createPracticeReplayRequest({
    symbol,
    tradingDate,
    timeframe,
    jumpToTime: Number.isFinite(
      parsedJumpTime,
    )
      ? parsedJumpTime
      : undefined,
    startMode: normalizeReplayStartMode(
      storedStartMode ?? undefined,
    ),
    customStartTime:
      storedCustomStartTime ?? null,
    source: "manual",
  });
}

export function subscribeToPracticeReplayRequests(
  listener: (
    request: PracticeReplayRequest,
  ) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleRequest = (event: Event) => {
    const customEvent =
      event as CustomEvent<PracticeReplayRequest>;

    if (!customEvent.detail) {
      return;
    }

    try {
      listener(
        createPracticeReplayRequest(
          customEvent.detail,
        ),
      );
    } catch (error) {
      console.error(
        "[PracticeReplayLauncher] Invalid replay request",
        error,
      );
    }
  };

  window.addEventListener(
    PRACTICE_REPLAY_REQUEST_EVENT,
    handleRequest,
  );

  return () => {
    window.removeEventListener(
      PRACTICE_REPLAY_REQUEST_EVENT,
      handleRequest,
    );
  };
}
