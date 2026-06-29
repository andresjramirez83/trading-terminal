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

import { fetchSharedAlpacaState } from "../../services/api";

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

type ReplaceSymbolsOptions = {
  name?: string;
  type?: WatchlistType;
  description?: string;
  activate?: boolean;
};

const WatchlistContext = createContext<WatchlistContextValue | null>(null);

const WATCHLIST_STORAGE_KEY = "trading.workstation.watchlists.v1";
const ACTIVE_WATCHLIST_STORAGE_KEY = "trading.workstation.activeWatchlist.v1";

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

function createId() {
  return `watchlist_${Date.now()}_${Math.round(Math.random() * 10000)}`;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function normalizeWatchlistId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function titleCaseFromId(id: string): string {
  const known = KNOWN_WATCHLIST_NAMES[id];
  if (known) return known;

  return id
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeWatchlistSymbol(
  input: string | WatchlistSymbol
): WatchlistSymbol | null {
  if (typeof input === "string") {
    const symbol = normalizeSymbol(input);

    if (!symbol) {
      return null;
    }

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

  if (!symbol) {
    return null;
  }

  return {
    ...input,
    symbol,
    score: input.score ?? 0,
    tone: input.tone ?? "watch",
    setup: input.setup ?? "Watchlist",
    note: input.note ?? "",
  };
}

function normalizeWatchlist(input: Watchlist): Watchlist | null {
  const id = normalizeWatchlistId(input.id);

  if (!id) {
    return null;
  }

  const symbols = (input.symbols ?? [])
    .map((item) => normalizeWatchlistSymbol(item))
    .filter((item): item is WatchlistSymbol => item !== null);

  return {
    id,
    name: input.name?.trim() || titleCaseFromId(id),
    type: input.type ?? "custom",
    description: input.description ?? "",
    symbols,
  };
}

function loadWatchlists(): Watchlist[] {
  if (typeof window === "undefined") {
    return DEFAULT_WATCHLISTS;
  }

  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_WATCHLISTS;
    }

    const parsed = JSON.parse(raw) as Watchlist[];
    const loaded = parsed
      .map((item) => normalizeWatchlist(item))
      .filter((item): item is Watchlist => item !== null);

    if (loaded.length === 0) {
      return DEFAULT_WATCHLISTS;
    }

    const existingIds = new Set(loaded.map((item) => item.id));
    const missingDefaults = DEFAULT_WATCHLISTS.filter(
      (item) => !existingIds.has(item.id)
    );

    return [...loaded, ...missingDefaults];
  } catch {
    return DEFAULT_WATCHLISTS;
  }
}

function loadActiveWatchlistId(): string {
  if (typeof window === "undefined") {
    return "scanner";
  }

  return window.localStorage.getItem(ACTIVE_WATCHLIST_STORAGE_KEY) || "scanner";
}


function normalizeSymbolArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  return Array.from(
    new Set(
      input
        .map((item) => {
          if (typeof item === "string") return normalizeSymbol(item);
          if (item && typeof item === "object" && "symbol" in item) {
            return normalizeSymbol(String((item as { symbol?: unknown }).symbol ?? ""));
          }
          return "";
        })
        .filter(Boolean)
    )
  );
}

function loadLegacyManualWatchlist(): string[] {
  if (typeof window === "undefined") return [];

  const keys = [
    "alpacaManualWatchlist",
    "manualWatchlist",
    "manual-watchlist",
    "trading.manual.watchlist",
  ];

  for (const key of keys) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as unknown;
      const symbols = normalizeSymbolArray(parsed);
      if (symbols.length > 0) return symbols;
    } catch {
      const symbols = raw
        .split(/[\s,]+/g)
        .map(normalizeSymbol)
        .filter(Boolean);
      if (symbols.length > 0) return Array.from(new Set(symbols));
    }
  }

  return [];
}

