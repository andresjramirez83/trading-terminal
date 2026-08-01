/**
 * DailyPracticeUniverseEngine.ts
 *
 * Records and preserves the complete set of symbols seen during each trading
 * day from scanner output and the manual watchlist.
 *
 * The engine is intentionally independent from replay/execution architecture.
 * Scanner and watchlist integrations can call this engine without affecting
 * TradeEngine, TradeHistoryEngine, or Practice Center fills.
 */

import {
  DAILY_PRACTICE_UNIVERSE_SNAPSHOT_VERSION,
  createDailyPracticeSymbolId,
  normalizePracticeSymbol,
  normalizeScannerId,
  uniqueStrings,
  type DailyManualWatchlistEvent,
  type DailyPracticeSymbol,
  type DailyPracticeUniverse,
  type DailyPracticeUniverseSnapshot,
  type DailyScannerHit,
  type PracticeScannerSummary,
  type PracticeSessionName,
  type RecordManualWatchlistInput,
  type RecordScannerHitInput,
  type RemoveManualWatchlistInput,
} from "./DailyPracticeUniverseTypes";

const STORAGE_KEY = "trading.practice.dailyUniverse.v1";
const MAX_STORED_TRADING_DAYS = 120;

export type DailyPracticeUniverseEventType =
  | "scanner-hit-recorded"
  | "manual-watchlist-added"
  | "manual-watchlist-removed"
  | "symbol-updated"
  | "universe-loaded"
  | "universe-cleared";

export interface DailyPracticeUniverseEvent {
  type: DailyPracticeUniverseEventType;
  tradingDate: string | null;
  symbol: string | null;
  timestamp: number;
}

export type DailyPracticeUniverseListener = (
  event: DailyPracticeUniverseEvent,
) => void;

function now(): number {
  return Date.now();
}

function safeNumber(value: unknown): number | null {
  if (value == null || value === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeTimestamp(value: unknown, fallback = now()): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSession(value: unknown): PracticeSessionName {
  switch (value) {
    case "premarket":
    case "regular":
    case "afterhours":
    case "overnight":
      return value;
    default:
      return "unknown";
  }
}

function tradingDateFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date);
}

function createEventId(prefix: string, timestamp: number): string {
  return `${prefix}_${timestamp}_${Math.random().toString(36).slice(2, 9)}`;
}

function uniqueSessions(
  sessions: readonly PracticeSessionName[],
): PracticeSessionName[] {
  return Array.from(new Set(sessions));
}

