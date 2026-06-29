import type {
  ReplaceSymbolsOptions,
  Watchlist,
  WatchlistSymbol,
  WatchlistType,
} from "./WatchlistTypes";

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

export const DEFAULT_WATCHLISTS: Watchlist[] = [
  {
    id: "scanner",
    name: "Scanner Watchlist",
    type: "scanner",
    source: "scanner",
    editable: false,
    deletable: false,
    autoRefresh: true,
    description: "Combined symbols currently coming from scanner output.",
    symbols: [],
  },
  {
    id: "manual",
    name: "Manual Watchlist",
    type: "manual",
    source: "user",
    editable: true,
    deletable: false,
    autoRefresh: false,
    description: "User selected symbols for active monitoring.",
    symbols: [],
  },
];

export function createId() {
  return `watchlist_${Date.now()}_${Math.round(Math.random() * 10000)}`;
}

export function normalizeSymbol(symbol: string): string {
  return String(symbol ?? "").trim().toUpperCase();
}

export function normalizeWatchlistId(id: string): string {
  return String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function titleCaseFromId(id: string): string {
  const normalizedId = normalizeWatchlistId(id);
  const known = KNOWN_WATCHLIST_NAMES[normalizedId];
  if (known) return known;

  return normalizedId
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeWatchlistSymbol(
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

export function uniqueSymbols(symbols: WatchlistSymbol[]): WatchlistSymbol[] {
  return Array.from(new Map(symbols.map((item) => [item.symbol, item])).values());
}

export function normalizeWatchlist(input: Watchlist): Watchlist | null {
  const id = normalizeWatchlistId(input.id);
  if (!id) return null;

  const symbols = (input.symbols ?? [])
    .map((item) => normalizeWatchlistSymbol(item))
    .filter((item): item is WatchlistSymbol => item !== null);

  const type = input.type ?? (id === "manual" ? "manual" : id === "scanner" ? "scanner" : "custom");

  return {
    ...input,
    id,
    name: input.name?.trim() || titleCaseFromId(id),
    type,
    source:
      input.source ?? (type === "scanner" ? "scanner" : type === "manual" ? "user" : "user"),
    editable: input.editable ?? type !== "scanner",
    deletable: input.deletable ?? !["scanner", "manual"].includes(id),
    autoRefresh: input.autoRefresh ?? type === "scanner",
    description: input.description ?? "",
    symbols,
  };
}

export function ensureDefaultWatchlists(input: Watchlist[]): Watchlist[] {
  const loaded = input
    .map((item) => normalizeWatchlist(item))
    .filter((item): item is Watchlist => item !== null);

  const byId = new Map<string, Watchlist>();

  [...DEFAULT_WATCHLISTS, ...loaded].forEach((watchlist) => {
    byId.set(watchlist.id, watchlist);
  });

  return Array.from(byId.values());
}

export function createWatchlistState(
  current: Watchlist[],
  name: string,
  type: WatchlistType = "custom"
): { watchlists: Watchlist[]; createdId: string | null } {
  const trimmed = name.trim();
  if (!trimmed) return { watchlists: current, createdId: null };

  const watchlist: Watchlist = {
    id: createId(),
    name: trimmed,
    type,
    source: "user",
    editable: true,
    deletable: true,
    autoRefresh: false,
    description: "Custom watchlist ready for symbols.",
    symbols: [],
  };

  return { watchlists: [...current, watchlist], createdId: watchlist.id };
}

export function renameWatchlistState(
  current: Watchlist[],
  id: string,
  name: string
): Watchlist[] {
  const normalizedId = normalizeWatchlistId(id);
  const trimmed = name.trim();
  if (!normalizedId || !trimmed) return current;

  return current.map((watchlist) =>
    watchlist.id === normalizedId && watchlist.editable !== false
      ? { ...watchlist, name: trimmed }
      : watchlist
  );
}

export function deleteWatchlistState(current: Watchlist[], id: string): Watchlist[] {
  const normalizedId = normalizeWatchlistId(id);
  if (!normalizedId || current.length <= 1) return current;

  const target = current.find((watchlist) => watchlist.id === normalizedId);
  if (target?.deletable === false) return current;

  return current.filter((watchlist) => watchlist.id !== normalizedId);
}

export function addSymbolState(
  current: Watchlist[],
  watchlistId: string,
  input: string | WatchlistSymbol
): Watchlist[] {
  const normalizedId = normalizeWatchlistId(watchlistId);
  const normalized = normalizeWatchlistSymbol(input);
  if (!normalizedId || !normalized) return current;

  const exists = current.some((watchlist) => watchlist.id === normalizedId);
  const base = exists
    ? current
    : [
        ...current,
        {
          id: normalizedId,
          name: titleCaseFromId(normalizedId),
          type: "custom" as WatchlistType,
          source: "user" as const,
          editable: true,
          deletable: true,
          autoRefresh: false,
          description: "Auto-created watchlist.",
          symbols: [],
        },
      ];

  return base.map((watchlist) => {
    if (watchlist.id !== normalizedId) return watchlist;

    return {
      ...watchlist,
      symbols: uniqueSymbols([
        ...watchlist.symbols.filter((item) => item.symbol !== normalized.symbol),
        normalized,
      ]),
    };
  });
}

export function removeSymbolState(
  current: Watchlist[],
  watchlistId: string,
  symbol: string
): Watchlist[] {
  const normalizedId = normalizeWatchlistId(watchlistId);
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedId || !normalizedSymbol) return current;

  return current.map((watchlist) =>
    watchlist.id === normalizedId
      ? {
          ...watchlist,
          symbols: watchlist.symbols.filter((item) => item.symbol !== normalizedSymbol),
        }
      : watchlist
  );
}

export function replaceSymbolsState(
  current: Watchlist[],
  watchlistId: string,
  symbols: Array<string | WatchlistSymbol>,
  options: ReplaceSymbolsOptions = {}
): Watchlist[] {
  const normalizedId = normalizeWatchlistId(watchlistId);
  if (!normalizedId) return current;

  const unique = uniqueSymbols(
    symbols
      .map((item) => normalizeWatchlistSymbol(item))
      .filter((item): item is WatchlistSymbol => item !== null)
  );

  // Safety: scanner/loading passes must never wipe an existing list with an empty array.
  // If a true clear is needed later, call replaceSymbols with { allowEmpty: true }.
  if (unique.length === 0 && options.allowEmpty !== true) {
    return current;
  }

  const existing = current.find((watchlist) => watchlist.id === normalizedId);

  if (!existing) {
    return [
      ...current,
      {
        id: normalizedId,
        name: options.name?.trim() || titleCaseFromId(normalizedId),
        type: options.type ?? "scanner",
        source: options.type === "manual" ? "user" : "scanner",
        editable: options.type === "manual",
        deletable: !["scanner", "manual"].includes(normalizedId),
        autoRefresh: options.type !== "manual",
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
          source: options.type === "manual" ? "user" : watchlist.source,
          description: options.description ?? watchlist.description,
          symbols: unique,
        }
      : watchlist
  );
}
