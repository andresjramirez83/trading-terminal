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

import { API_BASE, fetchScannerDefinitions } from "../../services/api";

import { dailyPracticeUniverseEngine } from "../../trading/practice/DailyPracticeUniverseEngine";

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

const WatchlistContext = createContext<WatchlistContextValue | null>(null);

const WATCHLIST_STORAGE_KEY = "trading.workstation.watchlists.v1";
const ACTIVE_WATCHLIST_STORAGE_KEY = "trading.workstation.activeWatchlist.v1";
const MANUAL_WATCHLIST_POLL_MS = 2_000;

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
  const didBootstrapBackendRef = useRef(false);
  const initialManualSymbolsRef = useRef<string[]>(getManualSymbols(watchlists));
  const manualMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const previousManualSymbolsRef = useRef<Set<string>>(new Set());
  const didCaptureInitialManualRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function loadScannerWatchlists() {
      try {
        const definitions = await fetchScannerDefinitions();
        if (cancelled) return;

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
      } catch (error) {
        console.warn("[WatchlistContext] scanner registry load failed", error);
      }
    }

    void loadScannerWatchlists();

    return () => {
      cancelled = true;
    };
  }, []);

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
    if (typeof window === "undefined") return;

    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlists));
  }, [watchlists]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const manualSymbols = getManualSymbols(watchlists);
    writeLegacyManualSymbols(manualSymbols);
  }, [watchlists]);

  useEffect(() => {
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
  }, [watchlists]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    window.localStorage.setItem(ACTIVE_WATCHLIST_STORAGE_KEY, activeWatchlistId);
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

        setWatchlists((current) => {
          return setManualSymbols(current, authoritativeManual);
        });

        setBackendSyncReady(true);
      } catch (error) {
        console.warn("[WatchlistContext] backend bootstrap failed", error);
      }
    }

    void bootstrapBackendOnce();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!backendSyncReady || typeof window === "undefined") return;

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
  }, [backendSyncReady]);

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

      if (normalizedId === "manual") {
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

          if (watchlist.type === "scanner" || normalizedId === "scanner") {
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

      if (normalizedId === "manual") {
        queueManualMutation(() =>
          setManualWatchlistSymbol(normalized.symbol, true)
        );
      }
    },
    [queueManualMutation]
  );

  const removeSymbol = useCallback((watchlistId: string, symbol: string) => {
    const normalizedId = normalizeWatchlistId(watchlistId);
    const normalizedSymbol = normalizeSymbol(symbol);

    if (!normalizedId || !normalizedSymbol) return;

    if (normalizedId === "manual") {
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

    if (normalizedId === "manual") {
      queueManualMutation(() =>
        setManualWatchlistSymbol(normalizedSymbol, false)
      );
    }
  }, [queueManualMutation]);

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

      if (resolvedType === "scanner" && normalizedId) {
        recordScannerWatchlistSymbols(
          normalizedId,
          resolvedName,
          normalizedSymbols
        );
      }

      if (normalizedId === "manual") {
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

      if (normalizedId === "manual") {
        queueManualMutation(() =>
          saveManualWatchlist(normalizedSymbols.map((item) => item.symbol))
        );
      }

      if (options.activate && normalizedId) {
        setActiveWatchlistId(normalizedId);
      }
    },
    [queueManualMutation, watchlists]
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
