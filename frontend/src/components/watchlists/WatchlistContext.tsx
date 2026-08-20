import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  API_BASE,
  fetchScannerCache,
} from "../../services/api";

import { dailyPracticeUniverseEngine } from "../../trading/practice/DailyPracticeUniverseEngine";
import {
  readSelectedPracticeTradingDate,
  subscribeToSelectedPracticeTradingDate,
} from "../../trading/practice/PracticeReplayLauncher";
import {
  MARKET_DATA_MODE_CHANGE_EVENT,
  MARKET_DATA_MODE_STORAGE_KEY,
  type MarketDataMode,
} from "../../trading/replay/ReplayTypes";

export type WatchlistType = "manual" | "scanner" | "custom" | "favorites";

export type WatchlistSymbolTone = "ready" | "watch" | "weak";

export interface WatchlistSymbol {
  symbol: string;
  company?: string;
  score?: number;
  tone?: WatchlistSymbolTone;
  setup?: string;
  scanner?: string;
  note?: string;
  lastPrice?: number;
  percentChange?: number;
  volume?: number;
  source?: string;
}

export interface Watchlist {
  id: string;
  name: string;
  type: WatchlistType;
  description?: string;
  symbols: WatchlistSymbol[];
}

type ReplaceSymbolsOptions = {
  name?: string;
  type?: WatchlistType;
  description?: string;
  activate?: boolean;
  allowEmpty?: boolean;
};

interface WatchlistContextValue {
  watchlists: Watchlist[];
  activeWatchlistId: string;
  activeWatchlist: Watchlist | undefined;

  setActiveWatchlist(id: string): void;

  createWatchlist(name: string, type?: WatchlistType): void;
  renameWatchlist(id: string, name: string): void;
  deleteWatchlist(id: string): void;

  addSymbol(watchlistId: string, symbol: string | WatchlistSymbol): void;
  removeSymbol(watchlistId: string, symbol: string): void;
  replaceSymbols(
    watchlistId: string,
    symbols: Array<string | WatchlistSymbol>,
    options?: ReplaceSymbolsOptions
  ): void;
  syncScannerWatchlists(definitions: ScannerWatchlistDefinition[]): void;
}

type ScannerWatchlistDefinition = {
  id: string;
  name: string;
  description?: string;
};

const VWAP3_TARGET_WATCHLIST: ScannerWatchlistDefinition = {
  id: "vwap3_target",
  name: "VWAP +3 Target",
  description: "VWAP +3 Target scanner symbols.",
};

const WatchlistContext = createContext<WatchlistContextValue | null>(null);

const WATCHLIST_STORAGE_KEY = "trading.workstation.watchlists.v1";
const ACTIVE_WATCHLIST_STORAGE_KEY = "trading.workstation.activeWatchlist.v1";
const MANUAL_WATCHLIST_POLL_MS = 10_000;
const SCANNER_WATCHLIST_POLL_MS = 45_000;

type CachedScannerRow = {
  symbol?: unknown;
  score?: number;
  score_at_freeze?: number;
  original_score?: number;
  current_score?: number;
  ah_score?: number;
  runner_score?: number;
  pm_runner_score?: number;
  compression_score?: number;
  breakout_score?: number;
  price?: number;
  last_price?: number;
  change_pct?: number;
  gap_pct?: number;
  pm_gap_pct?: number;
  volume?: number;
  ah_volume?: number;
  pm_volume?: number;
  runner_type?: string;
  source?: string;
  notes?: string[];
};

type CachedScannerResult = {
  scanner_id?: string;
  scanner_name?: string;
  description?: string;
  rows?: CachedScannerRow[];
};

type ArchivedScannerWatchlist = {
  symbols?: string[];
  seenSymbols?: string[];
  rows?: CachedScannerRow[];
  count?: number;
  updatedAt?: string | null;
  workflow?: string | null;
  source?: string | null;
};

type ArchivedDailyWatchlist = {
  tradeDate?: string;
  updatedAt?: string | null;
  manual?: {
    symbols?: string[];
    seenSymbols?: string[];
    updatedAt?: string | null;
  };
  scanners?: Record<string, ArchivedScannerWatchlist>;
  scannerSymbols?: string[];
  scannerSeenSymbols?: string[];
  combinedSymbols?: string[];
  combinedSeenSymbols?: string[];
};

type ManualWatchlistApiResponse = {
  symbol?: string;
  enabled?: boolean;
  symbols: string[];
  count: number;
  updatedAt: number | null;
};

