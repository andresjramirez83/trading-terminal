// src/trading/practice/PracticeSessionManager.ts

import type {
  DailyPracticeSymbol,
} from "./DailyPracticeUniverseTypes";
import type {
  ReplayStartMode,
} from "../replay/ReplaySessionManager";

const PRACTICE_SESSION_STORAGE_KEY =
  "trading.practice.session.v1";

export type PracticeSessionSymbolStatus =
  | "remaining"
  | "active"
  | "completed"
  | "skipped";

export type PracticeSessionSymbol = {
  symbol: string;
  scannerHitCount: number;
  scannerNames: string[];
  wasOnManualWatchlist: boolean;
  status: PracticeSessionSymbolStatus;
  completedAt: number | null;
  skippedAt: number | null;
};

export type PracticeSessionSettings = {
  timeframe: string;
  startMode: ReplayStartMode;
  customStartTime: string | null;
};

export type PracticeSession = {
  tradingDate: string;
  createdAt: number;
  updatedAt: number;
  activeSymbol: string | null;
  symbols: PracticeSessionSymbol[];
  settings: PracticeSessionSettings;
};

export type PracticeSessionProgress = {
  total: number;
  completed: number;
  skipped: number;
  remaining: number;
  currentIndex: number;
  percentComplete: number;
};

export type PracticeSessionListener = (
  session: PracticeSession | null,
) => void;

type StoredPracticeSessions = Record<
  string,
  PracticeSession
>;

function normalizeSymbol(value: string): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeTradingDate(
  value: string,
): string {
  const normalized = String(value ?? "").trim();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized)
  ) {
    throw new Error(
      "Practice trading date must use YYYY-MM-DD.",
    );
  }

  return normalized;
}

function cloneSession(
  session: PracticeSession,
): PracticeSession {
  return {
    ...session,
    settings: {
      ...session.settings,
    },
    symbols: session.symbols.map((symbol) => ({
      ...symbol,
      scannerNames: [
        ...symbol.scannerNames,
      ],
    })),
  };
}

function readStoredSessions():
  StoredPracticeSessions {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(
      PRACTICE_SESSION_STORAGE_KEY,
    );

    if (!raw) return {};

    const parsed = JSON.parse(raw);

    return parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as StoredPracticeSessions)
      : {};
  } catch {
    return {};
  }
}

function saveStoredSessions(
  sessions: StoredPracticeSessions,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      PRACTICE_SESSION_STORAGE_KEY,
      JSON.stringify(sessions),
    );
  } catch {
    // Practice remains usable if storage is unavailable.
  }
}

function rankUniverse(
  universe: DailyPracticeSymbol[],
): DailyPracticeSymbol[] {
  return [...universe].sort((left, right) => {
    if (
      left.wasPracticed !== right.wasPracticed
    ) {
      return left.wasPracticed ? 1 : -1;
    }

    if (
      left.scannerHitCount !==
      right.scannerHitCount
    ) {
      return (
        right.scannerHitCount -
        left.scannerHitCount
      );
    }

    if (
      left.wasOnManualWatchlist !==
      right.wasOnManualWatchlist
    ) {
      return left.wasOnManualWatchlist
        ? -1
        : 1;
    }

    return (
      right.lastSeenAt -
      left.lastSeenAt
    );
  });
}

function createSessionSymbol(
  source: DailyPracticeSymbol,
): PracticeSessionSymbol {
  return {
    symbol: normalizeSymbol(source.symbol),
    scannerHitCount:
      source.scannerHitCount,
    scannerNames: [
      ...source.scannerNames,
    ],
    wasOnManualWatchlist:
      source.wasOnManualWatchlist,
    status: source.wasPracticed
      ? "completed"
      : "remaining",
    completedAt: source.wasPracticed
      ? Date.now()
      : null,
    skippedAt: null,
  };
}

function findFirstRemainingSymbol(
  symbols: PracticeSessionSymbol[],
): PracticeSessionSymbol | null {
  return (
    symbols.find(
      (symbol) =>
        symbol.status === "remaining",
    ) ?? null
  );
}

function normalizeStatuses(
  symbols: PracticeSessionSymbol[],
  activeSymbol: string | null,
): PracticeSessionSymbol[] {
  return symbols.map((symbol) => {
    if (
      symbol.symbol === activeSymbol &&
      symbol.status === "remaining"
    ) {
      return {
        ...symbol,
        status: "active",
      };
    }

    if (
      symbol.symbol !== activeSymbol &&
      symbol.status === "active"
    ) {
      return {
        ...symbol,
        status: "remaining",
      };
    }

    return symbol;
  });
}

export class PracticeSessionManager {
  private sessions =
    readStoredSessions();

  private listeners =
    new Set<PracticeSessionListener>();

  getSession(
    tradingDate: string,
  ): PracticeSession | null {
    const normalizedDate =
      normalizeTradingDate(tradingDate);

    const session =
      this.sessions[normalizedDate];

    return session
      ? cloneSession(session)
      : null;
  }

