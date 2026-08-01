// src/trading/intelligence/MarketContextStore.ts

import type {
  MarketContextDelta,
  MarketContextHistory,
  MarketContextListener,
  MarketContextProvider,
  MarketContextQuery,
  MarketContextSnapshot,
  MarketContextSource,
  MarketRegime,
  MarketRegimeChange,
} from "./types/MarketContextTypes";

export interface MarketContextStoreOptions {
  /** Maximum snapshots retained per symbol/timeframe stream. */
  maxSnapshotsPerStream?: number;
  /** Maximum regime-change records retained per stream. */
  maxRegimeChangesPerStream?: number;
  /** Ignore a snapshot when its ID already exists in the same stream. */
  rejectDuplicateIds?: boolean;
  /** Ignore snapshots older than the latest stored snapshot. */
  rejectOutOfOrderSnapshots?: boolean;
  /** Optional callback used to report non-fatal store warnings. */
  onWarning?: (message: string, snapshot?: MarketContextSnapshot) => void;
}

export interface MarketContextStoreSubscription {
  unsubscribe(): void;
}

export interface MarketContextStreamSubscriptionOptions {
  symbol?: string;
  timeframe?: string;
  source?: MarketContextSource | readonly MarketContextSource[];
  emitLatestImmediately?: boolean;
}

export interface MarketContextStoreStats {
  streamCount: number;
  snapshotCount: number;
  regimeChangeCount: number;
  listenerCount: number;
}

interface StoredStream {
  symbol: string;
  timeframe: string;
  snapshots: MarketContextSnapshot[];
  regimeChanges: MarketRegimeChange[];
  snapshotIds: Set<string>;
}

interface ListenerEntry {
  id: number;
  listener: MarketContextListener;
  options: MarketContextStreamSubscriptionOptions;
}

const DEFAULT_MAX_SNAPSHOTS_PER_STREAM = 2_000;
const DEFAULT_MAX_REGIME_CHANGES_PER_STREAM = 500;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizeTimeframe(timeframe: string): string {
  return timeframe.trim().toLowerCase();
}

function streamKey(symbol: string, timeframe: string): string {
  return `${normalizeSymbol(symbol)}::${normalizeTimeframe(timeframe)}`;
}

function asArray<T>(value: T | readonly T[] | undefined): readonly T[] | null {
  if (value === undefined) return null;
  return (Array.isArray(value) ? value : [value]) as readonly T[];
}

function includesValue<T>(candidate: T, allowed: T | readonly T[] | undefined): boolean {
  const values = asArray(allowed);
  return values === null || values.includes(candidate);
}

function containsAllTags(snapshotTags: readonly string[], queryTags?: readonly string[]): boolean {
  if (!queryTags || queryTags.length === 0) return true;
  const available = new Set(snapshotTags.map((tag) => tag.toLowerCase()));
  return queryTags.every((tag) => available.has(tag.toLowerCase()));
}

function compareSnapshotsAscending(
  left: MarketContextSnapshot,
  right: MarketContextSnapshot,
): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }

  return left.id.localeCompare(right.id);
}

function cloneSnapshotArray(
  snapshots: readonly MarketContextSnapshot[],
): MarketContextSnapshot[] {
  return snapshots.slice();
}

export class MarketContextStore implements MarketContextProvider {
  private readonly options: Required<
    Pick<
      MarketContextStoreOptions,
      | "maxSnapshotsPerStream"
      | "maxRegimeChangesPerStream"
      | "rejectDuplicateIds"
      | "rejectOutOfOrderSnapshots"
    >
  > &
    Pick<MarketContextStoreOptions, "onWarning">;

  private readonly streams = new Map<string, StoredStream>();
  private readonly listeners = new Map<number, ListenerEntry>();
  private nextListenerId = 1;

  constructor(options: MarketContextStoreOptions = {}) {
    this.options = {
      maxSnapshotsPerStream: Math.max(
        1,
        Math.floor(
          options.maxSnapshotsPerStream ?? DEFAULT_MAX_SNAPSHOTS_PER_STREAM,
        ),
      ),
      maxRegimeChangesPerStream: Math.max(
        1,
        Math.floor(
          options.maxRegimeChangesPerStream ??
            DEFAULT_MAX_REGIME_CHANGES_PER_STREAM,
        ),
      ),
      rejectDuplicateIds: options.rejectDuplicateIds ?? true,
      rejectOutOfOrderSnapshots: options.rejectOutOfOrderSnapshots ?? false,
      onWarning: options.onWarning,
    };
  }

