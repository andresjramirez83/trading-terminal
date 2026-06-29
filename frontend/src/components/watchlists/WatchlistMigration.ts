import { normalizeSymbol } from "./WatchlistStore";

function parseLegacySymbolArray(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") return normalizeSymbol(item);
          if (item && typeof item === "object" && "symbol" in item) {
            return normalizeSymbol((item as { symbol?: unknown }).symbol);
          }
          return "";
        })
        .filter(Boolean);
    }
  } catch {
    return raw
      .split(/[\s,]+/g)
      .map(normalizeSymbol)
      .filter(Boolean);
  }

  return [];
}

export function loadLegacyManualWatchlist(): string[] {
  if (typeof window === "undefined") return [];

  const keys = [
    "alpacaManualWatchlist",
    "manualWatchlist",
    "manual-watchlist",
    "trading.manual.watchlist",
  ];

  for (const key of keys) {
    const symbols = parseLegacySymbolArray(window.localStorage.getItem(key));
    if (symbols.length > 0) return symbols;
  }

  return [];
}