async function parseManualWatchlistResponse(
  response: Response
): Promise<ManualWatchlistApiResponse> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Manual watchlist request failed: ${response.status} ${text}`
    );
  }

  const payload = JSON.parse(text) as Partial<ManualWatchlistApiResponse>;
  const symbols = uniqueSymbolStrings(payload.symbols ?? []);

  return {
    symbol: payload.symbol ? normalizeSymbol(payload.symbol) : undefined,
    enabled: payload.enabled,
    symbols,
    count: symbols.length,
    updatedAt:
      typeof payload.updatedAt === "number" ? payload.updatedAt : null,
  };
}

async function fetchManualWatchlist(): Promise<ManualWatchlistApiResponse> {
  const response = await fetch(`${API_BASE}/app-state/alpaca/manual-watchlist`);
  return parseManualWatchlistResponse(response);
}

async function saveManualWatchlist(
  symbols: string[]
): Promise<ManualWatchlistApiResponse> {
  const response = await fetch(`${API_BASE}/app-state/alpaca/manual-watchlist`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols: uniqueSymbolStrings(symbols) }),
  });

  return parseManualWatchlistResponse(response);
}

async function setManualWatchlistSymbol(
  symbol: string,
  enabled: boolean
): Promise<ManualWatchlistApiResponse> {
  const response = await fetch(
    `${API_BASE}/app-state/alpaca/manual-watchlist/toggle`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: normalizeSymbol(symbol), enabled }),
    }
  );

  return parseManualWatchlistResponse(response);
}

function readMarketDataMode(): MarketDataMode {
  if (typeof window === "undefined") return "live";
  return window.localStorage.getItem(MARKET_DATA_MODE_STORAGE_KEY) === "replay"
    ? "replay"
    : "live";
}

async function fetchArchivedDailyWatchlist(
  tradingDate: string,
): Promise<ArchivedDailyWatchlist | null> {
  const normalized = String(tradingDate ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;

  const response = await fetch(
    `${API_BASE}/backtests/watchlists/${encodeURIComponent(normalized)}`,
    { headers: { Accept: "application/json" } },
  );

  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Archived watchlist request failed: ${response.status} ${text}`,
    );
  }

  const payload = JSON.parse(text) as ArchivedDailyWatchlist;
  return payload && typeof payload === "object" ? payload : null;
}

function cachedScannerRowToWatchlistSymbol(
  row: CachedScannerRow,
  definition: ScannerWatchlistDefinition,
): WatchlistSymbol | null {
  const symbol = normalizeSymbol(row.symbol);
  if (!symbol) return null;

  const rawScore = Number(
    row.score_at_freeze ??
      row.original_score ??
      row.current_score ??
      row.score ??
      row.ah_score ??
      row.runner_score ??
      row.pm_runner_score ??
      row.compression_score ??
      row.breakout_score ??
      0,
  );
  const score = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(100, Math.round(rawScore)))
    : 0;

  return normalizeWatchlistSymbol({
    symbol,
    score,
    tone: score >= 70 ? "ready" : score <= 45 ? "weak" : "watch",
    setup: row.runner_type ?? row.source ?? definition.name,
    scanner: definition.name,
    note: row.notes?.join(" · ") ?? "",
    lastPrice: row.last_price ?? row.price,
    percentChange: row.pm_gap_pct ?? row.gap_pct ?? row.change_pct,
    volume: row.pm_volume ?? row.ah_volume ?? row.volume,
    source: row.source ?? row.runner_type ?? definition.id,
  });
}

function buildReplayWatchlistsFromArchive(
  payload: ArchivedDailyWatchlist | null,
  tradingDate: string,
): Watchlist[] {
  const manualRaw = payload?.manual;
  const manualSymbols = uniqueSymbolStrings(
    manualRaw?.symbols?.length
      ? manualRaw.symbols
      : manualRaw?.seenSymbols ?? [],
  );

  const manual: Watchlist = {
    id: "manual",
    name: "Manual Watchlist",
    type: "manual",
    description: `Archived manual watchlist for replay ${tradingDate}.`,
    symbols: manualSymbols
      .map((symbol) => normalizeWatchlistSymbol(symbol))
      .filter((item): item is WatchlistSymbol => item !== null),
  };

  const definition = VWAP3_TARGET_WATCHLIST;
  const archivedScanner = payload?.scanners?.[definition.id];
  const rowSymbols = (Array.isArray(archivedScanner?.rows)
    ? archivedScanner.rows
    : []
  )
    .map((row) => cachedScannerRowToWatchlistSymbol(row, definition))
    .filter((item): item is WatchlistSymbol => item !== null);

  const seenScannerSymbols = uniqueSymbolStrings(
    archivedScanner?.seenSymbols?.length
      ? archivedScanner.seenSymbols
      : archivedScanner?.symbols?.length
        ? archivedScanner.symbols
        : payload?.scannerSeenSymbols?.length
          ? payload.scannerSeenSymbols
          : payload?.scannerSymbols ?? [],
  );

  const rowBySymbol = new Map(rowSymbols.map((item) => [item.symbol, item]));
  const scannerSymbols = seenScannerSymbols.map((symbol) =>
    rowBySymbol.get(symbol) ??
    normalizeWatchlistSymbol({
      symbol,
      score: 0,
      tone: "watch",
      setup: "Replay scanner pick",
      scanner: definition.name,
      source: definition.id,
    })!,
  );

  const scanner: Watchlist = {
    id: definition.id,
    name: definition.name,
    type: "scanner",
    description: `Archived scanner watchlist for replay ${tradingDate}.`,
    symbols: uniqueWatchlistSymbols(scannerSymbols),
  };

  return [manual, scanner];
}

