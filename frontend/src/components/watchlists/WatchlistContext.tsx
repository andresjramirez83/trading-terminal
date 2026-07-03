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
  fetchSharedAlpacaState,
  saveSharedAlpacaState,
} from "../../services/api";

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
}

const WatchlistContext = createContext<WatchlistContextValue | null>(null);

const WATCHLIST_STORAGE_KEY = "trading.workstation.watchlists.v1";
const ACTIVE_WATCHLIST_STORAGE_KEY = "trading.workstation.activeWatchlist.v1";

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
    id: "scanner",
    name: "Scanner Watchlist",
    type: "scanner",
    description: "Symbols currently coming from scanner output.",
    symbols: [],
  },
  {
    id: "manual",
    name: "Manual Watchlist",
    type: "manual",
    description: "User selected symbols for active monitoring.",
    symbols: [],
  },
  {
    id: "momentum",
    name: "Momentum",
    type: "scanner",
    description: "Scanner-generated momentum opportunities.",
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
  const byId = new Map<string, Watchlist>();

  for (const item of DEFAULT_WATCHLISTS) {
    byId.set(item.id, item);
  }

  for (const item of watchlists) {
    const normalized = normalizeWatchlist(item);
    if (normalized) byId.set(normalized.id, normalized);
  }

  return Array.from(byId.values());
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
  const didBootstrapBackendRef = useRef(false);

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
    if (typeof window === "undefined") return;

    window.localStorage.setItem(ACTIVE_WATCHLIST_STORAGE_KEY, activeWatchlistId);
  }, [activeWatchlistId]);

  useEffect(() => {
    if (didBootstrapBackendRef.current) return;
    didBootstrapBackendRef.current = true;

    async function bootstrapBackendOnce() {
      try {
        const shared = (await fetchSharedAlpacaState()) as Record<string, unknown> | null;
        if (!shared) return;

        const scannerSymbols = extractSymbolsFromUnknown(
          shared.watchlist ?? shared.scannerWatchlist ?? shared.scanner_symbols
        );

        const backendManualSymbols = extractSymbolsFromUnknown(
          shared.manualWatchlist ??
            shared.manual_watchlist ??
            shared.manualSymbols ??
            shared.manual_symbols
        );

        setWatchlists((current) => {
          let next = current;

          if (scannerSymbols.length > 0) {
            next = replaceSymbolsInternal(next, "scanner", scannerSymbols, {
              type: "scanner",
              name: "Scanner Watchlist",
              allowEmpty: false,
            });
          }

          const currentManual = getManualSymbols(next);

          // Backend is only used to bootstrap if the local/manual list is empty.
          // This prevents deleted symbols from being re-added by backend sync.
          if (currentManual.length === 0 && backendManualSymbols.length > 0) {
            next = setManualSymbols(next, backendManualSymbols);
          }

          return next;
        });
      } catch (error) {
        console.warn("[WatchlistContext] backend bootstrap failed", error);
      }
    }

    void bootstrapBackendOnce();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const manualSymbols = getManualSymbols(watchlists);
    const scanner = watchlists.find((item) => item.id === "scanner");
    const scannerSymbols = (scanner?.symbols ?? []).map((item) => item.symbol);

    const timeoutId = window.setTimeout(async () => {
      try {
        const existing = (await fetchSharedAlpacaState()) as Record<string, unknown> | null;

        await saveSharedAlpacaState({
          ...(existing ?? {}),
          watchlist: scannerSymbols,
          manualWatchlist: manualSymbols,
          updatedAt: Date.now(),
        } as any);
      } catch (error) {
        console.warn("[WatchlistContext] backend save failed", error);
      }
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [watchlists]);

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

          return {
            ...watchlist,
            symbols: nextSymbols,
          };
        });
      });
    },
    []
  );

  const removeSymbol = useCallback((watchlistId: string, symbol: string) => {
    const normalizedId = normalizeWatchlistId(watchlistId);
    const normalizedSymbol = normalizeSymbol(symbol);

    if (!normalizedId || !normalizedSymbol) return;

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
  }, []);

  const replaceSymbols = useCallback(
    (
      watchlistId: string,
      symbols: Array<string | WatchlistSymbol>,
      options: ReplaceSymbolsOptions = {}
    ) => {
      setWatchlists((current) =>
        replaceSymbolsInternal(current, watchlistId, symbols, options)
      );

      const normalizedId = normalizeWatchlistId(watchlistId);

      if (options.activate && normalizedId) {
        setActiveWatchlistId(normalizedId);
      }
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
    if (unique.length === 0) return current;

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
