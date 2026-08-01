/**
 * DailyPracticeUniverseTypes.ts
 *
 * Shared domain types for preserving the complete symbol universe seen during
 * a trading day. This includes:
 *
 * - Every symbol returned by any scanner.
 * - Every symbol added to the manual watchlist.
 * - The scanners that found each symbol.
 * - First/last-seen timestamps and scanner hit counts.
 * - Optional market statistics used later for Practice Center ranking.
 *
 * Records are deduplicated by tradingDate + symbol. Individual scanner events
 * may still be retained separately so the original detection history is not lost.
 */

export type PracticeUniverseSourceType = "scanner" | "manual_watchlist";

export type PracticeSessionName =
  | "premarket"
  | "regular"
  | "afterhours"
  | "overnight"
  | "unknown";

export type PracticeDirection = "long" | "short" | "both" | "unknown";

export type PracticeDifficulty =
  | "beginner"
  | "intermediate"
  | "advanced"
  | "unrated";

export type PracticeQuality =
  | "excellent"
  | "good"
  | "average"
  | "limited"
  | "unrated";

export interface DailyScannerHit {
  /**
   * Stable event identifier. Scanner hits are not deduplicated because each
   * detection is useful when reconstructing what the trader saw during the day.
   */
  id: string;

  /**
   * Exchange trading date in YYYY-MM-DD format.
   */
  tradingDate: string;

  symbol: string;
  scannerId: string;
  scannerName: string;

  /**
   * Epoch milliseconds when the frontend received or recorded the result.
   */
  detectedAt: number;

  session: PracticeSessionName;

  price: number | null;
  score: number | null;
  percentChange: number | null;
  volume: number | null;

  /**
   * Scanner-specific label such as momentum, overnight, compression, or IFVG.
   */
  setup: string | null;

  /**
   * Original scanner source when available.
   */
  source: string | null;

  notes: string[];
}

export interface DailyManualWatchlistEvent {
  id: string;
  tradingDate: string;
  symbol: string;

  /**
   * Time the symbol was first added to the manual watchlist that day.
   */
  addedAt: number;

  /**
   * Time it was removed. Null means it remained on the list or has not yet
   * been removed.
   */
  removedAt: number | null;
}

export interface PracticeScannerSummary {
  scannerId: string;
  scannerName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  hitCount: number;

  bestScore: number | null;
  latestPrice: number | null;
  latestPercentChange: number | null;
  latestVolume: number | null;

  setups: string[];
  sessions: PracticeSessionName[];
}

export interface PracticeMarketStats {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  previousClose: number | null;

  totalVolume: number | null;
  relativeVolume: number | null;

  gapPercent: number | null;
  changePercent: number | null;
  rangePercent: number | null;
  dollarRange: number | null;

  premarketHigh: number | null;
  premarketLow: number | null;
  regularSessionHigh: number | null;
  regularSessionLow: number | null;

  moveStartedAt: number | null;
  highReachedAt: number | null;
  lowReachedAt: number | null;
}

export interface DailyPracticeSymbol {
  /**
   * Stable aggregate key in the form YYYY-MM-DD:SYMBOL.
   */
  id: string;

  tradingDate: string;
  symbol: string;

  /**
   * The complete set of sources that caused the symbol to belong to the day's
   * Practice Universe.
   */
  sourceTypes: PracticeUniverseSourceType[];

  scannerIds: string[];
  scannerNames: string[];
  scannerSummaries: PracticeScannerSummary[];

  scannerHitCount: number;
  firstSeenAt: number;
  lastSeenAt: number;

  wasOnManualWatchlist: boolean;
  manualWatchlistFirstAddedAt: number | null;
  manualWatchlistLastRemovedAt: number | null;

  /**
   * Preserves relevant scanner/watchlist context for later filtering.
   */
  setups: string[];
  sessions: PracticeSessionName[];
  notes: string[];

  /**
   * Populated by the end-of-day analyzer in a later phase.
   */
  marketStats: PracticeMarketStats | null;
  practiceScore: number | null;
  practiceQuality: PracticeQuality;
  difficulty: PracticeDifficulty;
  direction: PracticeDirection;
  tags: string[];

  wasTraded: boolean;
  wasPracticed: boolean;
  practiceCount: number;

  createdAt: number;
  updatedAt: number;
}

export interface DailyPracticeUniverse {
  /**
   * Exchange trading date in YYYY-MM-DD format.
   */
  tradingDate: string;

  symbols: DailyPracticeSymbol[];

  scannerHitCount: number;
  uniqueScannerSymbolCount: number;
  manualWatchlistSymbolCount: number;
  totalUniqueSymbolCount: number;

  scannerIds: string[];
  scannerNames: string[];

  createdAt: number;
  updatedAt: number;
}

export interface RecordScannerHitInput {
  tradingDate?: string;
  symbol: string;
  scannerId: string;
  scannerName?: string;
  detectedAt?: number;

  session?: PracticeSessionName;
  price?: number | null;
  score?: number | null;
  percentChange?: number | null;
  volume?: number | null;
  setup?: string | null;
  source?: string | null;
  notes?: string[];
}

export interface RecordManualWatchlistInput {
  tradingDate?: string;
  symbol: string;
  recordedAt?: number;
}

export interface RemoveManualWatchlistInput {
  tradingDate?: string;
  symbol: string;
  removedAt?: number;
}

export interface DailyPracticeUniverseSnapshot {
  version: 1;
  universes: DailyPracticeUniverse[];
}

export const DAILY_PRACTICE_UNIVERSE_SNAPSHOT_VERSION = 1 as const;

export function createDailyPracticeSymbolId(
  tradingDate: string,
  symbol: string,
): string {
  return `${tradingDate}:${normalizePracticeSymbol(symbol)}`;
}

export function normalizePracticeSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "");
}

export function normalizeScannerId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

export function createEmptyPracticeMarketStats(): PracticeMarketStats {
  return {
    open: null,
    high: null,
    low: null,
    close: null,
    previousClose: null,
    totalVolume: null,
    relativeVolume: null,
    gapPercent: null,
    changePercent: null,
    rangePercent: null,
    dollarRange: null,
    premarketHigh: null,
    premarketLow: null,
    regularSessionHigh: null,
    regularSessionLow: null,
    moveStartedAt: null,
    highReachedAt: null,
    lowReachedAt: null,
  };
}