function buildReplayWatchlistsFromLocalUniverse(tradingDate: string): Watchlist[] {
  const universe = dailyPracticeUniverseEngine.getUniverse(tradingDate);
  if (!universe) return buildReplayWatchlistsFromArchive(null, tradingDate);

  const manualSymbols = universe.symbols
    .filter((item) => item.wasOnManualWatchlist)
    .map((item) => item.symbol);
  const scannerSymbols = universe.symbols
    .filter((item) =>
      item.scannerIds.includes(VWAP3_TARGET_WATCHLIST.id) ||
      item.sourceTypes.includes("scanner"),
    )
    .map((item) => {
      const summary = item.scannerSummaries.find(
        (entry) => entry.scannerId === VWAP3_TARGET_WATCHLIST.id,
      );
      return normalizeWatchlistSymbol({
        symbol: item.symbol,
        score: summary?.bestScore ?? 0,
        tone:
          (summary?.bestScore ?? 0) >= 70
            ? "ready"
            : (summary?.bestScore ?? 0) <= 45
              ? "weak"
              : "watch",
        setup: summary?.setups?.[0] ?? "Replay scanner pick",
        scanner: VWAP3_TARGET_WATCHLIST.name,
        lastPrice: summary?.latestPrice ?? undefined,
        percentChange: summary?.latestPercentChange ?? undefined,
        volume: summary?.latestVolume ?? undefined,
        source: VWAP3_TARGET_WATCHLIST.id,
      });
    })
    .filter((item): item is WatchlistSymbol => item !== null);

  return [
    {
      id: "manual",
      name: "Manual Watchlist",
      type: "manual",
      description: `Locally recorded manual watchlist for replay ${tradingDate}.`,
      symbols: uniqueSymbolStrings(manualSymbols)
        .map((symbol) => normalizeWatchlistSymbol(symbol))
        .filter((item): item is WatchlistSymbol => item !== null),
    },
    {
      id: VWAP3_TARGET_WATCHLIST.id,
      name: VWAP3_TARGET_WATCHLIST.name,
      type: "scanner",
      description: `Locally recorded scanner watchlist for replay ${tradingDate}.`,
      symbols: uniqueWatchlistSymbols(scannerSymbols),
    },
  ];
}

const LEGACY_MANUAL_KEYS = [
  "watchlist",
  "manualWatchlist",
  "alpacaManualWatchlist",
  "manual-watchlist",
  "terminalManualWatchlist",
  "sharedManualWatchlist",
  "activeManualWatchlist",
  "trading.manual.watchlist",
  "tradingTerminalManualWatchlist",
];

const DEFAULT_WATCHLISTS: Watchlist[] = [
  {
    id: "manual",
    name: "Manual Watchlist",
    type: "manual",
    description: "User selected symbols for active monitoring.",
    symbols: [],
  },
];

const KNOWN_WATCHLIST_NAMES: Record<string, string> = {
  scanner: "Scanner Watchlist",
  manual: "Manual Watchlist",
  favorites: "Favorites",
  momentum: "Momentum",
  compression: "Compression",
  ifvg: "IFVG",
  gaprunner: "Gap Runner",
  gap_atr_runner: "Gap ATR Runner",
  hourly_sweep_runner: "Hourly Sweep",
  overnight_runner: "Overnight Runner",
  five_am_sweep: "5AM Sweep",
  lowfloat: "Low Float",
};

function createId(): string {
  return `watchlist_${Date.now()}_${Math.round(Math.random() * 10000)}`;
}

function normalizeSymbol(symbol: unknown): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "");
}

function normalizeWatchlistId(id: string): string {
  return String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function titleCaseFromId(id: string): string {
  const normalized = normalizeWatchlistId(id);
  const known = KNOWN_WATCHLIST_NAMES[normalized];

  if (known) return known;

  return normalized
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function extractSymbolsFromUnknown(input: unknown): string[] {
  if (Array.isArray(input)) {
    return uniqueSymbolStrings(
      input.map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "symbol" in item) {
          return (item as { symbol?: unknown }).symbol;
        }
        return "";
      })
    );
  }

  if (typeof input === "string") {
    return uniqueSymbolStrings(input.split(/[\s,;]+/g));
  }

  if (input && typeof input === "object") {
    const data = input as Record<string, unknown>;
    const possibleLists = [
      data.manualWatchlist,
      data.manual_watchlist,
      data.manualSymbols,
      data.manual_symbols,
      data.symbols,
      data.watchlist,
      data.selectedSymbols,
      data.selected_symbols,
    ];

    for (const possibleList of possibleLists) {
      const symbols = extractSymbolsFromUnknown(possibleList);
      if (symbols.length > 0) return symbols;
    }
  }

  return [];
}

function uniqueSymbolStrings(symbols: unknown[]): string[] {
  return Array.from(
    new Set(symbols.map(normalizeSymbol).filter(Boolean))
  );
}

function normalizeWatchlistSymbol(
  input: string | WatchlistSymbol
): WatchlistSymbol | null {
  if (typeof input === "string") {
    const symbol = normalizeSymbol(input);
    if (!symbol) return null;

    return {
      symbol,
      score: 0,
      tone: "watch",
      setup: "Watchlist",
      note: "",
      source: "manual",
    };
  }

  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) return null;

  return {
    ...input,
    symbol,
    score: input.score ?? 0,
    tone: input.tone ?? "watch",
    setup: input.setup ?? "Watchlist",
    note: input.note ?? "",
  };
}