  add(
    snapshot: MarketContextSnapshot,
    delta: MarketContextDelta | null = null,
  ): boolean {
    const symbol = normalizeSymbol(snapshot.symbol);
    const timeframe = normalizeTimeframe(snapshot.timeframe);

    if (!symbol || !timeframe) {
      this.warn("Market context snapshot requires a symbol and timeframe.", snapshot);
      return false;
    }

    const key = streamKey(symbol, timeframe);
    const stream = this.getOrCreateStream(symbol, timeframe);
    const latest = stream.snapshots.at(-1) ?? null;

    if (this.options.rejectDuplicateIds && stream.snapshotIds.has(snapshot.id)) {
      this.warn(`Duplicate market context snapshot ignored: ${snapshot.id}`, snapshot);
      return false;
    }

    if (
      this.options.rejectOutOfOrderSnapshots &&
      latest !== null &&
      snapshot.timestamp < latest.timestamp
    ) {
      this.warn(
        `Out-of-order market context snapshot ignored for ${symbol} ${timeframe}.`,
        snapshot,
      );
      return false;
    }

    const normalizedSnapshot =
      snapshot.symbol === symbol && snapshot.timeframe === timeframe
        ? snapshot
        : { ...snapshot, symbol, timeframe };

    stream.snapshots.push(normalizedSnapshot);
    stream.snapshotIds.add(normalizedSnapshot.id);

    if (
      stream.snapshots.length > 1 &&
      compareSnapshotsAscending(
        stream.snapshots[stream.snapshots.length - 2],
        normalizedSnapshot,
      ) > 0
    ) {
      stream.snapshots.sort(compareSnapshotsAscending);
    }

    this.trimSnapshots(stream);

    const previous = this.getPreviousForSnapshot(stream, normalizedSnapshot);
    const regimeChanged =
      previous !== null &&
      previous.regime.regime !== normalizedSnapshot.regime.regime;

    if (regimeChanged) {
      stream.regimeChanges.push(
        this.createRegimeChange(previous, normalizedSnapshot),
      );
      this.trimRegimeChanges(stream);
    }

    this.notify(normalizedSnapshot, delta);
    this.streams.set(key, stream);
    return true;
  }

  addMany(
    entries: readonly {
      snapshot: MarketContextSnapshot;
      delta?: MarketContextDelta | null;
    }[],
  ): number {
    let added = 0;

    for (const entry of entries) {
      if (this.add(entry.snapshot, entry.delta ?? null)) {
        added += 1;
      }
    }

    return added;
  }

  getLatest(symbol: string, timeframe: string): MarketContextSnapshot | null {
    const stream = this.streams.get(streamKey(symbol, timeframe));
    return stream?.snapshots.at(-1) ?? null;
  }

  getPrevious(symbol: string, timeframe: string): MarketContextSnapshot | null {
    const stream = this.streams.get(streamKey(symbol, timeframe));
    if (!stream || stream.snapshots.length < 2) return null;
    return stream.snapshots[stream.snapshots.length - 2];
  }

  getById(snapshotId: string): MarketContextSnapshot | null {
    for (const stream of this.streams.values()) {
      if (!stream.snapshotIds.has(snapshotId)) continue;
      return stream.snapshots.find((snapshot) => snapshot.id === snapshotId) ?? null;
    }

    return null;
  }

  getHistory(query: MarketContextQuery): MarketContextSnapshot[] {
    const snapshots: MarketContextSnapshot[] = [];
    const requestedSymbol = query.symbol
      ? normalizeSymbol(query.symbol)
      : undefined;
    const requestedTimeframe = query.timeframe
      ? normalizeTimeframe(query.timeframe)
      : undefined;

    for (const stream of this.streams.values()) {
      if (requestedSymbol && stream.symbol !== requestedSymbol) continue;
      if (requestedTimeframe && stream.timeframe !== requestedTimeframe) continue;

      for (const snapshot of stream.snapshots) {
        if (!this.matchesQuery(snapshot, query)) continue;
        snapshots.push(snapshot);
      }
    }

    snapshots.sort(compareSnapshotsAscending);

    if (query.limit !== undefined) {
      const limit = Math.max(0, Math.floor(query.limit));
      return limit === 0 ? [] : snapshots.slice(-limit);
    }

    return snapshots;
  }