function uniqueSymbols(symbols: WatchlistSymbol[]): WatchlistSymbol[] {
  return Array.from(
    new Map(symbols.map((item) => [item.symbol, item])).values()
  );
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [watchlists, setWatchlists] = useState<Watchlist[]>(() =>
    loadWatchlists()
  );

  const [activeWatchlistId, setActiveWatchlistId] = useState(() =>
    loadActiveWatchlistId()
  );

  const didLoadBackendRef = useRef(false);

  useEffect(() => {
    if (didLoadBackendRef.current) return;
    didLoadBackendRef.current = true;

    let cancelled = false;

    async function loadBackendState() {
      try {
        const shared = (await fetchSharedAlpacaState()) as Record<string, unknown> | null;
        if (cancelled || !shared) return;

        const scannerSymbols = normalizeSymbolArray(
          shared.watchlist ?? shared.scannerWatchlist ?? shared.scanner_symbols
        );
        const backendManualSymbols = normalizeSymbolArray(
          shared.manualWatchlist ?? shared.manual_watchlist ?? shared.manualSymbols
        );
        const legacyManualSymbols = loadLegacyManualWatchlist();
        const manualSymbols =
          backendManualSymbols.length > 0 ? backendManualSymbols : legacyManualSymbols;

        if (scannerSymbols.length === 0 && manualSymbols.length === 0) return;

        setWatchlists((current) =>
          current.map((watchlist) => {
            if (watchlist.id === "scanner" && scannerSymbols.length > 0) {
              return {
                ...watchlist,
                symbols: scannerSymbols
                  .map((symbol) => normalizeWatchlistSymbol(symbol))
                  .filter((item): item is WatchlistSymbol => item !== null),
              };
            }

            if (watchlist.id === "manual" && manualSymbols.length > 0) {
              return {
                ...watchlist,
                symbols: manualSymbols
                  .map((symbol) => normalizeWatchlistSymbol(symbol))
                  .filter((item): item is WatchlistSymbol => item !== null),
              };
            }

            return watchlist;
          })
        );
      } catch (error) {
        console.warn("[WatchlistContext] Backend watchlist load failed", error);
      }
    }

    void loadBackendState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlists));
  }, [watchlists]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ACTIVE_WATCHLIST_STORAGE_KEY, activeWatchlistId);
  }, [activeWatchlistId]);

  const activeWatchlist = useMemo(
    () =>
      watchlists.find((watchlist) => watchlist.id === activeWatchlistId) ??
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

      if (!trimmed) {
        return;
      }

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

    if (!normalizedId || !trimmed) {
      return;
    }

    setWatchlists((current) =>
      current.map((watchlist) =>
        watchlist.id === normalizedId
          ? {
              ...watchlist,
              name: trimmed,
            }
          : watchlist
      )
    );
  }, []);

  const deleteWatchlist = useCallback(
    (id: string) => {
      const normalizedId = normalizeWatchlistId(id);
      if (!normalizedId) return;

      setWatchlists((current) => {
        if (current.length <= 1) {
          return current;
        }

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

      if (!normalizedId || !normalized) {
        return;
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
          if (watchlist.id !== normalizedId) {
            return watchlist;
          }

          const nextSymbols = uniqueSymbols([
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

    if (!normalizedId || !normalizedSymbol) {
      return;
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
  }, []);

  const replaceSymbols = useCallback(
    (
      watchlistId: string,
      symbols: Array<string | WatchlistSymbol>,
      options: ReplaceSymbolsOptions = {}
    ) => {
      const normalizedId = normalizeWatchlistId(watchlistId);

      if (!normalizedId) {
        return;
      }

      const normalized = symbols
        .map((item) => normalizeWatchlistSymbol(item))
        .filter((item): item is WatchlistSymbol => item !== null);

      const unique = uniqueSymbols(normalized);

      setWatchlists((current) => {
        const existing = current.find((watchlist) => watchlist.id === normalizedId);

        if (!existing) {
          // Do not create empty scanner/generated lists during startup refreshes.
          if (unique.length === 0) {
            return current;
          }

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
                symbols: unique.length > 0 ? unique : watchlist.symbols,
              }
            : watchlist
        );
      });

      if (options.activate) {
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

export function useWatchlists() {
  const context = useContext(WatchlistContext);

  if (!context) {
    throw new Error("useWatchlists must be used inside WatchlistProvider");
  }

  return context;
}