function uniqueWatchlistSymbols(symbols: WatchlistSymbol[]): WatchlistSymbol[] {
  return Array.from(
    new Map(symbols.map((item) => [item.symbol, item])).values()
  );
}

function normalizeWatchlist(input: Watchlist): Watchlist | null {
  const id = normalizeWatchlistId(input.id);
  if (!id) return null;

  const symbols = (input.symbols ?? [])
    .map((item) => normalizeWatchlistSymbol(item))
    .filter((item): item is WatchlistSymbol => item !== null);

  return {
    id,
    name: input.name?.trim() || titleCaseFromId(id),
    type: input.type ?? "custom",
    description: input.description ?? "",
    symbols: uniqueWatchlistSymbols(symbols),
  };
}

function ensureDefaults(watchlists: Watchlist[]): Watchlist[] {
  const storedManual = watchlists
    .map((item) => normalizeWatchlist(item))
    .find((item) => item?.id === "manual");

  return [storedManual ?? DEFAULT_WATCHLISTS[0]];
}

function parseStoredWatchlists(raw: string | null): Watchlist[] {
  if (!raw) return DEFAULT_WATCHLISTS;

  try {
    const parsed = JSON.parse(raw) as Watchlist[];
    if (!Array.isArray(parsed)) return DEFAULT_WATCHLISTS;

    return ensureDefaults(parsed);
  } catch {
    return DEFAULT_WATCHLISTS;
  }
}

function readLegacyManualSymbols(): string[] {
  if (typeof window === "undefined") return [];

  const all: string[] = [];

  for (const key of LEGACY_MANUAL_KEYS) {
    const raw = window.localStorage.getItem(key);
    if (raw == null) continue;

    try {
      all.push(...extractSymbolsFromUnknown(JSON.parse(raw)));
    } catch {
      all.push(...extractSymbolsFromUnknown(raw));
    }
  }

  return uniqueSymbolStrings(all);
}

function writeLegacyManualSymbols(symbols: string[]): void {
  if (typeof window === "undefined") return;

  const cleaned = uniqueSymbolStrings(symbols);

  for (const key of LEGACY_MANUAL_KEYS) {
    try {
      window.localStorage.setItem(key, JSON.stringify(cleaned));
    } catch {
      // Ignore localStorage write failures.
    }
  }

  window.dispatchEvent(
    new CustomEvent("manual-watchlist-change", {
      detail: { symbols: cleaned },
    })
  );
}

function getManualSymbols(watchlists: Watchlist[]): string[] {
  const manual = watchlists.find((item) => item.id === "manual");

  return (manual?.symbols ?? [])
    .map((item) => normalizeSymbol(item.symbol))
    .filter(Boolean);
}

function recordScannerWatchlistSymbols(
  watchlistId: string,
  watchlistName: string,
  symbols: WatchlistSymbol[]
): void {
  for (const item of symbols) {
    dailyPracticeUniverseEngine.recordScannerHit({
      symbol: item.symbol,
      scannerId: watchlistId,
      scannerName: watchlistName,
      price: item.lastPrice ?? null,
      score: item.score ?? null,
      percentChange: item.percentChange ?? null,
      volume: item.volume ?? null,
      setup: item.setup ?? null,
      source: item.source ?? item.scanner ?? watchlistId,
      notes: item.note ? [item.note] : [],
    });
  }
}

function setManualSymbols(watchlists: Watchlist[], symbols: string[]): Watchlist[] {
  const cleaned = uniqueSymbolStrings(symbols);
  const manualSymbols = cleaned
    .map((symbol) => normalizeWatchlistSymbol(symbol))
    .filter((item): item is WatchlistSymbol => item !== null);

  const exists = watchlists.some((item) => item.id === "manual");
  const base = exists ? watchlists : ensureDefaults(watchlists);

  return base.map((watchlist) =>
    watchlist.id === "manual"
      ? {
          ...watchlist,
          symbols: manualSymbols,
        }
      : watchlist
  );
}

function loadWatchlists(): Watchlist[] {
  if (typeof window === "undefined") return DEFAULT_WATCHLISTS;

  const stored = parseStoredWatchlists(
    window.localStorage.getItem(WATCHLIST_STORAGE_KEY)
  );

  const legacyManual = readLegacyManualSymbols();

  if (legacyManual.length === 0) {
    return stored;
  }

  const currentManual = getManualSymbols(stored);
  const mergedManual = uniqueSymbolStrings([...currentManual, ...legacyManual]);

  return setManualSymbols(stored, mergedManual);
}