  getStreamHistory(symbol: string, timeframe: string): MarketContextHistory {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedTimeframe = normalizeTimeframe(timeframe);
    const stream = this.streams.get(
      streamKey(normalizedSymbol, normalizedTimeframe),
    );
    const snapshots = stream ? cloneSnapshotArray(stream.snapshots) : [];

    return {
      symbol: normalizedSymbol,
      timeframe: normalizedTimeframe,
      snapshots,
      latest: snapshots.at(-1) ?? null,
      previous: snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null,
      regimeChanges: stream ? stream.regimeChanges.slice() : [],
    };
  }

  getRegimeChanges(
    symbol?: string,
    timeframe?: string,
    limit?: number,
  ): MarketRegimeChange[] {
    const normalizedSymbol = symbol ? normalizeSymbol(symbol) : undefined;
    const normalizedTimeframe = timeframe
      ? normalizeTimeframe(timeframe)
      : undefined;
    const changes: MarketRegimeChange[] = [];

    for (const stream of this.streams.values()) {
      if (normalizedSymbol && stream.symbol !== normalizedSymbol) continue;
      if (normalizedTimeframe && stream.timeframe !== normalizedTimeframe) continue;
      changes.push(...stream.regimeChanges);
    }

    changes.sort((left, right) => left.timestamp - right.timestamp);

    if (limit === undefined) return changes;
    const safeLimit = Math.max(0, Math.floor(limit));
    return safeLimit === 0 ? [] : changes.slice(-safeLimit);
  }

  subscribe(
    listener: MarketContextListener,
    options: MarketContextStreamSubscriptionOptions = {},
  ): MarketContextStoreSubscription {
    const id = this.nextListenerId++;
    const normalizedOptions: MarketContextStreamSubscriptionOptions = {
      ...options,
      symbol: options.symbol ? normalizeSymbol(options.symbol) : undefined,
      timeframe: options.timeframe
        ? normalizeTimeframe(options.timeframe)
        : undefined,
    };

    this.listeners.set(id, {
      id,
      listener,
      options: normalizedOptions,
    });

    if (normalizedOptions.emitLatestImmediately) {
      const latestSnapshots = this.getLatestMatchingSnapshots(normalizedOptions);
      for (const snapshot of latestSnapshots) {
        listener(snapshot, null);
      }
    }

    return {
      unsubscribe: () => {
        this.listeners.delete(id);
      },
    };
  }

  clear(symbol?: string, timeframe?: string): number {
    if (!symbol && !timeframe) {
      const count = this.streams.size;
      this.streams.clear();
      return count;
    }

    const normalizedSymbol = symbol ? normalizeSymbol(symbol) : undefined;
    const normalizedTimeframe = timeframe
      ? normalizeTimeframe(timeframe)
      : undefined;
    let removed = 0;

    for (const [key, stream] of this.streams.entries()) {
      if (normalizedSymbol && stream.symbol !== normalizedSymbol) continue;
      if (normalizedTimeframe && stream.timeframe !== normalizedTimeframe) continue;
      this.streams.delete(key);
      removed += 1;
    }

    return removed;
  }

  removeSnapshot(snapshotId: string): boolean {
    for (const stream of this.streams.values()) {
      const index = stream.snapshots.findIndex(
        (snapshot) => snapshot.id === snapshotId,
      );
      if (index < 0) continue;

      stream.snapshots.splice(index, 1);
      stream.snapshotIds.delete(snapshotId);
      stream.regimeChanges = stream.regimeChanges.filter(
        (change) => change.snapshotId !== snapshotId,
      );
      return true;
    }

    return false;
  }

  getStats(): MarketContextStoreStats {
    let snapshotCount = 0;
    let regimeChangeCount = 0;

    for (const stream of this.streams.values()) {
      snapshotCount += stream.snapshots.length;
      regimeChangeCount += stream.regimeChanges.length;
    }

    return {
      streamCount: this.streams.size,
      snapshotCount,
      regimeChangeCount,
      listenerCount: this.listeners.size,
    };
  }

  private getOrCreateStream(symbol: string, timeframe: string): StoredStream {
    const key = streamKey(symbol, timeframe);
    const existing = this.streams.get(key);
    if (existing) return existing;

    const created: StoredStream = {
      symbol,
      timeframe,
      snapshots: [],
      regimeChanges: [],
      snapshotIds: new Set<string>(),
    };
    this.streams.set(key, created);
    return created;
  }

  private trimSnapshots(stream: StoredStream): void {
    const excess =
      stream.snapshots.length - this.options.maxSnapshotsPerStream;
    if (excess <= 0) return;

    const removed = stream.snapshots.splice(0, excess);
    for (const snapshot of removed) {
      stream.snapshotIds.delete(snapshot.id);
    }
  }