function createEmptyDailyPracticeSymbol(
  tradingDate: string,
  symbol: string,
  timestamp: number,
): DailyPracticeSymbol {
  return {
    id: createDailyPracticeSymbolId(tradingDate, symbol),
    tradingDate,
    symbol,
    sourceTypes: [],
    scannerIds: [],
    scannerNames: [],
    scannerSummaries: [],
    scannerHitCount: 0,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    wasOnManualWatchlist: false,
    manualWatchlistFirstAddedAt: null,
    manualWatchlistLastRemovedAt: null,
    setups: [],
    sessions: [],
    notes: [],
    marketStats: null,
    practiceScore: null,
    practiceQuality: "unrated",
    difficulty: "unrated",
    direction: "unknown",
    tags: [],
    wasTraded: false,
    wasPracticed: false,
    practiceCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createEmptyUniverse(
  tradingDate: string,
  timestamp: number,
): DailyPracticeUniverse {
  return {
    tradingDate,
    symbols: [],
    scannerHitCount: 0,
    uniqueScannerSymbolCount: 0,
    manualWatchlistSymbolCount: 0,
    totalUniqueSymbolCount: 0,
    scannerIds: [],
    scannerNames: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function cloneScannerSummary(
  summary: PracticeScannerSummary,
): PracticeScannerSummary {
  return {
    ...summary,
    setups: [...summary.setups],
    sessions: [...summary.sessions],
  };
}

function cloneSymbol(symbol: DailyPracticeSymbol): DailyPracticeSymbol {
  return {
    ...symbol,
    sourceTypes: [...symbol.sourceTypes],
    scannerIds: [...symbol.scannerIds],
    scannerNames: [...symbol.scannerNames],
    scannerSummaries: symbol.scannerSummaries.map(cloneScannerSummary),
    setups: [...symbol.setups],
    sessions: [...symbol.sessions],
    notes: [...symbol.notes],
    marketStats: symbol.marketStats ? { ...symbol.marketStats } : null,
    tags: [...symbol.tags],
  };
}

function cloneUniverse(universe: DailyPracticeUniverse): DailyPracticeUniverse {
  return {
    ...universe,
    symbols: universe.symbols.map(cloneSymbol),
    scannerIds: [...universe.scannerIds],
    scannerNames: [...universe.scannerNames],
  };
}

function recalculateUniverse(
  universe: DailyPracticeUniverse,
): DailyPracticeUniverse {
  const scannerSymbols = universe.symbols.filter(
    (symbol) => symbol.scannerHitCount > 0,
  );

  const manualSymbols = universe.symbols.filter(
    (symbol) => symbol.wasOnManualWatchlist,
  );

  return {
    ...universe,
    symbols: [...universe.symbols].sort((a, b) => {
      if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
      return a.symbol.localeCompare(b.symbol);
    }),
    scannerHitCount: universe.symbols.reduce(
      (sum, symbol) => sum + symbol.scannerHitCount,
      0,
    ),
    uniqueScannerSymbolCount: scannerSymbols.length,
    manualWatchlistSymbolCount: manualSymbols.length,
    totalUniqueSymbolCount: universe.symbols.length,
    scannerIds: uniqueStrings(
      universe.symbols.flatMap((symbol) => symbol.scannerIds),
    ),
    scannerNames: uniqueStrings(
      universe.symbols.flatMap((symbol) => symbol.scannerNames),
    ),
  };
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function parseSnapshot(value: string | null): DailyPracticeUniverseSnapshot | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<DailyPracticeUniverseSnapshot>;

    if (
      parsed.version !== DAILY_PRACTICE_UNIVERSE_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.universes)
    ) {
      return null;
    }

    return {
      version: DAILY_PRACTICE_UNIVERSE_SNAPSHOT_VERSION,
      universes: parsed.universes as DailyPracticeUniverse[],
    };
  } catch {
    return null;
  }
}

export class DailyPracticeUniverseEngine {
  private universes = new Map<string, DailyPracticeUniverse>();
  private scannerHits: DailyScannerHit[] = [];
  private manualWatchlistEvents: DailyManualWatchlistEvent[] = [];
  private listeners = new Set<DailyPracticeUniverseListener>();
  private loaded = false;

  constructor() {
    this.load();
  }

  subscribe(listener: DailyPracticeUniverseListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  recordScannerHit(input: RecordScannerHitInput): DailyPracticeSymbol | null {
    const detectedAt = safeTimestamp(input.detectedAt);
    const tradingDate =
      input.tradingDate?.trim() || tradingDateFromTimestamp(detectedAt);
    const symbol = normalizePracticeSymbol(input.symbol);
    const scannerId = normalizeScannerId(input.scannerId);

    if (!tradingDate || !symbol || !scannerId) return null;

    const scannerName =
      String(input.scannerName ?? input.scannerId).trim() || scannerId;
    const session = normalizeSession(input.session);

    const hit: DailyScannerHit = {
      id: createEventId("scanner_hit", detectedAt),
      tradingDate,
      symbol,
      scannerId,
      scannerName,
      detectedAt,
      session,
      price: safeNumber(input.price),
      score: safeNumber(input.score),
      percentChange: safeNumber(input.percentChange),
      volume: safeNumber(input.volume),
      setup: input.setup?.trim() || null,
      source: input.source?.trim() || null,
      notes: uniqueStrings(input.notes ?? []),
    };

    this.scannerHits.push(hit);

    const universe = this.getOrCreateUniverse(tradingDate, detectedAt);
    const current =
      universe.symbols.find((item) => item.symbol === symbol) ??
      createEmptyDailyPracticeSymbol(tradingDate, symbol, detectedAt);

    const existingSummary = current.scannerSummaries.find(
      (summary) => summary.scannerId === scannerId,
    );

    const nextSummary: PracticeScannerSummary = existingSummary
      ? {
          ...existingSummary,
          firstSeenAt: Math.min(existingSummary.firstSeenAt, detectedAt),
          lastSeenAt: Math.max(existingSummary.lastSeenAt, detectedAt),
          hitCount: existingSummary.hitCount + 1,
          bestScore:
            hit.score == null
              ? existingSummary.bestScore
              : existingSummary.bestScore == null
                ? hit.score
                : Math.max(existingSummary.bestScore, hit.score),
          latestPrice: hit.price ?? existingSummary.latestPrice,
          latestPercentChange:
            hit.percentChange ?? existingSummary.latestPercentChange,
          latestVolume: hit.volume ?? existingSummary.latestVolume,
          setups: uniqueStrings([
            ...existingSummary.setups,
            ...(hit.setup ? [hit.setup] : []),
          ]),
          sessions: uniqueSessions([
            ...existingSummary.sessions,
            hit.session,
          ]),
        }
      : {
          scannerId,
          scannerName,
          firstSeenAt: detectedAt,
          lastSeenAt: detectedAt,
          hitCount: 1,
          bestScore: hit.score,
          latestPrice: hit.price,
          latestPercentChange: hit.percentChange,
          latestVolume: hit.volume,
          setups: hit.setup ? [hit.setup] : [],
          sessions: [hit.session],
        };

    const nextSymbol: DailyPracticeSymbol = {
      ...current,
      sourceTypes: uniqueStrings([
        ...current.sourceTypes,
        "scanner",
      ]) as DailyPracticeSymbol["sourceTypes"],
      scannerIds: uniqueStrings([...current.scannerIds, scannerId]),
      scannerNames: uniqueStrings([...current.scannerNames, scannerName]),
      scannerSummaries: [
        ...current.scannerSummaries.filter(
          (summary) => summary.scannerId !== scannerId,
        ),
        nextSummary,
      ],
      scannerHitCount: current.scannerHitCount + 1,
      firstSeenAt: Math.min(current.firstSeenAt, detectedAt),
      lastSeenAt: Math.max(current.lastSeenAt, detectedAt),
      setups: uniqueStrings([
        ...current.setups,
        ...(hit.setup ? [hit.setup] : []),
      ]),
      sessions: uniqueSessions([...current.sessions, session]),
      notes: uniqueStrings([...current.notes, ...hit.notes]),
      updatedAt: detectedAt,
    };

    this.upsertSymbol(universe, nextSymbol);
    this.persist();
    this.emit("scanner-hit-recorded", tradingDate, symbol);

    return cloneSymbol(nextSymbol);
  }

  recordManualWatchlistSymbol(
    input: RecordManualWatchlistInput,
  ): DailyPracticeSymbol | null {
    const recordedAt = safeTimestamp(input.recordedAt);
    const tradingDate =
      input.tradingDate?.trim() || tradingDateFromTimestamp(recordedAt);
    const symbol = normalizePracticeSymbol(input.symbol);

    if (!tradingDate || !symbol) return null;

    const existingOpenEvent = this.manualWatchlistEvents.find(
      (event) =>
        event.tradingDate === tradingDate &&
        event.symbol === symbol &&
        event.removedAt == null,
    );

    if (!existingOpenEvent) {
      this.manualWatchlistEvents.push({
        id: createEventId("manual_watchlist", recordedAt),
        tradingDate,
        symbol,
        addedAt: recordedAt,
        removedAt: null,
      });
    }

    const universe = this.getOrCreateUniverse(tradingDate, recordedAt);
    const current =
      universe.symbols.find((item) => item.symbol === symbol) ??
      createEmptyDailyPracticeSymbol(tradingDate, symbol, recordedAt);

    const nextSymbol: DailyPracticeSymbol = {
      ...current,
      sourceTypes: uniqueStrings([
        ...current.sourceTypes,
        "manual_watchlist",
      ]) as DailyPracticeSymbol["sourceTypes"],
      firstSeenAt: Math.min(current.firstSeenAt, recordedAt),
      lastSeenAt: Math.max(current.lastSeenAt, recordedAt),
      wasOnManualWatchlist: true,
      manualWatchlistFirstAddedAt:
        current.manualWatchlistFirstAddedAt == null
          ? recordedAt
          : Math.min(current.manualWatchlistFirstAddedAt, recordedAt),
      manualWatchlistLastRemovedAt: null,
      updatedAt: recordedAt,
    };

    this.upsertSymbol(universe, nextSymbol);
    this.persist();
    this.emit("manual-watchlist-added", tradingDate, symbol);

    return cloneSymbol(nextSymbol);
  }

  removeManualWatchlistSymbol(
    input: RemoveManualWatchlistInput,
  ): DailyPracticeSymbol | null {
    const removedAt = safeTimestamp(input.removedAt);
    const tradingDate =
      input.tradingDate?.trim() || tradingDateFromTimestamp(removedAt);
    const symbol = normalizePracticeSymbol(input.symbol);

    if (!tradingDate || !symbol) return null;

    for (let index = this.manualWatchlistEvents.length - 1; index >= 0; index -= 1) {
      const event = this.manualWatchlistEvents[index];

      if (
        event.tradingDate === tradingDate &&
        event.symbol === symbol &&
        event.removedAt == null
      ) {
        this.manualWatchlistEvents[index] = {
          ...event,
          removedAt,
        };
        break;
      }
    }

    const universe = this.universes.get(tradingDate);
    const current = universe?.symbols.find((item) => item.symbol === symbol);

    if (!universe || !current) return null;

    const nextSymbol: DailyPracticeSymbol = {
      ...current,
      lastSeenAt: Math.max(current.lastSeenAt, removedAt),
      manualWatchlistLastRemovedAt: removedAt,
      updatedAt: removedAt,
    };

    this.upsertSymbol(universe, nextSymbol);
    this.persist();
    this.emit("manual-watchlist-removed", tradingDate, symbol);

    return cloneSymbol(nextSymbol);
  }

  recordManualWatchlistSnapshot(
    symbols: readonly string[],
    recordedAt = now(),
    tradingDate = tradingDateFromTimestamp(recordedAt),
  ): DailyPracticeUniverse {
    const normalized = uniqueStrings(
      symbols.map((symbol) => normalizePracticeSymbol(symbol)),
    );

    for (const symbol of normalized) {
      this.recordManualWatchlistSymbol({
        tradingDate,
        symbol,
        recordedAt,
      });
    }

    return this.getUniverse(tradingDate) ?? createEmptyUniverse(tradingDate, recordedAt);
  }

  getUniverse(tradingDate: string): DailyPracticeUniverse | null {
    const universe = this.universes.get(tradingDate.trim());
    return universe ? cloneUniverse(universe) : null;
  }

  getTodayUniverse(timestamp = now()): DailyPracticeUniverse | null {
    return this.getUniverse(tradingDateFromTimestamp(timestamp));
  }

  getUniverses(): DailyPracticeUniverse[] {
    return Array.from(this.universes.values())
      .sort((a, b) => b.tradingDate.localeCompare(a.tradingDate))
      .map(cloneUniverse);
  }

  getSymbol(
    tradingDate: string,
    symbol: string,
  ): DailyPracticeSymbol | null {
    const normalized = normalizePracticeSymbol(symbol);
    const universe = this.universes.get(tradingDate.trim());
    const match = universe?.symbols.find((item) => item.symbol === normalized);

    return match ? cloneSymbol(match) : null;
  }

  getScannerHits(
    tradingDate?: string,
    symbol?: string,
  ): DailyScannerHit[] {
    const normalizedSymbol = symbol
      ? normalizePracticeSymbol(symbol)
      : null;

    return this.scannerHits
      .filter((hit) => {
        if (tradingDate && hit.tradingDate !== tradingDate) return false;
        if (normalizedSymbol && hit.symbol !== normalizedSymbol) return false;
        return true;
      })
      .map((hit) => ({
        ...hit,
        notes: [...hit.notes],
      }));
  }

  getManualWatchlistEvents(
    tradingDate?: string,
    symbol?: string,
  ): DailyManualWatchlistEvent[] {
    const normalizedSymbol = symbol
      ? normalizePracticeSymbol(symbol)
      : null;

    return this.manualWatchlistEvents
      .filter((event) => {
        if (tradingDate && event.tradingDate !== tradingDate) return false;
        if (normalizedSymbol && event.symbol !== normalizedSymbol) return false;
        return true;
      })
      .map((event) => ({ ...event }));
  }

  markTraded(
    tradingDate: string,
    symbol: string,
    wasTraded = true,
  ): DailyPracticeSymbol | null {
    return this.patchSymbol(tradingDate, symbol, {
      wasTraded,
    });
  }

  markPracticed(
    tradingDate: string,
    symbol: string,
  ): DailyPracticeSymbol | null {
    const current = this.getSymbol(tradingDate, symbol);
    if (!current) return null;

    return this.patchSymbol(tradingDate, symbol, {
      wasPracticed: true,
      practiceCount: current.practiceCount + 1,
    });
  }

  clearTradingDate(tradingDate: string): void {
    const cleanDate = tradingDate.trim();
    if (!cleanDate) return;

    this.universes.delete(cleanDate);
    this.scannerHits = this.scannerHits.filter(
      (hit) => hit.tradingDate !== cleanDate,
    );
    this.manualWatchlistEvents = this.manualWatchlistEvents.filter(
      (event) => event.tradingDate !== cleanDate,
    );

    this.persist();
    this.emit("universe-cleared", cleanDate, null);
  }

  clearAll(): void {
    this.universes.clear();
    this.scannerHits = [];
    this.manualWatchlistEvents = [];

    if (isBrowser()) {
      localStorage.removeItem(STORAGE_KEY);
    }

    this.emit("universe-cleared", null, null);
  }

  private patchSymbol(
    tradingDate: string,
    symbol: string,
    patch: Partial<DailyPracticeSymbol>,
  ): DailyPracticeSymbol | null {
    const cleanDate = tradingDate.trim();
    const normalizedSymbol = normalizePracticeSymbol(symbol);
    const universe = this.universes.get(cleanDate);
    const current = universe?.symbols.find(
      (item) => item.symbol === normalizedSymbol,
    );

    if (!universe || !current) return null;

    const updatedAt = now();
    const nextSymbol: DailyPracticeSymbol = {
      ...current,
      ...patch,
      id: current.id,
      tradingDate: current.tradingDate,
      symbol: current.symbol,
      updatedAt,
    };

    this.upsertSymbol(universe, nextSymbol);
    this.persist();
    this.emit("symbol-updated", cleanDate, normalizedSymbol);

    return cloneSymbol(nextSymbol);
  }

  private getOrCreateUniverse(
    tradingDate: string,
    timestamp: number,
  ): DailyPracticeUniverse {
    const existing = this.universes.get(tradingDate);
    if (existing) return existing;

    const universe = createEmptyUniverse(tradingDate, timestamp);
    this.universes.set(tradingDate, universe);
    return universe;
  }

  private upsertSymbol(
    universe: DailyPracticeUniverse,
    symbol: DailyPracticeSymbol,
  ): void {
    const nextSymbols = [
      ...universe.symbols.filter((item) => item.symbol !== symbol.symbol),
      symbol,
    ];

    const nextUniverse = recalculateUniverse({
      ...universe,
      symbols: nextSymbols,
      updatedAt: symbol.updatedAt,
    });

    this.universes.set(universe.tradingDate, nextUniverse);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!isBrowser()) return;

    const snapshot = parseSnapshot(localStorage.getItem(STORAGE_KEY));
    if (!snapshot) return;

    for (const universe of snapshot.universes) {
      if (!universe?.tradingDate || !Array.isArray(universe.symbols)) continue;

      this.universes.set(
        universe.tradingDate,
        recalculateUniverse(cloneUniverse(universe)),
      );
    }

    this.emit("universe-loaded", null, null);
  }

  private persist(): void {
    if (!isBrowser()) return;

    const universes = this.getUniverses().slice(0, MAX_STORED_TRADING_DAYS);

    const retainedDates = new Set(
      universes.map((universe) => universe.tradingDate),
    );

    this.scannerHits = this.scannerHits.filter((hit) =>
      retainedDates.has(hit.tradingDate),
    );

    this.manualWatchlistEvents = this.manualWatchlistEvents.filter((event) =>
      retainedDates.has(event.tradingDate),
    );

    const snapshot: DailyPracticeUniverseSnapshot = {
      version: DAILY_PRACTICE_UNIVERSE_SNAPSHOT_VERSION,
      universes,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn(
        "[DailyPracticeUniverseEngine] Unable to persist daily universe",
        error,
      );
    }
  }

  private emit(
    type: DailyPracticeUniverseEventType,
    tradingDate: string | null,
    symbol: string | null,
  ): void {
    const event: DailyPracticeUniverseEvent = {
      type,
      tradingDate,
      symbol,
      timestamp: now(),
    };

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const dailyPracticeUniverseEngine =
  new DailyPracticeUniverseEngine();