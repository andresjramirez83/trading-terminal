import {
  fetchSharedAlpacaState,
  saveSharedAlpacaState,
  type SharedAlpacaStatePayload,
} from "./api";
import type { Watchlist, WatchlistSymbol } from "../watchlists/WatchlistTypes";

function normalizeSymbol(symbol: unknown): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "");
}

function uniqueSymbols(symbols: unknown[]): string[] {
  return Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
}

function extractSymbols(input: unknown): string[] {
  if (Array.isArray(input)) {
    return uniqueSymbols(
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
    return uniqueSymbols(input.split(/[\s,;]+/g));
  }

  if (input && typeof input === "object") {
    const data = input as Record<string, unknown>;

    return extractSymbols(
      data.manualWatchlist ??
        data.manual_watchlist ??
        data.manualSymbols ??
        data.manual_symbols ??
        data.symbols ??
        data.watchlist
    );
  }

  return [];
}

export type WatchlistBootstrapPayload = {
  scannerSymbols: string[];
  manualSymbols: string[];
};

export async function loadBackendWatchlists(): Promise<WatchlistBootstrapPayload> {
  let shared: SharedAlpacaStatePayload | null = null;

  try {
    shared = await fetchSharedAlpacaState();
  } catch (error) {
    console.warn("[WatchlistSync] backend load failed", error);
  }

  return {
    scannerSymbols: extractSymbols(shared?.watchlist),
    manualSymbols: extractSymbols(shared?.manualWatchlist),
  };
}

export async function saveBackendWatchlists(watchlists: Watchlist[]): Promise<void> {
  const scanner = watchlists.find((item) => item.id === "scanner");
  const manual = watchlists.find((item) => item.id === "manual");

  const scannerSymbols = uniqueSymbols((scanner?.symbols ?? []).map((item) => item.symbol));
  const manualSymbols = uniqueSymbols((manual?.symbols ?? []).map((item) => item.symbol));

  try {
    const existing = await fetchSharedAlpacaState();

    await saveSharedAlpacaState({
      ...(existing ?? {}),
      watchlist: scannerSymbols,
      manualWatchlist: manualSymbols,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.warn("[WatchlistSync] backend save failed", error);
  }
}

export function symbolsToWatchlistSymbols(symbols: string[]): WatchlistSymbol[] {
  return uniqueSymbols(symbols).map((symbol) => ({
    symbol,
    score: 0,
    tone: "watch" as const,
    setup: "Backend Watchlist",
    note: "Synced",
    source: "backend",
  }));
}