  private trimRegimeChanges(stream: StoredStream): void {
    const excess =
      stream.regimeChanges.length - this.options.maxRegimeChangesPerStream;
    if (excess > 0) {
      stream.regimeChanges.splice(0, excess);
    }
  }

  private getPreviousForSnapshot(
    stream: StoredStream,
    snapshot: MarketContextSnapshot,
  ): MarketContextSnapshot | null {
    const index = stream.snapshots.findIndex((item) => item.id === snapshot.id);
    return index > 0 ? stream.snapshots[index - 1] : null;
  }

  private createRegimeChange(
    previous: MarketContextSnapshot,
    current: MarketContextSnapshot,
  ): MarketRegimeChange {
    const reasonIds = current.reasons
      .filter((reason) => reason.confidence >= 0.35)
      .sort((left, right) => right.importance - left.importance)
      .slice(0, 8)
      .map((reason) => reason.id);

    return {
      id: `regime_${current.id}`,
      symbol: current.symbol,
      timeframe: current.timeframe,
      timestamp: current.timestamp,
      from: previous.regime.regime,
      to: current.regime.regime,
      confidence: current.regime.confidence,
      reasonIds,
      snapshotId: current.id,
    };
  }

  private matchesQuery(
    snapshot: MarketContextSnapshot,
    query: MarketContextQuery,
  ): boolean {
    if (
      query.symbol &&
      snapshot.symbol !== normalizeSymbol(query.symbol)
    ) {
      return false;
    }

    if (
      query.timeframe &&
      snapshot.timeframe !== normalizeTimeframe(query.timeframe)
    ) {
      return false;
    }

    if (!includesValue(snapshot.source, query.source)) return false;
    if (!includesValue(snapshot.regime.regime, query.regime)) return false;
    if (!includesValue(snapshot.direction, query.direction)) return false;

    if (
      query.minimumScore !== undefined &&
      snapshot.normalizedScore < query.minimumScore
    ) {
      return false;
    }

    if (
      query.minimumConfidence !== undefined &&
      snapshot.confidence < query.minimumConfidence
    ) {
      return false;
    }

    if (
      query.fromTimestamp !== undefined &&
      snapshot.timestamp < query.fromTimestamp
    ) {
      return false;
    }

    if (
      query.toTimestamp !== undefined &&
      snapshot.timestamp > query.toTimestamp
    ) {
      return false;
    }

    return containsAllTags(snapshot.tags, query.tags);
  }

  private getLatestMatchingSnapshots(
    options: MarketContextStreamSubscriptionOptions,
  ): MarketContextSnapshot[] {
    const snapshots: MarketContextSnapshot[] = [];

    for (const stream of this.streams.values()) {
      const latest = stream.snapshots.at(-1);
      if (!latest || !this.listenerMatches(latest, options)) continue;
      snapshots.push(latest);
    }

    return snapshots.sort(compareSnapshotsAscending);
  }

  private listenerMatches(
    snapshot: MarketContextSnapshot,
    options: MarketContextStreamSubscriptionOptions,
  ): boolean {
    if (options.symbol && snapshot.symbol !== options.symbol) return false;
    if (options.timeframe && snapshot.timeframe !== options.timeframe) {
      return false;
    }
    return includesValue(snapshot.source, options.source);
  }

  private notify(
    snapshot: MarketContextSnapshot,
    delta: MarketContextDelta | null,
  ): void {
    for (const entry of this.listeners.values()) {
      if (!this.listenerMatches(snapshot, entry.options)) continue;

      try {
        entry.listener(snapshot, delta);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.warn(`Market context listener failed: ${message}`, snapshot);
      }
    }
  }

  private warn(message: string, snapshot?: MarketContextSnapshot): void {
    this.options.onWarning?.(message, snapshot);
  }
}

export function createMarketContextStore(
  options: MarketContextStoreOptions = {},
): MarketContextStore {
  return new MarketContextStore(options);
}

export function isRegimeChange(
  previous: MarketContextSnapshot | null,
  current: MarketContextSnapshot,
): boolean {
  return (
    previous !== null &&
    previous.regime.regime !== current.regime.regime
  );
}

export function getRegimeDirection(regime: MarketRegime): -1 | 0 | 1 {
  switch (regime) {
    case "strong-uptrend":
    case "uptrend":
    case "bullish-expansion":
    case "bullish-pullback":
    case "breakout":
      return 1;
    case "strong-downtrend":
    case "downtrend":
    case "bearish-expansion":
    case "bearish-pullback":
    case "breakdown":
      return -1;
    default:
      return 0;
  }
}