  createOrRefreshSession(
    tradingDate: string,
    universe: DailyPracticeSymbol[],
    settings: PracticeSessionSettings,
  ): PracticeSession {
    const normalizedDate =
      normalizeTradingDate(tradingDate);

    const existing =
      this.sessions[normalizedDate] ??
      null;

    const rankedUniverse =
      rankUniverse(universe);

    const existingBySymbol =
      new Map(
        existing?.symbols.map((symbol) => [
          symbol.symbol,
          symbol,
        ]) ?? [],
      );

    const symbols =
      rankedUniverse.map((source) => {
        const normalized =
          normalizeSymbol(source.symbol);

        const prior =
          existingBySymbol.get(normalized);

        if (!prior) {
          return createSessionSymbol(source);
        }

        return {
          ...prior,
          scannerHitCount:
            source.scannerHitCount,
          scannerNames: [
            ...source.scannerNames,
          ],
          wasOnManualWatchlist:
            source.wasOnManualWatchlist,
        };
      });

    const activeStillExists =
      existing?.activeSymbol &&
      symbols.some(
        (symbol) =>
          symbol.symbol ===
          existing.activeSymbol,
      );

    const nextActiveSymbol =
      activeStillExists
        ? existing?.activeSymbol ?? null
        : findFirstRemainingSymbol(
            symbols,
          )?.symbol ?? null;

    const now = Date.now();

    const session: PracticeSession = {
      tradingDate: normalizedDate,
      createdAt:
        existing?.createdAt ?? now,
      updatedAt: now,
      activeSymbol: nextActiveSymbol,
      symbols: normalizeStatuses(
        symbols,
        nextActiveSymbol,
      ),
      settings: {
        ...settings,
      },
    };

    this.sessions[normalizedDate] =
      session;

    this.commit(session);

    return cloneSession(session);
  }

  updateSettings(
    tradingDate: string,
    settings: Partial<PracticeSessionSettings>,
  ): PracticeSession | null {
    const session =
      this.getMutableSession(tradingDate);

    if (!session) return null;

    session.settings = {
      ...session.settings,
      ...settings,
    };

    session.updatedAt = Date.now();

    this.commit(session);

    return cloneSession(session);
  }

  setActiveSymbol(
    tradingDate: string,
    symbol: string,
  ): PracticeSession | null {
    const session =
      this.getMutableSession(tradingDate);

    if (!session) return null;

    const normalized =
      normalizeSymbol(symbol);

    const target =
      session.symbols.find(
        (item) =>
          item.symbol === normalized,
      );

    if (!target) return null;

    if (
      target.status === "completed" ||
      target.status === "skipped"
    ) {
      return cloneSession(session);
    }

    session.activeSymbol = normalized;
    session.symbols =
      normalizeStatuses(
        session.symbols,
        normalized,
      );
    session.updatedAt = Date.now();

    this.commit(session);

    return cloneSession(session);
  }

  completeActiveSymbol(
    tradingDate: string,
  ): PracticeSession | null {
    return this.finishActiveSymbol(
      tradingDate,
      "completed",
    );
  }

  skipActiveSymbol(
    tradingDate: string,
  ): PracticeSession | null {
    return this.finishActiveSymbol(
      tradingDate,
      "skipped",
    );
  }

  moveNext(
    tradingDate: string,
  ): PracticeSession | null {
    const session =
      this.getMutableSession(tradingDate);

    if (!session) return null;

    const currentIndex =
      session.symbols.findIndex(
        (symbol) =>
          symbol.symbol ===
          session.activeSymbol,
      );

    const next =
      session.symbols
        .slice(
          Math.max(0, currentIndex + 1),
        )
        .find(
          (symbol) =>
            symbol.status === "remaining",
        ) ??
      session.symbols.find(
        (symbol) =>
          symbol.status === "remaining",
      ) ??
      null;

    session.activeSymbol =
      next?.symbol ?? null;

    session.symbols =
      normalizeStatuses(
        session.symbols,
        session.activeSymbol,
      );

    session.updatedAt = Date.now();

    this.commit(session);

    return cloneSession(session);
  }

  movePrevious(
    tradingDate: string,
  ): PracticeSession | null {
    const session =
      this.getMutableSession(tradingDate);

    if (!session) return null;

    const currentIndex =
      session.symbols.findIndex(
        (symbol) =>
          symbol.symbol ===
          session.activeSymbol,
      );

    let previous:
      | PracticeSessionSymbol
      | null = null;

    for (
      let index = currentIndex - 1;
      index >= 0;
      index -= 1
    ) {
      const candidate =
        session.symbols[index];

      if (
        candidate.status ===
          "remaining" ||
        candidate.status === "active"
      ) {
        previous = candidate;
        break;
      }
    }

    if (!previous) {
      return cloneSession(session);
    }

    session.activeSymbol =
      previous.symbol;

    session.symbols =
      normalizeStatuses(
        session.symbols,
        previous.symbol,
      );

    session.updatedAt = Date.now();

    this.commit(session);

    return cloneSession(session);
  }