function loadActiveWatchlistId(): string {
  if (typeof window === "undefined") return "manual";

  return (
    window.localStorage.getItem(ACTIVE_WATCHLIST_STORAGE_KEY) ||
    "manual"
  );
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [watchlists, setWatchlists] = useState<Watchlist[]>(loadWatchlists);
  const [activeWatchlistId, setActiveWatchlistId] = useState(loadActiveWatchlistId);
  const [backendSyncReady, setBackendSyncReady] = useState(false);
  const [marketDataMode, setWatchlistMarketDataMode] = useState<MarketDataMode>(
    readMarketDataMode,
  );
  const [replayTradingDate, setReplayTradingDate] = useState(
    () => readSelectedPracticeTradingDate(),
  );
  const didBootstrapBackendRef = useRef(false);
  const initialManualSymbolsRef = useRef<string[]>(getManualSymbols(watchlists));
  const liveWatchlistsRef = useRef<Watchlist[]>(watchlists);
  const manualMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const previousManualSymbolsRef = useRef<Set<string>>(new Set());
  const didCaptureInitialManualRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const applyMode = (next: MarketDataMode) => {
      if (next === "live") {
        setWatchlists(liveWatchlistsRef.current);
      }
      setWatchlistMarketDataMode(next);
    };

    const handleModeChange = (event: Event) => {
      const custom = event as CustomEvent<MarketDataMode>;
      applyMode(custom.detail === "replay" ? "replay" : "live");
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== MARKET_DATA_MODE_STORAGE_KEY) return;
      applyMode(event.newValue === "replay" ? "replay" : "live");
    };

    window.addEventListener(MARKET_DATA_MODE_CHANGE_EVENT, handleModeChange);
    window.addEventListener("storage", handleStorage);
    const unsubscribeDate = subscribeToSelectedPracticeTradingDate(
      setReplayTradingDate,
    );

    return () => {
      unsubscribeDate();
      window.removeEventListener(MARKET_DATA_MODE_CHANGE_EVENT, handleModeChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (marketDataMode === "live") {
      liveWatchlistsRef.current = watchlists;
    }
  }, [marketDataMode, watchlists]);

  useEffect(() => {
    if (marketDataMode === "replay") return;

    let cancelled = false;
    let refreshInFlight = false;

    async function loadScannerWatchlists() {
      if (refreshInFlight) return;
      refreshInFlight = true;

      try {
        const normalizedDefinitions = [VWAP3_TARGET_WATCHLIST]
          .map((definition) => ({
            ...definition,
            id: normalizeWatchlistId(definition.id),
            name: definition.name.trim(),
          }))
          .filter((definition) => definition.id && definition.name);

        const cachedResults = await Promise.all(
          normalizedDefinitions.map(async (definition) => {
            try {
              const cache = await fetchScannerCache(definition.id);
              return [definition.id, cache.data as CachedScannerResult | null] as const;
            } catch (error) {
              console.warn(
                `[WatchlistContext] scanner cache load failed for ${definition.id}`,
                error
              );
              return [definition.id, null] as const;
            }
          })
        );
        if (cancelled) return;

        const cachedById = new Map(cachedResults);

        setWatchlists((current) => {
          const manual =
            current.find((watchlist) => watchlist.id === "manual") ??
            DEFAULT_WATCHLISTS[0];
          return [
            manual,
            ...normalizedDefinitions.map((definition) => {
              const cached = cachedById.get(definition.id);
              const rows = Array.isArray(cached?.rows) ? cached.rows : [];
              const symbols = rows
                .map((row) => cachedScannerRowToWatchlistSymbol(row, definition))
                .filter((item): item is WatchlistSymbol => item !== null);

              return {
                id: definition.id,
                name: cached?.scanner_name ?? definition.name,
                type: "scanner" as const,
                description:
                  cached?.description ??
                  definition.description ??
                  `Scanner-generated symbols for ${definition.name}.`,
                symbols: uniqueWatchlistSymbols(symbols),
              };
            }),
          ];
        });

        setActiveWatchlistId((current) => {
          const validIds = new Set([
            "manual",
            ...normalizedDefinitions.map((definition) => definition.id),
          ]);
          return validIds.has(current) ? current : "manual";
        });
      } catch (error) {
        console.warn("[WatchlistContext] VWAP +3 scanner cache load failed", error);
      } finally {
        refreshInFlight = false;
      }
    }

    void loadScannerWatchlists();
    const pollTimer = window.setInterval(
      () => void loadScannerWatchlists(),
      SCANNER_WATCHLIST_POLL_MS
    );

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, [marketDataMode]);

  useEffect(() => {
    if (marketDataMode !== "replay" || !replayTradingDate) return;

    let cancelled = false;

    async function loadReplayWatchlists() {
      try {
        const archived = await fetchArchivedDailyWatchlist(replayTradingDate);
        if (cancelled) return;

        const next = archived
          ? buildReplayWatchlistsFromArchive(archived, replayTradingDate)
          : buildReplayWatchlistsFromLocalUniverse(replayTradingDate);

        setWatchlists(next);
        setActiveWatchlistId((current) =>
          next.some((watchlist) => watchlist.id === current)
            ? current
            : "manual",
        );
      } catch (error) {
        console.warn(
          `[WatchlistContext] replay watchlist load failed for ${replayTradingDate}`,
          error,
        );
        if (cancelled) return;
        const fallback = buildReplayWatchlistsFromLocalUniverse(replayTradingDate);
        setWatchlists(fallback);
        setActiveWatchlistId((current) =>
          fallback.some((watchlist) => watchlist.id === current)
            ? current
            : "manual",
        );
      }
    }

    void loadReplayWatchlists();

    return () => {
      cancelled = true;
    };
  }, [marketDataMode, replayTradingDate]);

  const queueManualMutation = useCallback(
    (operation: () => Promise<ManualWatchlistApiResponse>) => {
      manualMutationQueueRef.current = manualMutationQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const snapshot = await operation();
          setWatchlists((current) =>
            setManualSymbols(current, snapshot.symbols)
          );
        })
        .catch((error) => {
          console.warn("[WatchlistContext] manual watchlist sync failed", error);
        });
    },
    []
  );

  useEffect(() => {
    if (typeof window === "undefined" || marketDataMode === "replay") return;

    // Scanner watchlists are runtime data refreshed from the backend every 45s.
    // Persisting every scanner row (price, volume, notes, scores, etc.) can easily
    // exceed the browser's localStorage quota and crash the React tree.  Only the
    // small manual list needs local persistence; the backend remains authoritative.
    const manual = watchlists.find((watchlist) => watchlist.id === "manual");
    const compactWatchlists: Watchlist[] = [
      {
        id: "manual",
        name: manual?.name ?? DEFAULT_WATCHLISTS[0].name,
        type: "manual",
        description:
          manual?.description ?? DEFAULT_WATCHLISTS[0].description ?? "",
        symbols: uniqueSymbolStrings(
          (manual?.symbols ?? []).map((item) => item.symbol)
        ).map((symbol) => ({ symbol })),
      },
    ];

    try {
      window.localStorage.setItem(
        WATCHLIST_STORAGE_KEY,
        JSON.stringify(compactWatchlists)
      );
    } catch (error) {
      // Browser storage must never be allowed to take down the trading terminal.
      console.warn("[WatchlistContext] local watchlist persistence skipped", error);
    }
  }, [watchlists, marketDataMode]);

  useEffect(() => {
    if (typeof window === "undefined" || marketDataMode === "replay") return;

    const manualSymbols = getManualSymbols(watchlists);
    writeLegacyManualSymbols(manualSymbols);
  }, [watchlists, marketDataMode]);

  useEffect(() => {
    if (marketDataMode === "replay") return;

    const currentManualSymbols = new Set(getManualSymbols(watchlists));

    if (!didCaptureInitialManualRef.current) {
      didCaptureInitialManualRef.current = true;

      dailyPracticeUniverseEngine.recordManualWatchlistSnapshot(
        Array.from(currentManualSymbols)
      );

      previousManualSymbolsRef.current = currentManualSymbols;
      return;
    }

    for (const symbol of currentManualSymbols) {
      if (!previousManualSymbolsRef.current.has(symbol)) {
        dailyPracticeUniverseEngine.recordManualWatchlistSymbol({ symbol });
      }
    }

    for (const symbol of previousManualSymbolsRef.current) {
      if (!currentManualSymbols.has(symbol)) {
        dailyPracticeUniverseEngine.removeManualWatchlistSymbol({ symbol });
      }
    }

    previousManualSymbolsRef.current = currentManualSymbols;
  }, [watchlists, marketDataMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(
        ACTIVE_WATCHLIST_STORAGE_KEY,
        activeWatchlistId
      );
    } catch (error) {
      console.warn("[WatchlistContext] active watchlist persistence skipped", error);
    }
  }, [activeWatchlistId]);

  useEffect(() => {
    if (didBootstrapBackendRef.current) return;
    didBootstrapBackendRef.current = true;

    let cancelled = false;

    async function bootstrapBackendOnce() {
      try {
        const backendManual = await fetchManualWatchlist();
        let authoritativeManual = backendManual.symbols;

        // A null timestamp means the dedicated endpoint has not established an
        // authoritative list yet. Migrate the existing backend list first, or
        // use this browser's local list only when the backend has no list.
        if (backendManual.updatedAt === null) {
          if (
            authoritativeManual.length === 0 &&
            initialManualSymbolsRef.current.length > 0
          ) {
            authoritativeManual = initialManualSymbolsRef.current;
          }

          const initialized = await saveManualWatchlist(authoritativeManual);
          authoritativeManual = initialized.symbols;
        }

        if (cancelled) return;

        if (marketDataMode !== "replay") {
          setWatchlists((current) => {
            return setManualSymbols(current, authoritativeManual);
          });
        }

        setBackendSyncReady(true);
      } catch (error) {
        console.warn("[WatchlistContext] backend bootstrap failed", error);
      }
    }

    void bootstrapBackendOnce();

    return () => {
      cancelled = true;
    };
  }, [marketDataMode]);

  useEffect(() => {
    if (
      !backendSyncReady ||
      typeof window === "undefined" ||
      marketDataMode === "replay"
    ) return;

    let cancelled = false;
    let refreshInFlight = false;

    const refreshManualWatchlist = async () => {
      if (cancelled || refreshInFlight) return;
      refreshInFlight = true;

      try {
        await manualMutationQueueRef.current.catch(() => undefined);
        const snapshot = await fetchManualWatchlist();

        if (!cancelled) {
          setWatchlists((current) => {
            const currentSymbols = getManualSymbols(current);
            const nextSymbols = uniqueSymbolStrings(snapshot.symbols);
            const unchanged =
              currentSymbols.length === nextSymbols.length &&
              currentSymbols.every(
                (symbol, index) => symbol === nextSymbols[index]
              );

            return unchanged
              ? current
              : setManualSymbols(current, nextSymbols);
          });
        }
      } catch (error) {
        console.warn("[WatchlistContext] manual watchlist refresh failed", error);
      } finally {
        refreshInFlight = false;
      }
    };

    const handleFocus = () => {
      void refreshManualWatchlist();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshManualWatchlist();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const pollTimer = window.setInterval(
      () => void refreshManualWatchlist(),
      MANUAL_WATCHLIST_POLL_MS
    );

    void refreshManualWatchlist();

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [backendSyncReady, marketDataMode]);

  const activeWatchlist = useMemo(
    () =>
      watchlists.find((watchlist) => watchlist.id === activeWatchlistId) ??
      watchlists.find((watchlist) => watchlist.id === "manual") ??
      watchlists[0],
    [watchlists, activeWatchlistId]
  );

  const setActiveWatchlist = useCallback((id: string) => {
    const normalizedId = normalizeWatchlistId(id);
    if (!normalizedId) return;

    setActiveWatchlistId(normalizedId);
  }, []);

  const createWatchlist = useCallback(
    (name: string, type: WatchlistType = "custom") => {
      const trimmed = name.trim();
      if (!trimmed) return;

      const watchlist: Watchlist = {
        id: createId(),
        name: trimmed,
        type,
        description: "Custom watchlist ready for symbols.",
        symbols: [],
      };

      setWatchlists((current) => [...current, watchlist]);
      setActiveWatchlistId(watchlist.id);
    },
    []
  );

  const renameWatchlist = useCallback((id: string, name: string) => {
    const normalizedId = normalizeWatchlistId(id);
    const trimmed = name.trim();

    if (!normalizedId || !trimmed) return;

    setWatchlists((current) =>
      current.map((watchlist) =>
        watchlist.id === normalizedId
          ? { ...watchlist, name: trimmed }
          : watchlist
      )
    );
  }, []);

  const deleteWatchlist = useCallback(
    (id: string) => {
      const normalizedId = normalizeWatchlistId(id);
      if (!normalizedId || normalizedId === "manual" || normalizedId === "scanner") return;

      setWatchlists((current) => {
        if (current.length <= 1) return current;

        const next = current.filter((watchlist) => watchlist.id !== normalizedId);

        if (activeWatchlistId === normalizedId && next.length > 0) {
          setActiveWatchlistId(next[0].id);
        }

        return next;
      });
    },
    [activeWatchlistId]
  );

  const addSymbol = useCallback(
    (watchlistId: string, input: string | WatchlistSymbol) => {
      const normalizedId = normalizeWatchlistId(watchlistId);
      const normalized = normalizeWatchlistSymbol(input);

      if (!normalizedId || !normalized) return;

      if (normalizedId === "manual" && marketDataMode !== "replay") {
        dailyPracticeUniverseEngine.recordManualWatchlistSymbol({
          symbol: normalized.symbol,
        });
      }

      setWatchlists((current) => {
        const exists = current.some((watchlist) => watchlist.id === normalizedId);
        const base = exists
          ? current
          : [
              ...current,
              {
                id: normalizedId,
                name: titleCaseFromId(normalizedId),
                type: "custom" as WatchlistType,
                description: "Auto-created watchlist.",
                symbols: [],
              },
            ];

        return base.map((watchlist) => {
          if (watchlist.id !== normalizedId) return watchlist;

          const nextSymbols = uniqueWatchlistSymbols([
            ...watchlist.symbols.filter((item) => item.symbol !== normalized.symbol),
            normalized,
          ]);

          if (
            marketDataMode !== "replay" &&
            (watchlist.type === "scanner" || normalizedId === "scanner")
          ) {
            recordScannerWatchlistSymbols(
              normalizedId,
              watchlist.name,
              [normalized]
            );
          }

          return {
            ...watchlist,
            symbols: nextSymbols,
          };
        });
      });

      if (normalizedId === "manual" && marketDataMode !== "replay") {
        queueManualMutation(() =>
          setManualWatchlistSymbol(normalized.symbol, true)
        );
      }
    },
    [marketDataMode, queueManualMutation]
  );

  const removeSymbol = useCallback((watchlistId: string, symbol: string) => {
    const normalizedId = normalizeWatchlistId(watchlistId);
    const normalizedSymbol = normalizeSymbol(symbol);

    if (!normalizedId || !normalizedSymbol) return;

    if (normalizedId === "manual" && marketDataMode !== "replay") {
      dailyPracticeUniverseEngine.removeManualWatchlistSymbol({
        symbol: normalizedSymbol,
      });
    }

    setWatchlists((current) =>
      current.map((watchlist) =>
        watchlist.id === normalizedId
          ? {
              ...watchlist,
              symbols: watchlist.symbols.filter(
                (item) => item.symbol !== normalizedSymbol
              ),
            }
          : watchlist
      )
    );

    if (normalizedId === "manual" && marketDataMode !== "replay") {
      queueManualMutation(() =>
        setManualWatchlistSymbol(normalizedSymbol, false)
      );
    }
  }, [marketDataMode, queueManualMutation]);

  const replaceSymbols = useCallback(
    (
      watchlistId: string,
      symbols: Array<string | WatchlistSymbol>,
      options: ReplaceSymbolsOptions = {}
    ) => {
      const normalizedId = normalizeWatchlistId(watchlistId);
      const normalizedSymbols = symbols
        .map((item) => normalizeWatchlistSymbol(item))
        .filter((item): item is WatchlistSymbol => item !== null);

      const existingWatchlist = watchlists.find(
        (watchlist) => watchlist.id === normalizedId
      );

      const resolvedType =
        options.type ?? existingWatchlist?.type ?? "scanner";
      const resolvedName =
        options.name?.trim() ||
        existingWatchlist?.name ||
        titleCaseFromId(normalizedId);

      if (
        marketDataMode !== "replay" &&
        resolvedType === "scanner" &&
        normalizedId
      ) {
        recordScannerWatchlistSymbols(
          normalizedId,
          resolvedName,
          normalizedSymbols
        );
      }

      if (normalizedId === "manual" && marketDataMode !== "replay") {
        const nextManualSymbols = new Set(
          normalizedSymbols.map((item) => item.symbol)
        );
        const currentManualSymbols = new Set(getManualSymbols(watchlists));

        for (const symbol of nextManualSymbols) {
          if (!currentManualSymbols.has(symbol)) {
            dailyPracticeUniverseEngine.recordManualWatchlistSymbol({ symbol });
          }
        }

        for (const symbol of currentManualSymbols) {
          if (!nextManualSymbols.has(symbol)) {
            dailyPracticeUniverseEngine.removeManualWatchlistSymbol({ symbol });
          }
        }
      }

      setWatchlists((current) =>
        replaceSymbolsInternal(current, watchlistId, symbols, options)
      );

      if (normalizedId === "manual" && marketDataMode !== "replay") {
        queueManualMutation(() =>
          saveManualWatchlist(normalizedSymbols.map((item) => item.symbol))
        );
      }

      if (options.activate && normalizedId) {
        setActiveWatchlistId(normalizedId);
      }
    },
    [marketDataMode, queueManualMutation, watchlists]
  );

  const syncScannerWatchlists = useCallback(
    (definitions: ScannerWatchlistDefinition[]) => {
      const normalizedDefinitions = definitions
        .map((definition) => ({
          ...definition,
          id: normalizeWatchlistId(definition.id),
          name: definition.name.trim(),
        }))
        .filter((definition) => definition.id && definition.name);

      setWatchlists((current) => {
        const manual =
          current.find((watchlist) => watchlist.id === "manual") ??
          DEFAULT_WATCHLISTS[0];
        const currentById = new Map(
          current.map((watchlist) => [watchlist.id, watchlist])
        );

        return [
          manual,
          ...normalizedDefinitions.map((definition) => ({
            id: definition.id,
            name: definition.name,
            type: "scanner" as const,
            description:
              definition.description ??
              `Scanner-generated symbols for ${definition.name}.`,
            symbols: currentById.get(definition.id)?.symbols ?? [],
          })),
        ];
      });

      setActiveWatchlistId((current) => {
        const validIds = new Set([
          "manual",
          ...normalizedDefinitions.map((definition) => definition.id),
        ]);
        return validIds.has(current) ? current : "manual";
      });
    },
    []
  );

  const value = useMemo<WatchlistContextValue>(
    () => ({
      watchlists,
      activeWatchlistId: activeWatchlist?.id ?? activeWatchlistId,
      activeWatchlist,
      setActiveWatchlist,
      createWatchlist,
      renameWatchlist,
      deleteWatchlist,
      addSymbol,
      removeSymbol,
      replaceSymbols,
      syncScannerWatchlists,
    }),
    [
      watchlists,
      activeWatchlistId,
      activeWatchlist,
      setActiveWatchlist,
      createWatchlist,
      renameWatchlist,
      deleteWatchlist,
      addSymbol,
      removeSymbol,
      replaceSymbols,
      syncScannerWatchlists,
    ]
  );

  return (
    <WatchlistContext.Provider value={value}>
      {children}
    </WatchlistContext.Provider>
  );
}

function replaceSymbolsInternal(
  current: Watchlist[],
  watchlistId: string,
  symbols: Array<string | WatchlistSymbol>,
  options: ReplaceSymbolsOptions = {}
): Watchlist[] {
  const normalizedId = normalizeWatchlistId(watchlistId);
  if (!normalizedId) return current;

  const normalized = symbols
    .map((item) => normalizeWatchlistSymbol(item))
    .filter((item): item is WatchlistSymbol => item !== null);

  const unique = uniqueWatchlistSymbols(normalized);

  if (unique.length === 0 && options.allowEmpty !== true) {
    return current;
  }

  const existing = current.find((watchlist) => watchlist.id === normalizedId);

  if (!existing) {
    if (unique.length === 0 && options.allowEmpty !== true) return current;

    return [
      ...current,
      {
        id: normalizedId,
        name: options.name?.trim() || titleCaseFromId(normalizedId),
        type: options.type ?? "scanner",
        description:
          options.description ??
          `Scanner-generated symbols for ${titleCaseFromId(normalizedId)}.`,
        symbols: unique,
      },
    ];
  }

  return current.map((watchlist) =>
    watchlist.id === normalizedId
      ? {
          ...watchlist,
          name: options.name?.trim() || watchlist.name,
          type: options.type ?? watchlist.type,
          description: options.description ?? watchlist.description,
          symbols: unique,
        }
      : watchlist
  );
}

export function useWatchlists() {
  const context = useContext(WatchlistContext);

  if (!context) {
    throw new Error("useWatchlists must be used inside WatchlistProvider");
  }

  return context;
}