  restoreSymbol(
    tradingDate: string,
    symbol: string,
  ): PracticeSession | null {
    const session =
      this.getMutableSession(tradingDate);

    if (!session) return null;

    const normalized =
      normalizeSymbol(symbol);

    session.symbols =
      session.symbols.map((item) =>
        item.symbol === normalized
          ? {
              ...item,
              status: "remaining",
              completedAt: null,
              skippedAt: null,
            }
          : item,
      );

    if (!session.activeSymbol) {
      session.activeSymbol =
        normalized;

      session.symbols =
        normalizeStatuses(
          session.symbols,
          normalized,
        );
    }

    session.updatedAt = Date.now();

    this.commit(session);

    return cloneSession(session);
  }

  resetSession(
    tradingDate: string,
  ): PracticeSession | null {
    const session =
      this.getMutableSession(tradingDate);

    if (!session) return null;

    session.symbols =
      session.symbols.map((symbol) => ({
        ...symbol,
        status: "remaining",
        completedAt: null,
        skippedAt: null,
      }));

    session.activeSymbol =
      session.symbols[0]?.symbol ?? null;

    session.symbols =
      normalizeStatuses(
        session.symbols,
        session.activeSymbol,
      );

    session.updatedAt = Date.now();

    this.commit(session);

    return cloneSession(session);
  }

  deleteSession(
    tradingDate: string,
  ): void {
    const normalizedDate =
      normalizeTradingDate(tradingDate);

    delete this.sessions[normalizedDate];

    saveStoredSessions(
      this.sessions,
    );

    this.emit(null);
  }

  getProgress(
    tradingDate: string,
  ): PracticeSessionProgress {
    const session =
      this.getSession(tradingDate);

    if (!session) {
      return {
        total: 0,
        completed: 0,
        skipped: 0,
        remaining: 0,
        currentIndex: 0,
        percentComplete: 0,
      };
    }

    const completed =
      session.symbols.filter(
        (symbol) =>
          symbol.status === "completed",
      ).length;

    const skipped =
      session.symbols.filter(
        (symbol) =>
          symbol.status === "skipped",
      ).length;

    const remaining =
      session.symbols.filter(
        (symbol) =>
          symbol.status === "remaining" ||
          symbol.status === "active",
      ).length;

    const activeIndex =
      session.symbols.findIndex(
        (symbol) =>
          symbol.symbol ===
          session.activeSymbol,
      );

    const finished =
      completed + skipped;

    return {
      total: session.symbols.length,
      completed,
      skipped,
      remaining,
      currentIndex:
        activeIndex >= 0
          ? activeIndex + 1
          : 0,
      percentComplete:
        session.symbols.length > 0
          ? Math.round(
              (finished /
                session.symbols.length) *
                100,
            )
          : 0,
    };
  }

  subscribe(
    listener: PracticeSessionListener,
  ): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private finishActiveSymbol(
    tradingDate: string,
    status: "completed" | "skipped",
  ): PracticeSession | null {
    const session =
      this.getMutableSession(tradingDate);

    if (
      !session ||
      !session.activeSymbol
    ) {
      return session
        ? cloneSession(session)
        : null;
    }

    const now = Date.now();

    session.symbols =
      session.symbols.map((symbol) => {
        if (
          symbol.symbol !==
          session.activeSymbol
        ) {
          return symbol;
        }

        return {
          ...symbol,
          status,
          completedAt:
            status === "completed"
              ? now
              : null,
          skippedAt:
            status === "skipped"
              ? now
              : null,
        };
      });

    const next =
      findFirstRemainingSymbol(
        session.symbols,
      );

    session.activeSymbol =
      next?.symbol ?? null;

    session.symbols =
      normalizeStatuses(
        session.symbols,
        session.activeSymbol,
      );

    session.updatedAt = now;

    this.commit(session);

    return cloneSession(session);
  }

  private getMutableSession(
    tradingDate: string,
  ): PracticeSession | null {
    const normalizedDate =
      normalizeTradingDate(tradingDate);

    return (
      this.sessions[normalizedDate] ??
      null
    );
  }

  private commit(
    session: PracticeSession,
  ): void {
    this.sessions[
      session.tradingDate
    ] = session;

    saveStoredSessions(
      this.sessions,
    );

    this.emit(
      cloneSession(session),
    );
  }

  private emit(
    session: PracticeSession | null,
  ): void {
    for (
      const listener of this.listeners
    ) {
      listener(
        session
          ? cloneSession(session)
          : null,
      );
    }
  }
}

export const practiceSessionManager =
  new PracticeSessionManager();
